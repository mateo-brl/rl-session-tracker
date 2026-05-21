// lib/players.js — Registre des joueurs / agents autorisés.
//
// Chaque PC qui pousse ses stats possède un token. On ne stocke jamais le
// token en clair : seul son hachage SHA-256 est gardé dans players.json.
// Ainsi, un players.json qui fuite ne donne aucun token réutilisable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.PLAYERS_FILE || path.join(__dirname, '..', 'players.json');

let agents = [];

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Recharge le registre depuis le disque. Retourne le tableau d'agents.
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    agents = Array.isArray(raw.agents) ? raw.agents : [];
  } catch (e) {
    agents = [];
  }
  return agents;
}

function persist(list) {
  fs.writeFileSync(FILE, JSON.stringify({ agents: list }, null, 2) + '\n', { mode: 0o600 });
  agents = list;
}

function getPlayer(id) {
  return agents.find((a) => a.id === id) || null;
}

// Liste publique — jamais le tokenHash.
function listPlayers() {
  return agents.map((a) => ({
    id: a.id, name: a.name, platform: a.platform, username: a.username,
  }));
}

// Résout un token présenté par un agent vers son enregistrement joueur.
// Comparaison à temps constant pour ne pas fuiter d'info par timing.
function resolveToken(token) {
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), 'utf8');
  let match = null;
  for (const a of agents) {
    if (!a.tokenHash || a.tokenHash.length !== presented.length) continue;
    const stored = Buffer.from(a.tokenHash, 'utf8');
    if (crypto.timingSafeEqual(stored, presented)) match = a;
  }
  return match;
}

// Recharge automatiquement si players.json change (ajout d'un agent sans
// redémarrer le serveur).
function watch() {
  try {
    fs.watchFile(FILE, { interval: 2000 }, () => load());
  } catch (e) { /* watch optionnel */ }
}

module.exports = {
  FILE, load, persist, getPlayer, listPlayers, resolveToken, hashToken, watch,
};
