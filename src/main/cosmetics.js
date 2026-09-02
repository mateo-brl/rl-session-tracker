// cosmetics.js — Swaps cosmétiques : remplacer un paquet du jeu par un autre.
//
// C'est le SEUL module de l'application qui touche aux fichiers de Rocket
// League, et il est optionnel. Le principe est celui de Shift, RLPeak ou
// Bakkboard : un fichier `.upk` (ou une paire `.upk` + `.bnk` pour un boost)
// vient remplacer un paquet original dans TAGame\CookedPCConsole, côté client
// uniquement — seul le joueur voit le changement. Aucune injection, aucune
// lecture mémoire : de la copie de fichiers, jeu fermé.
//
// Ce que ce module fait MIEUX que les outils existants, et qui justifie son
// existence ici :
//  • l'original est sauvegardé UNE fois, jamais écrasé par une sauvegarde
//    ultérieure (leçon de l'ini de la Stats API : une seconde sauvegarde
//    recopiait le fichier déjà restauré par Steam) ;
//  • la restauration est un clic, et retirer un swap restaure d'abord ;
//  • une mise à jour du jeu ou une vérification d'intégrité Steam remet les
//    originaux — c'est DÉTECTÉ (empreinte du fichier) et les swaps sont
//    réappliqués automatiquement au prochain moment sûr, alors que RLPeak et
//    VelocityRL laissent l'utilisateur cliquer « tout réappliquer » ;
//  • rien n'est jamais écrit pendant que Rocket League tourne.
//
// Aucun asset n'est embarqué ni téléchargé : les fichiers viennent du disque
// de l'utilisateur (paquets déjà présents dans son installation, ou fichiers
// préparés récupérés par lui). Redistribuer des paquets du jeu n'est pas notre
// affaire.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const upk = require('./upk');

const SUB = path.join('TAGame', 'CookedPCConsole');
const EXTS = ['.upk', '.bnk'];
const MAX_TARGETS = 200;
const MAX_SWAPS = 64;

// Empreinte bon marché d'un fichier : taille + date de modification. Suffit à
// savoir si un paquet de plusieurs dizaines de Mo a été remplacé (par Steam
// ou par nous) sans le hacher à chaque contrôle.
function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch (e) { return null; }
}

function sameFp(a, b) {
  return !!(a && b && a.size === b.size && a.mtime === b.mtime);
}

// Un nom de cible est un simple nom de fichier de CookedPCConsole — jamais un
// chemin. Le renderer ne doit pas pouvoir viser autre chose.
function validTarget(name) {
  const n = String(name || '');
  if (!n || n.length > 200) return false;
  if (n.includes('/') || n.includes('\\') || n.includes('..') || n.includes('\0')) return false;
  return EXTS.includes(path.extname(n).toLowerCase());
}

