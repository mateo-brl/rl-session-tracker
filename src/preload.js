// preload.js — Pont sécurisé entre les fenêtres et le processus principal.
// contextIsolation est activé : les fenêtres n'ont pas accès à Node, seulement
// à l'API minimale exposée ici.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // Rapport de diagnostic : ce qui va et ce qui ne va pas, contrôle par
  // contrôle. Il ne modifie aucun réglage et ne touche à aucun fichier du jeu
  // (sauf un fichier temporaire aussitôt supprimé, pour éprouver les droits
  // d'écriture) : on peut le relancer autant de fois qu'on veut.
  runDiagnostic: () => ipcRenderer.invoke('run-diagnostic'),
  // Disposition de l'overlay : elle se compose au pixel près, donc elle doit
  // pouvoir se sauvegarder, se transporter et se partager.
  exportOverlayPreset: () => ipcRenderer.invoke('export-overlay-preset'),
  importOverlayPreset: () => ipcRenderer.invoke('import-overlay-preset'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  openControl: (section) => ipcRenderer.send('open-control', section),
  // Télécommande média : passe par le contrôleur de Windows, donc pilote le
  // lecteur qui a la main (Spotify, navigateur, VLC…).
  mediaCommand: (cmd) => ipcRenderer.invoke('media-command', cmd),
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

  // Cosmétiques : swaps de paquets du jeu (optionnels, jeu fermé uniquement).
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


  // Cartes workshop : bibliothèque, emplacement Underpass, et le site
  // bakkesplugins affiché dans la fenêtre Cartes.
  openMaps: () => ipcRenderer.send('open-maps'),
  mapsList: () => ipcRenderer.invoke('maps-list'),
  mapsPreview: (id) => ipcRenderer.invoke('maps-preview', id),
  mapsLoad: (id) => ipcRenderer.invoke('maps-load', id),
  mapsRestore: () => ipcRenderer.invoke('maps-restore'),
  mapsRemove: (id) => ipcRenderer.invoke('maps-remove', id),
  mapsImport: () => ipcRenderer.invoke('maps-import'),
  // Un fichier glissé dans la fenêtre : avec contextIsolation, la page n'a
  // pas accès au chemin, seul le preload peut le lire.
  mapsImportFiles: (files) => ipcRenderer.invoke('maps-import-paths',
    Array.from(files || []).map((f) => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } })),
  mapsViewBounds: (r) => ipcRenderer.send('maps-view-bounds', r),
  mapsView: (cmd) => ipcRenderer.send('maps-view', cmd),
  onMapsNav: (cb) => ipcRenderer.on('maps-nav', (_e, n) => cb(n)),
  onMapsDownload: (cb) => ipcRenderer.on('maps-download', (_e, d) => cb(d)),
  onMapsChanged: (cb) => ipcRenderer.on('maps-changed', (_e, c) => cb(c)),

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
