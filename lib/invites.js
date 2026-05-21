// lib/invites.js — Registre des codes d'invitation.
//
// L'inscription self-service est GARDÉE : pour créer une page joueur, il faut
// présenter un code d'invitation valide. L'admin génère ces codes (CLI
// add-invite). Sans cette barrière, n'importe qui pourrait faire scraper
// n'importe quel pseudo tracker.gg par le serveur.
//
// Comme pour les tokens, un code n'est jamais stocké en clair : seul son
// hachage SHA-256 est gardé dans invites.json. L'admin ne le voit qu'une fois.

const fs = require('fs');
const path = require('path');
const codes = require('./codes');

const FILE = process.env.INVITES_FILE || path.join(__dirname, '..', 'invites.json');

let invites = [];
let loadedOnce = false;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    invites = Array.isArray(raw.invites) ? raw.invites : [];
    loadedOnce = true;
  } catch (e) {
    if (e.code === 'ENOENT') {
      invites = [];
      loadedOnce = true;
    } else {
      // Fichier illisible/tronqué : on garde la liste en mémoire plutôt que
      // d'invalider tous les codes le temps que le fichier redevienne lisible.
      console.error('[invites] lecture impossible (' + e.message + ')'
        + (loadedOnce ? ' — registre en mémoire conservé' : ''));
    }
  }
  return invites;
}

// Écriture atomique (fichier temporaire puis rename).
function persist(list) {
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ invites: list }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  invites = list;
}

// Crée un code d'invitation. `maxUses` = nombre d'inscriptions autorisées,
// `ttlDays` = durée de validité (0 = sans expiration). Retourne le code EN
// CLAIR — c'est la seule fois où il est visible.
function create({ label, maxUses, ttlDays }) {
  const code = codes.genCode('RLINV');
  const list = load();
  list.push({
    codeHash: codes.hashCode(code),
    label: label || '',
    maxUses: Math.max(1, Number(maxUses) || 1),
    uses: 0,
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays > 0
      ? new Date(Date.now() + ttlDays * 86400000).toISOString()
      : null,
  });
  persist(list);
  return code;
}

// Consomme une utilisation du code s'il est valide. Synchrone et sans await :
// la lecture, la vérification et l'incrément sont atomiques dans la boucle
// d'évènements Node. Retourne { ok } ou { ok:false, reason }.
function redeem(code) {
  const hash = codes.hashCode(code);
  const now = Date.now();
  let target = null;
  for (const inv of invites) {
    if (inv.codeHash && codes.hashEquals(inv.codeHash, hash)) target = inv;
  }
  if (!target) return { ok: false, reason: 'invalide' };
  if (target.expiresAt && Date.parse(target.expiresAt) < now) {
    return { ok: false, reason: 'expiré' };
  }
  if (target.uses >= target.maxUses) return { ok: false, reason: 'épuisé' };
  target.uses += 1;
  persist(invites);
  return { ok: true };
}

// Vue admin (le code lui-même est haché, donc non affichable).
function list() {
  const now = Date.now();
  return invites.map((inv) => ({
    label: inv.label,
    uses: inv.uses,
    maxUses: inv.maxUses,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    spent: inv.uses >= inv.maxUses,
    expired: !!(inv.expiresAt && Date.parse(inv.expiresAt) < now),
  }));
}

function watch() {
  try {
    fs.watchFile(FILE, { interval: 2000 }, () => load());
  } catch (e) { /* watch optionnel */ }
}

module.exports = { FILE, load, persist, create, redeem, list, watch };
