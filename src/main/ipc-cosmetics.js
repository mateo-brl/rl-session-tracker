// ipc-cosmetics.js — Swaps cosmétiques : ce que les fenêtres peuvent demander.
//
// Extrait d'index.js. Contient aussi withGameRights, que les cartes workshop
// utilisent : les deux écrivent dans CookedPCConsole, sous Program Files.

const { ipcMain, dialog } = require('electron');
const { enableStatsApi } = require('./enable-statsapi');

const NO_MODULE = { ok: false, error: 'Module indisponible.' };

// `ctx` : { state, config, log, pushState, cosmetics } ; `repair` : le module
// statsapi-repair (l'élévation qui pose les droits passe par lui).
module.exports = function createCosmeticsIpc(ctx, repair) {
  const { state, config, log } = ctx;

  function refresh() {
    if (ctx.cosmetics) state.cosmetics = ctx.cosmetics.summary();
  }
  function result(r) {
    refresh();
    ctx.pushState();
    return r;
  }

  // Les paquets vivent sous Program Files : la première écriture échoue tant
  // que l'utilisateur n'a pas de droits sur CookedPCConsole. Plutôt que de lui
  // demander d'aller cliquer ailleurs, on lance l'élévation (qui pose l'ACL)
  // et on rejoue l'opération une fois. Une seule invite UAC, puis plus jamais.
  async function withGameRights(op, what) {
    const who = what || 'cosmétiques';
    let r = await op();
    if (r && r.ok === false && (r.code === 'EACCES' || r.code === 'EPERM')
        && process.platform === 'win32') {
      log(who + ' : accès refusé, élévation pour poser les droits…');
      try { await enableStatsApi(config.get().statsApiPort, { forceElevate: true }); }
      catch (e) { log(who + ' : élévation échouée : ' + e.message); }
      repair.refreshFlag();
      r = await op();
    }
    return result(r);
  }

  // Appel protégé : le module est créé une fois l'application prête.
  const call = (fn) => (ctx.cosmetics ? fn(ctx.cosmetics) : NO_MODULE);

  ipcMain.handle('cosmetics-list', () => (ctx.cosmetics ? ctx.cosmetics.list()
    : { installs: [], swaps: [], gameRunning: false }));
  ipcMain.handle('cosmetics-targets', (_e, install, query) =>
    (ctx.cosmetics ? ctx.cosmetics.targets(String(install || ''), String(query || '')) : []));
  ipcMain.handle('cosmetics-add', async (_e, opts) => {
    const cosmetics = ctx.cosmetics;
    if (!cosmetics) return NO_MODULE;
    const o = opts || {};
    if (cosmetics.isGameRunning()) {
      return { ok: false, error: 'Rocket League est ouvert : ferme le jeu d’abord.' };
    }
    const ext = String(o.target || '').split('.').pop().toLowerCase();
    const r = await dialog.showOpenDialog({
      title: state.lang === 'en' ? 'Replacement file' : 'Fichier de remplacement',
      properties: ['openFile'],
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    return result(cosmetics.add({
      install: o.install, target: o.target, label: o.label, sourcePath: r.filePaths[0],
    }));
  });
  ipcMain.handle('cosmetics-presets', () => (ctx.cosmetics ? ctx.cosmetics.presets() : []));
  ipcMain.handle('cosmetics-check-targets', (_e, id, install) =>
    (ctx.cosmetics ? ctx.cosmetics.checkTargets(id, install) : { ok: false, error: 'indisponible' }));
  ipcMain.handle('cosmetics-add-preset', (_e, id, opts) =>
    result(call((c) => c.addPreset(String(id || ''), opts || {}))));
  ipcMain.handle('cosmetics-apply', (_e, id) =>
    withGameRights(() => call((c) => c.apply(String(id || '')))));
  ipcMain.handle('cosmetics-restore', (_e, id) =>
    withGameRights(() => call((c) => c.restore(String(id || '')))));
  ipcMain.handle('cosmetics-remove', (_e, id) =>
    result(call((c) => c.remove(String(id || '')))));
  ipcMain.handle('cosmetics-toggle', (_e, id, enabled) =>
    result(call((c) => c.toggle(String(id || ''), !!enabled))));
  ipcMain.handle('cosmetics-apply-all', () => withGameRights(() => call((c) => c.applyAll())));
  ipcMain.handle('cosmetics-restore-all', () => withGameRights(() => call((c) => c.restoreAll())));

  return { refresh, withGameRights };
};
