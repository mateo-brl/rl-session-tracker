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
  exportMatches: () => ipcRenderer.invoke('export-matches'),
  // Correction manuelle d'un résultat de l'historique : 'W', 'L', ou null
  // pour revenir au calcul automatique.
  setMatchResult: (id, result) => ipcRenderer.invoke('set-match-result', id, result),
  enableStatsApi: () => ipcRenderer.invoke('enable-statsapi'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  closeDashboard: () => ipcRenderer.send('close-dashboard'),
  toggleFullscreen: () => ipcRenderer.send('dashboard-fullscreen-toggle'),
  setCurrentRanked: (on) => ipcRenderer.send('set-current-ranked', on),
  previewAnimation: (result) => ipcRenderer.send('preview-animation', result),

  // Cosmétiques : swaps de paquets du jeu (seule fonction qui touche aux
  // fichiers de Rocket League — optionnelle, jeu fermé uniquement).
  cosmeticsList: () => ipcRenderer.invoke('cosmetics-list'),
  cosmeticsTargets: (install, query) => ipcRenderer.invoke('cosmetics-targets', install, query),
  cosmeticsAdd: (opts) => ipcRenderer.invoke('cosmetics-add', opts),
  cosmeticsPresets: () => ipcRenderer.invoke('cosmetics-presets'),
  cosmeticsAddPreset: (id, opts) => ipcRenderer.invoke('cosmetics-add-preset', id, opts),
  cosmeticsApply: (id) => ipcRenderer.invoke('cosmetics-apply', id),
  cosmeticsRestore: (id) => ipcRenderer.invoke('cosmetics-restore', id),
  cosmeticsRemove: (id) => ipcRenderer.invoke('cosmetics-remove', id),
  cosmeticsToggle: (id, enabled) => ipcRenderer.invoke('cosmetics-toggle', id, enabled),
  cosmeticsApplyAll: () => ipcRenderer.invoke('cosmetics-apply-all'),
  cosmeticsRestoreAll: () => ipcRenderer.invoke('cosmetics-restore-all'),

  // Mises à jour.
  updateCheck: () => ipcRenderer.send('update-check'),
  updateDownload: () => ipcRenderer.send('update-download'),
  updateInstall: () => ipcRenderer.send('update-install'),

  // Contrôles de la fenêtre (barre de titre personnalisée).
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  quit: () => ipcRenderer.send('quit-app'),
});
