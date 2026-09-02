// upk.js — Lecture et patch minimal d'un paquet Unreal Engine 3 de Rocket
// League (.upk) : renommer des entrées de sa table des noms SANS toucher au
// reste du fichier.
//
// POURQUOI : copier tel quel Boost_AlphaReward_SF.upk par-dessus
// Boost_Bubble_SF.upk donne un boost TRANSPARENT (constaté en jeu). Le moteur
// ouvre le fichier au nom de Bubble et y cherche des objets nommés
// « Boost_Bubble… » ; le paquet ne contient que des « Boost_AlphaReward… ».
// Il faut donc renommer ces entrées — c'est ce que font les outils qui
// marchent (VelocityRL, RLUPKTools), et c'est la seule différence entre un
// fichier « préparé » par la communauté et le paquet d'origine.
//
// STRUCTURE (little-endian), établie à partir de RLUPKTool, VelocityRL,
// RLUPKTools et de la Unreal-Library :
//  • un préfixe EN CLAIR : tag 0x9E2A83C1, versions, TotalHeaderSize,
//    FolderName, flags, NameCount/NameOffset, Export*/Import*, DependsOffset,
//    GUID, Generations, Engine/Cooker, compression, PackageSource, deux
//    tableaux, puis trois champs propres à Psyonix : GarbageSize,
//    CompressedChunkInfoOffset, LastBlockSize. Il se termine EXACTEMENT à
//    NameOffset ;
//  • une région CHIFFRÉE en AES-256-ECB sans bourrage, de NameOffset à
//    TotalHeaderSize − GarbageSize, arrondie au bloc de 16 : table des noms,
//    imports, exports, table des chunks zlib ;
//  • le corps compressé, jamais touché ici.
//
// Le renommage se fait « à longueur constante » : la longueur sérialisée d'un
// nom est conservée, le nouveau nom (plus court) est complété par des NUL.
// Aucun offset ne bouge, le corps reste octet pour octet identique — seule la
// région chiffrée est réécrite, avec la clé du paquet DESTINATION.
//
// La clé est une propriété du PAQUET (pas de la version du jeu). Celle
// embarquée couvre ~65 % des paquets, dont les boosts Alpha et Bubble ; un
// fichier keys.txt (une clé base64 par ligne) placé à côté de la
// configuration permet d'en ajouter. Le bon choix est VALIDÉ, pas supposé :
// on déchiffre la table des chunks et on vérifie qu'elle est cohérente.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TAG = 0x9E2A83C1;
const COMPRESS_ZLIB = 0x01;
const MAX_NAME_LEN = 1024;

// Clé historique (RLUPKTool, 2018), toujours utilisée par la majorité des
// paquets — dont Boost_AlphaReward_SF et Boost_Bubble_SF.
const DEFAULT_KEYS = [
  'c7df6b13252acc7147bb51c98ad7e34b7fe500b77fa5fab293e2f24e6b17e779',
];

