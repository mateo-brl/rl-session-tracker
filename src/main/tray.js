// tray.js — Icône et menu de la zone de notification.
//
// Extrait d'index.js. L'application vit là : fermer la fenêtre de contrôle
// la cache, elle ne quitte pas.

const { app, Tray, Menu } = require('electron');
const path = require('path');
const updater = require('./updater');

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');

const LABELS = {
  fr: { open: 'Ouvrir', dash: 'Ouvrir le dashboard', overlay: 'Mini-overlay', maps: 'Cartes workshop',
    update: 'Vérifier les mises à jour', quit: 'Quitter' },
  en: { open: 'Open', dash: 'Open the dashboard', overlay: 'Mini-overlay', maps: 'Workshop maps',
    update: 'Check for updates', quit: 'Quit' },
};

// `actions` : { lang(), openDashboard(), toggleOverlay(), openMaps() }.
module.exports = function createTray(ctx, actions) {
  const { windows, log } = ctx;
  let tray = null;

  // Reconstruit le menu : appelé aussi quand la langue change.
  function rebuild() {
    if (!tray) return;
    const L = LABELS[actions.lang()] || LABELS.fr;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: L.open, click: () => windows.showControl() },
      { label: L.dash, click: () => actions.openDashboard() },
      { label: L.overlay, click: () => actions.toggleOverlay() },
      { label: L.maps, click: () => actions.openMaps() },
      { type: 'separator' },
      { label: L.update, click: () => updater.check() },
      { type: 'separator' },
      { label: L.quit, click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  }

  function create() {
    try {
      tray = new Tray(ICON);
    } catch (e) {
      log('icône systray indisponible : ' + e.message);
      return;
    }
    tray.setToolTip('RL Session Tracker');
    rebuild();
    tray.on('click', () => windows.showControl());
    tray.on('double-click', () => windows.showControl());
  }

  return { create, rebuild };
};
