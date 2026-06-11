// index.js — Processus principal de RL Session Tracker.
//
// L'application est 100 % locale : pas de serveur, pas de compte. Elle :
//  • démarre avec Windows et vit dans la barre des tâches ;
//  • surveille Rocket League (processus + Stats API du jeu) ;
//  • ouvre automatiquement le dashboard en plein écran sur le 2ᵉ écran
//    quand le jeu se lance, et le ferme quand le jeu se ferme ;
//  • enregistre chaque match (victoires/défaites, série, stats par mode) ;
//  • se met à jour toute seule depuis les releases GitHub (sur accord).

const { app, Tray, Menu, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const windows = require('./windows');
const updater = require('./updater');
const discord = require('./discord-rpc');
const obs = require('./obs-server');
const SessionStore = require('./session');
const GameWatcher = require('./game-watcher');
const RLStatsAPI = require('./statsapi');
const { enableStatsApi } = require('./enable-statsapi');

const SILENT = process.argv.includes('--silent');   // lancé par le démarrage auto
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');
const LOG_FILE = path.join(app.getPath('userData'), 'app.log');

// ───────── Journal fichier (l'application n'a pas de console) ─────────
function log(msg) {
  try {
    let flag = 'a';
    try { if (fs.statSync(LOG_FILE).size > 262144) flag = 'w'; } catch (e) {}
    fs.writeFileSync(LOG_FILE,
      '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: flag });
  } catch (e) {}
}
process.on('uncaughtException', (e) => log('uncaughtException : ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection : ' + (e && (e.message || e))));

// ───────── État partagé, poussé aux fenêtres ─────────
let store = null;
let tray = null;

const state = {
  version: app.getVersion(),
  firstRun: false,
  lang: 'fr',            // langue résolue (réglage, sinon langue du système)
  config: null,
  autostart: false,
  game: { processRunning: false, statsConnected: false, running: false },
  live: null,            // match en cours (snapshot Stats API), ou null
  currentRanked: null,   // le match en cours est-il classé ? (null = pas de match)
  session: null,         // agrégats de session
  history: [],
  playersSeen: [],
  pseudoCandidates: [],  // si le pseudo n'a pas pu être deviné tout seul
  evolution: {},         // courbes MMR par mode calibré
  week: null,            // bilan des 7 derniers jours
  records: null,         // records de tous les temps
  h2h: null,             // « déjà croisé » : bilan contre les adversaires du match en cours
  obs: { running: false, port: 0, error: null },   // serveur overlay OBS
  update: updater.getState(),
};

// ── Mode streamer : extrait de l'état envoyé à la page overlay OBS ──
function obsState() {
  return {
    lang: state.lang,
    theme: config.get().theme,
    obsCfg: config.get().obs,    // style, échelle, contenu — appliqués en direct
    game: state.game.running,
    live: state.live,
    currentRanked: state.currentRanked,
    session: state.session,
    h2h: state.h2h,
  };
}

function applyObsConfig() {
  const o = config.get().obs || {};
  if (o.enabled) {
    obs.start(o.port, log, (st) => { state.obs = st; pushState(); });
  } else if (obs.running()) {
    obs.stop();
  }
}

// ── Head-to-head : recalculé uniquement quand la liste d'adversaires change ──
let h2hKey = '';
function refreshH2h() {
  const live = state.live;
  const pseudo = (config.get().pseudo || '').trim().toLowerCase();
  if (!live || live.training || !pseudo || !Array.isArray(live.players)) {
    state.h2h = null;
    h2hKey = '';
    return;
  }
  const mine = live.players.find((p) => String(p.name).trim().toLowerCase() === pseudo);
  if (!mine) { state.h2h = null; h2hKey = ''; return; }
  const opponents = live.players.filter((p) => p.team !== mine.team).map((p) => p.name);
  const key = opponents.slice().sort().join('|');
  if (key === h2hKey) return;
  h2hKey = key;
  const all = store.headToHead(opponents, config.get().pseudo);
  const seen = {};
  for (const name of Object.keys(all)) {
    if (all[name].played > 0) seen[name] = all[name];
  }
  state.h2h = Object.keys(seen).length ? seen : null;
}

function refreshSession() {
  const snap = store.snapshot(config.get().pseudo, config.get());
  state.session = snap.session;
  state.history = snap.history;
  state.playersSeen = snap.playersSeen;
  state.evolution = snap.evolution;
  state.week = snap.week;
  state.records = snap.records;
}

function resolveLang() {
  const l = config.get().lang;
  if (l === 'fr' || l === 'en') return l;
  try {
    return String(app.getLocale()).toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch (e) { return 'fr'; }
}

function pushState() {
  state.config = config.get();
  state.lang = resolveLang();
  refreshH2h();
  discord.refresh(state);
  windows.broadcast('state', state);
  obs.broadcast(obsState());
}

// ───────── Démarrage automatique avec Windows ─────────
// IMPORTANT : sous Windows, getLoginItemSettings ne reconnaît l'entrée que si
// on lui passe les MÊMES args que ceux donnés à setLoginItemSettings — sans
// ça il répond toujours « désactivé » et la case se décoche toute seule.
const AUTOSTART_ARGS = ['--silent'];
function autostartEnabled() {
  try {
    return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin;
  } catch (e) { return false; }
}
function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: AUTOSTART_ARGS });
    state.autostart = autostartEnabled();
    log('démarrage auto : ' + (on ? 'activé' : 'désactivé'));
  } catch (e) {
    log('démarrage auto échec : ' + e.message);
  }
}