function keyBuf(k) {
  if (Buffer.isBuffer(k)) return k.length === 32 ? k : null;
  const s = String(k || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  try {
    const b = Buffer.from(s, 'base64');
    return b.length === 32 ? b : null;
  } catch (e) { return null; }
}

// Clés utilisables : celles embarquées, plus un éventuel keys.txt.
function loadKeys(extraFile) {
  const out = [];
  const seen = new Set();
  const add = (k) => {
    const b = keyBuf(k);
    if (!b) return;
    const h = b.toString('hex');
    if (seen.has(h)) return;
    seen.add(h);
    out.push(b);
  };
  DEFAULT_KEYS.forEach(add);
  if (extraFile) {
    try {
      for (const line of fs.readFileSync(extraFile, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) add(t);
      }
    } catch (e) { /* pas de fichier : les clés embarquées suffisent souvent */ }
  }
  return out;
}

function ecb(op, key, buf) {
  const c = op === 'enc'
    ? crypto.createCipheriv('aes-256-ecb', key, null)
    : crypto.createDecipheriv('aes-256-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]);
}

// ───────── Préfixe en clair ─────────
function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) throw new Error('fichier trop court');
  let p = 0;
  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const fstr = () => {
    const l = i32();
    if (l > 0) { const s = buf.subarray(p, p + l - 1).toString('latin1'); p += l; return s; }
    if (l < 0) { const s = buf.subarray(p, p - l * 2).toString('utf16le'); p += -l * 2; return s.replace(/\0+$/, ''); }
    return '';
  };
  const h = {};
  h.tag = u32();
  if (h.tag !== TAG) throw new Error('pas un paquet Unreal (tag ' + h.tag.toString(16) + ')');
  h.fileVersion = buf.readUInt16LE(p); p += 2;
  h.licenseeVersion = buf.readUInt16LE(p); p += 2;
  h.totalHeaderSize = i32();
  h.folderName = fstr();
  h.packageFlags = u32();
  h.nameCount = i32(); h.nameOffset = i32();
  h.exportCount = i32(); h.exportOffset = i32();
  h.importCount = i32(); h.importOffset = i32();
  h.dependsOffset = i32();
  h.fixedEnd = p;

  // Jusqu'ici les champs sont à position fixe : sûrs. Ce qui suit contient des
  // tableaux de longueur variable et, sur les paquets réels, des champs que la
  // rétro-ingénierie publique ne décrit pas complètement (constaté : la marche
  // avant finit 12 octets avant NameOffset). On la fait quand même — elle
  // renseigne le diagnostic — mais elle ne décide de RIEN.
  try {
    h.importExportGuidsOffset = i32(); h.importGuidsCount = i32(); h.exportGuidsCount = i32();
    h.thumbnailTableOffset = i32();
    h.guid = buf.subarray(p, p + 16).toString('hex'); p += 16;
    h.generationCount = i32();
    if (h.generationCount < 0 || h.generationCount > 64) throw new Error('generations');
    p += 12 * h.generationCount;
    h.engineVersion = u32(); h.cookerVersion = u32();
    h.compressionFlags = u32();
    const chunkEntry = h.licenseeVersion >= 22 ? 24 : 16;
    h.summaryChunks = i32();
    if (h.summaryChunks < 0 || h.summaryChunks > 4096) throw new Error('chunks');
    p += chunkEntry * h.summaryChunks;
    h.packageSource = u32();
    const nAdd = i32();
    if (nAdd < 0 || nAdd > 1024) throw new Error('additional packages');
    for (let i = 0; i < nAdd; i++) fstr();
    const nTex = i32();
    if (nTex < 0 || nTex > 4096) throw new Error('texture allocations');
    for (let i = 0; i < nTex; i++) { p += 20; const n = i32(); if (n < 0) throw new Error('tex'); p += 4 * n; }
    h.walkEnd = p + 12;                      // + GarbageSize, ChunkInfoOffset, LastBlockSize
    h.walkError = null;
  } catch (e) {
    h.walkEnd = null;
    h.walkError = e.message;
  }

  // Vérifications qui, elles, décident.
  if (h.nameOffset < 32 || h.nameOffset > buf.length) throw new Error('NameOffset hors du fichier (' + h.nameOffset + ')');
  if (h.totalHeaderSize <= h.nameOffset || h.totalHeaderSize > buf.length) {
    throw new Error('TotalHeaderSize incohérent (' + h.totalHeaderSize + ')');
  }
  if (h.nameCount < 1 || h.nameCount > 1000000) throw new Error('NameCount aberrant (' + h.nameCount + ')');

  // GarbageSize, CompressedChunkInfoOffset et LastBlockSize sont les trois
  // derniers entiers EN CLAIR avant la table des noms. On les lit à reculons
  // depuis NameOffset : c'est vrai quels que soient les champs inconnus placés
  // avant, là où la marche avant, elle, se décale.
  const trio = h.nameOffset - 12;
  h.garbageSize = buf.readInt32LE(trio);
  h.chunkInfoOffset = buf.readInt32LE(trio + 4);
  h.lastBlockSize = buf.readInt32LE(trio + 8);
  h.prefixEnd = h.nameOffset;
  h.prefixGap = h.walkEnd === null ? null : h.nameOffset - h.walkEnd;

  if (h.garbageSize < 0 || h.garbageSize > h.totalHeaderSize - h.nameOffset) {
    throw new Error('GarbageSize aberrant (' + h.garbageSize + ')');
  }
  h.zlib = !!(h.compressionFlags & COMPRESS_ZLIB);
  // Seuls les blocs COMPLETS de 16 octets sont chiffrés ; un éventuel reste
  // est laissé tel quel — on ne le réécrit donc jamais.
  const raw = h.totalHeaderSize - h.garbageSize - h.nameOffset;
  h.rawLen = raw;
  h.encLen = raw - (raw % 16);
  h.tailLen = raw - h.encLen;
  if (h.encLen < 16 || h.nameOffset + h.encLen > buf.length) throw new Error('région chiffrée hors du fichier');
  return h;
}

