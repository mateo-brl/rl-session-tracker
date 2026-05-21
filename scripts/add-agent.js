#!/usr/bin/env node
// scripts/add-agent.js — Déclare un nouveau PC autorisé à pousser ses stats.
//
// Génère un token, enregistre son hachage dans players.json, et écrit un
// fichier de config prêt à donner au PC concerné.
//
// Exemple :
//   npm run add-agent -- --id mateo --platform epic --username mateobrl \
//                        --name "Mateo" --server https://rl.mateobrl.fr
//
//   npm run add-agent -- --list      (liste les agents existants)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const players = require('../lib/players');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes('--' + name); }

function fail(msg) {
  console.error('\n  Erreur : ' + msg + '\n');
  process.exit(1);
}

players.load();

// ───────── Mode liste ─────────
if (has('list')) {
  const list = players.listPlayers();
  console.log('\n  Agents déclarés : ' + list.length);
  for (const p of list) {
    console.log('   • ' + p.id + '  (' + p.name + ' — ' + p.platform + '/' + p.username + ')');
  }
  console.log('');
  process.exit(0);
}

// ───────── Mode création ─────────
const id = arg('id');
const platform = arg('platform');
const username = arg('username');
const name = arg('name', id);
const server = arg('server', 'https://rl.mateobrl.fr');

if (!id || !platform || !username) {
  console.log('\n  Usage :');
  console.log('    npm run add-agent -- --id <slug> --platform <epic|steam|psn|xbox> \\');
  console.log('                         --username <pseudo tracker.gg> [--name "Nom"] \\');
  console.log('                         [--server https://rl.mateobrl.fr]\n');
  console.log('    npm run add-agent -- --list\n');
  process.exit(1);
}
if (!/^[a-z0-9_-]{2,32}$/.test(id)) {
  fail('--id doit être un slug (minuscules, chiffres, - et _, 2 à 32 caractères).');
}
if (!['epic', 'steam', 'psn', 'xbox'].includes(platform)) {
  fail('--platform doit valoir epic, steam, psn ou xbox.');
}
if (players.getPlayer(id)) {
  fail("l'identifiant « " + id + " » existe déjà.");
}

const token = crypto.randomBytes(24).toString('base64url');
const list = players.load();
list.push({
  id, name, platform, username,
  tokenHash: players.hashToken(token),
  createdAt: new Date().toISOString(),
});
players.persist(list);

// Fichier de config prêt à l'emploi pour le PC concerné.
const cfgPath = path.join(process.cwd(), 'agent-config-' + id + '.json');
fs.writeFileSync(
  cfgPath,
  JSON.stringify({ serverUrl: server, token, statsApiPort: 49123 }, null, 2) + '\n',
  { mode: 0o600 }
);

console.log('\n  ✓ Agent « ' + id + " » créé.");
console.log('    Page dashboard : ' + server.replace(/\/$/, '') + '/u/' + id);
console.log('');
console.log('  Config écrite : ' + cfgPath);
console.log('  → Renomme ce fichier en « config.json » et place-le À CÔTÉ');
console.log('    de rl-agent.exe sur le PC ' + name + '.');
console.log('');
console.log('  Token (affiché une seule fois) :');
console.log('    ' + token);
console.log('');
