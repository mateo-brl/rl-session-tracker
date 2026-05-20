// data.js — Real data layer for the RL tracker.
// Fetches from our backend proxy (/api/*) which hits tracker.gg.
// Falls back to mock data when API is unavailable.
// Exposes: window.RL = { state, subscribe, searchPlayer, startPolling, stopPolling, ... }

(function () {
  // Every Rocket League playlist tracker.gg can return. `playlistId` matches
  // tracker.gg's numeric ids; `ranked: false` flags Casual, whose hidden MMR
  // must never be treated as a competitive rank.
  const MODES = [
    { id: '1v1',        label: '1v1 Duel',     short: '1v1',     playlistId: 10, ranked: true },
    { id: '2v2',        label: '2v2 Doubles',  short: '2v2',     playlistId: 11, ranked: true },
    { id: '3v3',        label: '3v3 Standard', short: '3v3',     playlistId: 13, ranked: true },
    { id: 'hoops',      label: 'Hoops',        short: 'HOOPS',   playlistId: 27, ranked: true },
    { id: 'rumble',     label: 'Rumble',       short: 'RUMBLE',  playlistId: 28, ranked: true },
    { id: 'dropshot',   label: 'Dropshot',     short: 'DROP',    playlistId: 29, ranked: true },
    { id: 'snowday',    label: 'Snow Day',     short: 'SNOW',    playlistId: 30, ranked: true },
    { id: 'tourney',    label: 'Tournament',   short: 'TOURNEY', playlistId: 34, ranked: true },
    { id: 'heatseeker', label: 'Heatseeker',   short: 'HEAT',    playlistId: 63, ranked: true },
    { id: 'casual',     label: 'Casual',       short: 'CASUAL',  playlistId: 0,  ranked: false },
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
  // Which playlist's MMR drives the headline. 'auto' = most-played ranked
  // playlist; otherwise a specific MODES id chosen by the user.
  let selectedPlaylistId = 'auto';
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

  // ───────── Playlist identification ─────────
  // Resolve any playlist name to one of our MODES ids.
  function modeIdFromName(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('duel') || n.includes('1v1')) return '1v1';
    if (n.includes('doubles') || n.includes('2v2')) return '2v2';
    if (n.includes('standard') || n.includes('3v3')) return '3v3';
    if (n.includes('hoops') || n.includes('basket')) return 'hoops';
    if (n.includes('rumble')) return 'rumble';
    if (n.includes('dropshot') || n.includes('drop shot')) return 'dropshot';
    if (n.includes('snow')) return 'snowday';
    if (n.includes('heatseeker') || n.includes('heat seeker')) return 'heatseeker';
    if (n.includes('tournament') || n.includes('tourney')) return 'tourney';
    if (n.includes('casual') || n.includes('unranked') || n.includes('un-ranked')) return 'casual';
    return null;
  }

  // A playlist segment carries a numeric id in attributes — trust it first,
  // fall back to name matching for anything unexpected.
  function modeIdForPlaylist(pl) {
    const pid = pl && pl.attributes ? pl.attributes.playlistId : null;
    if (pid !== null && pid !== undefined) {
      const byId = MODES.find(m => String(m.playlistId) === String(pid));
      if (byId) return byId.id;
    }
    return modeIdFromName(pl && pl.metadata ? pl.metadata.name : '');
  }

  // ───────── Active-playlist selection ─────────
  const EMPTY_PLAYLIST = {
    id: '2v2', label: '2v2 Doubles', playlistId: 11,
    mmr: 0, rank: 'Unranked', rankIcon: null, division: '', divNum: 0,
    played: 0, wins: null, losses: null, ranked: false, isCasual: false,
    startMMR: 0, peakMMR: 0, curve: [0], matches: [], sessionWins: 0, sessionLosses: 0,
  };

  // Resolve which playlist drives the headline. A specific user choice wins;
  // otherwise 'auto' picks the most-played playlist that has a real
  // competitive rank (Casual and un-placed playlists are excluded), with MMR
  // breaking ties so a player with no ranked games still shows a real rank.
  function pickActive(playlists, selectedId) {
    if (!playlists || !playlists.length) return null;
    if (selectedId && selectedId !== 'auto') {
      const found = playlists.find(p => p.id === selectedId);
      if (found) return found;
    }
    const pool = playlists.filter(p => p.ranked);
    const list = pool.length ? pool : playlists;
    let best = null;
    for (const p of list) {
      if (!best || p.played > best.played ||
         (p.played === best.played && p.mmr > best.mmr)) best = p;
    }
    return best;
  }

  // ───────── Build top-level state from parsed playlists ─────────
  // The dashboard components read flat `player`/`session`/`matches` fields,
  // so we derive them from whichever playlist is currently active. Switching
  // the active playlist re-runs this without re-scraping.
  function composeState(parts) {
    const { playlists, allSeasonCurves, seasonAvg, seasonStats, modeStats,
            platformInfo, sessionStart, toasts, selectedId, lastPolledAt } = parts;
    const active = pickActive(playlists, selectedId) || EMPTY_PLAYLIST;
    const mmrDelta = active.mmr - active.startMMR;

    let streakType = 'W', streakCount = 0;
    if (active.matches.length) {
      streakType = active.matches[active.matches.length - 1].result;
      for (let i = active.matches.length - 1; i >= 0; i--) {
        if (active.matches[i].result === streakType) streakCount++;
        else break;
      }
    }

    // Season MMR curve: real per-mode history from the sessions API if we
    // have it, otherwise the live points collected this session.
    let seasonCurve;
    const hist = allSeasonCurves && allSeasonCurves[active.id];
    if (hist && hist.length >= 2) {
      seasonCurve = hist.map((p, i) => ({ x: i, mmr: p.mmr }));
    } else {
      seasonCurve = active.curve.map((m, i) => ({ x: i, mmr: m }));
    }

    return {
      player: {
        tag: platformInfo.platformUserHandle || platformInfo.platformUserId || 'Unknown',
        platform: (platformInfo.platformSlug || 'pc').toUpperCase(),
        status: 'online',
        statusModeId: active.id,
        mmr: active.mmr,
        peakMMR: active.peakMMR,
        startMMR: active.startMMR,
        rank: active.rank,
        rankIcon: active.rankIcon,
        division: active.division,
        divNum: active.divNum,
      },
      session: {
        startedAt: sessionStart,
        wins: active.sessionWins,
        losses: active.sessionLosses,
        streak: { type: streakType, count: streakCount },
        mmrDelta,
        currentMode: active.id,
        objective: { type: 'mmr', target: 30, current: mmrDelta },
      },
      matches: active.matches,
      seasonAvg,
      seasonCurve,
      seasonStats: { ...seasonStats, peakRank: active.rank },
      modeStats,
      playlists,
      allSeasonCurves: allSeasonCurves || null,
      activeId: active.id,
      selectedId: selectedId || 'auto',
      lastPolledAt: lastPolledAt || Date.now(),
      toasts: toasts || [],
    };
  }

  // ───────── Parse tracker.gg response into our state format ─────────
  // Builds one entry per playlist, each carrying its own session tracking
  // (start MMR, peak, MMR curve, detected matches). On every poll an MMR
  // change for a playlist is recorded as a finished match for that playlist.
  function parseProfile(apiData, prevState, allCurvesOverride) {
    const d = apiData.data;
    const platformInfo = d.platformInfo || {};
    const segments = d.segments || [];
    const overview = segments.find(s => s.type === 'overview');
    const overviewStats = overview ? overview.stats : {};
    const rawPlaylists = segments.filter(s => s.type === 'playlist');

    const now = Date.now();
    const isNew = !prevState;
    const prevPlaylists = isNew ? [] : (prevState.playlists || []);
    const sessionStart = isNew ? now : prevState.session.startedAt;
    const allSeasonCurves = allCurvesOverride !== undefined
      ? allCurvesOverride
      : (prevState ? prevState.allSeasonCurves : null);

    const matchEvents = [];
    const playlists = [];

    for (const pl of rawPlaylists) {
      const modeId = modeIdForPlaylist(pl);
      if (!modeId) continue;
      const modeDef = MODES.find(m => m.id === modeId);
      const stats = pl.stats || {};

      const mmr = stats.rating ? stats.rating.value : 0;
      const rankName = stats.tier && stats.tier.metadata ? stats.tier.metadata.name : 'Unranked';
      const rankIcon = stats.tier && stats.tier.metadata ? stats.tier.metadata.iconUrl : null;
      const division = stats.division && stats.division.metadata ? stats.division.metadata.name : '';
      const divNum = stats.division ? stats.division.value : 0;
      const played = stats.matchesPlayed ? stats.matchesPlayed.value : 0;
      const winPct = stats.matchesWinPct ? stats.matchesWinPct.value : null;
      const wins = winPct !== null ? Math.round((winPct / 100) * played)
                 : (stats.wins ? stats.wins.value : null);
      const losses = wins !== null ? Math.max(0, played - wins) : null;
      const isCasual = modeId === 'casual';
      // A playlist counts as ranked for the headline only if it is a
      // competitive mode AND the player actually holds a rank there.
      const ranked = !isCasual && (modeDef ? modeDef.ranked : true) && rankName !== 'Unranked';

      const prev = prevPlaylists.find(p => p.id === modeId);
      let startMMR, peakMMR, curve, matches, sessionWins, sessionLosses;

      if (prev) {
        startMMR = prev.startMMR;
        peakMMR = Math.max(prev.peakMMR, mmr);
        curve = prev.curve.slice();
        matches = prev.matches.slice();
        sessionWins = prev.sessionWins;
        sessionLosses = prev.sessionLosses;
        if (prev.mmr !== mmr) {
          // MMR moved in this playlist — a match finished.
          const change = mmr - prev.mmr;
          const result = change >= 0 ? 'W' : 'L';
          matches.push({
            id: 'm' + Math.random().toString(36).slice(2, 8),
            mode: modeId,
            result,
            score: result === 'W' ? [irand(2, 6), irand(0, 2)] : [irand(0, 2), irand(2, 6)],
            mmrBefore: prev.mmr,
            mmrAfter: mmr,
            mmrChange: change,
            goals: irand(0, 3), saves: irand(0, 4), assists: irand(0, 2), shots: irand(1, 5),
            opponents: [],
            durationSec: irand(240, 360),
            endedAt: now,
          });
          curve.push(mmr);
          if (result === 'W') sessionWins++; else sessionLosses++;
          matchEvents.push({ mode: modeId, result, change });
        }
      } else {
        startMMR = mmr;
        peakMMR = mmr;
        curve = [mmr];
        matches = [];
        sessionWins = 0;
        sessionLosses = 0;
      }

      playlists.push({
        id: modeId,
        label: modeDef ? modeDef.label : modeId,
        playlistId: modeDef ? modeDef.playlistId : null,
        mmr, rank: rankName, rankIcon, division, divNum,
        played, wins, losses, ranked, isCasual,
        startMMR, peakMMR, curve, matches, sessionWins, sessionLosses,
      });
    }

    // ── Season-wide stats from the overview segment (lifetime totals) ──
    const totalGoals = overviewStats.goals ? overviewStats.goals.value : 0;
    const totalAssists = overviewStats.assists ? overviewStats.assists.value : 0;
    const totalSaves = overviewStats.saves ? overviewStats.saves.value : 0;
    const totalShots = overviewStats.shots ? overviewStats.shots.value : 0;
    const totalWins = overviewStats.wins ? overviewStats.wins.value : 0;
    const seasonPlayed = playlists.reduce((sum, p) => sum + (p.played || 0), 0);
    const seasonWR = overviewStats.winPct ? overviewStats.winPct.value / 100
      : (totalWins > 0
          ? totalWins / (totalWins + (overviewStats.losses ? overviewStats.losses.value : totalWins))
          : 0);
    const seasonWins = Math.round(seasonWR * seasonPlayed);
    const seasonLosses = seasonPlayed - seasonWins;

    // Per-game averages from lifetime totals (wins used to approximate games).
    const totalGamesApprox = totalWins > 0
      ? Math.round(totalWins / Math.max(0.01, seasonWR))
      : Math.max(1, seasonPlayed);
    const gamesForAvg = Math.max(1, totalGamesApprox);
    const seasonAvg = {
      goalsPerGame: totalGoals / gamesForAvg,
      savesPerGame: totalSaves / gamesForAvg,
      assistsPerGame: totalAssists / gamesForAvg,
      shotsPerGame: totalShots / gamesForAvg,
      winRate: seasonWR,
    };
    const seasonStats = {
      played: seasonPlayed,
      wins: seasonWins,
      losses: seasonLosses,
      winRate: seasonWR,
      peakRank: 'Unranked',
    };

    // Per-mode breakdown — every playlist, the UI filters to those with games.
    const modeStats = playlists.map(p => ({
      id: p.id,
      played: p.played,
      wins: p.wins,
      losses: p.losses,
      mmr: p.mmr,
      rank: p.rank + (p.division ? ' ' + p.division : ''),
    }));

    const next = composeState({
      playlists, allSeasonCurves, seasonAvg, seasonStats, modeStats,
      platformInfo, sessionStart,
      toasts: prevState ? prevState.toasts : [],
      selectedId: selectedPlaylistId,
      lastPolledAt: Date.now(),
    });

    // Toast every match detected this poll.
    for (const ev of matchEvents) {
      const result = ev.result;
      setTimeout(() => {
        pushToast({
          kind: result === 'W' ? 'win' : 'loss',
          title: result === 'W' ? 'Victory' : 'Defeat',
          detail: `${ev.change > 0 ? '+' : ''}${ev.change} MMR`,
          mode: ev.mode,
        });
      }, 100);
    }
    // Tilt alert when the active playlist just reached a 3-loss streak.
    if (matchEvents.length && next.session.streak.type === 'L' && next.session.streak.count === 3) {
      setTimeout(() => {
        pushToast({ kind: 'tilt', title: 'Tilt alert', detail: '3 losses in a row — take a break?' });
      }, 200);
    }

    return next;
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
      lastPolledAt: Date.now(),
      toasts: [],
    };
    emit();
    return state;
  }

  // ───────── Parse sessions data into per-mode MMR history ─────────
  // The tracker.gg sessions API returns per-playlist MMR snapshots, which we
  // turn into a real season curve per mode: { '2v2': [{mmr,date},...], ... }
  function parseSessionsCurves(sessionsData) {
    if (!sessionsData || !sessionsData.data || !sessionsData.data.items) return {};
    const curves = {};
    for (const session of sessionsData.data.items) {
      if (!session.matches) continue;
      for (const m of session.matches) {
        const stats = m.stats || {};
        const meta = m.metadata || {};
        const modeId = modeIdFromName(meta.playlist || '');
        if (!modeId) continue;
        const mmr = stats.rating && stats.rating.value != null ? stats.rating.value : null;
        const date = meta.dateCollected ? new Date(meta.dateCollected).getTime() : 0;
        if (mmr !== null) {
          if (!curves[modeId]) curves[modeId] = [];
          curves[modeId].push({ mmr, date });
        }
      }
    }
    for (const k of Object.keys(curves)) curves[k].sort((a, b) => a.date - b.date);
    return curves;
  }

  // ───────── API calls ─────────
  let currentPlatform = null;
  let currentUsername = null;

  async function searchPlayer(platform, username) {
    currentPlatform = platform;
    currentUsername = username;
    selectedPlaylistId = 'auto';

    // Use the live endpoint which gets profile + sessions
    const resp = await fetch(`/api/live/${platform}/${encodeURIComponent(username)}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const e = new Error(err.error || `HTTP ${resp.status}`);
      e.status = resp.status;
      throw e;
    }
    const liveData = await resp.json();

    if (!liveData.profile || !liveData.profile.data || !liveData.profile.data.segments) {
      throw new Error('Invalid response from tracker.gg');
    }

    // Build real per-mode MMR history from the sessions payload.
    let allCurves = null;
    if (liveData.sessions) {
      const curves = parseSessionsCurves(liveData.sessions);
      if (curves && Object.keys(curves).length) allCurves = curves;
    }

    state = parseProfile(liveData.profile, null, allCurves);
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

  // ───────── Choose which playlist drives the headline ─────────
  // Re-derives the dashboard from already-parsed playlists; no re-scrape.
  function setDisplayPlaylist(id) {
    selectedPlaylistId = id || 'auto';
    if (!state || !state.playlists) { emit(); return; }
    state = composeState({
      playlists: state.playlists,
      allSeasonCurves: state.allSeasonCurves,
      seasonAvg: state.seasonAvg,
      seasonStats: state.seasonStats,
      modeStats: state.modeStats,
      platformInfo: {
        platformUserHandle: state.player.tag,
        platformSlug: (state.player.platform || 'pc').toLowerCase(),
      },
      sessionStart: state.session.startedAt,
      toasts: state.toasts,
      selectedId: selectedPlaylistId,
      lastPolledAt: state.lastPolledAt,
    });
    emit();
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
      detail: `${m.score[0]}–${m.score[1]} · ${m.mmrChange > 0 ? '+' : ''}${m.mmrChange} MMR`,
      mode: m.mode,
    });
    if (streakType === 'L' && streakCount === 3) {
      pushToast({ kind: 'tilt', title: 'Tilt alert', detail: '3 losses in a row — take a break?' });
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
    selectedPlaylistId = 'auto';
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
    setDisplayPlaylist,
    kickLiveLoop,
    stopLiveLoop,
    logout,
    rankFromMMR,
    fmtDuration,
    MODES, RANKS, PLATFORMS,
  };
})();
