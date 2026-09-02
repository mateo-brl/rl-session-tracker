// Fabrique un paquet .upk synthétique conforme à la disposition lue par
// src/main/upk.js : préfixe en clair, région chiffrée (table des noms + table
// des chunks), corps. Sert à tester le patcheur sans fichier du jeu.
'use strict';

const { ecb, DEFAULT_KEYS } = require('../../src/main/upk.js');

function fstr(s) {
  const b = Buffer.from(s + '\0', 'latin1');
  const out = Buffer.alloc(4 + b.length);
  out.writeInt32LE(b.length, 0);
  b.copy(out, 4);
  return out;
}

function nameEntry(name, padTo) {
  const b = Buffer.from(name, 'latin1');
  const len = Math.max(b.length + 1, padTo || 0);
  const out = Buffer.alloc(4 + len + 8);
  out.writeInt32LE(len, 0);
  b.copy(out, 4);
  out.writeUInt32LE(0x0007, 4 + len);      // flags (u64) — valeur quelconque
  return out;
}

// build({ names, key, body }) → { buf, nameOffset, dependsOffset, key }
function build(opts) {
  const o = opts || {};
  const key = o.key || Buffer.from(DEFAULT_KEYS[0], 'hex');
  const names = o.names || ['None', 'Core'];
  const body = o.body || Buffer.from('BODY-COMPRESSED-DATA-0123456789');

  const nameTable = Buffer.concat(names.map((n) => nameEntry(n)));
  // Table des chunks juste après les noms : count=1, {i64 unc, i32 size, i64 comp, i32 csize}
  const chunk = Buffer.alloc(4 + 24);
  const rawLen = nameTable.length + chunk.length;
  const encLen = (rawLen + 15) & ~15;
  const garbage = encLen - rawLen;

  // Préfixe (sans les champs dépendant des offsets, remplis après)
  const parts = [];
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x9E2A83C1, 0); head.writeUInt16LE(868, 4); head.writeUInt16LE(32, 6);
  parts.push(head);
  const totalHeaderSizeBuf = Buffer.alloc(4); parts.push(totalHeaderSizeBuf);
  parts.push(fstr('None'));
  const flags = Buffer.alloc(4); flags.writeUInt32LE(0x1, 0); parts.push(flags);
  const counts = Buffer.alloc(4 * 11); parts.push(counts);   // NameCount..ThumbnailTableOffset
  parts.push(Buffer.alloc(16, 0xab));                         // GUID
  const gen = Buffer.alloc(4 + 12); gen.writeInt32LE(1, 0); parts.push(gen);
  const ver = Buffer.alloc(12); ver.writeUInt32LE(12345, 0); ver.writeUInt32LE(67, 4); ver.writeUInt32LE(0x01, 8); parts.push(ver);
  parts.push(Buffer.alloc(4, 0));                             // CompressedChunks count = 0
  parts.push(Buffer.alloc(4, 0x5a));                          // PackageSource
  parts.push(Buffer.alloc(4, 0));                             // AdditionalPackagesToCook = 0
  parts.push(Buffer.alloc(4, 0));                             // TextureAllocations = 0
  const psy = Buffer.alloc(12); parts.push(psy);              // Garbage, ChunkInfoOffset, LastBlockSize
  let prefix = Buffer.concat(parts);

  const nameOffset = prefix.length;
  const importOffset = nameOffset + nameTable.length;
  const exportOffset = importOffset;
  const dependsOffset = nameOffset + encLen;
  const totalHeaderSize = dependsOffset;

  totalHeaderSizeBuf.writeInt32LE(totalHeaderSize, 0);
  counts.writeInt32LE(names.length, 0);      // NameCount
  counts.writeInt32LE(nameOffset, 4);
  counts.writeInt32LE(0, 8);                 // ExportCount
  counts.writeInt32LE(exportOffset, 12);
  counts.writeInt32LE(0, 16);                // ImportCount
  counts.writeInt32LE(importOffset, 20);
  counts.writeInt32LE(dependsOffset, 24);
  counts.writeInt32LE(dependsOffset, 28);    // ImportExportGuidsOffset
  counts.writeInt32LE(0, 32); counts.writeInt32LE(0, 36); counts.writeInt32LE(0, 40);
  psy.writeInt32LE(garbage, 0);
  psy.writeInt32LE(nameTable.length, 4);     // ChunkInfoOffset (relatif à la zone déchiffrée)
  psy.writeInt32LE(16, 8);
  prefix = Buffer.concat(parts);

  chunk.writeInt32LE(1, 0);
  chunk.writeBigInt64LE(BigInt(dependsOffset), 4);
  chunk.writeInt32LE(body.length, 12);
  chunk.writeBigInt64LE(BigInt(dependsOffset), 16);
  chunk.writeInt32LE(body.length, 24);

  const plain = Buffer.concat([nameTable, chunk, Buffer.alloc(garbage, 0)]);
  const enc = ecb('enc', key, plain);
  const buf = Buffer.concat([prefix, enc, body]);
  return { buf, key, nameOffset, dependsOffset, encLen, body };
}

module.exports = { build };
