// Tests du garde-fou des lectures de MMR (src/main/mmr-guard.js) et de la
// recherche du dossier Documents (src/main/documents.js).
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { judge, tolerance, IDLE_MS } = require('../src/main/mmr-guard.js');
const documents = require('../src/main/documents.js');

const T0 = Date.UTC(2026, 8, 24, 18, 0, 0);
const MIN = 60 * 1000;
const bilan = (wins, losses, unmatched) =>
  ({ wins, losses, unmatched: unmatched || 0, net: wins - losses });

test('première lecture d’un mode : acceptée', () => {
  assert.equal(judge({ prev: null, reading: { mode: '2v2', mmr: 1100 }, now: T0 }).action, 'accept');
});

test('lecture cohérente avec les matchs : acceptée', () => {
  // 1100, puis 4 victoires et 1 défaite à ~9 : ~1127 attendu.
  const r = judge({ prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1131 },
    now: T0 + 40 * MIN, step: 9, decided: bilan(4, 1) });
  assert.equal(r.action, 'accept');
  assert.equal(r.expected, 1127);
});

test('forfait mal compté (écart de deux gains) : jamais bloqué', () => {
  // Une défaite enregistrée qui était une victoire : +18 par rapport à l'attendu.
  const r = judge({ prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1118 + 9 },
    now: T0 + 30 * MIN, step: 9, decided: bilan(1, 1) });
  assert.equal(r.action, 'accept');
});

test('MMR du chef de groupe (bien plus haut) : mis de côté', () => {
  const r = judge({ prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1420 },
    now: T0 + 25 * MIN, step: 9, decided: bilan(2, 1) });
  assert.equal(r.action, 'hold');
  assert.equal(r.expected, 1109);
});

test('saut sans aucun match enregistré : accepté après une longue pause, pas juste après', () => {
  const base = { prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1180 },
    step: 9, decided: bilan(0, 0) };
  assert.equal(judge(Object.assign({ now: T0 + 5 * MIN }, base)).action, 'hold');
  assert.equal(judge(Object.assign({ now: T0 + IDLE_MS + MIN }, base)).action, 'accept');
});

test('lecture mise de côté puis confirmée par la suivante : vrai saut', () => {
  // Mis de côté : 1250 alors que ~1109 attendu. Puis 2 victoires : 1268.
  const r = judge({ prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1268 },
    now: T0 + 60 * MIN, step: 9, decided: bilan(4, 1),
    pending: { mmr: 1250, at: T0 + 25 * MIN }, decidedPending: bilan(2, 0) });
  assert.equal(r.action, 'accept-pending');
});

test('lecture mise de côté puis retour sur la trajectoire : elle était l’intruse', () => {
  const r = judge({ prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1127 },
    now: T0 + 60 * MIN, step: 9, decided: bilan(4, 1),
    pending: { mmr: 1420, at: T0 + 25 * MIN }, decidedPending: bilan(2, 0) });
  assert.equal(r.action, 'accept');
});

test('ni l’un ni l’autre : la nouvelle lecture remplace celle en attente', () => {
  const r = judge({ prev: { t: T0, v: 1100 }, reading: { mode: '2v2', mmr: 1700 },
    now: T0 + 60 * MIN, step: 9, decided: bilan(4, 1),
    pending: { mmr: 1420, at: T0 + 25 * MIN }, decidedPending: bilan(2, 0) });
  assert.equal(r.action, 'hold');
});

test('tolérance : grandit avec le nombre de matchs et les matchs sans verdict', () => {
  assert.equal(tolerance(9, bilan(0, 0)), 27);
  assert.equal(tolerance(9, bilan(3, 2)), 47);
  assert.equal(tolerance(9, bilan(0, 0, 2)), 54);
  assert.equal(tolerance(6, bilan(0, 0)), 25);   // plancher
});

test('documents : dossier connu de Windows en premier, OneDrive ensuite, journal le plus récent', (t) => {
  const saved = { USERPROFILE: process.env.USERPROFILE, OneDrive: process.env.OneDrive };
  t.after(() => {
    documents.setKnown(null);
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-docs-'));
  const home = path.join(root, 'home');
  const drive = path.join(root, 'OneDrive');
  const moved = path.join(root, 'D', 'Mes documents');
  process.env.USERPROFILE = home;
  process.env.OneDrive = drive;
  documents.setKnown(moved);
  assert.deepEqual(documents.documentsDirs(),
    [moved, path.join(home, 'Documents'), path.join(drive, 'Documents')]);

  // Aucun journal : le dossier connu de Windows sert de chemin par défaut.
  const logIn = (d) => path.join(d, 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log');
  assert.equal(documents.launchLogPath(), logIn(moved));

  // Un vieux journal sous %USERPROFILE%, le vrai (plus récent) sous OneDrive.
  for (const d of [path.join(home, 'Documents'), path.join(drive, 'Documents')]) {
    fs.mkdirSync(path.dirname(logIn(d)), { recursive: true });
    fs.writeFileSync(logIn(d), 'x');
  }
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(logIn(path.join(home, 'Documents')), old, old);
  assert.equal(documents.launchLogPath(), logIn(path.join(drive, 'Documents')));
  assert.deepEqual(documents.existingRocketLeagueDirs(), [
    path.join(home, 'Documents', 'My Games', 'Rocket League'),
    path.join(drive, 'Documents', 'My Games', 'Rocket League'),
  ]);
});
