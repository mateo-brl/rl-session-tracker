// preload.js — Pont sécurisé entre les fenêtres et le processus principal.
// contextIsolation est activé : les fenêtres n'ont pas accès à Node, seulement
// à l'API minimale exposée ici.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rl', {
  // État de l'application (poussé en continu).
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onGoal: (cb) => ipcRenderer.on('goal', (_e, g) => cb(g)),
  onMatchResult: (cb) => ipcRenderer.on('match-result', (_e, m) => cb(m)),

  // Réglages et actions.
  setConfig: (partial) => ipcRenderer.invoke('set-config', partial),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  resetSession: () => ipcRenderer.invoke('reset-session'),
  enableStatsApi: () => ipcRenderer.invoke('enable-statsapi'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  closeDashboard: () => ipcRenderer.send('close-dashboard'),
  toggleFullscreen: () => ipcRenderer.send('dashboard-fullscreen-toggle'),
  setCurrentRanked: (on) => ipcRenderer.send('set-current-ranked', on),
  previewAnimation: (result) => ipcRenderer.send('preview-animation', result),

  // Son Alpha Boost : essai (réglages) et flux vers le moteur audio caché.
  alphaTest: () => ipcRenderer.send('alpha-test'),
  onAlphaCfg: (cb) => ipcRenderer.on('alpha-cfg', (_e, c) => cb(c)),
  onAlphaTelemetry: (cb) => ipcRenderer.on('alpha-telemetry', (_e, t) => cb(t)),
  onAlphaTest: (cb) => ipcRenderer.on('alpha-test', () => cb()),
  // Lecture d'un sample audio : fetch() refuse file:// et le preload est
  // sandboxé (pas de fs) — c'est donc le processus principal qui lit le
  // fichier (fs y est patché pour l'asar une fois l'application empaquetée).
  readSound: (name) => ipcRenderer.invoke('alpha-read-sound', name)
    .then((u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)),

  // Mises à jour.
  updateCheck: () => ipcRenderer.send('update-check'),
  updateDownload: () => ipcRenderer.send('update-download'),
  updateInstall: () => ipcRenderer.send('update-install'),

  // Contrôles de la fenêtre (barre de titre personnalisée).
  minimize: () => ipcRenderer.send('win-minimize'),
  close: () => ipcRenderer.send('win-close'),
  quit: () => ipcRenderer.send('quit-app'),
});
