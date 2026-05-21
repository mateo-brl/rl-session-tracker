#!/usr/bin/env node
// scripts/add-invite.js — Génère un code d'invitation pour l'inscription
// self-service. À lancer par l'admin.
//
// Exemples :
//   npm run add-invite -- --label "Amis" --uses 5 --days 30
//   npm run add-invite -- --uses 1
//   npm run add-invite -- --list

const invites = require('../lib/invites');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes('--' + name); }

invites.load();

// ───────── Mode liste ─────────
if (has('list')) {
  const all = invites.list();
  console.log('\n  Codes d\'invitation : ' + all.length);
  for (const inv of all) {
    const state = inv.spent ? 'épuisé' : inv.expired ? 'expiré' : 'actif';
    const exp = inv.expiresAt
      ? 'expire le ' + inv.expiresAt.slice(0, 10) : 'sans expiration';
    console.log('   • ' + (inv.label || '(sans libellé)')
      + '  —  ' + inv.uses + '/' + inv.maxUses + ' utilisé(s)'
      + '  —  ' + state + '  —  ' + exp);
  }
  console.log('');
  process.exit(0);
}

// ───────── Mode création ─────────
const label = arg('label', '');
const uses = parseInt(arg('uses', '1'), 10);
const days = parseInt(arg('days', '0'), 10);

if (!Number.isFinite(uses) || uses < 1 || uses > 1000) {
  console.error('\n  Erreur : --uses doit être un entier entre 1 et 1000.\n');
  process.exit(1);
}
if (!Number.isFinite(days) || days < 0 || days > 3650) {
  console.error('\n  Erreur : --days doit être un entier entre 0 et 3650 (0 = sans expiration).\n');
  process.exit(1);
}

const code = invites.create({ label, maxUses: uses, ttlDays: days });

console.log('\n  ✓ Code d\'invitation créé' + (label ? ' (« ' + label + ' »)' : '') + '.');
console.log('    Inscriptions autorisées : ' + uses);
console.log('    Validité : ' + (days > 0 ? days + ' jour(s)' : 'sans expiration'));
console.log('');
console.log('  Code (affiché une seule fois) :');
console.log('');
console.log('      ' + code);
console.log('');
console.log('  Donne ce code au joueur. Il s\'inscrit sur la page /enroll du');
console.log('  dashboard, puis télécharge l\'agent et colle le code de');
console.log('  configuration affiché. Aucun fichier à transférer.');
console.log('');
