// Tests du connecteur Stats API (src/main/statsapi.js) : séquences
// d'évènements du jeu rejouées directement dans le routeur (_handle),
// sans socket.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const RLStatsAPI = require('../src/main/statsapi.js');

function feed(api, event, data) {
  api._handle({ event: event, data: data });
}

const PLAYERS = {
  P1: { Name: 'Mateo', TeamNum: 0, Goals: 1, Saves: 0, Assists: 0, Shots: 2, Score: 300 },
  P2: { Name: 'Adv', TeamNum: 1, Goals: 3, Saves: 1, Assists: 0, Shots: 5, Score: 500 },
};
const STATE = { Game: { Teams: [{ Score: 1 }, { Score: 3 }], TimeSeconds: 12 }, Players: PLAYERS };

function listen(api) {
  const got = { ended: 0, abandoned: 0, starts: 0 };
  api.on('ended', () => got.ended++);
  api.on('abandoned', () => got.abandoned++);
  api.on('match', (d) => { if (d.phase === 'start') got.starts++; });
  return got;
}

test('FF : matchended puis updatestate puis matchdestroyed = UNE seule fin', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { Winner: 1 });
  // Écran de fin : le jeu continue d'envoyer des updatestate — ils ne
  // doivent PAS recréer un match fantôme…
  feed(api, 'UpdateState', STATE);
  feed(api, 'UpdateState', STATE);
  // …que matchdestroyed compterait comme un abandon (double défaite).
  feed(api, 'MatchDestroyed', {});
  assert.equal(got.ended, 1);
  assert.equal(got.abandoned, 0);
});

test('vrai abandon : destruction sans fin de match = un événement abandoned', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchDestroyed', {});
  assert.equal(got.ended, 0);
  assert.equal(got.abandoned, 1);
});

test('le match suivant repart normalement après une fin de match', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { Winner: 0 });
  feed(api, 'UpdateState', STATE);          // écran de fin, ignoré
  feed(api, 'MatchDestroyed', {});
  feed(api, 'MatchCreated', {});            // nouveau match
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(got.ended, 2);
  assert.equal(got.abandoned, 0);
  assert.equal(got.starts, 2);
});

// ───────── Télémétrie boost (son Alpha Boost) ─────────
// Champs réels de la Stats API : Speed (km/h), Boost (0-100), bBoosting.
// Particularité du jeu : tout champ à 0 / false est OMIS du JSON.

function lastTelemetry(api) {
  const box = { value: null, stops: 0 };
  api.on('telemetry', (t) => {
    box.value = t;
    if (!t.boosting && !t.boost && !t.speed) box.stops++;
  });
  return box;
}

function stateWith(player) {
  return {
    Game: { Teams: [{ Score: 0 }, { Score: 0 }], TimeSeconds: 100 },
    Players: { P1: player, P2: PLAYERS.P2 },
  };
}

test('télémétrie : bBoosting + jauge pleine = boosting, vitesse convertie', () => {
  const api = new RLStatsAPI();
  const got = lastTelemetry(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', stateWith({ Name: 'Mateo', TeamNum: 0, Score: 0,
    Speed: 83, Boost: 64, bBoosting: true }));
  assert.equal(got.value.boosting, true);
  assert.equal(got.value.boost, 64);
  assert.equal(got.value.speed, 2300);            // 83 km/h ≈ supersonique
});

test('télémétrie : champs omis = zéro — jauge vide, pas de son', () => {
  const api = new RLStatsAPI();
  const got = lastTelemetry(api);
  feed(api, 'MatchCreated', {});
  // bBoosting tenu mais Boost absent (= 0) : bouton enfoncé sans carburant.
  feed(api, 'UpdateState', stateWith({ Name: 'Mateo', TeamNum: 0, Score: 0,
    Speed: 50, bBoosting: true }));
  assert.equal(got.value.boosting, false);
  assert.equal(got.value.boost, 0);
});

test('télémétrie : la jauge qui descend vaut un bBoosting', () => {
  const api = new RLStatsAPI();
  const got = lastTelemetry(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', stateWith({ Name: 'Mateo', TeamNum: 0, Score: 0,
    Speed: 40, Boost: 80 }));
  assert.equal(got.value.boosting, false);        // premier paquet : référence
  feed(api, 'UpdateState', stateWith({ Name: 'Mateo', TeamNum: 0, Score: 0,
    Speed: 45, Boost: 71 }));
  assert.equal(got.value.boosting, true);         // 80 → 71 : il booste
});

test('télémétrie : silence pendant le ralenti après un but', () => {
  const api = new RLStatsAPI();
  const got = lastTelemetry(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'GoalScored', { Scorer: { Name: 'Adv', TeamNum: 1 } });
  assert.equal(got.stops, 1);                     // arrêt immédiat du son
  feed(api, 'UpdateState', stateWith({ Name: 'Mateo', TeamNum: 0, Score: 0,
    Speed: 60, Boost: 50, bBoosting: true }));
  assert.equal(got.value.boosting, false);        // replay : muet
});

test('télémétrie : le son est coupé à la fin du match', () => {
  const api = new RLStatsAPI();
  const got = lastTelemetry(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', stateWith({ Name: 'Mateo', TeamNum: 0, Score: 0,
    Speed: 83, Boost: 64, bBoosting: true }));
  assert.equal(got.value.boosting, true);
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(got.value.boosting, false);
  assert.ok(got.stops >= 1);
});

test('télémétrie : suit la cible de la caméra (Game.Target)', () => {
  const api = new RLStatsAPI();
  const got = lastTelemetry(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', {
    Game: { Teams: [{ Score: 0 }, { Score: 0 }], TimeSeconds: 100,
      bHasTarget: true, Target: { Name: 'Adv', TeamNum: 1 } },
    Players: {
      P1: { Name: 'Mateo', TeamNum: 0, Score: 0, Speed: 10 },
      P2: { Name: 'Adv', TeamNum: 1, Score: 0, Speed: 83, Boost: 30, bBoosting: true },
    },
  });
  assert.equal(got.value.boosting, true);         // c'est bien Adv qui est lu
  assert.equal(got.value.speed, 2300);
});

test('les stats des joueurs arrivent dans le snapshot de fin', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { Winner: 1 });
  assert.equal(snap.winnerTeam, 1);
  assert.deepEqual(snap.score, [1, 3]);
  assert.equal(snap.players.length, 2);
  assert.equal(snap.players[0].name, 'Mateo');
  assert.equal(snap.mode, '1v1');           // 2 joueurs → 1v1
});
