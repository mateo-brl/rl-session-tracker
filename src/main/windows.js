// windows.js — Les deux fenêtres de l'application.
//
//  • La fenêtre de contrôle : petite, sans cadre, pour l'état et les réglages.
//  • Le dashboard : la grande page « tracker », ouverte automatiquement en
//    plein écran sur l'écran secondaire quand Rocket League démarre.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

let control = null;
let dashboard = null;
let overlay = null;

// ───────── Durcissement commun à toutes les fenêtres ─────────
// Défense en profondeur : la seule donnée contrôlée par un adversaire (les
// pseudos reçus de la Stats API) est systématiquement échappée via esc()
// dans les renderers, donc aucune injection n'est possible aujourd'hui. Mais
// si une régression future laissait passer du HTML non échappé issu d'un
// pseudo adverse, l'absence de ces garde-fous permettrait à la page
// compromise de se naviguer vers une origine distante ou d'ouvrir de
// nouvelles fenêtres. Les liens externes légitimes de l'application passent
// tous par le canal IPC dédié 'open-external' (shell.openExternal côté
// main), qui n'est pas affecté par ces restrictions.
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockRemoteNav = (e, url) => {
    if (!String(url).startsWith('file://')) e.preventDefault();
  };
  win.webContents.on('will-navigate', blockRemoteNav);
  win.webContents.on('will-redirect', blockRemoteNav);
}

// ───────── Fenêtre de contrôle ─────────
// Un vrai panneau de configuration : redimensionnable, maximisable, taille et
// position mémorisées. La version 460×640 figée était « toute petite » et, une
// fois cachée dans la zone de notification (souvent repliée par Windows),
// difficile à retrouver.
const CONTROL_W = 1080;
const CONTROL_H = 720;
const CONTROL_MIN_W = 880;
const CONTROL_MIN_H = 600;

// Fermer la fenêtre : la cacher (vie dans la zone de notification, défaut)
// ou la réduire dans la barre des tâches, où elle reste visible d'un clic.
let trayOnly = true;
function setTrayOnly(on) { trayOnly = on !== false; }

let onControlBounds = null;
let boundsTimer = null;

// Une position mémorisée n'a de sens que si elle tombe encore sur un écran
// branché — sinon la fenêtre renaîtrait hors champ.
function boundsOnScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)
    || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return false;
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + b.width > a.x + 60 && b.x < a.x + a.width - 60
        && b.y + 40 > a.y && b.y < a.y + a.height - 40;
    });
  } catch (e) { return false; }
}

function createControl(show, onReady, opts) {
  if (control && !control.isDestroyed()) { if (show) showControl(); return control; }
  const o = opts || {};
  const saved = boundsOnScreen(o.bounds) ? o.bounds : null;
  onControlBounds = o.onBounds || onControlBounds;
  control = new BrowserWindow({
    width: saved ? saved.width : CONTROL_W,
    height: saved ? saved.height : CONTROL_H,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: CONTROL_MIN_W,
    minHeight: CONTROL_MIN_H,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    frame: false,
    backgroundColor: '#0c0e11',
    show: false,
    icon: ICON,
    title: 'RL Session Tracker',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(control);
  control.loadFile(path.join(RENDERER, 'control.html'));
  control.once('ready-to-show', () => {
    if (saved && saved.maximized) control.maximize();
    if (show) control.show();
  });
  control.webContents.on('did-finish-load', () => { if (onReady) onReady(); });
  // Mémorisation de la géométrie, sans écrire la config à chaque pixel.
  const remember = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!control || control.isDestroyed() || !onControlBounds) return;
      const max = control.isMaximized();
      const b = max ? control.getNormalBounds() : control.getBounds();
      onControlBounds({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: max });
    }, 400);
  };
  control.on('resize', remember);
  control.on('move', remember);
  control.on('maximize', remember);
  control.on('unmaximize', remember);
  control.on('close', (e) => {
    const app = require('electron').app;
    if (app.isQuitting) return;
    e.preventDefault();
    if (trayOnly) control.hide();
    else control.minimize();
  });
  return control;
}

