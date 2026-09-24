// maps.js — Cartes workshop sur Epic : bibliothèque et emplacement Underpass.
//
// La version Epic de Rocket League n'a pas d'onglet Workshop. La méthode de
// la communauté (rl-map-loader, le greffon Workshop Map Loader de
// BakkesMod) : remplacer le paquet d'une carte d'entraînement par le .udk de
// la carte voulue, puis lancer cette carte en Entraînement libre. On fait la
// même chose, sur Labs_Underpass_P.upk.
//
// Pourquoi Underpass : c'est l'emplacement qu'utilisent les outils existants,
// donc celui dont on sait qu'il charge les cartes workshop. En ligne, il
// n'apparaît que dans la rotation des modes extra (Rumble) : voir guardQueue.
//
// Ce module ne dépend PAS d'Electron : les téléchargements arrivent sous
// forme de fichiers déjà sur disque (maps-browser.js s'en charge), ce qui
// garde toute la partie fichiers vérifiable par `node --test`.
//
// Règles tirées des cosmétiques et de l'ini de la Stats API :
//  • l'original est sauvegardé depuis le jeu, jamais depuis un fichier que
//    nous avons écrit : l'empreinte de ce qu'on a posé dit si le fichier en
//    place est encore le nôtre ;
//  • si le jeu a remis son fichier (mise à jour, vérification Epic), on ne
//    le restaure PAS avec une sauvegarde devenue périmée : on la jette.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');
const { TAG } = require('./upk');
const { fingerprint, pathKey } = require('./cosmetics');

const SUB = path.join('TAGame', 'CookedPCConsole');
const SLOT = 'Labs_Underpass_P.upk';
const MAX_MAPS = 200;
const MAX_PREVIEW = 3 * 1024 * 1024;
const MAX_TITLE = 120;

// Files où Underpass ne peut pas sortir : les modes classiques, en casual
// comme en classé. Toute autre file (Rumble, modes extra, tournois, playlist
// inconnue) remet l'original avant que le jeu ne charge une carte : un
// client qui chargerait une carte workshop dans un vrai match serait
// désynchronisé du serveur.
const SAFE_PLAYLISTS = new Set([1, 2, 3, 4, 10, 11, 12, 13]);

function sameFp(a, b) {
  return !!(a && b && a.size === b.size && a.mtime === b.mtime);
}

function shortKey(p) {
  return crypto.createHash('sha1').update(pathKey(p)).digest('hex').slice(0, 12);
}

// Un paquet Unreal commence par la signature 0x9E2A83C1. Un .udk de carte
// aussi : c'est le même format. Tout le reste est refusé avant d'approcher
// le dossier du jeu.
function isPackage(buf) {
  return !!(buf && buf.length >= 4 && buf.readUInt32LE(0) === TAG);
}

function imageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Nom lisible tiré d'un nom de fichier du CDN :
// « 6516c70f…-LethIceRings_1.0.0.zip » donne « LethIceRings ».
function titleFromFile(name) {
  let t = path.basename(String(name || '')).replace(/\.[a-z0-9]+$/i, '');
  t = t.replace(/^[0-9a-f]{32}-/i, '').replace(/[_ -]v?\d+(\.\d+)+$/i, '');
  t = t.replace(/_/g, ' ').trim();
  return t || 'Carte';
}

function cleanText(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
    .trim().slice(0, max);
}

async function copyAtomic(src, dest) {
  const tmp = dest + '.rlst-tmp';
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dest);
}

function explain(e) {
  const code = e && e.code;
  if (code === 'EBUSY') {
    return 'Rocket League utilise la carte en ce moment : reviens au menu principal, puis réessaie.';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'Accès refusé au dossier du jeu.';
  }
  if (code === 'ENOSPC') return 'Disque plein.';
  return (e && e.message) || String(e);
}

