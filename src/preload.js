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
  openControl: (section) => ipcRenderer.send('open-control', section),
  // Télécommande Spotify. Le son ne transite pas par l'application : ces
  // appels pilotent le lecteur Spotify de l'utilisateur.
  spotifySetClient: (id) => ipcRenderer.invoke('spotify-set-client', id),
  spotifyConnect: () => ipcRenderer.invoke('spotify-connect'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify-disconnect'),
  spotifyCommand: (cmd, value) => ipcRenderer.invoke('spotify-command', cmd, value),
  // Essayage d'un habillage : appliqué dans toutes les fenêtres, enregistré
  // nulle part. `null` remet la configuration réelle.
  previewLook: (look) => ipcRenderer.send('preview-look', look),
  onLookPreview: (cb) => ipcRenderer.on('look-preview', (_e, l) => cb(l)),
  onGotoSection: (cb) => ipcRenderer.on('goto-section', (_e, s) => cb(s)),
  openOverlayComposer: () => ipcRenderer.send('open-overlay-composer'),
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
  cosmeticsCheckTargets: (id, install) => ipcRenderer.invoke('cosmetics-check-targets', id, install),
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
