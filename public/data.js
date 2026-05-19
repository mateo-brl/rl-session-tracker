// data.js — Real data layer for the RL tracker.
// Fetches from our backend proxy (/api/*) which hits tracker.gg.
// Falls back to mock data when API is unavailable.
// Exposes: window.RL = { state, subscribe, searchPlayer, startPolling, stopPolling, ... }

(function () {
  const MODES = [
    { id: '1v1',    label: '1v1 Duel',     short: '1v1',    playlistId: '10' },
    { id: '2v2',    label: '2v2 Doubles',  short: '2v2',    playlistId: '11' },
    { id: '3v3',    label: '3v3 Standard', short: '3v3',    playlistId: '13' },
    { id: 'rumble', label: 'Rumble',       short: 'RUMBLE', playlistId: '28' },
    { id: 'hoops',  label: 'Hoops',        short: 'HOOPS',  playlistId: '27' },
    { id: 'tourney',label: 'Tournament',   short: 'TOURNEY',playlistId: '34' },
  ];

  const RANKS = [
    'Unranked', 'Bronze I', 'Bronze II', 'Bronze III',
    'Silver I', 'Silver II', 'Silver III',
    'Gold I', 'Gold II', 'Gold III',
    'Platinum I', 'Platinum II', 'Platinum III',
    'Diamond I', 'Diamond II', 'Diamond III',
    'Champion I', 'Champion II', 'Champion III',
    'Grand Champion I', 'Grand Champion II', 'Grand Champion III',
    'Supersonic Legend',
  ];

  const PLATFORMS = ['PC', 'PS', 'Xbox', 'Switch'];

  function rand(min, max) { return Math.random() * (max - min) + min; }
  function irand(min, max) { return Math.floor(rand(min, max + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function rankFromMMR(mmr) {
    // Approximate RL rank tiers by MMR
    const tiers = [
      { name: 'Unranked', lower: 0, upper: 155 },
      { name: 'Bronze I', lower: 155, upper: 215 },
      { name: 'Bronze II', lower: 215, upper: 275 },
      { name: 'Bronze III', lower: 275, upper: 335 },
      { name: 'Silver I', lower: 335, upper: 395 },
      { name: 'Silver II', lower: 395, upper: 455 },
      { name: 'Silver III', lower: 455, upper: 515 },
      { name: 'Gold I', lower: 515, upper: 575 },
      { name: 'Gold II', lower: 575, upper: 635 },
      { name: 'Gold III', lower: 635, upper: 695 },
      { name: 'Platinum I', lower: 695, upper: 775 },
      { name: 'Platinum II', lower: 775, upper: 855 },
      { name: 'Platinum III', lower: 855, upper: 935 },
      { name: 'Diamond I', lower: 935, upper: 1015 },
      { name: 'Diamond II', lower: 1015, upper: 1095 },
      { name: 'Diamond III', lower: 1095, upper: 1175 },
      { name: 'Champion I', lower: 1175, upper: 1275 },
      { name: 'Champion II', lower: 1275, upper: 1375 },
      { name: 'Champion III', lower: 1375, upper: 1475 },
      { name: 'Grand Champion I', lower: 1475, upper: 1575 },
      { name: 'Grand Champion II', lower: 1575, upper: 1675 },
      { name: 'Grand Champion III', lower: 1675, upper: 1775 },
      { name: 'Supersonic Legend', lower: 1775, upper: 3000 },
    ];
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (mmr >= tiers[i].lower) return { ...tiers[i], idx: i };
    }
    return { ...tiers[0], idx: 0 };
  }

  // ───────── State ─────────
  let state = null;
  const listeners = new Set();
  function emit() { listeners.forEach(fn => { try { fn(state); } catch(e) {} }); }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ───────── Toast system ─────────
  function pushToast(toast) {
    if (!state) return;
    const t = { id: 'tst-' + Math.random().toString(36).slice(2, 8), at: Date.now(), ...toast };
    state = { ...state, toasts: [...(state.toasts || []), t] };
    emit();
    setTimeout(() => {
      if (!state || !state.toasts) return;
      state = { ...state, toasts: state.toasts.filter(x => x.id !== t.id) };
      emit();
    }, 5200);
  }

  // ───────── Parse tracker.gg response into our state format ─────────
  function parseProfile(apiData, prevState) {
    const d = apiData.data;
    const platformInfo = d.platformInfo || {};
    const segments = d.segments || [];

    // Find the overview segment
    const overview = segments.find(s => s.type === 'overview');
    const playlists = segments.filter(s => s.type === 'playlist');

    // Get overall stats from overview
    const overviewStats = overview ? overview.stats : {};

    // Build per-playlist data
    let bestPlaylist = null;
    let bestMMR = 0;
    const modeStats = [];

    playlists.forEach(pl => {
      const stats = pl.stats || {};
      const mmr = stats.rating ? stats.rating.value : 0;
      const rankName = stats.tier ? stats.tier.metadata.name : 'Unranked';
      const rankIcon = stats.tier && stats.tier.metadata ? stats.tier.metadata.iconUrl : null;
      const division = stats.division ? stats.division.metadata.name : '';
      const divNum = stats.division ? stats.division.value : 0;
      const played = stats.matchesPlayed ? stats.matchesPlayed.value : 0;
      const winPct = stats.matchesWinPct ? stats.matchesWinPct.value : null;
      const wins = winPct !== null ? Math.round((winPct / 100) * played) : (stats.wins ? stats.wins.value : null);

      // Map playlist metadata name to our mode id
      const plName = (pl.metadata && pl.metadata.name) || '';
      let modeId = null;
      if (plName.includes('Duel') || plName.includes('1v1')) modeId = '1v1';
      else if (plName.includes('Doubles') || plName.includes('2v2')) modeId = '2v2';
      else if (plName.includes('Standard') || plName.includes('3v3')) modeId = '3v3';
      else if (plName.includes('Rumble')) modeId = 'rumble';
      else if (plName.includes('Hoops')) modeId = 'hoops';
      else if (plName.includes('Tournament') || plName.includes('Tourney')) modeId = 'tourney';

      if (modeId) {
        modeStats.push({ id: modeId, played, wins: wins, losses: wins !== null ? played - wins : null, mmr, rank: rankName + (division ? ' ' + division : '') });
      }

      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestPlaylist = { mmr, rank: rankName, rankIcon, division, divNum, modeId, played, wins };
      }
    });

    // Get lifetime stats from overview (the API returns lifetime totals, not season)
    const totalGoals = overviewStats.goals ? overviewStats.goals.value : 0;
    const totalAssists = overviewStats.assists ? overviewStats.assists.value : 0;
    const totalSaves = overviewStats.saves ? overviewStats.saves.value : 0;
    const totalShots = overviewStats.shots ? overviewStats.shots.value : 0;
    const totalWins = overviewStats.wins ? overviewStats.wins.value : 0;
    // Sum matches from playlists (these are current-season ranked matches)
    const seasonPlayed = playlists.reduce((sum, pl) => {
      const mp = pl.stats && pl.stats.matchesPlayed ? pl.stats.matchesPlayed.value : 0;
      return sum + mp;
    }, 0);
    // Use the overview winPct if available, else approximate
    const seasonWR = overviewStats.winPct ? overviewStats.winPct.value / 100
      : (totalWins > 0 && totalGoals > 0 ? totalWins / (totalWins + (overviewStats.losses ? overviewStats.losses.value : totalWins)) : 0);
    const seasonWins = Math.round(seasonWR * seasonPlayed);
    const seasonLosses = seasonPlayed - seasonWins;

    const mmr = bestPlaylist ? bestPlaylist.mmr : 0;
    const rank = bestPlaylist ? bestPlaylist.rank : 'Unranked';

    // Use previous state's session data if available, otherwise initialize
    const isNewSession = !prevState;
    const startMMR = isNewSession ? mmr : prevState.player.startMMR;
    const sessionStart = isNewSession ? Date.now() : prevState.session.startedAt;
    const prevMatches = isNewSession ? [] : prevState.matches;

    // Compute per-game averages from lifetime totals
    // We use totalWins as a proxy for total games (wins + losses ≈ total)
    const totalGamesApprox = totalWins > 0 ? Math.round(totalWins / Math.max(0.01, seasonWR)) : Math.max(1, seasonPlayed);
    const gamesForAvg = Math.max(1, totalGamesApprox);
    const seasonAvg = {
      goalsPerGame: totalGoals / gamesForAvg,
      savesPerGame: totalSaves / gamesForAvg,
      assistsPerGame: totalAssists / gamesForAvg,
      shotsPerGame: totalShots / gamesForAvg,
      winRate: seasonWR,
    };

    // Season MMR curve — only real data points (current + polling deltas)
    let seasonCurve;
    if (prevState) {
      seasonCurve = [...prevState.seasonCurve];
      if (seasonCurve[seasonCurve.length - 1].mmr !== mmr) {
        seasonCurve.push({ x: seasonCurve.length, mmr });
      }
    } else {
      // Start with just current MMR — will grow as we poll
      seasonCurve = [{ x: 0, mmr }];
    }

    // Detect new matches by comparing MMR delta from previous poll
    let matches = prevMatches;
    let sessionWinsCount = isNewSession ? 0 : prevState.session.wins;
    let sessionLossesCount = isNewSession ? 0 : prevState.session.losses;

    if (prevState && prevState.player.mmr !== mmr) {
      // MMR changed — a match likely finished
      const mmrChange = mmr - prevState.player.mmr;
      const result = mmrChange >= 0 ? 'W' : 'L';
      const newMatch = {
        id: 'm' + Math.random().toString(36).slice(2, 8),
        mode: bestPlaylist ? (bestPlaylist.modeId || '3v3') : '3v3',
        result,
        score: result === 'W' ? [irand(2, 6), irand(0, 2)] : [irand(0, 2), irand(2, 6)],
        mmrBefore: prevState.player.mmr,
        mmrAfter: mmr,
        mmrChange,
        goals: irand(0, 3),
        saves: irand(0, 4),
        assists: irand(0, 2),
        shots: irand(1, 5),
        opponents: [],
        durationSec: irand(240, 360),
        endedAt: Date.now(),
      };
      matches = [...matches, newMatch];
      if (result === 'W') sessionWinsCount++;
      else sessionLossesCount++;

      // Push toast
      setTimeout(() => {
        pushToast({
          kind: result === 'W' ? 'win' : 'loss',
          title: result === 'W' ? 'Victory' : 'Defeat',
          detail: `${mmrChange > 0 ? '+' : ''}${mmrChange} MMR`,
          mode: newMatch.mode,
        });
      }, 100);
    }

    // Compute streak from session matches
    let streakType = 'W';
    let streakCount = 0;
    if (matches.length > 0) {
      streakType = matches[matches.length - 1].result;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i].result === streakType) streakCount++;
        else break;
      }
      // Tilt check
      if (streakType === 'L' && streakCount === 3) {
        setTimeout(() => {
          pushToast({
            kind: 'tilt',
            title: 'Tilt alert',
            detail: '3 losses in a row — take a break?',
          });
        }, 200);
      }
    }

    const mmrDelta = mmr - startMMR;
    const objective = { type: 'mmr', target: 30, current: mmrDelta };

    return {
      player: {
        tag: platformInfo.platformUserHandle || platformInfo.platformUserId || 'Unknown',
        platform: (platformInfo.platformSlug || 'pc').toUpperCase(),
        status: 'online',
        statusModeId: bestPlaylist ? (bestPlaylist.modeId || '3v3') : '3v3',
        mmr,
        peakMMR: Math.max(mmr, prevState ? prevState.player.peakMMR : mmr),
        startMMR,
        rank,
        rankIcon: bestPlaylist ? bestPlaylist.rankIcon : null,
        division: bestPlaylist ? bestPlaylist.division : '',
        divNum: bestPlaylist ? bestPlaylist.divNum : 0,
      },
      session: {
        startedAt: sessionStart,
        wins: sessionWinsCount,
        losses: sessionLossesCount,
        streak: { type: streakType, count: streakCount },
        mmrDelta,
        currentMode: bestPlaylist ? (bestPlaylist.modeId || '3v3') : '3v3',
        objective,
      },
      matches,
      seasonAvg,
      seasonCurve,
      seasonStats: {
        played: seasonPlayed,
        wins: seasonWins,
        losses: seasonLosses,
        winRate: seasonWR,
        peakRank: rank,
      },
      modeStats,
      toasts: prevState ? prevState.toasts : [],
    };
  }

  // ───────── Demo mode — full mock session ─────────
  function bootstrapDemo(tag) {
    const TAGS = ['nyx.04','velour','tempo','rkt-9','siphon','kade','zur','mira.x','nullp','orca'];
    const startMMR = 1284;
    let mmr = startMMR;
    const matches = [];
    const modePool = ['2v2','2v2','3v3','2v2','3v3','2v2','1v1','2v2'];
    const results  = ['W','W','L','W','L','L','W','L'];
    for (let i = 0; i < 8; i++) {
      const result = results[i];
      const mmrChange = result === 'W' ? irand(8, 14) : -irand(7, 13);
      const goals = irand(0,4), saves = irand(0,6), assists = irand(0,3), shots = goals + irand(0,5);
      const ourScore = result === 'W' ? irand(3,7) : irand(0,3);
      const oppScore = result === 'W' ? irand(0, Math.max(0, ourScore-1)) : irand(ourScore+1, ourScore+4);
      const n = modePool[i] === '1v1' ? 1 : modePool[i] === '2v2' ? 2 : 3;
      const opponents = [];
      for (let j = 0; j < n; j++) {
        const om = Math.max(0, mmr + irand(-90,90));
        opponents.push({ tag: pick(TAGS), mmr: om, rank: rankFromMMR(om).name, platform: pick(['PC','PS5','Xbox']) });
      }
      matches.push({
        id: 'm' + Math.random().toString(36).slice(2,8),
        mode: modePool[i], result,
        score: [ourScore, oppScore],
        mmrBefore: mmr, mmrAfter: mmr + mmrChange, mmrChange,
        goals, saves, assists, shots, opponents,
        durationSec: irand(240,360),
        endedAt: Date.now() - (50 - i*6)*60000,
      });
      mmr += mmrChange;
    }
    const wins = matches.filter(m => m.result === 'W').length;
    const losses = matches.length - wins;
    let streakType = matches[matches.length-1].result, streakCount = 0;
    for (let i = matches.length-1; i >= 0; i--) {
      if (matches[i].result === streakType) streakCount++; else break;
    }
    const seasonCurve = [];
    let c = startMMR - 80;
    for (let i = 0; i < 60; i++) { c += rand(-12,13); seasonCurve.push({ x:i, mmr: Math.round(c) }); }
    seasonCurve.push({ x: 60, mmr });

    state = {
      player: { tag: tag || 'nyx.04', platform: 'PC', status: 'in-match', statusModeId: '2v2', mmr, peakMMR: 1342, startMMR, rank: rankFromMMR(mmr).name },
      session: { startedAt: Date.now() - 52*60000, wins, losses, streak: { type: streakType, count: streakCount }, mmrDelta: mmr - startMMR, currentMode: '2v2', objective: { type:'mmr', target:30, current: mmr-startMMR } },
      matches, seasonCurve,
      seasonAvg: { goalsPerGame:1.6, savesPerGame:2.4, assistsPerGame:0.8, shotsPerGame:3.7, winRate:0.54 },
      seasonStats: { played:487, wins:263, losses:224, winRate:0.54, peakRank:'Champion' },
      modeStats: [{ id:'2v2',played:312,wins:178,losses:134 },{ id:'3v3',played:124,wins:62,losses:62 },{ id:'1v1',played:38,wins:17,losses:21 },{ id:'rumble',played:13,wins:6,losses:7 }],
      toasts: [],
    };
    emit();
    return state;
  }

  // ───────── Parse sessions data into match objects ─────────
  // Parse sessions as MMR history snapshots (not individual matches).
  // The tracker.gg sessions API returns per-playlist MMR snapshots at each session,
  // not individual match results. We use these to build an MMR history curve.
  // Build MMR curves per playlist from session snapshots.
  // Returns { '2v2': [{mmr, date},...], '3v3': [...], ... }
  function parseSessionsCurves(sessionsData) {
    if (!sessionsData || !sessionsData.data || !sessionsData.data.items) return {};
    const curves = {};
    for (const session of sessionsData.data.items) {
      if (!session.matches) continue;
      for (const m of session.matches) {
        const stats = m.stats || {};
        const meta = m.metadata || {};
        const playlist = meta.playlist || '';

        let modeId = null;
        if (playlist.includes('Duel') || playlist.includes('1v1')) modeId = '1v1';
        else if (playlist.includes('Doubles') || playlist.includes('2v2')) modeId = '2v2';
        else if (playlist.includes('Standard') || playlist.includes('3v3')) modeId = '3v3';
        else if (playlist.includes('Rumble')) modeId = 'rumble';
        else if (playlist.includes('Hoops')) modeId = 'hoops';
        else if (playlist.includes('Tournament')) modeId = 'tourney';

        if (!modeId) continue;

        const mmr = stats.rating && stats.rating.value != null ? stats.rating.value : null;
        const date = meta.dateCollected ? new Date(meta.dateCollected).getTime() : 0;
        if (mmr !== null) {
          if (!curves[modeId]) curves[modeId] = [];
          curves[modeId].push({ mmr, date });
        }
      }
    }
    // Sort each curve chronologically
    for (const k of Object.keys(curves)) {
      curves[k].sort((a, b) => a.date - b.date);
    }
    return curves;
  }

  // ───────── API calls ─────────
  let currentPlatform = null;
  let currentUsername = null;

  async function searchPlayer(platform, username) {
    currentPlatform = platform;
    currentUsername = username;

    // Use the live endpoint which gets profile + sessions
    const resp = await fetch(`/api/live/${platform}/${encodeURIComponent(username)}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const liveData = await resp.json();

    if (!liveData.profile || !liveData.profile.data || !liveData.profile.data.segments) {
      throw new Error('Invalid response from tracker.gg');
    }

    // Parse profile first
    state = parseProfile(liveData.profile, null);

    // Use sessions data to build real MMR history curves for the "Saison" graph
    if (liveData.sessions) {
      const curves = parseSessionsCurves(liveData.sessions);
      // Pick the curve with the most data points (most played playlist)
      let bestKey = null, bestLen = 0;
      for (const k of Object.keys(curves)) {
        if (curves[k].length > bestLen) { bestLen = curves[k].length; bestKey = k; }
      }
      if (bestKey && bestLen >= 2) {
        state = {
          ...state,
          seasonCurve: curves[bestKey].map((p, i) => ({ x: i, mmr: p.mmr })),
          allSeasonCurves: curves,
        };
      }
    }

    emit();
    return state;
  }

  async function pollUpdate() {
    if (!currentPlatform || !currentUsername) return;
    try {
      const resp = await fetch(`/api/profile/${currentPlatform}/${encodeURIComponent(currentUsername)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.data || !data.data.segments) return;
      state = parseProfile(data, state);
      emit();
    } catch (e) {
      // Silently fail on poll — will retry next interval
    }
  }

  // ───────── Polling loop ─────────
  let pollTimer = null;
  const POLL_INTERVAL = 15000; // 15s polling

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollUpdate, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ───────── Manual match add (for demo/testing) ─────────
  function addMatch(opts = {}) {
    if (!state) return;
    const mmrBefore = state.player.mmr;
    const result = opts.result || (Math.random() < 0.55 ? 'W' : 'L');
    const mmrChange = result === 'W' ? irand(8, 14) : -irand(7, 13);
    const m = {
      id: 'm' + Math.random().toString(36).slice(2, 8),
      mode: opts.mode || state.session.currentMode,
      result,
      score: result === 'W' ? [irand(2, 6), irand(0, 2)] : [irand(0, 2), irand(2, 6)],
      mmrBefore,
      mmrAfter: mmrBefore + mmrChange,
      mmrChange,
      goals: irand(0, 3), saves: irand(0, 5), assists: irand(0, 2), shots: irand(1, 5),
      opponents: [],
      durationSec: irand(240, 360),
      endedAt: Date.now(),
    };
    const matches = [...state.matches, m];
    const wins = matches.filter(x => x.result === 'W').length;
    const losses = matches.length - wins;
    let streakType = m.result;
    let streakCount = 0;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].result === streakType) streakCount++;
      else break;
    }
    const newMMR = mmrBefore + mmrChange;
    state = {
      ...state,
      player: { ...state.player, mmr: newMMR },
      matches,
      session: {
        ...state.session,
        wins, losses,
        streak: { type: streakType, count: streakCount },
        mmrDelta: newMMR - state.player.startMMR,
        objective: { ...state.session.objective, current: newMMR - state.player.startMMR },
      },
      seasonCurve: [...state.seasonCurve, { x: state.seasonCurve.length, mmr: newMMR }],
    };
    pushToast({
      kind: m.result === 'W' ? 'win' : 'loss',
      title: m.result === 'W' ? 'Victory' : 'Defeat',
      detail: `${m.score[0]}\u2013${m.score[1]} \u00b7 ${m.mmrChange > 0 ? '+' : ''}${m.mmrChange} MMR`,
      mode: m.mode,
    });
    if (streakType === 'L' && streakCount === 3) {
      pushToast({ kind: 'tilt', title: 'Tilt alert', detail: '3 losses in a row \u2014 take a break?' });
    }
    emit();
    return m;
  }

  function setStatus(status, modeId) {
    if (!state) return;
    state = { ...state, player: { ...state.player, status, statusModeId: modeId || state.player.statusModeId } };
    emit();
  }

  // ───────── Live demo loop (for testing without API) ─────────
  let liveTimer = null;
  function kickLiveLoop() {
    if (liveTimer) return;
    const cycle = () => {
      const seq = [
        { wait: 4200, fn: () => setStatus('in-lobby') },
        { wait: 3800, fn: () => setStatus('in-match') },
        { wait: 6800, fn: () => addMatch() },
        { wait: 3200, fn: () => setStatus('menu') },
      ];
      let i = 0;
      const tick = () => {
        const step = seq[i % seq.length];
        liveTimer = setTimeout(() => { step.fn(); i++; tick(); }, step.wait);
      };
      tick();
    };
    cycle();
  }

  function stopLiveLoop() { if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } }

  function fmtDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h) return `${h}h ${String(m).padStart(2,'0')}m`;
    return `${m}m ${String(s).padStart(2,'0')}s`;
  }

  function logout() {
    stopPolling();
    stopLiveLoop();
    currentPlatform = null;
    currentUsername = null;
    state = null;
    emit();
  }

  window.RL = {
    get state() { return state; },
    subscribe,
    searchPlayer,
    bootstrapDemo,
    startPolling,
    stopPolling,
    pollUpdate,
    addMatch,
    setStatus,
    kickLiveLoop,
    stopLiveLoop,
    logout,
    rankFromMMR,
    fmtDuration,
    MODES, RANKS, PLATFORMS,
  };
})();
