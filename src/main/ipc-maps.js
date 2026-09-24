// ipc-maps.js — Fenêtre Cartes workshop : ce que les fenêtres peuvent demander.
//
// Extrait d'index.js. Fait le lien entre la bibliothèque (maps.js), le site
// intégré (maps-browser.js) et la fenêtre (maps.html).

const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const mapsBrowser = require('./maps-browser');

const NO_MODULE = { ok: false, error: 'Module indisponible.' };

// `ctx` : { state, windows, log, mapLib } ; `withGameRights` : voir
// ipc-cosmetics.js (même dossier du jeu, mêmes droits).
module.exports = function createMapsIpc(ctx, withGameRights) {
  const { state, windows, log } = ctx;
  let nav = null;   // site bakkesplugins affiché dans la fenêtre Cartes

  function send(channel, payload) {
    const w = windows.getMaps();
    if (w) { try { w.webContents.send(channel, payload); } catch (e) { /* fenêtre fermée */ } }
  }
  function list() {
    if (!ctx.mapLib) return { installs: [], maps: [], slots: [], gameRunning: false };
    return Object.assign(ctx.mapLib.list(), { gameRunning: !!state.game.processRunning });
  }
  function changed(r) {
    send('maps-changed', null);
    return r;
  }
  const call = (fn) => (ctx.mapLib ? fn(ctx.mapLib) : NO_MODULE);

  // Téléchargement terminé dans le site : l'aperçu est récupéré, la carte
  // entre dans la bibliothèque, l'archive temporaire disparaît.
  async function importDownload(d) {
    const meta = d.meta || {};
    const preview = meta.preview ? await mapsBrowser.fetchPreview(meta.preview) : null;
    const r = ctx.mapLib ? await ctx.mapLib.importFile(d.file, {
      title: meta.title, author: meta.author, page: meta.page,
      source: 'bakkesplugins', preview: preview,
    }) : NO_MODULE;
    try { fs.rmSync(d.file, { force: true }); } catch (e) { /* déjà parti */ }
    log('cartes : téléchargement « ' + d.name + ' » ' + (r.ok ? 'ajouté' : 'refusé : ' + r.error));
    send('maps-download', { id: d.id, name: d.name, state: r.ok ? 'imported' : 'error',
      mapId: r.ok ? r.map.id : null, title: r.ok ? r.map.title : null,
      duplicate: !!r.duplicate, error: r.ok ? null : r.error });
    send('maps-changed', null);
  }

  function openWindow() {
    return windows.openMaps((win) => {
      nav = mapsBrowser.attach(win, {
        downloadDir: ctx.mapLib ? ctx.mapLib.incomingDir : path.join(app.getPath('temp'), 'rlst-maps'),
        onNav: (n) => send('maps-nav', n),
        onDownload: (d) => send('maps-download', d),
        onComplete: (d) => { importDownload(d).catch((e) => log('cartes : import échoué : ' + e.message)); },
      });
      win.on('close', () => { if (nav) { nav.destroy(); nav = null; } });
    });
  }

  // Une mise en file relevée dans le journal : les cartes posées dans le jeu
  // repartent si le match pourrait tomber sur leur arène. On peut lancer une
  // recherche DEPUIS l'entraînement sur la carte : le fichier est alors
  // encore ouvert par le jeu, d'où quelques reprises, le temps que le match
  // trouvé fasse quitter la carte.
  function guardQueue(q) {
    const attempt = async (tries) => {
      if (!ctx.mapLib) return;
      const g = await ctx.mapLib.guardQueue(q);
      if (g.restored.length || g.error) send('maps-changed', { guard: g });
      if (g.error && tries > 0) setTimeout(() => attempt(tries - 1), 5000).unref();
    };
    attempt(6);
  }

  async function importPaths(paths) {
    const out = [];
    for (const p of paths.slice(0, 20)) {
      if (typeof p !== 'string' || !/\.(udk|upk|zip)$/i.test(p)) {
        out.push({ ok: false, error: 'Format non pris en charge : il faut un .udk, un .upk ou un .zip.' });
        continue;
      }
      out.push(ctx.mapLib ? await ctx.mapLib.importFile(p, { source: 'fichier' }) : NO_MODULE);
    }
    changed(null);
    return out;
  }

  ipcMain.on('open-maps', () => openWindow());
  ipcMain.handle('maps-list', () => list());
  ipcMain.handle('maps-preview', (_e, id) => (ctx.mapLib ? ctx.mapLib.preview(String(id || '')) : null));
  ipcMain.handle('maps-load', (_e, id, slot) =>
    withGameRights(() => call((m) => m.load(String(id || ''), String(slot || ''))), 'cartes').then(changed));
  // Sans emplacement : tous les originaux reviennent.
  ipcMain.handle('maps-restore', (_e, slot) =>
    withGameRights(() => call((m) => m.restore(slot ? String(slot) : undefined)), 'cartes').then(changed));
  ipcMain.handle('maps-favorite', (_e, id, on) => changed(call((m) => m.setFavorite(String(id || ''), !!on))));
  ipcMain.handle('maps-remove', (_e, id) =>
    withGameRights(() => call((m) => m.remove(String(id || ''))), 'cartes').then(changed));
  ipcMain.handle('maps-import', async () => {
    const w = windows.getMaps();
    const r = await dialog.showOpenDialog(w || undefined, {
      title: state.lang === 'en' ? 'Import a map' : 'Importer une carte',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: state.lang === 'en' ? 'Maps' : 'Cartes', extensions: ['udk', 'upk', 'zip'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true, results: [] };
    return { results: await importPaths(r.filePaths) };
  });
  // Glisser-déposer : les chemins viennent de webUtils.getPathForFile, côté
  // preload ; ils sont revérifiés ici (extension) puis à l'import (contenu).
  ipcMain.handle('maps-import-paths', async (_e, paths) =>
    ({ results: await importPaths(Array.isArray(paths) ? paths : []) }));
  ipcMain.on('maps-view-bounds', (_e, r) => { if (nav) nav.setBounds(r); });
  ipcMain.on('maps-view', (_e, cmd) => { if (nav) nav.command(String(cmd || '')); });

  return { openWindow, guardQueue, send };
};
