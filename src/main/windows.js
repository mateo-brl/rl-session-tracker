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

// ───────── Fenêtre de contrôle ─────────
function createControl(show, onReady) {
  if (control && !control.isDestroyed()) { if (show) showControl(); return control; }
  control = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    maximizable: false,
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
  control.loadFile(path.join(RENDERER, 'control.html'));
  control.once('ready-to-show', () => { if (show) control.show(); });
  control.webContents.on('did-finish-load', () => { if (onReady) onReady(); });
  // Fermer = masquer ; l'application vit dans la barre des tâches.
  control.on('close', (e) => {
    const app = require('electron').app;
    if (!app.isQuitting) { e.preventDefault(); control.hide(); }
  });
  return control;
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
function openOverlay(pos, onMoved) {
  if (overlay && !overlay.isDestroyed()) { overlay.show(); return overlay; }
  const wa = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    x: (pos && Number.isFinite(pos.x)) ? pos.x : wa.x + wa.width - 300,
    y: (pos && Number.isFinite(pos.y)) ? pos.y : wa.y + 16,
    width: 284,
    height: 92,
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

function getOverlay() {
  return (overlay && !overlay.isDestroyed()) ? overlay : null;
}

// Pousse l'état vers toutes les fenêtres ouvertes.
function broadcast(channel, payload) {
  for (const w of [getControl(), getDashboard(), getOverlay()]) {
    if (w && w.webContents) {
      try { w.webContents.send(channel, payload); } catch (e) {}
    }
  }
}

module.exports = {
  createControl, showControl, getControl,
  openDashboard, closeDashboard, getDashboard,
  setDashboardFullscreen,
  openOverlay, closeOverlay, getOverlay,
  broadcast,
};