// Bascule maximisé / restauré (bouton de la barre de titre personnalisée).
function toggleMaximizeControl() {
  if (!control || control.isDestroyed()) return;
  if (control.isMaximized()) control.unmaximize();
  else control.maximize();
}

// Raccourci global : la fenêtre apparaît si elle est cachée/réduite/derrière,
// et se range si elle est déjà au premier plan.
function toggleControl() {
  if (!control || control.isDestroyed()) { createControl(true); return; }
  if (control.isVisible() && !control.isMinimized() && control.isFocused()) {
    if (trayOnly) control.hide();
    else control.minimize();
    return;
  }
  showControl();
}

function showControl() {
  if (!control || control.isDestroyed()) { createControl(true); return; }
  if (!control.isVisible()) control.show();
  if (control.isMinimized()) control.restore();
  control.focus();
}

function getControl() {
  return (control && !control.isDestroyed()) ? control : null;
}

// ───────── Dashboard (2ᵉ écran) ─────────
// Choisit l'écran secondaire s'il existe, sinon l'écran principal.
function pickDisplay() {
  const primary = screen.getPrimaryDisplay();
  const external = screen.getAllDisplays().find((d) => d.id !== primary.id);
  return external || primary;
}

// Compositeur d'overlay : la MÊME page que le dashboard, en mode overlay et
// en édition. On y compose ce que verra le spectateur, sur un damier qui
// montre ce qui est transparent. Une fenêtre ordinaire, pas un plein écran :
// on la garde à côté d'OBS pendant qu'on règle.
let composer = null;
function openOverlayComposer() {
  if (composer && !composer.isDestroyed()) {
    composer.show();
    composer.focus();
    return composer;
  }
  const display = pickDisplay();
  const { width, height } = display.bounds;
  composer = new BrowserWindow({
    width: Math.min(1280, width - 120),
    height: Math.min(760, height - 140),
    backgroundColor: '#12161b',
    show: false,
    icon: ICON,
    autoHideMenuBar: true,
    title: 'RL Session Tracker — Compositeur d’overlay',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(composer);
  composer.loadFile(path.join(RENDERER, 'dashboard.html'), {
    query: { obs: '1', edit: '1' },
  });
  composer.once('ready-to-show', () => composer.show());
  composer.on('closed', () => { composer = null; });
  return composer;
}
function getComposer() {
  return composer && !composer.isDestroyed() ? composer : null;
}

function openDashboard(opts, onReady) {
  const fullscreen = !opts || opts.fullscreen !== false;
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    return dashboard;
  }
  const display = pickDisplay();
  const { x, y, width, height } = display.bounds;
  dashboard = new BrowserWindow({
    x: x + 50,
    y: y + 50,
    width: Math.min(1280, width - 100),
    height: Math.min(800, height - 100),
    backgroundColor: '#0c0e11',
    show: false,
    icon: ICON,
    autoHideMenuBar: true,
    title: 'RL Session Tracker — Dashboard',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(dashboard);
  dashboard.loadFile(path.join(RENDERER, 'dashboard.html'));
  dashboard.once('ready-to-show', () => {
    if (fullscreen) {
      dashboard.setBounds(display.bounds);
      dashboard.setFullScreen(true);
    }
    dashboard.show();
  });
  dashboard.webContents.on('did-finish-load', () => { if (onReady) onReady(); });
  dashboard.on('closed', () => { dashboard = null; });
  return dashboard;
}

// Bascule le plein écran du dashboard ouvert. En sortant du plein écran, on
// redonne une taille de fenêtre raisonnable, centrée sur le même écran.
function setDashboardFullscreen(on) {
  if (!dashboard || dashboard.isDestroyed()) return;
  dashboard.setFullScreen(!!on);
  if (!on) {
    const d = screen.getDisplayMatching(dashboard.getBounds());
    const wa = d.workArea;
    const w = Math.min(1280, wa.width - 80);
    const h = Math.min(800, wa.height - 80);
    dashboard.setBounds({
      x: wa.x + Math.round((wa.width - w) / 2),
      y: wa.y + Math.round((wa.height - h) / 2),
      width: w,
      height: h,
    });
  }
}

function closeDashboard() {
  if (dashboard && !dashboard.isDestroyed()) dashboard.destroy();
  dashboard = null;
}

function getDashboard() {
  return (dashboard && !dashboard.isDestroyed()) ? dashboard : null;
}

// ───────── Mini-overlay (toujours au premier plan) ─────────
// Petit bandeau W–L / série / score live, pour jouer sur un seul écran.
const OVERLAY_W = 284;
const OVERLAY_H = 92;

// La position mémorisée pointe-t-elle encore sur un écran existant ? Le public
// de l'application joue sur deux écrans : après avoir posé l'overlay sur le
// second puis débranché celui-ci, la fenêtre — sans cadre, non focalisable et
// absente de la barre des tâches — se rouvrait à des coordonnées invisibles,
// irrécupérable autrement qu'en éditant config.json à la main.
function posOnScreen(pos, w, h) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false;
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      // On exige que la fenêtre reste attrapable : au moins 40 px visibles.
      return pos.x + w > a.x + 40 && pos.x < a.x + a.width - 40
        && pos.y + h > a.y && pos.y < a.y + a.height - 20;
    });
  } catch (e) { return false; }
}