// ───────── Dashboard auto sur le 2ᵉ écran ─────────
function setGameRunning(running) {
  if (state.game.running === running) return;
  state.game.running = running;
  log('Rocket League : ' + (running ? 'détecté' : 'fermé'));
  if (running) {
    if (config.get().autoDashboard) openDashboard();
    if (config.get().overlayEnabled) openOverlay();
    if (alphaEnabled()) openAlphaAudio();
  } else {
    state.live = null;
    state.currentRanked = null;
    windows.closeDashboard();
    windows.closeOverlay();
    windows.closeAlphaAudio();
  }
  pushState();
}

// ───────── Son Alpha Boost ─────────
// Joué par une fenêtre invisible (WebAudio), pilotée par la télémétrie de la
// Stats API. 100 % externe : on ne touche ni aux fichiers ni à la mémoire du
// jeu — même approche que le reste de l'application.
function alphaEnabled() {
  const ab = config.get().alphaBoost;
  return !!(ab && ab.enabled);
}

function sendAlphaCfg() {
  const w = windows.getAlphaAudio();
  if (w) {
    try { w.webContents.send('alpha-cfg', config.get().alphaBoost); } catch (e) {}
  }
}

function openAlphaAudio() {
  windows.openAlphaAudio(() => sendAlphaCfg());
}

function openOverlay() {
  windows.openOverlay(config.get().overlayPos,
    (pos) => config.update({ overlayPos: pos }),
    config.get().overlayCfg);
}

function recomputeRunning() {
  setGameRunning(state.game.processRunning || state.game.statsConnected);
  pushState();
}

function openDashboard() {
  windows.openDashboard(
    { fullscreen: config.get().dashboardFullscreen },
    () => pushState());
}

// ───────── Barre des tâches ─────────
const TRAY_LABELS = {
  fr: { open: 'Ouvrir', dash: 'Ouvrir le dashboard', overlay: 'Mini-overlay',
    update: 'Vérifier les mises à jour', quit: 'Quitter' },
  en: { open: 'Open', dash: 'Open the dashboard', overlay: 'Mini-overlay',
    update: 'Check for updates', quit: 'Quit' },
};

