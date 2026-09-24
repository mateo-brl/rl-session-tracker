// Tests de l'export CSV (src/main/csv.js).
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toCsv } = require('../src/main/csv.js');

const match = {
  endedAt: Date.UTC(2026, 8, 24, 20, 0, 0), mode: '2v2', ranked: true, result: 'W',
  score: [3, 2], isOT: true, forfeit: false, myTeam: 0,
  me: { goals: 2, assists: 1, saves: 3, shots: 5, score: 640, mvp: true },
  players: [
    { name: 'Mateo', team: 0 }, { name: 'Lu;cas', team: 0 },
    { name: 'Adv "le fort"', team: 1 }, { name: 'Autre', team: 1 },
  ],
};

test('csv : BOM, séparateur « ; », pseudos piégés entre guillemets', () => {
  const out = toCsv([match], 'Mateo');
  assert.ok(out.startsWith('﻿'));
  const lines = out.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^date;mode;classe;resultat;score/);
  assert.match(lines[1], /;2v2;classe;W;3-2;oui;non;2;1;3;5;640;oui;/);
  // Le joueur suivi n'apparaît pas parmi ses coéquipiers ; un « ; » dans un
  // pseudo ne casse pas les colonnes.
  assert.match(lines[1], /;"Lu;cas";"Adv ""le fort"", Autre"$/);
});

test('csv : équipe inconnue, colonnes de joueurs vides', () => {
  const out = toCsv([Object.assign({}, match, { myTeam: null, me: null })], 'Mateo');
  const cols = out.slice(1).trim().split('\r\n')[1].split(';');
  assert.equal(cols.length, 15);
  assert.equal(cols[13], '');
  assert.equal(cols[14], '');
});