function openOverlay(pos, onMoved, ocfg) {
  if (overlay && !overlay.isDestroyed()) { overlay.show(); return overlay; }
  const wa = screen.getPrimaryDisplay().workArea;
  const scale = (ocfg && ocfg.scale) || 1;
  const w = Math.round(OVERLAY_W * scale);
  const h = Math.round(OVERLAY_H * scale);
  const keep = posOnScreen(pos, w, h);
  overlay = new BrowserWindow({
    x: keep ? pos.x : wa.x + wa.width - 300,
    y: keep ? pos.y : wa.y + 16,
    width: w,
    height: h,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#0c0e11',
    show: false,
    icon: ICON,
    title: 'RL Session Tracker — Overlay',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (ocfg && ocfg.opacity < 1) {
    try { overlay.setOpacity(ocfg.opacity); } catch (e) {}
  }
  hardenWindow(overlay);
  overlay.loadFile(path.join(RENDERER, 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.show());
  overlay.on('moved', () => {
    if (onMoved && overlay && !overlay.isDestroyed()) {
      const b = overlay.getBounds();
      onMoved({ x: b.x, y: b.y });
    }
  });
  overlay.on('closed', () => { overlay = null; });
  return overlay;
}

function closeOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}

// Applique échelle et opacité à un overlay déjà ouvert.
function applyOverlayCfg(ocfg) {
  if (!overlay || overlay.isDestroyed() || !ocfg) return;
  const b = overlay.getBounds();
  const scale = ocfg.scale || 1;
  overlay.setBounds({
    x: b.x, y: b.y,
    width: Math.round(OVERLAY_W * scale),
    height: Math.round(OVERLAY_H * scale),
  });
  try { overlay.setOpacity(ocfg.opacity == null ? 1 : ocfg.opacity); } catch (e) {}
}

function getOverlay() {
  return (overlay && !overlay.isDestroyed()) ? overlay : null;
}

// ───────── Moteur audio Alpha Boost (fenêtre invisible) ─────────
// Le son est joué par un renderer caché : WebAudio y tourne sans fenêtre
// visible, et continue même en arrière-plan (backgroundThrottling désactivé,
// sinon Chromium ralentit les timers d'une fenêtre masquée).



// Pousse l'état vers toutes les fenêtres ouvertes.
function broadcast(channel, payload) {
  for (const w of [getControl(), getDashboard(), getOverlay(), getComposer()]) {
    if (w && w.webContents) {
      try { w.webContents.send(channel, payload); } catch (e) {}
    }
  }
}

module.exports = {
  createControl, showControl, getControl, toggleControl, toggleMaximizeControl,
  setTrayOnly,
  openDashboard, closeDashboard, getDashboard,
  openOverlayComposer, getComposer,
  setDashboardFullscreen,
  openOverlay, closeOverlay, getOverlay, applyOverlayCfg,
  broadcast,
};
