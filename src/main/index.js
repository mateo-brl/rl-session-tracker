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
  update: updater.getState(),
};

function refreshSession() {
  const snap = store.snapshot(config.get().pseudo, config.get());
  state.session = snap.session;
  state.history = snap.history;
  state.playersSeen = snap.playersSeen;
  state.evolution = snap.evolution;
  state.week = snap.week;
  state.records = snap.records;
}

function pushState() {
  state.config = config.get();
  windows.broadcast('state', state);
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
  } else {
    state.live = null;
    state.currentRanked = null;
    windows.closeDashboard();
    windows.closeOverlay();
  }
  pushState();
}

function openOverlay() {
  windows.openOverlay(config.get().overlayPos,
    (pos) => config.update({ overlayPos: pos }));
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
function createTray() {
  try {
    tray = new Tray(ICON);
  } catch (e) {
    log('icône systray indisponible : ' + e.message);
    return;
  }
  tray.setToolTip('RL Session Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir', click: () => windows.showControl() },
    { label: 'Ouvrir le dashboard', click: () => openDashboard() },
    { label: 'Mini-overlay', click: () => {
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
    { label: 'Vérifier les mises à jour', click: () => updater.check() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
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
    snap.ranked = true;
    store.addMatch(snap);
    refreshSession();
    pushState();
    const last = state.history[0];
    if (last) windows.broadcast('match-result', last);
    log('forfait enregistré : ' + (snap.mode || '?') + ' — compté comme défaite');
  });
  api.on('goal', (d) => {
    if (state.live && state.live.training) return;
    windows.broadcast('goal', d);
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
    if (last) windows.broadcast('match-result', last);
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
  refreshSession();                    // le pseudo peut changer les résultats
  pushState();
  return config.get();
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
  app.on('before-quit', () => { app.isQuitting = true; });

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
