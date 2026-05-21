// lib/validate.js — Validations partagées entre le CLI d'admin (add-agent) et
// les endpoints d'enrôlement self-service. Une seule source de vérité : ce que
// l'admin peut créer et ce qu'un inconnu peut soumettre suivent les mêmes règles.

const PLATFORMS = ['epic', 'steam', 'psn', 'xbox'];

// `id` : slug d'URL (/u/<id>). Minuscules, chiffres, - et _, 2 à 32 caractères.
function badId(id) {
  return typeof id !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(id);
}

function badPlatform(p) {
  return !PLATFORMS.includes(p);
}

// `username` : réinjecté dans une URL de scraping tracker.gg ET affiché dans le
// dashboard. On refuse les caractères de contrôle, la barre oblique et
// l'antislash ; les caractères usuels d'un pseudo restent autorisés.
function badUsername(u) {
  if (typeof u !== 'string' || u.length < 1 || u.length > 64) return true;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return true;
  }
  return false;
}

// `name` : nom d'affichage. 1 à 32 caractères, pas de caractères de contrôle.
function badName(n) {
  if (typeof n !== 'string' || n.length < 1 || n.length > 32) return true;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

module.exports = { PLATFORMS, badId, badPlatform, badUsername, badName };