class MapLibrary {
  // opts.detectInstalls : () => [chemins d'installation valides]
  // opts.log            : (msg) => void
  constructor(userDataDir, opts) {
    const o = opts || {};
    this.dir = path.join(userDataDir, 'maps');
    this.file = path.join(this.dir, 'library.json');
    this.filesDir = path.join(this.dir, 'files');
    this.backupsDir = path.join(this.dir, 'backups');
    this.incomingDir = path.join(this.dir, 'incoming');
    this.detectInstalls = o.detectInstalls || (() => []);
    this.log = o.log || (() => {});
    this.now = o.now || Date.now;
    this.maps = [];
    // installs : { [clé] : { install, writtenFp } } — ce qu'on a posé où.
    this.slot = { loaded: null, installs: {} };
    // Dernière carte que le jeu a remplacée de lui-même, pour le dire.
    this.reverted = null;
    // Les opérations qui écrivent passent une par une : un clic sur
    // « Charger » pendant que la garde de file remet Underpass ne doit pas
    // entrelacer deux copies sur le même fichier.
    this._queue = Promise.resolve();
    this._busy = 0;
    this._load();
  }

  _serial(fn) {
    const wrapped = async () => {
      this._busy++;
      try { return await fn(); } finally { this._busy--; }
    };
    const run = this._queue.then(wrapped, wrapped);
    this._queue = run.catch(() => {});
    return run;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.maps = Array.isArray(raw.maps) ? raw.maps.filter((m) => m && m.id) : [];
      if (raw.slot && typeof raw.slot === 'object') {
        this.slot = { loaded: raw.slot.loaded || null,
          installs: raw.slot.installs && typeof raw.slot.installs === 'object' ? raw.slot.installs : {} };
      }
      this.reverted = raw.reverted || null;
    } catch (e) { /* bibliothèque vide */ }
  }

  _persist() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ maps: this.maps, slot: this.slot,
        reverted: this.reverted }, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('cartes : écriture de library.json impossible : ' + e.message); }
  }

  installs() {
    try { return this.detectInstalls().filter((p) => typeof p === 'string' && p); }
    catch (e) { return []; }
  }

  _find(id) { return this.maps.find((m) => m.id === id) || null; }
  _mapPath(m) { return path.join(this.filesDir, m.file); }
  _backupPath(install) { return path.join(this.backupsDir, shortKey(install), SLOT); }
  _slotPath(install) { return path.join(install, SUB, SLOT); }

  // ───────── Lecture ─────────

  // Le fichier en place est-il encore celui qu'on a posé ? Sinon le jeu l'a
  // remis (mise à jour, vérification) : l'état et la sauvegarde sont
  // périmés, on les oublie. Appelé avant toute lecture de l'état.
  refresh() {
    // Pendant une copie, le fichier en place change sous nos pieds : le
    // prendre pour une remise par le jeu effacerait la sauvegarde du vrai
    // original. On attend que l'opération se termine.
    if (this._busy) return;
    const keys = Object.keys(this.slot.installs);
    if (!keys.length) return;
    let changed = false;
    for (const k of keys) {
      const st = this.slot.installs[k];
      if (sameFp(fingerprint(this._slotPath(st.install)), st.writtenFp)) continue;
      try { fs.rmSync(this._backupPath(st.install), { force: true }); } catch (e) {}
      delete this.slot.installs[k];
      changed = true;
    }
    if (changed && !Object.keys(this.slot.installs).length) {
      const m = this._find(this.slot.loaded);
      this.reverted = m ? { id: m.id, title: m.title, at: this.now() } : null;
      this.log('cartes : le jeu a remis ' + SLOT + ' (mise à jour ou vérification)');
      this.slot.loaded = null;
    }
    if (changed) this._persist();
  }

  // État de l'emplacement, pour l'interface.
  slotStatus() {
    this.refresh();
    const m = this._find(this.slot.loaded);
    return {
      target: SLOT,
      loaded: m ? { id: m.id, title: m.title } : null,
      installs: Object.values(this.slot.installs).map((s) => s.install),
      reverted: this.reverted,
    };
  }

  list() {
    const slot = this.slotStatus();
    return {
      installs: this.installs(),
      slot,
      maps: this.maps.map((m) => ({
        id: m.id, title: m.title, author: m.author || '', source: m.source,
        page: m.page || '', size: m.size, addedAt: m.addedAt,
        hasPreview: !!m.preview, loaded: slot.loaded ? slot.loaded.id === m.id : false,
        missing: !fs.existsSync(this._mapPath(m)),
      })),
    };
  }

  summary() {
    const s = this.slotStatus();
    return { count: this.maps.length, loaded: s.loaded ? s.loaded.title : null };
  }

  // Aperçu en data: URL. Demandé carte par carte par la fenêtre : renvoyer
  // toutes les images d'un coup alourdirait chaque rafraîchissement.
  preview(id) {
    const m = this._find(id);
    if (!m || !m.preview) return null;
    try {
      const buf = fs.readFileSync(path.join(this.filesDir, m.preview));
      const ext = imageExt(buf);
      if (!ext) return null;
      return 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + buf.toString('base64');
    } catch (e) { return null; }
  }

  // ───────── Import ─────────

  // `file` : .udk, .upk ou .zip déjà sur disque.
  // `meta` : { title, author, page, source, preview: Buffer } (facultatif).
  // Asynchrone : lire, décompresser et écrire 300 Mo figeait le processus
  // principal, donc le dashboard et l'overlay, pendant plus d'une seconde.
  importFile(file, meta) {
    return this._serial(() => this._import(file, meta));
  }

  async _import(file, meta) {
    const mt = meta || {};
    let buf;
    let previewBuf = Buffer.isBuffer(mt.preview) ? mt.preview : null;
    let innerName = null;
    try {
      const raw = await fsp.readFile(file);
      const ext = path.extname(file).toLowerCase();
      if (ext === '.zip') {
        const entries = zip.list(raw).filter((e) => !e.name.endsWith('/'));
        const maps = entries.filter((e) => /\.(udk|upk)$/i.test(e.name));
        if (!maps.length) {
          return { ok: false, error: 'Aucune carte (.udk ou .upk) dans cette archive.' };
        }
        // Une archive peut contenir plusieurs paquets ; la carte est le .udk,
        // et à défaut le plus gros paquet.
        maps.sort((a, b) => (/\.udk$/i.test(b.name) - /\.udk$/i.test(a.name)) || (b.size - a.size));
        buf = await zip.extractAsync(raw, maps[0]);
        innerName = maps[0].name;
        if (maps.length > 1) {
          this.log('cartes : ' + maps.length + ' paquets dans l\'archive, retenu : ' + innerName);
        }
        if (!previewBuf) {
          const img = entries.filter((e) => /\.(jpe?g|png|webp)$/i.test(e.name) && e.size <= MAX_PREVIEW)
            .sort((a, b) => b.size - a.size)[0];
          if (img) { try { previewBuf = await zip.extractAsync(raw, img); } catch (e) { previewBuf = null; } }
        }
      } else if (ext === '.udk' || ext === '.upk') {
        buf = raw;
      } else {
        return { ok: false, error: 'Format non pris en charge : il faut un .udk, un .upk ou un .zip.' };
      }
    } catch (e) {
      return { ok: false, error: 'Lecture impossible : ' + explain(e) };
    }
    if (!isPackage(buf)) {
      return { ok: false, error: 'Ce fichier n\'est pas une carte Rocket League (paquet Unreal invalide).' };
    }

    // Même contenu = même carte : un second téléchargement ne duplique rien,
    // il complète seulement ce qui manquait (titre, aperçu).
    const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const existing = this._find(id);
    if (!existing && this.maps.length >= MAX_MAPS) {
      return { ok: false, error: 'Bibliothèque pleine (' + MAX_MAPS + ' cartes) : supprimes-en une.' };
    }
    const title = cleanText(mt.title, MAX_TITLE) || titleFromFile(innerName || file);
    try {
      await fsp.mkdir(this.filesDir, { recursive: true });
      const map = existing || { id, file: id + '.udk', addedAt: this.now() };
      if (!existing || !fs.existsSync(this._mapPath(map))) {
        const dest = this._mapPath(map);
        await fsp.writeFile(dest + '.tmp', buf);
        await fsp.rename(dest + '.tmp', dest);
      }
      const pext = imageExt(previewBuf);
      if (pext && previewBuf.length <= MAX_PREVIEW && (!existing || !existing.preview)) {
        map.preview = id + '.' + pext;
        await fsp.writeFile(path.join(this.filesDir, map.preview), previewBuf);
      }
      if (!existing || mt.title) map.title = title;
      if (mt.author || !existing) map.author = cleanText(mt.author, 60);
      if (mt.page || !existing) map.page = cleanText(mt.page, 300);
      map.source = mt.source || map.source || 'fichier';
      map.size = buf.length;
      if (!existing) this.maps.unshift(map);
      this._persist();
      return { ok: true, map: { id: map.id, title: map.title }, duplicate: !!existing };
    } catch (e) {
      return { ok: false, error: 'Enregistrement impossible : ' + explain(e) };
    }
  }

  remove(id) {
    return this._serial(() => this._remove(id));
  }

  async _remove(id) {
    const m = this._find(id);
    if (!m) return { ok: false, error: 'Carte introuvable.' };
    if (this.slot.loaded === id) {
      const r = await this._restore();
      if (!r.ok) return r;
    }
    try { fs.rmSync(this._mapPath(m), { force: true }); } catch (e) {}
    if (m.preview) { try { fs.rmSync(path.join(this.filesDir, m.preview), { force: true }); } catch (e) {} }
    this.maps = this.maps.filter((x) => x.id !== id);
    this._persist();
    return { ok: true };
  }

  // ───────── Emplacement Underpass ─────────

  load(id) {
    return this._serial(() => this._loadMap(id));
  }

  async _loadMap(id) {
    const m = this._find(id);
    if (!m) return { ok: false, error: 'Carte introuvable.' };
    const src = this._mapPath(m);
    if (!fs.existsSync(src)) {
      return { ok: false, error: 'Le fichier de cette carte a disparu de la bibliothèque : supprime-la et télécharge-la à nouveau.' };
    }
    const installs = this.installs();
    if (!installs.length) return { ok: false, error: 'Aucune installation de Rocket League détectée.' };

    const done = [];
    let fail = null;
    for (const install of installs) {
      const target = this._slotPath(install);
      if (!fs.existsSync(target)) {
        fail = fail || { error: SLOT + ' introuvable dans ' + install + '.' };
        continue;
      }
      const key = pathKey(install);
      const st = this.slot.installs[key];
      const backup = this._backupPath(install);
      try {
        // Sauvegarde seulement si le fichier en place est l'original du jeu.
        // Si c'est une carte qu'on a posée, la sauvegarde existante est la
        // bonne : la recopier par-dessus détruirait le seul vrai original.
        const ours = st && sameFp(fingerprint(target), st.writtenFp) && fs.existsSync(backup);
        if (!ours) {
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await copyAtomic(target, backup);
        }
      } catch (e) {
        // Sauvegarde impossible : on n'a encore rien touché au jeu.
        fail = fail || { error: explain(e), code: e.code };
        continue;
      }
      // Copie directe et non « fichier temporaire + renommage » : sous
      // Windows, renommer par-dessus un fichier ouvert par le jeu échoue en
      // EPERM, que l'on confondrait avec un manque de droits (et qui
      // déclencherait une invite UAC inutile). La copie directe échoue, elle,
      // en EBUSY, sans rien écrire.
      const before = fingerprint(target);
      try {
        await fsp.copyFile(src, target);
        this.slot.installs[key] = { install, writtenFp: fingerprint(target) };
        done.push(install);
      } catch (e) {
        fail = fail || { error: explain(e), code: e.code };
        if (!sameFp(fingerprint(target), before)) await this._repair(key, install, target, backup);
      }
    }
    if (!done.length) {
      if (!Object.keys(this.slot.installs).length) this.slot.loaded = null;
      this._persist();
    }
    if (done.length) {
      this.slot.loaded = id;
      this.reverted = null;
      this._persist();
      this.log('cartes : « ' + m.title + ' » chargée dans ' + SLOT + ' (' + done.length + ' installation(s))');
    }
    if (fail) return Object.assign({ ok: false, installs: done }, fail);
    return { ok: true, installs: done };
  }

  // Une copie vers le jeu s'est interrompue en route (disque plein…) : le
  // paquet en place est tronqué. On remet l'original depuis la sauvegarde ;
  // si même ça échoue, on note le fichier abîmé comme « le nôtre », pour que
  // la sauvegarde soit gardée et que « Remettre Underpass » la réessaie.
  async _repair(key, install, target, backup) {
    try {
      await fsp.copyFile(backup, target);
      await fsp.rm(backup, { force: true });
      delete this.slot.installs[key];
      this.log('cartes : copie interrompue, ' + SLOT + ' d\'origine remis');
    } catch (e) {
      this.slot.installs[key] = { install, writtenFp: fingerprint(target) };
      this.log('cartes : copie interrompue ET remise impossible (' + e.message + '), sauvegarde conservée');
    }
  }

  // Remet l'original partout où une carte a été posée.
  restore() {
    return this._serial(() => this._restore());
  }

  async _restore() {
    let fail = null;
    for (const k of Object.keys(this.slot.installs)) {
      const st = this.slot.installs[k];
      const target = this._slotPath(st.install);
      const backup = this._backupPath(st.install);
      const before = fingerprint(target);
      try {
        if (sameFp(before, st.writtenFp) && fs.existsSync(backup)) {
          await fsp.copyFile(backup, target);
        }
        // Sinon le jeu a déjà remis son propre fichier, peut-être plus récent
        // que notre sauvegarde : on ne touche à rien.
        fs.rmSync(backup, { force: true });
        delete this.slot.installs[k];
      } catch (e) {
        fail = fail || { error: explain(e), code: e.code };
        // Copie interrompue : le fichier en place n'est plus celui qu'on
        // avait noté. Sans mise à jour de l'empreinte, la prochaine lecture
        // le prendrait pour une remise par le jeu et jetterait la sauvegarde,
        // seule copie de l'original.
        if (!sameFp(fingerprint(target), before)) st.writtenFp = fingerprint(target);
      }
    }
    if (!Object.keys(this.slot.installs).length) this.slot.loaded = null;
    this.reverted = null;
    this._persist();
    if (fail) return Object.assign({ ok: false }, fail);
    this.log('cartes : ' + SLOT + ' d\'origine remis en place');
    return { ok: true };
  }

  // Appelé à chaque mise en file relevée dans le journal du jeu.
  async guardQueue(q) {
    if (!this.slot.loaded || !q) return { restored: false };
    if (SAFE_PLAYLISTS.has(Number(q.playlist))) return { restored: false };
    this.log('cartes : file ' + q.playlist + ' hors modes classiques, Underpass remis par sécurité');
    const r = await this.restore();
    return { restored: r.ok, error: r.ok ? null : r.error };
  }
}

module.exports = MapLibrary;
module.exports.SLOT = SLOT;
module.exports.SAFE_PLAYLISTS = SAFE_PLAYLISTS;
module.exports.titleFromFile = titleFromFile;
module.exports.isPackage = isPackage;
