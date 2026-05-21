// agent/main.js — Processus principal de l'agent RL Session Tracker (Electron).
//
// L'agent est une vraie application de bureau : fenêtre native sur mesure +
// icône dans la barre des tâches. Ce processus :
//  • lit la Stats API de Rocket League (socket local) et pousse les évènements
//    vers le serveur ;
//  • gère l'enrôlement (échange d'un code de configuration contre un token) ;
//  • s'installe en démarrage automatique avec Windows.
//
// L'interface (renderer.html) ne fait qu'AFFICHER l'état ; toute la logique
// vit ici. Communication par IPC via preload.js.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { enableStatsApi } = require('./enable-statsapi');

// ───────── Constantes ─────────
const VERSION = app.getVersion();
let DEFAULT_SERVER = 'https://rl.mateobrl.fr';
try {
  const s = require('./default-server.json').server;
  if (s) DEFAULT_SERVER = s;
} catch (e) { /* valeur par défaut conservée */ }
// Surcharge possible pour le développement / un test ponctuel.
if (process.env.AGENT_DEFAULT_SERVER) DEFAULT_SERVER = process.env.AGENT_DEFAULT_SERVER;
DEFAULT_SERVER = String(DEFAULT_SERVER).replace(/\/+$/, '');

const SILENT = process.argv.includes('--silent');   // lancé par le démarrage auto
const ICON = path.join(__dirname, 'assets', 'icon.ico');

const USER_DATA = app.getPath('userData');           // %APPDATA%/RL Session Tracker
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const LOG_FILE = path.join(USER_DATA, 'agent.log');

// ───────── Journal fichier (l'app n'a pas de console) ─────────
function log(msg) {
  try {
    let flag = 'a';
    try { if (fs.statSync(LOG_FILE).size > 262144) flag = 'w'; } catch (e) {}
    fs.writeFileSync(LOG_FILE,
      '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: flag });
  } catch (e) {}
}
process.on('uncaughtException', (e) => log('uncaughtException : ' + (e && e.message)));
process.on('unhandledRejection', (e) => log('unhandledRejection : ' + (e && (e.message || e))));

// ───────── État partagé, envoyé à l'interface ─────────
const state = {
  phase: 'loading',     // loading | need-code | configuring | running
  version: VERSION,
  message: '',
  enrollError: null,
  player: null,         // { id, name }
  dashboardUrl: null,
  server: { connected: false, label: 'pas encore contacté' },
  game: { connected: false, label: 'en attente' },
  match: null,
  lastMatch: null,
};

let win = null;
let tray = null;

function pushState() {
  if (win && !win.isDestroyed() && win.webContents) {
    try { win.webContents.send('state', state); } catch (e) {}
  }
}
function setPhase(p) { state.phase = p; pushState(); }

// ───────── Fenêtre ─────────
function createWindow(show) {
  if (win && !win.isDestroyed()) { if (show) showWindow(); return; }
  win = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,                 // barre de titre 100 % sur mesure
    backgroundColor: '#0a0c12',
    show: false,
    icon: ICON,
    title: 'RL Session Tracker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.webContents.on('did-finish-load', () => pushState());
  // Fermer la fenêtre = la masquer ; l'agent continue dans la barre des tâches.
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(true); return; }
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ───────── Icône de la barre des tâches ─────────
function createTray() {
  try {
    tray = new Tray(ICON);
  } catch (e) {
    log('icône systray indisponible : ' + e.message);
    return;
  }
  tray.setToolTip('RL Session Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir', click: () => showWindow() },
    {
      label: 'Ouvrir mon dashboard',
      click: () => { if (state.dashboardUrl) shell.openExternal(state.dashboardUrl); },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

// ───────── Configuration ─────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.serverUrl || !cfg.token) throw new Error('serverUrl ou token manquant');
    cfg.serverUrl = String(cfg.serverUrl).replace(/\/+$/, '');
    cfg.statsApiPort = cfg.statsApiPort || 49123;
    let host = '';
    try { host = new URL(cfg.serverUrl).hostname; } catch (e) {}
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!/^https:\/\//i.test(cfg.serverUrl) && !local) {
      throw new Error('serverUrl doit utiliser https://');
    }
    return cfg;
  } catch (e) {
    log('config.json illisible : ' + e.message);
    return null;
  }
}