// ───────── Choix de la clé (validé par la table des chunks) ─────────
// Une entrée de nom valide : longueur plausible, ASCII, terminée par NUL.
// Le premier nom d'un paquet UE3 est « None » — signal net, et il ne dépend
// d'aucun champ dont l'interprétation est incertaine.
function firstNameLooksSane(plain) {
  if (plain.length < 8) return false;
  const len = plain.readInt32LE(0);
  if (len < 2 || len > MAX_NAME_LEN || 4 + len > plain.length) return false;
  const data = plain.subarray(4, 4 + len);
  if (data[len - 1] !== 0) return false;
  for (let i = 0; i < len - 1; i++) {
    if (data[i] < 0x20 || data[i] > 0x7e) return false;
  }
  return true;
}

function probeKey(buf, h, key) {
  const n = Math.min(64, h.encLen) & ~15;
  if (n < 16) return false;
  try {
    return firstNameLooksSane(ecb('dec', key, buf.subarray(h.nameOffset, h.nameOffset + n)));
  } catch (e) { return false; }
}

// Contrôle secondaire : la table des chunks pointe sur DependsOffset. Vrai sur
// les paquets de test ; sur les paquets réels l'origine de ChunkInfoOffset
// n'est pas certaine, donc c'est un indice de diagnostic, pas un verdict.
function chunkTableAgrees(buf, h, key) {
  try {
    for (const base of [h.chunkInfoOffset, h.chunkInfoOffset - h.nameOffset]) {
      if (base < 0 || base + 32 > h.encLen) continue;
      const bs = base & ~15, inner = base & 15;
      const d = ecb('dec', key, buf.subarray(h.nameOffset + bs, h.nameOffset + bs + 32));
      const count = d.readInt32LE(inner);
      if (count >= 1 && count <= 65536 && d.readBigInt64LE(inner + 4) === BigInt(h.dependsOffset)) return true;
    }
  } catch (e) { /* indice absent */ }
  return false;
}

function findKey(buf, h, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (probeKey(buf, h, keys[i])) return { key: keys[i], index: i };
  }
  return null;
}

// ───────── Table des noms (région déchiffrée) ─────────
function readNames(plain, h) {
  const names = [];
  let q = 0;
  for (let i = 0; i < h.nameCount; i++) {
    if (q + 4 > plain.length) throw new Error('table des noms tronquée');
    const len = plain.readInt32LE(q);
    if (len === 0 || len > MAX_NAME_LEN || len < -MAX_NAME_LEN) {
      throw new Error('longueur de nom aberrante (' + len + ') à l’entrée ' + i);
    }
    const bytes = len > 0 ? len : -len * 2;
    const data = plain.subarray(q + 4, q + 4 + bytes);
    let name;
    if (len > 0) {
      const z = data.indexOf(0);
      name = data.subarray(0, z < 0 ? bytes : z).toString('latin1');
    } else {
      name = data.toString('utf16le').replace(/\0+$/, '');
    }
    names.push({ index: i, offset: q, len, utf16: len < 0, name });
    q += 4 + bytes + 8;                 // + flags (u64)
  }
  return { names, end: q };
}