// Clé d'une installation : chemin résolu, séparateurs unifiés, casse ignorée
// sous Windows. Deux orthographes du même dossier doivent donner la même clé —
// sinon la même installation a deux sauvegardes, et la seconde peut capturer
// un fichier déjà remplacé par la première (constaté en jeu : boost
// transparent puis jeu figé).
function pathKey(p) {
  let out = path.resolve(String(p));
  if (process.platform === 'win32') out = out.replace(/\//g, '\\').toLowerCase();
  return out;
}

function short(p) {
  return crypto.createHash('sha1').update(pathKey(p)).digest('hex').slice(0, 12);
}

// Préréglages : des swaps dont la SOURCE est un paquet déjà présent dans
// l'installation du joueur. Rien n'est téléchargé ni redistribué — c'est la
// possession qui est côté serveur, pas le fichier.
//
// Alpha Boost : le paquet « Gold Rush (Alpha Reward) » est chez tout le monde
// sous Boost_AlphaReward_SF.upk. Le copier par-dessus le paquet d'un boost
// qu'on possède (Bubbles par convention communautaire : jamais peint, donc
// aucun conflit) suffit — pour les boosts, la copie brute fonctionne sans
// réécrire la table des noms, contrairement aux carrosseries ou explosions.
// Testé en jeu (2 septembre 2026) : la copie brute du paquet Alpha par-dessus
// Bubbles donne un boost TRANSPARENT — le moteur cherche des objets nommés
// « Boost_Bubble… » dans le fichier et n'y trouve que des « Boost_AlphaReward… ».
// Le préréglage passe donc par le patcheur (upk.js) : les entrées de la table
// des noms sont renommées à longueur constante dans l'en-tête chiffré, le
// corps du paquet reste intact. C'est exactement ce que contiennent les
// fichiers « préparés » que la communauté partage.
const PRESETS_ENABLED = true;
const PRESETS = {
  alpha: {
    label: 'Alpha Boost',
    source: 'Boost_AlphaReward_SF.upk',
    recommended: 'Boost_Bubble_SF.upk',
    targetPattern: /^Boost_.*_SF\.upk$/i,
    patch: true,
  },
};

class Cosmetics {
  // opts.detectInstalls : () => [chemins d'installation valides]
  // opts.isGameRunning  : () => bool  (on ne touche à rien jeu ouvert)
  // opts.log            : (msg) => void
  constructor(userDataDir, opts) {
    const o = opts || {};
    this.dir = path.join(userDataDir, 'cosmetics');
    this.file = path.join(this.dir, 'swaps.json');
    this.filesDir = path.join(this.dir, 'files');
    this.backupsDir = path.join(this.dir, 'backups');
    this.detectInstalls = o.detectInstalls || (() => []);
    this.isGameRunning = o.isGameRunning || (() => false);
    this.log = o.log || (() => {});
    this._presetsForced = !!o.presets;   // tests : exercer le préréglage retiré
    this.swaps = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.swaps = Array.isArray(raw.swaps) ? raw.swaps : [];
    } catch (e) { this.swaps = []; }
  }

  _persist() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ swaps: this.swaps }, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('cosmétiques : écriture de swaps.json impossible : ' + e.message); }
  }

  // ───────── Chemins ─────────
  installs() {
    try { return this.detectInstalls().filter((p) => typeof p === 'string' && p); }
    catch (e) { return []; }
  }

  _checkInstall(install) {
    const k = pathKey(install);
    return this.installs().some((p) => pathKey(p) === k);
  }

  _sameInstall(a, b) {
    return pathKey(a) === pathKey(b);
  }

  _targetPath(install, target) {
    return path.join(install, SUB, target);
  }

  _backupPath(install, target) {
    return path.join(this.backupsDir, short(install), target);
  }

  // ───────── Lecture ─────────
  // Fichiers remplaçables d'une installation, filtrés — les paquets se
  // comptent par milliers, on ne renvoie jamais tout.
  targets(install, query) {
    if (!this._checkInstall(install)) return [];
    const q = String(query || '').trim().toLowerCase();
    let names;
    try { names = fs.readdirSync(path.join(install, SUB)); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      if (!EXTS.includes(path.extname(n).toLowerCase())) continue;
      if (q && !n.toLowerCase().includes(q)) continue;
      out.push(n);
      if (out.length >= MAX_TARGETS) break;
    }
    return out.sort();
  }

  status(swap) {
    const target = this._targetPath(swap.install, swap.target);
    const fp = fingerprint(target);
    if (!fp) return 'missing';
    if (!swap.appliedFp) return 'pending';
    return sameFp(fp, swap.appliedFp) ? 'applied' : 'reverted';
  }

  list() {
    return {
      installs: this.installs(),
      swaps: this.swaps.map((s) => ({
        id: s.id, label: s.label, install: s.install, target: s.target,
        kind: s.kind, enabled: s.enabled !== false, status: this.status(s),
      })),
      gameRunning: !!this.isGameRunning(),
    };
  }

  summary() {
    let applied = 0;
    let reverted = 0;
    for (const s of this.swaps) {
      if (s.enabled === false) continue;
      const st = this.status(s);
      if (st === 'applied') applied++;
      else if (st === 'reverted') reverted++;
    }
    return { count: this.swaps.length, applied, reverted, gameRunning: !!this.isGameRunning() };
  }

  // ───────── Écriture ─────────
  _guard() {
    if (this.isGameRunning()) return 'Rocket League est ouvert : ferme le jeu d’abord.';
    return null;
  }

  add(opts) {
    const o = opts || {};
    const install = String(o.install || '');
    const target = String(o.target || '');
    const sourceRef = o.sourceRef ? String(o.sourceRef) : null;
    if (!this._checkInstall(install)) return { ok: false, error: 'Installation inconnue.' };
    if (!validTarget(target)) return { ok: false, error: 'Fichier cible invalide.' };
    if (sourceRef && !validTarget(sourceRef)) return { ok: false, error: 'Fichier source invalide.' };
    if (sourceRef && sourceRef.toLowerCase() === target.toLowerCase()) {
      return { ok: false, error: 'La source et la cible sont le même fichier.' };
    }
    const source = sourceRef ? this._targetPath(install, sourceRef) : String(o.sourcePath || '');
    if (this.swaps.length >= MAX_SWAPS) return { ok: false, error: 'Trop de swaps.' };
    const targetPath = this._targetPath(install, target);
    if (!fs.existsSync(targetPath)) return { ok: false, error: 'Le fichier cible n’existe pas dans le jeu.' };
    const ext = path.extname(target).toLowerCase();
    if (path.extname(source).toLowerCase() !== ext) {
      return { ok: false, error: 'Le remplaçant doit être un ' + ext + ' comme la cible.' };
    }
    if (!fs.existsSync(source)) return { ok: false, error: 'Fichier de remplacement introuvable.' };
    // Une cible ne peut porter qu'un swap : deux remplaçants se battraient.
    if (this.swaps.some((s) => this._sameInstall(s.install, install)
        && s.target.toLowerCase() === target.toLowerCase())) {
      return { ok: false, error: 'Ce fichier a déjà un swap.' };
    }

    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const kept = path.join(this.filesDir, id, path.basename(source));
    try {
      // Copie interne : l'utilisateur peut ensuite supprimer ou déplacer son
      // fichier, le swap reste réapplicable après une mise à jour du jeu.
      fs.mkdirSync(path.dirname(kept), { recursive: true });
      fs.copyFileSync(source, kept);
    } catch (e) {
      return { ok: false, error: 'Copie impossible : ' + e.message };
    }
    const swap = {
      id, label: String(o.label || target).slice(0, 80),
      install, target, kind: ext.slice(1),
      source: kept, sourceRef: sourceRef, enabled: true, appliedFp: null, addedAt: Date.now(),
      // Paires de renommage à appliquer au paquet avant la copie (préréglages).
      patch: (o.patch && Array.isArray(o.patch.pairs)) ? { pairs: o.patch.pairs } : null,
    };
    this.swaps.push(swap);
    this._persist();
    return { ok: true, swap: { ...swap, status: 'pending' } };
  }

  // Préréglages disponibles, par installation : le paquet source doit exister
  // chez le joueur, et on propose les cibles plausibles (les boosts), avec la
  // recommandation communautaire en tête si elle est présente.
  presets() {
    const out = [];
    if (!PRESETS_ENABLED && !this._presetsForced) return out;
    for (const install of this.installs()) {
      for (const id of Object.keys(PRESETS)) {
        const p = PRESETS[id];
        const available = fs.existsSync(this._targetPath(install, p.source));
        let targets = [];
        if (available) {
          try {
            targets = fs.readdirSync(path.join(install, SUB))
              .filter((n) => p.targetPattern.test(n) && n.toLowerCase() !== p.source.toLowerCase())
              .sort();
          } catch (e) { targets = []; }
        }
        const active = this.swaps.find((s) => s.install === install
          && s.sourceRef && s.sourceRef.toLowerCase() === p.source.toLowerCase());
        out.push({
          id, install, label: p.label, source: p.source, available, targets,
          recommended: targets.includes(p.recommended) ? p.recommended : null,
          active: active ? active.id : null,
        });
      }
    }
    return out;
  }

  addPreset(id, opts) {
    const p = PRESETS[id];
    if (!p) return { ok: false, error: 'Préréglage inconnu.' };
    if (!PRESETS_ENABLED && !this._presetsForced) {
      return { ok: false, error: 'Préréglage indisponible : la copie brute ne fonctionne pas, utilise un fichier préparé.' };
    }
    const o = opts || {};
    const target = String(o.target || '');
    if (!p.targetPattern.test(target)) return { ok: false, error: 'Cette cible n’est pas un boost.' };
    return this.add({
      install: o.install, target, label: p.label, sourceRef: p.source,
      patch: p.patch ? { pairs: upk.pairsFor(p.source, target) } : null,
    });
  }

  _keys() {
    return upk.loadKeys(path.join(this.dir, 'keys.txt'));
  }

  // Écrit un rapport lisible sur la source et la cible : en-tête compris ou
  // non, clé trouvée, premiers noms. C'est ce qu'il faut envoyer quand un
  // patch échoue.
  _writeDiagnostic(s, sourceFile, targetFile, error) {
    try {
      const dir = path.join(this.dir, 'diagnostics');
      fs.mkdirSync(dir, { recursive: true });
      const keys = this._keys();
      const rep = {
        at: new Date().toISOString(), swap: s.label, target: s.target,
        pairs: s.patch && s.patch.pairs, error: String(error),
        source: upk.inspect(fs.readFileSync(sourceFile), keys),
        destination: fs.existsSync(targetFile)
          ? upk.inspect(fs.readFileSync(targetFile), keys) : { error: 'absent' },
      };
      const file = path.join(dir, s.id + '.json');
      fs.writeFileSync(file, JSON.stringify(rep, null, 2) + '\n');
      return file;
    } catch (e) { return null; }
  }

  // Cibles compatibles : celles dont tous les noms tiennent dans ceux de la
  // source. Sert à proposer autre chose quand la cible choisie est trop longue.
  _compatible(install, sourceRef, limit) {
    const out = [];
    try {
      const keys = this._keys();
      const src = fs.readFileSync(this._targetPath(install, sourceRef));
      const sn = upk.namesOf(src, keys);
      // Lecture directe du dossier : targets() plafonne sa liste, or on cherche
      // ici parmi TOUS les boosts.
      let all = [];
      let tried = 0;
      try { all = fs.readdirSync(path.join(install, SUB)); } catch (e) { return out; }
      for (const t of all.sort()) {
        if (!/^Boost_.*_SF\.upk$/i.test(t) || t.toLowerCase() === String(sourceRef).toLowerCase()) continue;
        if (++tried > 200) break;
        try {
          const tn = upk.namesOf(fs.readFileSync(this._targetPath(install, t)), keys);
          const pairs = upk.pairsFor(sourceRef, t).concat(upk.rolePairs(sn, tn));
          // Seul juge fiable : tenter le patch pour de vrai, en mémoire.
          upk.patchPackage(src, { pairs, keys });
          out.push(t.replace(/\.upk$/i, '').replace(/^Boost_/i, '').replace(/_SF$/i, ''));
        } catch (e) { /* ne convient pas ou paquet illisible */ }
        if (out.length >= (limit || 8)) break;
      }
    } catch (e) { /* pas de suggestion possible */ }
    return out;
  }

  // Passe en revue TOUTES les cibles possibles d'un préréglage et dit, pour
  // chacune, si le patch tiendrait. Le seul juge fiable étant le patch
  // lui-même, on le tente en mémoire ; rien n'est écrit.
  checkTargets(id, install) {
    const p = PRESETS[id];
    if (!p) return { ok: false, error: 'Préréglage inconnu.' };
    if (!this._checkInstall(install)) return { ok: false, error: 'Installation inconnue.' };
    const keys = this._keys();
    let src;
    try { src = fs.readFileSync(this._targetPath(install, p.source)); }
    catch (e) { return { ok: false, error: 'Paquet source introuvable : ' + p.source }; }
    let sn;
    try { sn = upk.namesOf(src, keys); }
    catch (e) { return { ok: false, error: 'Paquet source illisible : ' + e.message }; }

    let all = [];
    try { all = fs.readdirSync(path.join(install, SUB)); } catch (e) { /* vide */ }
    const good = [], bad = [];
    for (const t of all.sort()) {
      if (!p.targetPattern.test(t) || t.toLowerCase() === p.source.toLowerCase()) continue;
      const short = t.replace(/\.upk$/i, '');
      try {
        const tn = upk.namesOf(fs.readFileSync(this._targetPath(install, t)), keys);
        const pairs = upk.pairsFor(p.source, t).concat(upk.rolePairs(sn, tn));
        upk.patchPackage(src, { pairs, keys });
        good.push(short);
      } catch (e) {
        bad.push({ name: short, reason: e.message });
      }
    }
    this.log('cosmétiques : vérification des cibles — ' + good.length + ' compatible(s), '
      + bad.length + ' non');
    return { ok: true, compatible: good, incompatible: bad };
  }

  _preparePatched(s, sourceFile, targetFile) {
    try {
      const keys = this._keys();
      const buf = fs.readFileSync(sourceFile);
      // Rechiffrer avec la clé du paquet DESTINATION : c'est le nom du fichier
      // qui décide de la clé côté jeu. Si la cible n'est pas déchiffrable
      // (clé inconnue), on garde celle de la source — Alpha et Bubble
      // partagent la même.
      let outKey = null;
      try { outKey = fs.existsSync(targetFile) ? upk.keyOf(fs.readFileSync(targetFile), keys) : null; }
      catch (e) { outKey = null; }
      // Les paires sont recalculées ICI, sur les deux paquets tels qu'ils sont
      // dans le jeu : une mise à jour peut renommer des objets.
      let pairs = s.patch.pairs || [];
      if (s.sourceRef && fs.existsSync(targetFile)) {
        try {
          const sn = upk.namesOf(buf, keys);
          const tn = upk.namesOf(fs.readFileSync(targetFile), keys);
          pairs = upk.pairsFor(s.sourceRef, s.target).concat(upk.rolePairs(sn, tn));
        } catch (e) {
          if (/ne convient pas/.test(e.message)) throw e;
          // Cible illisible : on retombe sur les paires déduites des noms de fichiers.
        }
      }
      let r;
      try {
        r = upk.patchPackage(buf, { pairs, keys, outKey });
      } catch (e) {
        if (/il manque/.test(e.message)) {
          const alt = this._compatible(s.install, s.sourceRef, 8);
          throw new Error('ce boost ne convient pas : ' + e.message
            + (alt.length ? '. Boosts compatibles : ' + alt.join(', ') : ''));
        }
        throw e;
      }
      const out = path.join(path.dirname(s.source), 'patched-' + s.target);
      fs.writeFileSync(out, r.buffer);
      this.log('cosmétiques : paquet patché pour « ' + s.label + ' » (' + r.changed.length
        + ' nom(s) renommé(s), clé n°' + r.keyIndex + ')');
      return { ok: true, file: out, changed: r.changed };
    } catch (e) {
      if (/ne convient pas/.test(e.message)) {
        this.log('cosmétiques : cible refusée pour « ' + s.label + ' » : ' + e.message);
        return { ok: false, error: e.message };
      }
      const rep = this._writeDiagnostic(s, sourceFile, targetFile, e.message);
      this.log('cosmétiques : patch impossible pour « ' + s.label + ' » : ' + e.message);
      return { ok: false, error: 'Patch du paquet impossible : ' + e.message
        + (rep ? ' — rapport : ' + rep : '') };
    }
  }

  _find(id) {
    return this.swaps.find((s) => s.id === id) || null;
  }

  apply(id) {
    const g = this._guard();
    if (g) return { ok: false, error: g };
    const s = this._find(id);
    if (!s) return { ok: false, error: 'Swap inconnu.' };
    if (!this._checkInstall(s.install)) return { ok: false, error: 'Installation introuvable.' };
    const target = this._targetPath(s.install, s.target);
    const backup = this._backupPath(s.install, s.target);
    if (!fs.existsSync(target)) return { ok: false, error: 'Le fichier cible n’existe plus dans le jeu.' };
    // Préréglage : la source vit dans le jeu lui-même — on la prend là, elle
    // suit les mises à jour. La copie interne ne sert que si elle a disparu.
    let source = s.source;
    if (s.sourceRef) {
      const live = this._targetPath(s.install, s.sourceRef);
      if (fs.existsSync(live)) source = live;
    }
    if (!fs.existsSync(source)) return { ok: false, error: 'Fichier de remplacement perdu.' };
    // Préréglage : le paquet est PATCHÉ (noms renommés) avant d'être copié.
    // Un échec ici n'écrit rien dans le jeu et laisse un rapport de
    // diagnostic — c'est sur des données réelles qu'on corrige, pas à l'aveugle.
    if (s.patch && s.patch.pairs) {
      const prepared = this._preparePatched(s, source, target);
      if (!prepared.ok) return prepared;
      source = prepared.file;
    }
    try {
      // Sauvegarde UNE seule fois : si elle existe, c'est l'original — même
      // si Steam vient de remettre le fichier d'origine, on ne la touche pas.
      if (!fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup);
      }
      fs.copyFileSync(source, target);
    } catch (e) {
      return { ok: false, error: this._explain(e), code: e && e.code };
    }
    s.appliedFp = fingerprint(target);
    this._persist();
    this.log('cosmétiques : appliqué « ' + s.label + ' » sur ' + s.target);
    return { ok: true };
  }

  restore(id) {
    const g = this._guard();
    if (g) return { ok: false, error: g };
    const s = this._find(id);
    if (!s) return { ok: false, error: 'Swap inconnu.' };
    const target = this._targetPath(s.install, s.target);
    const backup = this._backupPath(s.install, s.target);
    if (!fs.existsSync(backup)) {
      // Jamais appliqué (ou sauvegarde perdue) : rien à remettre.
      s.appliedFp = null;
      this._persist();
      return { ok: true, restored: false };
    }
    try { fs.copyFileSync(backup, target); }
    catch (e) { return { ok: false, error: this._explain(e), code: e && e.code }; }
    s.appliedFp = null;
    this._persist();
    this.log('cosmétiques : restauré ' + s.target);
    return { ok: true, restored: true };
  }

  remove(id) {
    const s = this._find(id);
    if (!s) return { ok: false, error: 'Swap inconnu.' };
    if (this.status(s) === 'applied') {
      const r = this.restore(id);
      if (!r.ok) return r;
    }
    this.swaps = this.swaps.filter((x) => x.id !== id);
    this._persist();
    try { fs.rmSync(path.dirname(s.source), { recursive: true, force: true }); } catch (e) {}
    return { ok: true };
  }

  toggle(id, enabled) {
    const s = this._find(id);
    if (!s) return { ok: false, error: 'Swap inconnu.' };
    s.enabled = enabled !== false;
    this._persist();
    return { ok: true };
  }

  applyAll() {
    const g = this._guard();
    if (g) return { ok: false, error: g };
    const errors = [];
    let code = null;
    for (const s of this.swaps) {
      if (s.enabled === false) continue;
      const r = this.apply(s.id);
      if (!r.ok) { errors.push(s.label + ' : ' + r.error); code = code || r.code || null; }
    }
    return errors.length ? { ok: false, error: errors.join(' · '), code } : { ok: true };
  }

  restoreAll() {
    const g = this._guard();
    if (g) return { ok: false, error: g };
    const errors = [];
    let code = null;
    for (const s of this.swaps) {
      const r = this.restore(s.id);
      if (!r.ok) { errors.push(s.label + ' : ' + r.error); code = code || r.code || null; }
    }
    return errors.length ? { ok: false, error: errors.join(' · '), code } : { ok: true };
  }

  // Après une mise à jour du jeu ou une vérification Steam : les swaps
  // activés dont l'original est revenu sont remis en place. Appelé aux
  // moments sûrs (fermeture du jeu, lancement de l'application).
  reapplyReverted() {
    if (this.isGameRunning()) return { count: 0 };
    let count = 0;
    for (const s of this.swaps) {
      if (s.enabled === false || this.status(s) !== 'reverted') continue;
      if (this.apply(s.id).ok) count++;
    }
    if (count) this.log('cosmétiques : ' + count + ' swap(s) réappliqué(s) après retour des originaux');
    return { count };
  }

  _explain(e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      return 'Accès refusé au dossier du jeu — droits insuffisants sur CookedPCConsole '
        + '(l’élévation a été refusée ou a échoué).';
    }
    if (e && e.code === 'EBUSY') return 'Fichier verrouillé : le jeu ou Steam l’utilise encore.';
    return (e && e.message) || 'Erreur inconnue.';
  }
}

module.exports = Cosmetics;
module.exports.validTarget = validTarget;
module.exports.fingerprint = fingerprint;
module.exports.pathKey = pathKey;
module.exports.PRESETS_ENABLED = PRESETS_ENABLED;
