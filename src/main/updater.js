// updater.js — Mises à jour automatiques via GitHub Releases.
//
// electron-updater consulte la dernière release du dépôt GitHub (latest.yml,
// publié par electron-builder dans le workflow release.yml). Comportement :
//
//  • vérification au lancement puis toutes les 4 h ;
//  • quand une version est disponible, l'interface affiche un bouton
//    « Mettre à jour » — rien n'est téléchargé sans accord ;
//  • au clic : téléchargement (avec progression), puis installation et
//    redémarrage automatiques.

const { app } = require('electron');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// État exposé aux fenêtres :
// status : disabled | idle | checking | available | downloading | downloaded | error
const state = {
  status: app.isPackaged ? 'idle' : 'disabled',
  current: app.getVersion(),
  next: null,
  percent: 0,
  error: null,
};

let autoUpdater = null;
let onChange = () => {};

function set(patch) {
  Object.assign(state, patch);
  onChange(state);
}

function init(listener, log) {
  onChange = listener || onChange;
  if (!app.isPackaged) return state;   // en développement : pas de mise à jour

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    log('mise à jour disponible : ' + info.version);
    set({ status: 'available', next: info.version });
  });
  autoUpdater.on('update-not-available', () => set({ status: 'idle', next: null }));
  autoUpdater.on('download-progress', (p) => {
    set({ status: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', () => set({ status: 'downloaded', percent: 100 }));
  autoUpdater.on('error', (e) => {
    log('updater : ' + (e && e.message));
    // Erreur réseau au démarrage = silencieuse ; on retentera plus tard.
    set({ status: state.next ? 'error' : 'idle', error: e && e.message });
  });

  check();
  setInterval(check, CHECK_INTERVAL_MS);
  return state;
}

function check() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

function download() {
  if (!autoUpdater || (state.status !== 'available' && state.status !== 'error')) return;
  set({ status: 'downloading', percent: 0, error: null });
  autoUpdater.downloadUpdate().catch((e) => {
    set({ status: 'error', error: e && e.message });
  });
}

function install() {
  if (!autoUpdater || state.status !== 'downloaded') return;
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
}

function getState() {
  return state;
}

module.exports = { init, check, download, install, getState };