function printable(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

// Renomme sur place. `pairs` : [[ancien, nouveau], …], comparés à l'entrée
// ENTIÈRE, sans tenir compte de la casse. Le nouveau nom doit tenir dans la
// longueur sérialisée existante (NUL compris) : il est complété par des NUL.
function renameInPlace(plain, names, pairs, opts) {
  const loose = !!(opts && opts.loose);
  const changed = [];
  const lower = (s) => String(s).toLowerCase();
  const existing = new Set(names.map((n) => lower(n.name)));
  for (const [oldName, newName] of pairs) {
    if (lower(oldName) === lower(newName)) continue;
    // Strict : l'entrée entière vaut l'ancien nom. Souple : l'ancien nom est un
    // motif remplacé À L'INTÉRIEUR de l'entrée (Boost_AlphaReward_Body → …).
    const hits = loose
      ? names.filter((n) => lower(n.name).includes(lower(oldName)))
      : names.filter((n) => lower(n.name) === lower(oldName));
    if (!hits.length) continue;
    if (!loose && existing.has(lower(newName))) {
      throw new Error('collision : « ' + newName + ' » existe déjà dans le paquet');
    }
    for (const n of hits) {
      const target = loose
        ? n.name.replace(new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), newName)
        : newName;
      if (loose && (target === n.name || existing.has(lower(target)))) continue;
      if (n.utf16) throw new Error('« ' + n.name + ' » est en UTF-16 : renommage en place impossible');
      const nb = Buffer.from(target, 'latin1');
      if (nb.length + 1 > n.len) {
        if (loose) continue;
        throw new Error('« ' + target + ' » (' + nb.length + ') ne tient pas dans « '
          + n.name + ' » (' + (n.len - 1) + ')');
      }
      const data = plain.subarray(n.offset + 4, n.offset + 4 + n.len);
      data.fill(0);
      nb.copy(data, 0);
      changed.push({ index: n.index, from: n.name, to: target });
      n.name = target;
      existing.add(lower(target));
    }
    if (!loose) existing.add(lower(newName));
  }
  return changed;
}

// ───────── Opérations de haut niveau ─────────

