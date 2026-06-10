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
  session: null,         // agrégats de session
  history: [],
  playersSeen: [],
  pseudoCandidates: [],  // si le pseudo n'a pas pu être deviné tout seul
  update: updater.getState(),
};

function refreshSession() {
  const snap = store.snapshot(config.get().pseudo, config.get());
  state.session = snap.session;
  state.history = snap.history;
  state.playersSeen = snap.playersSeen;
}

function pushState() {
  state.config = config.get();
  windows.broadcast('state', state);
}

// ───────── Démarrage automatique avec Windows ─────────
function autostartEnabled() {
  try { return app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
}
function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--silent'] });
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
  } else {
    state.live = null;
    windows.closeDashboard();
  }
  pushState();
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
    { type: 'separator' },
    { label: 'Vérifier les mises à jour', click: () => updater.check() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => windows.showControl());
  tray.on('double-click', () => windows.showControl());
}

// ───────── Stats API du jeu ─────────
function startStatsApi() {
  process.env.STATSAPI_PORT = String(config.get().statsApiPort);
  const api = new RLStatsAPI();

  api.on('connection', (d) => {
    state.game.statsConnected = d.connected;
    recomputeRunning();
  });
  api.on('state', (d) => {
    state.live = d && d.active ? d : null;
    pushState();
  });
  api.on('match', (d) => {
    if (d.phase === 'destroyed') { state.live = null; pushState(); }
  });
  api.on('goal', (d) => {
    windows.broadcast('goal', d);
  });
  api.on('ended', (snap) => {
    state.live = null;
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
  refreshSession();                    // le pseudo peut changer les résultats
  pushState();
  return config.get();
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