function buildTrayMenu() {
  if (!tray) return;
  const L = TRAY_LABELS[resolveLang()] || TRAY_LABELS.fr;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L.open, click: () => windows.showControl() },
    { label: L.dash, click: () => openDashboard() },
    { label: L.overlay, click: () => {
      if (windows.getOverlay()) {
        config.update({ overlayEnabled: false });
        windows.closeOverlay();
      } else {
        config.update({ overlayEnabled: true });
        openOverlay();
      }
      pushState();
    } },
    { type: 'separator' },
    { label: L.update, click: () => updater.check() },
    { type: 'separator' },
    { label: L.quit, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  try {
    tray = new Tray(ICON);
  } catch (e) {
    log('icône systray indisponible : ' + e.message);
    return;
  }
  tray.setToolTip('RL Session Tracker');
  buildTrayMenu();
  tray.on('click', () => windows.showControl());
  tray.on('double-click', () => windows.showControl());
}

// ───────── Stats API du jeu ─────────
// Entraînement / piste libre : le joueur est seul dans la « partie ». Un vrai
// match a toujours au moins 2 joueurs — en dessous, on affiche « entraînement »
// et on ne compte RIEN (ni buts, ni résultat).
function isTraining(d) {
  return !Array.isArray(d.players) || d.players.length < 2;
}

function startStatsApi() {
  process.env.STATSAPI_PORT = String(config.get().statsApiPort);
  const api = new RLStatsAPI();
  let lastRecordedAt = 0;   // ceinture anti-doublon (fin de match + abandon)

  api.on('connection', (d) => {
    state.game.statsConnected = d.connected;
    recomputeRunning();
  });
  api.on('state', (d) => {
    state.live = d && d.active ? { ...d, training: isTraining(d) } : null;
    // Nouveau match : classé ou casual ? Pré-réglé sur la préférence, et
    // modifiable d'un clic sur le dashboard pendant la partie.
    if (state.live && !state.live.training && state.currentRanked === null) {
      state.currentRanked = config.get().mmrCounts !== false;
    }
    pushState();
  });
  api.on('match', (d) => {
    if (d.phase === 'destroyed') {
      state.live = null;
      state.currentRanked = null;
      pushState();
    }
  });
  // Abandon (forfait, départ en cours de match, déconnexion). En CLASSÉ, le
  // jeu compte une défaite — nous aussi. En casual, quitter est normal : on
  // ignore le match.
  api.on('abandoned', (snap) => {
    state.live = null;
    const ranked = state.currentRanked !== null
      ? state.currentRanked : config.get().mmrCounts !== false;
    state.currentRanked = null;
    if (isTraining(snap) || !ranked) {
      pushState();
      log('abandon casual / entraînement — non compté');
      return;
    }
    // Un match vient d'être enregistré ? Cet « abandon » n'est que la fin
    // d'écran du même match (FF) : on ne compte pas deux défaites.
    if (Date.now() - lastRecordedAt < 45 * 1000) {
      pushState();
      log('abandon ignoré — match déjà enregistré il y a moins de 45 s');
      return;
    }
    lastRecordedAt = Date.now();
    snap.ranked = true;
    store.addMatch(snap);
    refreshSession();
    pushState();
    const last = state.history[0];
    if (last) { windows.broadcast('match-result', last); obs.emit('result', last); }
    log('forfait enregistré : ' + (snap.mode || '?') + ' — compté comme défaite');
  });
  api.on('goal', (d) => {
    if (state.live && state.live.training) return;
    windows.broadcast('goal', d);
    obs.emit('goal', d);
  });
  // Télémétrie boost → moteur audio Alpha Boost (fenêtre invisible).
  api.on('telemetry', (d) => {
    const w = windows.getAlphaAudio();
    if (w) {
      try { w.webContents.send('alpha-telemetry', d); } catch (e) {}
    }
  });
  api.on('ended', (snap) => {
    state.live = null;
    if (isTraining(snap)) {
      state.currentRanked = null;
      pushState();
      log('entraînement terminé — non compté');
      return;
    }
    snap.ranked = state.currentRanked !== null
      ? state.currentRanked : config.get().mmrCounts !== false;
    state.currentRanked = null;
    lastRecordedAt = Date.now();
    store.addMatch(snap);
    // Pseudo pas encore configuré : on le devine (joueur présent dans tous
    // les derniers matchs). Zéro saisie pour l'utilisateur dans le cas normal.
    if (!config.get().pseudo) {
      const d = store.detectPseudo();
      state.pseudoCandidates = d.candidates;
      if (d.auto) {
        config.update({ pseudo: d.auto });
        log('pseudo détecté automatiquement : ' + d.auto);
      }
    } else {
      state.pseudoCandidates = [];
    }
    refreshSession();
    pushState();
    // Animation victoire / défaite sur le dashboard : le match qu'on vient
    // d'enregistrer est le premier de l'historique, déjà évalué (W/L, MVP).
    const last = state.history[0];
    if (last) { windows.broadcast('match-result', last); obs.emit('result', last); }
    log('match enregistré : ' + (snap.mode || '?') + ' '
      + (Array.isArray(snap.score) ? snap.score.join('-') : '?'));
  });
  api.start();
}

