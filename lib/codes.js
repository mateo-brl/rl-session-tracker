// lib/codes.js — Génération et normalisation des codes lisibles par un humain.
//
// Deux usages : les codes d'invitation (donnés par l'admin) et les codes de
// configuration (donnés à l'agent au premier lancement). Les deux ne sont
// JAMAIS stockés en clair — seul leur hachage SHA-256 est conservé.

const crypto = require('crypto');

// Alphabet sans caractères ambigus (pas de 0/O, 1/I/L). 32 symboles : 256
// étant un multiple de 32, le tirage `octet % 32` est SANS biais de modulo.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomChars(n) {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Code affiché à l'humain : PREFIX-XXXXX-XXXXX (10 caractères aléatoires).
function genCode(prefix) {
  return prefix + '-' + randomChars(5) + '-' + randomChars(5);
}

// Normalisation tolérante : majuscules, et on retire tout ce qui n'est pas
// alphanumérique (tirets, espaces, retours à la ligne d'un copier-coller).
// Saisie et vérification passent toujours par ici → la mise en forme du code
// (tirets, casse) n'a aucune importance pour l'utilisateur.
function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

// Comparaison à temps constant de deux hachages hexadécimaux.
function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = { genCode, normalizeCode, hashCode, hashEquals };
