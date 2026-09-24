// zip.js — Lecture minimale d'une archive ZIP.
//
// Les cartes de bakkesplugins.com arrivent en .zip. Le dépôt n'accepte
// aucune dépendance runtime hors electron-updater : on lit donc le format à
// la main. Seul ce dont une carte a besoin est pris en charge : entrées
// stockées (méthode 0) ou compressées en deflate (méthode 8), sans
// chiffrement. Le reste est refusé proprement plutôt que mal décodé.
//
// Aucun nom d'entrée n'est jamais utilisé comme chemin d'écriture : l'appelant
// choisit où poser les octets. Une archive piégée (« ../../Windows/… ») ne
// peut donc rien écrire hors de la bibliothèque.

const zlib = require('zlib');
const { promisify } = require('util');

const inflateRawAsync = promisify(zlib.inflateRaw);

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// Plafond d'une entrée décompressée. Une carte pèse de quelques Mo à ~350 Mo ;
// au-delà, c'est une archive anormale (ou une bombe de décompression).
const MAX_ENTRY = 1024 * 1024 * 1024;

// Le répertoire central se termine par un enregistrement de fin, suivi d'un
// commentaire de 64 Kio au plus : on le cherche à reculons dans cette fenêtre.
function findEocd(buf) {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// Liste les entrées : { name, method, size, csize, offset, flags }.
function list(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('archive ZIP illisible (fin introuvable)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // 0xFFFFFFFF signale une archive ZIP64 : aucune carte n'en a besoin.
  if (cdOffset === 0xffffffff) throw new Error('archive ZIP64 non prise en charge');
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('archive ZIP corrompue (répertoire central)');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    // Bit 11 : nom en UTF-8. Sinon CP437, dont l'ASCII est un sous-ensemble ;
    // les noms de cartes sont en pratique toujours ASCII.
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    out.push({ name, method, size, csize, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Données encore compressées d'une entrée, après contrôles.
function locate(buf, entry) {
  if (entry.flags & 0x1) throw new Error('entrée chiffrée : ' + entry.name);
  if (entry.size > MAX_ENTRY) throw new Error('entrée trop volumineuse : ' + entry.name);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error('compression non prise en charge (' + entry.method + ') : ' + entry.name);
  }
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new Error('archive ZIP corrompue (en-tête local)');
  }
  // Les longueurs du nom et du champ extra de l'en-tête LOCAL peuvent
  // différer de celles du répertoire central : on relit celles d'ici.
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.csize);
  if (data.length !== entry.csize) throw new Error('archive ZIP tronquée : ' + entry.name);
  return data;
}

function checked(entry, raw) {
  if (raw.length !== entry.size) throw new Error('taille inattendue après décompression : ' + entry.name);
  return raw;
}

// Octets décompressés d'une entrée.
function extract(buf, entry) {
  const data = locate(buf, entry);
  return checked(entry, entry.method === 0 ? Buffer.from(data)
    : zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }));
}

// Variante asynchrone : la décompression part dans le pool de threads de
// Node. Une carte de 300 Mo prenait une demi-seconde de décompression sur le
// processus principal, et le dashboard se figeait d'autant.
async function extractAsync(buf, entry) {
  const data = locate(buf, entry);
  return checked(entry, entry.method === 0 ? Buffer.from(data)
    : await inflateRawAsync(data, { maxOutputLength: MAX_ENTRY }));
}

module.exports = { list, extract, extractAsync, MAX_ENTRY };
