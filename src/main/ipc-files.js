// ipc-files.js — Ce que l'application écrit ou lit hors de son dossier, à la
// demande de l'utilisateur : dispositions d'overlay (export et import) et
// journal des matchs (CSV ou JSON).
//
// Extrait d'index.js.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { toCsv } = require('./csv');

// `ctx` : { state, config, log, pushState, store }.
module.exports = function registerFileIpc(ctx) {
  const { state, config, log } = ctx;
  const pushState = () => ctx.pushState();

  // Une disposition d'overlay se compose au pixel près pendant une heure : elle
  // doit pouvoir suivre l'utilisateur d'un PC à l'autre (et se partager), sans
  // quoi tout est à refaire après une réinstallation.
  const PRESET_MAX_BYTES = 256 * 1024;
  const PRESET_APP = 'rl-session-tracker';

  ipcMain.handle('export-overlay-preset', async () => {
    try {
      const cfg = config.get();
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog({
        title: state.lang === 'en' ? 'Export the overlay preset'
          : 'Exporter la disposition de l’overlay',
        defaultPath: 'overlay-' + stamp + '.rlst.json',
        filters: [{ name: 'RL Session Tracker', extensions: ['rlst.json', 'json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      // L'habillage et la palette voyagent AVEC la disposition : sans eux, le
      // fichier rouvert chez quelqu'un d'autre place bien les blocs mais ne
      // ressemble à rien de ce qui avait été composé.
      const preset = {
        app: PRESET_APP,
        v: 1,
        at: Date.now(),
        obsLayout: cfg.obsLayout || null,
        skin: cfg.skin || null,
        theme: cfg.theme || null,
        tune: cfg.tune || null,
        canvas: (cfg.obs && cfg.obs.canvas) || null,
      };
      fs.writeFileSync(r.filePath, JSON.stringify(preset, null, 2) + '\n');
      log('disposition d’overlay exportée vers ' + r.filePath);
      return { ok: true, file: r.filePath };
    } catch (e) {
      log('export de la disposition échoué : ' + e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('import-overlay-preset', async () => {
    try {
      const r = await dialog.showOpenDialog({
        title: state.lang === 'en' ? 'Import an overlay preset'
          : 'Importer une disposition d’overlay',
        properties: ['openFile'],
        filters: [{ name: 'RL Session Tracker', extensions: ['rlst.json', 'json'] }],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
      const file = r.filePaths[0];
      // Fichier VENU DE L'EXTÉRIEUR : on borne la taille AVANT de lire (une
      // disposition pèse quelques kilo-octets ; au-delà, ce n'en est pas une), et
      // on revérifie après lecture — le fichier a pu grossir entre les deux.
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { size = 0; }
      if (size > PRESET_MAX_BYTES) {
        return { ok: false, error: 'Fichier trop volumineux : ce n’est pas une disposition.' };
      }
      const raw = fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(raw) > PRESET_MAX_BYTES) {
        return { ok: false, error: 'Fichier trop volumineux : ce n’est pas une disposition.' };
      }
      let data;
      try { data = JSON.parse(raw); }
      catch (e) { return { ok: false, error: 'Fichier illisible : ce n’est pas du JSON valide.' }; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'Fichier invalide : disposition attendue.' };
      }
      if (data.app !== PRESET_APP) {
        return { ok: false, error: 'Ce fichier ne vient pas de RL Session Tracker.' };
      }
      // Une version FUTURE peut contenir des clés dont le sens nous échappe :
      // appliquer ce qu'on en comprend donnerait un résultat à moitié juste, plus
      // déroutant qu'un refus franc.
      const v = Number(data.v);
      if (!Number.isFinite(v) || v > 1) {
        return { ok: false, error: 'Disposition créée par une version plus récente de l’application.' };
      }
      // Tout passe par config.update : c'est LUI qui borne les positions, filtre
      // l'habillage par liste blanche et rejette une couleur qui n'est pas un
      // hexadécimal. Dupliquer cette validation ici, c'est la voir diverger.
      const partial = {};
      const obj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
      if (obj(data.obsLayout)) partial.obsLayout = data.obsLayout;
      if (typeof data.skin === 'string') partial.skin = data.skin;
      if (obj(data.theme)) partial.theme = data.theme;
      if (obj(data.tune)) partial.tune = data.tune;
      if (obj(data.canvas)) partial.obs = { canvas: data.canvas };
      // Un fichier bien formé mais vide s'appliquerait « avec succès » sans rien
      // changer : l'utilisateur croirait avoir importé sa disposition.
      if (!Object.keys(partial).length) {
        return { ok: false, error: 'Ce fichier ne contient aucune disposition.' };
      }
      config.update(partial);
      pushState();
      const name = path.basename(file);
      log('disposition d’overlay importée depuis ' + file);
      return { ok: true, name: name };
    } catch (e) {
      log('import de la disposition échoué : ' + e.message);
      return { ok: false, error: e.message };
    }
  });

  // Aperçu d'un habillage : rediffusé tel quel aux fenêtres, jamais écrit dans
  // la configuration. C'est la fenêtre qui l'a lancé qui décide d'appliquer.
  ipcMain.on('preview-look', (_e, look) => {
    const clean = look && typeof look === 'object'
      ? { skin: String(look.skin || '').slice(0, 24), theme: look.theme } : null;
    windows.broadcast('look-preview', clean);
  });


  ipcMain.handle('media-command', (_e, cmd) =>
    (media ? media.command(String(cmd || '')) : { ok: false, error: 'indisponible' }));

  ipcMain.on('open-control', (_e, section) => {
    windows.showControl();
    const w = windows.getControl();
    if (w && typeof section === 'string') {
      try { w.webContents.send('goto-section', section.slice(0, 24)); } catch (e) {}
    }
  });

  ipcMain.on('open-overlay-composer', () => {
    const w = windows.openOverlayComposer();
    // La fenêtre reçoit l'état comme les autres (windows.broadcast la couvre
    // dès qu'elle existe) ; on pousse tout de suite pour ne pas attendre.
    if (w) w.webContents.once('did-finish-load', () => pushState());
  });

  ipcMain.handle('export-matches', async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog({
        title: state.lang === 'en' ? 'Export matches' : 'Exporter les matchs',
        defaultPath: 'rl-matchs-' + stamp + '.csv',
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      // Le point de vue du joueur (victoire/défaite, stats perso) est dérivé au
      // calcul : on exporte donc l'historique évalué, pas les données brutes.
      const rows = ctx.store.exportRows(config.get().pseudo);
      const json = /\.json$/i.test(r.filePath);
      fs.writeFileSync(r.filePath,
        json ? JSON.stringify(rows, null, 2) + '\n' : toCsv(rows, config.get().pseudo));
      log('export de ' + rows.length + ' match(s) vers ' + r.filePath);
      return { ok: true, file: r.filePath, count: rows.length };
    } catch (e) {
      log('export échoué : ' + e.message);
      return { ok: false, error: e.message };
    }
  });
};