// ───────── Premier lancement ─────────
async function firstRunSetup() {
  state.firstRun = true;
  log('premier lancement — activation de la Stats API + démarrage auto');
  config.save();                       // crée config.json (fin du premier lancement)
  setAutostart(true);
  if (process.platform === 'win32') {
    let r;
    try { r = await enableStatsApi(); } catch (e) { r = { ok: false, reason: e.message }; }
    log('Stats API : ' + (r.skipped ? 'ignorée' : r.ok ? 'configurée' : 'échec ' + (r.reason || '')));
  }
}

// ───────── IPC (depuis les fenêtres) ─────────
ipcMain.handle('get-state', () => { state.config = config.get(); return state; });
ipcMain.handle('set-config', (_e, partial) => {
  config.update(partial);
  // Le plein écran s'applique immédiatement si le dashboard est ouvert.
  if (partial && typeof partial.dashboardFullscreen === 'boolean') {
    windows.setDashboardFullscreen(partial.dashboardFullscreen);
  }
  // L'overlay suit son réglage sans attendre le prochain lancement du jeu.
  if (partial && typeof partial.overlayEnabled === 'boolean') {
    if (partial.overlayEnabled && state.game.running) openOverlay();
    else if (!partial.overlayEnabled) windows.closeOverlay();
  }
  if (partial && partial.overlayCfg) {
    windows.applyOverlayCfg(config.get().overlayCfg);
  }
  // Le son Alpha Boost suit son réglage sans redémarrage.
  if (partial && partial.alphaBoost) {
    if (alphaEnabled()) {
      if (state.game.running) openAlphaAudio();
      sendAlphaCfg();
    } else {
      windows.closeAlphaAudio();
    }
  }
  if (partial && partial.lang) buildTrayMenu();
  if (partial && typeof partial.discordRpc === 'boolean') {
    discord.setEnabled(partial.discordRpc, log);
  }
  if (partial && partial.obs) applyObsConfig();
  refreshSession();                    // le pseudo peut changer les résultats
  pushState();
  return config.get();
});
// Prévisualise l'animation de fin de match sur le dashboard (réglages).
ipcMain.on('preview-animation', (_e, result) => {
  const win = result === 'W';
  const fake = {
    result: win ? 'W' : 'L',
    score: win ? [3, 2] : [1, 3],
    mode: '2v2',
    isOT: false,
    ranked: true,
    forfeit: false,
    me: { goals: 2, saves: 1, assists: 0, shots: 4, score: 520, mvp: win },
    preview: true,
  };
  const already = !!windows.getDashboard();
  windows.openDashboard({ fullscreen: config.get().dashboardFullscreen });
  // Si la fenêtre vient d'être créée, on lui laisse le temps de charger.
  // L'overlay OBS reçoit aussi le test : le streamer voit sa bannière.
  setTimeout(() => {
    windows.broadcast('match-result', fake);
    obs.emit('result', fake);
  }, already ? 50 : 900);
});

