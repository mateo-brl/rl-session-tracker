// agent/preload.js — Pont sécurisé entre l'interface (renderer) et le
// processus principal. contextIsolation est activé : la fenêtre n'a pas accès
// à Node, seulement à l'API minimale exposée ici.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rlAgent', {
  // État de l'agent.
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),

  // Actions.
  enroll: (code) => ipcRenderer.invoke('enroll', code),
  openDashboard: () => ipcRenderer.send('open-dashboard'),

  // Contrôles de la fenêtre (barre de titre personnalisée).
  minimize: () => ipcRenderer.send('win-minimize'),
  close: () => ipcRenderer.send('win-close'),
});