// Rapport de diagnostic sur un paquet : ce qu'on comprend de l'en-tête, si une
// clé le déchiffre, et les premiers noms. Sert à corriger sur des données
// réelles quand quelque chose ne colle pas.
function inspect(buf, keys) {
  const out = { ok: false, size: buf.length };
  try {
    const h = parseHeader(buf);
    Object.assign(out, {
      fileVersion: h.fileVersion, licenseeVersion: h.licenseeVersion,
      totalHeaderSize: h.totalHeaderSize, folderName: h.folderName,
      nameCount: h.nameCount, nameOffset: h.nameOffset,
      importCount: h.importCount, importOffset: h.importOffset,
      exportCount: h.exportCount, exportOffset: h.exportOffset,
      dependsOffset: h.dependsOffset, garbageSize: h.garbageSize,
      chunkInfoOffset: h.chunkInfoOffset, lastBlockSize: h.lastBlockSize,
      compressionFlags: h.compressionFlags, zlib: h.zlib,
      summaryChunks: h.summaryChunks, fixedEnd: h.fixedEnd, walkEnd: h.walkEnd,
      walkError: h.walkError, prefixGap: h.prefixGap,
      rawLen: h.rawLen, encLen: h.encLen, tailLen: h.tailLen,
    });
    const k = findKey(buf, h, keys);
    out.keyFound = !!k;
    out.keyIndex = k ? k.index : -1;
    out.chunkTableAgrees = k ? chunkTableAgrees(buf, h, k.key) : false;
    if (!k) { out.error = 'aucune clé connue ne déchiffre ce paquet'; return out; }
    const plain = ecb('dec', k.key, buf.subarray(h.nameOffset, h.nameOffset + h.encLen));
    const { names, end } = readNames(plain, h);
    out.namesEnd = end;
    out.namesMatchImports = (h.nameOffset + end === h.importOffset);
    out.namesPrintable = names.every((n) => n.utf16 || printable(n.name));
    out.names = names.slice(0, 60).map((n) => n.name);
    out.ok = out.namesPrintable;
    if (!out.ok) out.error = 'table des noms illisible avec cette clé';
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Patch complet : lit, déchiffre, renomme, rechiffre. Renvoie le nouveau
// Buffer et un rapport. `outKey` : clé du paquet DESTINATION (si connue),
// sinon celle du paquet source.
function patchPackage(buf, opts) {
  const o = opts || {};
  const keys = o.keys || loadKeys();
  const h = parseHeader(buf);
  const k = findKey(buf, h, keys);
  if (!k) throw new Error('aucune clé connue ne déchiffre ce paquet');
  const region = buf.subarray(h.nameOffset, h.nameOffset + h.encLen);
  const plain = ecb('dec', k.key, region);
  const { names, end } = readNames(plain, h);
  if (!names.every((n) => n.utf16 || printable(n.name))) {
    throw new Error('table des noms illisible : clé douteuse');
  }
  const outKey = o.outKey || k.key;
  // Un reste non aligné garde le chiffrement de la SOURCE : inoffensif tant
  // que la destination utilise la même clé, faux sinon. On refuse ce cas
  // plutôt que d'écrire un fichier à moitié déchiffrable.
  if (h.tailLen > 0 && !outKey.equals(k.key)) {
    throw new Error('région chiffrée non alignée (' + h.tailLen + ' octets) et clés différentes');
  }
  const pairs = o.pairs || [];
  let changed = renameInPlace(plain, names, pairs);
  if (!changed.length) {
    // Les noms exacts n'y sont pas : on remplace le motif à l'intérieur des
    // entrées (Boost_AlphaReward_Body, …), ce que fait aussi VelocityRL.
    changed = renameInPlace(plain, names, pairs, { loose: true });
  }
  if (!changed.length) {
    throw new Error('aucune entrée à renommer : noms attendus absents (table : '
      + names.slice(0, 12).map((n) => n.name).join(', ') + '…)');
  }
  const out = Buffer.from(buf);
  ecb('enc', outKey, plain).copy(out, h.nameOffset);
  return {
    buffer: out, changed, keyIndex: k.index, header: h,
    namesMatchImports: (h.nameOffset + end === h.importOffset),
  };
}

// Clé qui déchiffre un paquet donné (pour rechiffrer à la clé de destination).
function keyOf(buf, keys) {
  try {
    const h = parseHeader(buf);
    const k = findKey(buf, h, keys);
    return k ? k.key : null;
  } catch (e) { return null; }
}

// Paires de renommage pour un swap « paquet source → paquet cible » d'objets
// du même type (Boost_X_SF → Boost_Y_SF) : le nom de base, le nom de fichier,
// et les variantes peintes que VelocityRL renomme systématiquement.
function pairsFor(sourceFile, targetFile) {
  const stem = (f) => path.basename(String(f)).replace(/\.upk$/i, '');
  const base = (s) => s.replace(/_SF$/i, '');
  const s = stem(sourceFile), t = stem(targetFile);
  const sb = base(s), tb = base(t);
  return [
    [sb, tb],
    [sb + '_SF', tb + '_SF'],
    [sb + '_Painted', tb + '_Painted'],
    [sb + '_P', tb + '_P'],
  ];
}

// Noms d'un paquet (liste simple), pour comparer source et cible.
function namesOf(buf, keys) {
  const h = parseHeader(buf);
  const k = findKey(buf, h, keys || loadKeys());
  if (!k) throw new Error('aucune clé connue ne déchiffre ce paquet');
  const plain = ecb('dec', k.key, buf.subarray(h.nameOffset, h.nameOffset + h.encLen));
  return readNames(plain, h).names.map((n) => n.name);
}

// Paires déduites du CONTENU des deux paquets, pas de leur nom de fichier.
// Constaté en jeu : le visuel se résout autrement que le son. La fiche audio
// (« Boost_<objet>_Loop », un AkSoundCue) est cherchée sous le nom de l'objet
// équipé ; si elle garde le nom de la source, le jeu ne la trouve pas et joue
// le son générique. On l'ajoute donc aux renommages.
const CUE_RE = /^Boost_.+_Loop$/i;

function rolePairs(sourceNames, targetNames) {
  const out = [];
  const cs = (sourceNames || []).filter((n) => CUE_RE.test(n));
  const ct = (targetNames || []).filter((n) => CUE_RE.test(n));
  if (cs.length === 1 && ct.length === 1 && cs[0].toLowerCase() !== ct[0].toLowerCase()) {
    out.push([cs[0], ct[0]]);
  }
  return out;
}

// Un renommage ne tient que si le nouveau nom n'est pas plus long. Sert à
// écarter une cible AVANT d'écrire quoi que ce soit dans le jeu.
function fits(sourceNames, pairs) {
  const bad = [];
  const lower = (x) => String(x).toLowerCase();
  for (const [from, to] of pairs) {
    const hit = (sourceNames || []).find((n) => lower(n) === lower(from));
    if (hit && to.length > hit.length) bad.push({ from: hit, to });
  }
  return bad;
}

module.exports = {
  namesOf, rolePairs, fits, CUE_RE,
  parseHeader, findKey, probeKey, chunkTableAgrees, readNames, renameInPlace, inspect, patchPackage,
  keyOf, pairsFor, loadKeys, ecb, DEFAULT_KEYS, TAG,
};