// Lit un sample Alpha Boost pour le moteur audio (nom strictement filtré,
// dossier imposé : aucun chemin arbitraire ne peut sortir d'ici).
ipcMain.handle('alpha-read-sound', (_e, name) => {
  const safe = String(name).replace(/[^a-z0-9]/g, '');
  return fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'sounds', 'alpha', safe + '.ogg'));
});

// Essai du son Alpha Boost depuis les réglages : la fenêtre audio joue une
// montée en vitesse simulée. Créée au besoin, refermée après si le jeu ne
// tourne pas (pour ne pas garder un renderer inutile en mémoire).
ipcMain.on('alpha-test', () => {
  const existed = !!windows.getAlphaAudio();
  windows.openAlphaAudio(() => {
    sendAlphaCfg();
    const w = windows.getAlphaAudio();
    if (w) {
      try { w.webContents.send('alpha-test'); } catch (e) {}
    }
  });
  if (!existed && !state.game.running) {
    // L'essai dure ~4 s : large marge avant de refermer la fenêtre.
    setTimeout(() => {
      if (!state.game.running) windows.closeAlphaAudio();
    }, 12000);
  }
});

// Marque le match EN COURS comme classé ou casual.
ipcMain.on('set-current-ranked', (_e, ranked) => {
  if (state.live && !state.live.training) {
    state.currentRanked = !!ranked;
    pushState();
  }
});
ipcMain.on('dashboard-fullscreen-toggle', () => {
  const on = !config.get().dashboardFullscreen;
  config.update({ dashboardFullscreen: on });
  windows.setDashboardFullscreen(on);
  pushState();
});
ipcMain.handle('reset-session', () => {
  store.resetSession();
  refreshSession();
  pushState();
});
ipcMain.handle('set-autostart', (_e, on) => { setAutostart(!!on); pushState(); });
ipcMain.handle('enable-statsapi', async () => {
  let r;
  try { r = await enableStatsApi(); } catch (e) { r = { ok: false, reason: e.message }; }
  return r;
});
ipcMain.on('open-dashboard', () => openDashboard());
ipcMain.on('close-dashboard', () => windows.closeDashboard());
ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(url);
});
ipcMain.on('update-check', () => updater.check());
ipcMain.on('update-download', () => updater.download());
ipcMain.on('update-install', () => updater.install());
ipcMain.on('win-minimize', () => { const w = windows.getControl(); if (w) w.minimize(); });
ipcMain.on('win-close', () => { const w = windows.getControl(); if (w) w.hide(); });
ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit(); });

// ───────── Cycle de vie ─────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => windows.showControl());
  app.on('window-all-closed', () => { /* on vit dans la barre des tâches */ });
  app.on('before-quit', () => { app.isQuitting = true; discord.stop(); obs.stop(); });

  app.whenReady().then(async () => {
    try { app.setAppUserModelId('com.rlsessiontracker.app'); } catch (e) {}

    const firstRun = !configExists();
    config.init(app.getPath('userData'));
    store = new SessionStore(app.getPath('userData'));
    // Chaque lancement démarre une nouvelle liste de « matchs récents ».
    // Le journal complet est conservé : courbe MMR, 7 jours et records
    // continuent de tout voir.
    store.resetSession();
    state.autostart = autostartEnabled();
    refreshSession();

    createTray();
    windows.createControl(!SILENT, () => pushState());

    updater.init((u) => { state.update = u; pushState(); }, log);
    discord.setEnabled(config.get().discordRpc, log);
    applyObsConfig();
    startStatsApi();

    const watcher = new GameWatcher();
    watcher.on('change', (running) => {
      state.game.processRunning = running;
      recomputeRunning();
    });
    watcher.start();

    if (firstRun) {
      await firstRunSetup();
      windows.showControl();           // premier lancement : on se montre
      pushState();
    }

    log('application lancée v' + state.version + (SILENT ? ' (silencieux)' : ''));
  });
}

function configExists() {
  try {
    return fs.existsSync(path.join(app.getPath('userData'), 'config.json'));
  } catch (e) { return false; }
}