function saveConfig(result) {
  const cfg = {
    serverUrl: String(result.serverUrl).replace(/\/+$/, ''),
    token: result.token,
    statsApiPort: 49123,
  };
  if (result.id) cfg.id = result.id;
  if (result.name) cfg.name = result.name;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    return cfg;
  } catch (e) {
    log('écriture config.json impossible : ' + e.message);
    return null;
  }
}

// Cherche un code dans le chemin de l'app : le téléchargement est nommé
// rl-agent-RLST-XXXXX-XXXXX.zip → après extraction, le code est dans le nom
// du dossier. Permet une configuration sans aucune saisie.
function codeFromPath() {
  try {
    const m = process.execPath.match(/RLST-[0-9A-Z]{5}-[0-9A-Z]{5}/i);
    return m ? m[0].toUpperCase() : null;
  } catch (e) { return null; }
}

// ───────── Démarrage automatique avec Windows ─────────
function autostartEnabled() {
  try { return app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
}
function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--silent'] });
    log('démarrage auto : ' + (on ? 'activé' : 'désactivé'));
    return true;
  } catch (e) {
    log('démarrage auto échec : ' + e.message);
    return false;
  }
}

// ───────── Enrôlement ─────────
async function claimCode(code) {
  const resp = await fetch(DEFAULT_SERVER + '/api/enroll/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code }),
    signal: AbortSignal.timeout(15000),
  });
  let data = {};
  try { data = await resp.json(); } catch (e) {}
  if (!resp.ok) {
    return { ok: false, error: (data && data.error) || ('Erreur serveur ' + resp.status) };
  }
  if (!data.token || !data.serverUrl) {
    return { ok: false, error: 'Réponse du serveur incomplète.' };
  }
  return {
    ok: true, serverUrl: data.serverUrl, token: data.token,
    id: data.id, name: data.name,
  };
}

async function tryEnableStatsApi() {
  if (process.platform !== 'win32') return;
  let r;
  try { r = await enableStatsApi(); } catch (e) { r = { ok: false, reason: e.message }; }
  log('Stats API : ' + (r.skipped ? 'ignorée' : r.ok ? 'configurée' : 'échec ' + r.reason));
}

// Enrôle l'agent à partir d'un code. Pilote l'interface. Retourne { ok, error }.
async function enroll(code) {
  code = String(code || '').trim();
  if (!code) return { ok: false, error: 'Saisis ton code de configuration.' };

  state.enrollError = null;
  setPhase('configuring');
  state.message = 'Vérification du code…'; pushState();

  let result;
  try {
    result = await claimCode(code);
  } catch (e) {
    setPhase('need-code');
    state.enrollError = 'Serveur injoignable. Vérifie ta connexion.'; pushState();
    return { ok: false, error: state.enrollError };
  }
  if (!result.ok) {
    setPhase('need-code');
    state.enrollError = result.error; pushState();
    return { ok: false, error: result.error };
  }

  const cfg = saveConfig(result);
  if (!cfg) {
    setPhase('need-code');
    state.enrollError = "Impossible d'enregistrer la configuration."; pushState();
    return { ok: false, error: state.enrollError };
  }

  state.message = 'Activation de la Stats API du jeu… (autorise la fenêtre Windows)';
  pushState();
  await tryEnableStatsApi();

  state.message = 'Installation du démarrage automatique…'; pushState();
  if (!autostartEnabled()) setAutostart(true);

  startAgent(cfg);
  return { ok: true };
}

// ───────── Démarrage de la boucle agent ─────────
async function boot() {
  const cfg = loadConfig();
  if (cfg) return startAgent(cfg);

  const embedded = codeFromPath();
  if (embedded) {
    log('code détecté dans le chemin — enrôlement automatique');
    const r = await enroll(embedded);
    if (r.ok) return;
  }
  setPhase('need-code');
  if (SILENT) showWindow();   // pas configuré : il faut bien montrer la fenêtre
}

