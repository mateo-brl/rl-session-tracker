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
  h.importExportGuidsOffset = i32(); h.importGuidsCount = i32(); h.exportGuidsCount = i32();
  h.thumbnailTableOffset = i32();
  h.guid = buf.subarray(p, p + 16).toString('hex'); p += 16;
  h.generationCount = i32();
  if (h.generationCount < 0 || h.generationCount > 64) throw new Error('GenerationCount aberrant');
  p += 12 * h.generationCount;
  h.engineVersion = u32(); h.cookerVersion = u32();
  h.compressionFlags = u32();
  const chunkEntry = h.licenseeVersion >= 22 ? 24 : 16;
  h.summaryChunks = i32();
  if (h.summaryChunks < 0 || h.summaryChunks > 4096) throw new Error('CompressedChunks aberrant');
  p += chunkEntry * h.summaryChunks;
  h.packageSource = u32();
  const nAdd = i32();
  if (nAdd < 0 || nAdd > 1024) throw new Error('AdditionalPackagesToCook aberrant');
  for (let i = 0; i < nAdd; i++) fstr();
  const nTex = i32();
  if (nTex < 0 || nTex > 4096) throw new Error('TextureAllocations aberrant');
  for (let i = 0; i < nTex; i++) { p += 20; const n = i32(); if (n < 0) throw new Error('TextureAllocations'); p += 4 * n; }
  h.garbageSize = i32();
  h.chunkInfoOffset = i32();
  h.lastBlockSize = i32();
  h.prefixEnd = p;
  h.prefixMatches = (p === h.nameOffset);
  h.zlib = !!(h.compressionFlags & COMPRESS_ZLIB);
  const raw = h.totalHeaderSize - h.garbageSize - h.nameOffset;
  h.encLen = (raw + 15) & ~15;
  if (!h.prefixMatches) throw new Error('préfixe (' + p + ') ≠ NameOffset (' + h.nameOffset + ')');
  if (raw <= 0 || h.nameOffset + h.encLen > buf.length) throw new Error('région chiffrée hors du fichier');
  return h;
}

// ───────── Choix de la clé (validé par la table des chunks) ─────────
function probeKey(buf, h, key) {
  const region = buf.subarray(h.nameOffset, h.nameOffset + h.encLen);
  const bs = h.chunkInfoOffset & ~15;
  const inner = h.chunkInfoOffset & 15;
  if (bs + 32 > region.length) return false;
  let d;
  try { d = ecb('dec', key, region.subarray(bs, bs + 32)); } catch (e) { return false; }
  const count = d.readInt32LE(inner);
  if (count < 1 || count > 65536) return false;
  return d.readBigInt64LE(inner + 4) === BigInt(h.dependsOffset);
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
function renameInPlace(plain, names, pairs) {
  const changed = [];
  const lower = (s) => String(s).toLowerCase();
  const existing = new Set(names.map((n) => lower(n.name)));
  for (const [oldName, newName] of pairs) {
    if (lower(oldName) === lower(newName)) continue;
    const hits = names.filter((n) => lower(n.name) === lower(oldName));
    if (!hits.length) continue;
    if (existing.has(lower(newName))) {
      throw new Error('collision : « ' + newName + ' » existe déjà dans le paquet');
    }
    for (const n of hits) {
      if (n.utf16) throw new Error('« ' + n.name + ' » est en UTF-16 : renommage en place impossible');
      const nb = Buffer.from(newName, 'latin1');
      if (nb.length + 1 > n.len) {
        throw new Error('« ' + newName + ' » (' + nb.length + ') ne tient pas dans « '
          + n.name + ' » (' + (n.len - 1) + ')');
      }
      const data = plain.subarray(n.offset + 4, n.offset + 4 + n.len);
      data.fill(0);
      nb.copy(data, 0);
      changed.push({ index: n.index, from: n.name, to: newName });
      n.name = newName;
    }
    existing.add(lower(newName));
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
      summaryChunks: h.summaryChunks, prefixEnd: h.prefixEnd, encLen: h.encLen,
    });
    const k = findKey(buf, h, keys);
    out.keyFound = !!k;
    out.keyIndex = k ? k.index : -1;
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
  if (h.nameOffset + end !== h.importOffset) {
    throw new Error('table des noms incohérente (fin ' + (h.nameOffset + end)
      + ' ≠ ImportOffset ' + h.importOffset + ')');
  }
  if (!names.every((n) => n.utf16 || printable(n.name))) {
    throw new Error('table des noms illisible : clé douteuse');
  }
  const changed = renameInPlace(plain, names, o.pairs || []);
  if (!changed.length) throw new Error('aucune entrée à renommer : le paquet ne contient pas les noms attendus');
  const outKey = o.outKey || k.key;
  const out = Buffer.from(buf);
  ecb('enc', outKey, plain).copy(out, h.nameOffset);
  return { buffer: out, changed, keyIndex: k.index, header: h };
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

module.exports = {
  parseHeader, findKey, readNames, renameInPlace, inspect, patchPackage,
  keyOf, pairsFor, loadKeys, ecb, DEFAULT_KEYS, TAG,
};
