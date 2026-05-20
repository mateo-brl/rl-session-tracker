// data.js — Real data layer for the RL tracker.
// Fetches from our backend proxy (/api/*) which hits tracker.gg.
// All match data is real: it comes from tracker.gg's sessions API
// (goals/saves/assists/shots/MVPs/MMR delta per match). Nothing is invented.
// Exposes: window.RL = { state, subscribe, searchPlayer, startPolling, ... }

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
    // Approximate RL rank tiers by MMR — only used for the fallback badge.
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

  function modeIdForPlaylist(pl) {
    const pid = pl && pl.attributes ? pl.attributes.playlistId : null;
    if (pid !== null && pid !== undefined) {
      const byId = MODES.find(m => String(m.playlistId) === String(pid));
      if (byId) return byId.id;
    }
    return modeIdFromName(pl && pl.metadata ? pl.metadata.name : '');
  }

  // ───────── Parse the sessions API into real matches ─────────
  // Each session match carries real per-match stats. We never invent these.
  // Returns { byMode, all, current, currentStart }:
  //  - all      : every match we got, oldest→newest
  //  - byMode   : all matches grouped by mode id
  //  - current  : matches of the most recent play session (oldest→newest)
  //  - currentStart : timestamp of the first match of that session
  const STALE_SESSION_MS = 3 * 60 * 60 * 1000; // a 3h+ gap = a new session

  function sessionMatchFromRaw(m) {
    const meta = m.metadata || {};
    const st = m.stats || {};
    // tracker.gg's sessions feed mixes real matches with per-mode and
    // session rollup rows (result like " wins" / "246 wins", playlist
    // "Multiple"). Only an explicit victory/defeat row is a real match.
    const result = meta.result;
    if (result !== 'victory' && result !== 'defeat') return null;
    const modeId = modeIdFromName(meta.playlist || '');
    if (!modeId) return null;
    const num = (k) => (st[k] && st[k].value != null ? st[k].value : 0);
    const rating = st.rating || {};
    const rmeta = rating.metadata || {};
    return {
      id: m.id || 'm' + Math.random().toString(36).slice(2, 9),
      mode: modeId,
      result: result === 'victory' ? 'W' : 'L',
      goals: num('goals'),
      saves: num('saves'),
      assists: num('assists'),
      shots: num('shots'),
      mvps: num('mvps'),
      mmrChange: rmeta.ratingDelta != null ? rmeta.ratingDelta : 0,
      mmrAfter: rating.value != null ? rating.value : 0,
      endedAt: meta.dateCollected ? Date.parse(meta.dateCollected) : 0,
    };
  }

  function parseSessions(sessionsData) {
    const out = { byMode: {}, all: [], current: [], currentStart: null };
    if (!sessionsData || !sessionsData.data || !Array.isArray(sessionsData.data.items)) return out;
    const items = sessionsData.data.items;

    // Flatten every match across every session.
    for (const it of items) {
      for (const raw of (it.matches || [])) {
        const m = sessionMatchFromRaw(raw);
        if (m) out.all.push(m);
      }
    }
    out.all.sort((a, b) => a.endedAt - b.endedAt);
    for (const m of out.all) (out.byMode[m.mode] = out.byMode[m.mode] || []).push(m);

    // Current session = the session item with the most recent match, but only
    // if that match is recent enough to still count as "now".
    let best = null, bestDate = -1;
    for (const it of items) {
      for (const raw of (it.matches || [])) {
        const d = raw.metadata && raw.metadata.dateCollected
          ? Date.parse(raw.metadata.dateCollected) : 0;
        if (d > bestDate) { bestDate = d; best = it; }
      }
    }
    if (best && bestDate > 0 && (Date.now() - bestDate) < STALE_SESSION_MS) {
      out.current = (best.matches || []).map(sessionMatchFromRaw).filter(Boolean)
        .sort((a, b) => a.endedAt - b.endedAt);
      if (out.current.length) out.currentStart = out.current[0].endedAt;
    }
    return out;
  }

  // ───────── Active-playlist selection ─────────
  const EMPTY_PLAYLIST = {
    id: '2v2', label: '2v2 Doubles', playlistId: 11,
    mmr: 0, rank: 'Unranked', rankIcon: null, division: '', divNum: 0,
    played: 0, wins: null, losses: null, ranked: false, isCasual: false,
    startMMR: 0, peakMMR: 0, seasonPeak: 0, curve: [0],
    matches: [], sessionWins: 0, sessionLosses: 0,
  };

  function pickActive(playlists, selectedId) {
    if (!playlists || !playlists.length) return null;
    if (selectedId && selectedId !== 'auto') {
      const found = playlists.find(p => p.id === selectedId);
      if (found) return found;
    }
    // auto: most-played playlist with a real competitive rank; MMR breaks ties.
    const pool = playlists.filter(p => p.ranked);
    const list = pool.length ? pool : playlists;
    let best = null;
    for (const p of list) {
      if (!best || p.played > best.played ||
         (p.played === best.played && p.mmr > best.mmr)) best = p;
    }
    return best;
  }

  // ───────── Derive the flat dashboard state from parsed playlists ─────────
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
        seasonPeak: active.seasonPeak,
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

  // ───────── Build full state from a profile + sessions payload ─────────
  function buildState(profileData, sessionsData, prevState) {
    const d = profileData.data || {};
    const platformInfo = d.platformInfo || {};
    const segments = d.segments || [];
    const overview = segments.find(s => s.type === 'overview');
    const overviewStats = overview ? overview.stats : {};
    const rawPlaylists = segments.filter(s => s.type === 'playlist');

    const parsed = parseSessions(sessionsData);
    // Session window = the current real play session from tracker.gg.
    const sessionStart = parsed.currentStart
      || (prevState ? prevState.session.startedAt : Date.now());

    // Track which matches we already knew, to toast only genuinely new ones.
    const prevIds = new Set();
    if (prevState && prevState.playlists) {
      for (const p of prevState.playlists) for (const m of p.matches) prevIds.add(m.id);
    }
    const newMatches = [];

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
      const seasonPeak = stats.peakRating && stats.peakRating.value != null
        ? stats.peakRating.value : mmr;
      const isCasual = modeId === 'casual';
      const ranked = !isCasual && (modeDef ? modeDef.ranked : true) && rankName !== 'Unranked';

      // Real session matches for this mode.
      const matches = parsed.current.filter(m => m.mode === modeId);
      for (const m of matches) if (!prevIds.has(m.id)) newMatches.push(m);

      const startMMR = matches.length
        ? (matches[0].mmrAfter - matches[0].mmrChange) : mmr;
      let peakMMR = Math.max(mmr, startMMR);
      let sessionWins = 0, sessionLosses = 0;
      for (const m of matches) {
        peakMMR = Math.max(peakMMR, m.mmrAfter);
        if (m.result === 'W') sessionWins++; else sessionLosses++;
      }
      const curve = [startMMR, ...matches.map(m => m.mmrAfter)];

      playlists.push({
        id: modeId,
        label: modeDef ? modeDef.label : modeId,
        playlistId: modeDef ? modeDef.playlistId : null,
        mmr, rank: rankName, rankIcon, division, divNum,
        played, wins: null, losses: null, ranked, isCasual,
        startMMR, peakMMR, seasonPeak, curve,
        matches, sessionWins, sessionLosses,
      });
    }

    // Per-game averages — tracker.gg's overview holds lifetime totals; the
    // game count is estimated from wins (this matches tracker.gg's own site).
    const ov = overviewStats;
    const num = (k) => (ov[k] && ov[k].value != null ? ov[k].value : 0);
    const totalGoals = num('goals'), totalAssists = num('assists'),
          totalSaves = num('saves'), totalShots = num('shots'), totalWins = num('wins');
    const gamesForAvg = Math.max(1, totalWins > 0 ? totalWins * 2 : 1);
    const seasonAvg = {
      goalsPerGame: totalGoals / gamesForAvg,
      savesPerGame: totalSaves / gamesForAvg,
      assistsPerGame: totalAssists / gamesForAvg,
      shotsPerGame: totalShots / gamesForAvg,
    };

    // Recent win rate — computed from the real matches tracker.gg returned.
    const recentGames = parsed.all.length;
    const recentWins = parsed.all.filter(m => m.result === 'W').length;
    const seasonPlayed = playlists.reduce((s, p) => s + (p.played || 0), 0);
    const seasonStats = {
      played: seasonPlayed,
      recentGames,
      winRate: recentGames ? recentWins / recentGames : null,
    };

    // Real season MMR history per mode, from every match we have.
    const allSeasonCurves = {};
    for (const k of Object.keys(parsed.byMode)) {
      allSeasonCurves[k] = parsed.byMode[k].map(m => ({ mmr: m.mmrAfter, date: m.endedAt }));
    }

    const modeStats = playlists.map(p => ({
      id: p.id, played: p.played,
      wins: null, losses: null,
      mmr: p.mmr, rank: p.rank + (p.division ? ' ' + p.division : ''),
    }));

    const next = composeState({
      playlists, allSeasonCurves, seasonAvg, seasonStats, modeStats,
      platformInfo, sessionStart,
      toasts: prevState ? prevState.toasts : [],
      selectedId: selectedPlaylistId,
      lastPolledAt: Date.now(),
    });

    // Toast newly-finished matches (never on the very first load).
    if (prevState) {
      for (const ev of newMatches) {
        setTimeout(() => {
          pushToast({
            kind: ev.result === 'W' ? 'win' : 'loss',
            title: ev.result === 'W' ? 'Victory' : 'Defeat',
            detail: `${ev.mmrChange > 0 ? '+' : ''}${ev.mmrChange} MMR`,
            mode: ev.mode,
          });
        }, 100);
      }
      if (newMatches.length && next.session.streak.type === 'L' && next.session.streak.count === 3) {
        setTimeout(() => {
          pushToast({ kind: 'tilt', title: 'Tilt alert', detail: '3 losses in a row — take a break?' });
        }, 200);
      }
    }

    return next;
  }

  // ───────── Demo mode — clearly-labelled mock session ─────────
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
      matches.push({
        id: 'm' + Math.random().toString(36).slice(2,8),
        mode: modePool[i], result,
        mmrChange, mmrAfter: mmr + mmrChange,
        goals, saves, assists, shots, mvps: result === 'W' ? irand(0,1) : 0,
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
      player: { tag: tag || 'nyx.04', platform: 'PC', status: 'in-match', statusModeId: '2v2', mmr, peakMMR: 1342, seasonPeak: 1342, startMMR, rank: rankFromMMR(mmr).name },
      session: { startedAt: Date.now() - 52*60000, wins, losses, streak: { type: streakType, count: streakCount }, mmrDelta: mmr - startMMR, currentMode: '2v2', objective: { type:'mmr', target:30, current: mmr-startMMR } },
      matches, seasonCurve,
      seasonAvg: { goalsPerGame:1.6, savesPerGame:2.4, assistsPerGame:0.8, shotsPerGame:3.7 },
      seasonStats: { played:487, winRate:0.54, recentGames: matches.length },
      modeStats: [{ id:'2v2',played:312,wins:178,losses:134 },{ id:'3v3',played:124,wins:62,losses:62 },{ id:'1v1',played:38,wins:17,losses:21 },{ id:'rumble',played:13,wins:6,losses:7 }],
      lastPolledAt: Date.now(),
      toasts: [],
    };
    emit();
    return state;
  }

  // ───────── API calls ─────────
  let currentPlatform = null;
  let currentUsername = null;

  function isValidProfile(p) {
    return p && p.data && Array.isArray(p.data.segments);
  }

  async function searchPlayer(platform, username) {
    currentPlatform = platform;
    currentUsername = username;
    selectedPlaylistId = 'auto';

    const resp = await fetch(`/api/live/${platform}/${encodeURIComponent(username)}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const e = new Error(err.error || `HTTP ${resp.status}`);
      e.status = resp.status;
      throw e;
    }
    const liveData = await resp.json();
    if (!isValidProfile(liveData.profile)) {
      throw new Error('Invalid response from tracker.gg');
    }
    state = buildState(liveData.profile, liveData.sessions, null);
    emit();
    return state;
  }

  async function pollUpdate() {
    if (!currentPlatform || !currentUsername) return;
    try {
      const resp = await fetch(`/api/live/${currentPlatform}/${encodeURIComponent(currentUsername)}`);
      if (!resp.ok) return;
      const liveData = await resp.json();
      if (!isValidProfile(liveData.profile)) return;
      state = buildState(liveData.profile, liveData.sessions, state);
      emit();
    } catch (e) {
      // Silently fail on poll — will retry next interval.
    }
  }

  // ───────── Choose which playlist drives the headline ─────────
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

  // ───────── Demo-only helpers ─────────
  function addMatch(opts = {}) {
    if (!state) return;
    const mmrBefore = state.player.mmr;
    const result = opts.result || (Math.random() < 0.55 ? 'W' : 'L');
    const mmrChange = result === 'W' ? irand(8, 14) : -irand(7, 13);
    const m = {
      id: 'm' + Math.random().toString(36).slice(2, 8),
      mode: opts.mode || state.session.currentMode,
      result,
      mmrChange, mmrAfter: mmrBefore + mmrChange,
      goals: irand(0, 3), saves: irand(0, 5), assists: irand(0, 2), shots: irand(1, 5),
      mvps: result === 'W' ? irand(0, 1) : 0,
      endedAt: Date.now(),
    };
    const matches = [...state.matches, m];
    const wins = matches.filter(x => x.result === 'W').length;
    const losses = matches.length - wins;
    let streakType = m.result, streakCount = 0;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].result === streakType) streakCount++; else break;
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
      detail: `${m.mmrChange > 0 ? '+' : ''}${m.mmrChange} MMR`,
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

  let liveTimer = null;
  function kickLiveLoop() {
    if (liveTimer) return;
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