// ───────── Boucle principale : Stats API → serveur ─────────
function startAgent(cfg) {
  process.env.STATSAPI_PORT = String(cfg.statsApiPort);
  if (cfg.debug) process.env.STATSAPI_DEBUG = '1';
  const RLStatsAPI = require('./statsapi');

  if (cfg.id) {
    state.player = { id: cfg.id, name: cfg.name || cfg.id };
    state.dashboardUrl = cfg.serverUrl + '/u/' + cfg.id;
  }
  state.message = '';
  state.enrollError = null;
  setPhase('running');
  log('agent démarré — serveur ' + cfg.serverUrl);

  const ingestUrl = cfg.serverUrl + '/api/ingest';
  const latest = { connected: false, match: { active: false } };
  let queue = [];
  let lastFlush = 0;
  let sending = false;

  function setServer(connected, label) {
    state.server = { connected: connected, label: label }; pushState();
  }
  function setGame(connected) {
    state.game = { connected: connected, label: connected ? 'détecté' : 'en attente' };
    pushState();
  }
  function applyIdentity(player) {
    if (!player || !player.id) return;
    if (state.player && state.player.id === player.id) return;
    state.player = { id: player.id, name: player.name || player.id };
    state.dashboardUrl = cfg.serverUrl + '/u/' + player.id;
    pushState();
  }
  function fmtScore(m) {
    return (m && Array.isArray(m.score)) ? (m.score[0] + ' – ' + m.score[1]) : null;
  }

  async function flush() {
    if (sending) return;
    sending = true;
    const events = queue;
    queue = [];
    const payload = { connected: latest.connected, match: latest.match, events: events };
    try {
      const resp = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.status === 401) {
        setServer(false, 'token refusé');
      } else if (resp.status === 429 || resp.status >= 500) {
        queue = events.concat(queue).slice(-100);
        setServer(false, 'serveur occupé');
      } else if (!resp.ok) {
        setServer(false, 'erreur ' + resp.status);
      } else {
        setServer(true, 'connecté');
        try {
          const data = await resp.json();
          if (data && data.player) applyIdentity(data.player);
        } catch (e) {}
      }
    } catch (e) {
      queue = events.concat(queue).slice(-100);
      setServer(false, 'injoignable');
    } finally {
      sending = false;
    }
  }
  function triggerFlush() { lastFlush = Date.now(); flush(); }

  const api = new RLStatsAPI();
  api.on('connection', (d) => { latest.connected = d.connected; setGame(d.connected); triggerFlush(); });
  api.on('match', (d) => {
    if (d.phase === 'start') {
      queue.push({ type: 'match-start' });
      triggerFlush();
    } else if (d.phase === 'destroyed') {
      queue.push({ type: 'match-destroyed' });
      latest.match = { active: false };
      state.match = null; pushState();
      triggerFlush();
    }
  });
  api.on('state', (d) => {
    latest.match = d;
    state.match = d && d.active ? fmtScore(d) : null;
    pushState();
  });
  api.on('goal', (d) => { queue.push({ type: 'goal', scorer: d.scorer, team: d.team }); });
  api.on('ended', (d) => {
    latest.match = { active: false };
    state.match = null;
    const sc = fmtScore(d);
    if (sc) state.lastMatch = sc;
    pushState();
    queue.push({
      type: 'match-end',
      winnerTeam: d.winnerTeam,
      mode: d.mode,
      players: (d.players || []).map((p) => ({ name: p.name, team: p.team })),
    });
    triggerFlush();
  });
  api.start();

  setTimeout(() => {
    if (!latest.connected) {
      log('Stats API injoignable port ' + cfg.statsApiPort + ' — redémarrer Rocket League ?');
    }
  }, 20 * 1000);

  setInterval(() => {
    const now = Date.now();
    const inMatch = latest.match && latest.match.active;
    const due = queue.length > 0
      || (inMatch && now - lastFlush >= 1000)
      || (now - lastFlush >= 20 * 1000);
    if (due) triggerFlush();
  }, 1000);
}

// ───────── IPC (depuis l'interface) ─────────
ipcMain.handle('get-state', () => state);
ipcMain.handle('enroll', (_e, code) => enroll(code));
ipcMain.on('open-dashboard', () => {
  if (state.dashboardUrl) shell.openExternal(state.dashboardUrl);
});
ipcMain.on('win-minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.on('win-close', () => { if (win && !win.isDestroyed()) win.hide(); });

// ───────── Cycle de vie de l'application ─────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Une instance tourne déjà : on la laisse rouvrir sa fenêtre, on sort.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* on vit dans la barre des tâches */ });
  app.on('before-quit', () => { app.isQuitting = true; });

  app.whenReady().then(() => {
    try { app.setAppUserModelId('com.rlsessiontracker.agent'); } catch (e) {}
    createTray();
    if (!SILENT) createWindow(true);
    log('agent lancé' + (SILENT ? ' (démarrage silencieux)' : ''));
    boot().catch((e) => log('boot : ' + (e && e.message)));
  });
}
