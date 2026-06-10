// Tests du journal des matchs et des statistiques (src/main/session.js).
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SessionStore = require('../src/main/session.js');

function tmpStore() {
  return new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-test-')));
}

// Match 2v2 type : « Mateo » + coéquipier contre deux adversaires uniques.
let uid = 0;
function snap(over) {
  uid++;
  return Object.assign({
    mode: '2v2',
    score: [3, 1],
    winnerTeam: 0,
    isOT: false,
    endedAt: Date.now(),
    players: [
      { name: 'Mateo', team: 0, goals: 2, saves: 1, assists: 0, shots: 4, score: 520 },
      { name: 'Mate1', team: 0, goals: 1, saves: 0, assists: 1, shots: 2, score: 300 },
      { name: 'Adv' + uid + 'a', team: 1, goals: 1, saves: 2, assists: 0, shots: 3, score: 280 },
      { name: 'Adv' + uid + 'b', team: 1, goals: 0, saves: 1, assists: 1, shots: 1, score: 200 },
    ],
  }, over);
}

const CFG = { mmr: { '2v2': { base: 1000, setAt: 0 } }, mmrCounts: true };

test('victoire / défaite attribuées par équipe, insensible à la casse', () => {
  const s = tmpStore();
  s.addMatch(snap({}));                                    // victoire
  s.addMatch(snap({ winnerTeam: 1, score: [1, 3] }));      // défaite
  const a = s.snapshot('mateo', CFG).session;
  assert.equal(a.wins, 1);
  assert.equal(a.losses, 1);
  assert.equal(a.winrate, 50);
});

test('vainqueur déduit du score quand le jeu ne l’annonce pas', () => {
  const s = tmpStore();
  s.addMatch(snap({ winnerTeam: null, score: [2, 5] }));
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'L');
});

test('forfait = défaite, quel que soit le score', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, score: [3, 0] }));
  const m = s.snapshot('Mateo', CFG).history[0];
  assert.equal(m.result, 'L');
  assert.equal(m.forfeit, true);
  assert.equal(m.me.mvp, false);
});

test('entraînement (joueur seul) jamais enregistré', () => {
  const s = tmpStore();
  s.addMatch({ mode: '1v1', score: [5, 0], endedAt: Date.now(),
    players: [{ name: 'Mateo', team: 0, goals: 5, saves: 0, assists: 0, shots: 9, score: 900 }] });
  assert.equal(s.matches.length, 0);
});

test('MVP : meilleur score ET équipe gagnante', () => {
  const s = tmpStore();
  s.addMatch(snap({}));                                    // Mateo top score, gagnant
  s.addMatch(snap({ winnerTeam: 1, score: [0, 2] }));      // top score mais perdant
  const h = s.snapshot('Mateo', CFG).history;              // récent → ancien
  assert.equal(h[1].me.mvp, true);
  assert.equal(h[0].me.mvp, false);
});

test('seuls les matchs classés font bouger le MMR estimé', () => {
  const s = tmpStore();
  s.addMatch(snap({}));                                    // classé : +9
  s.addMatch(snap({ ranked: false }));                     // casual : ignoré
  s.addMatch(snap({ winnerTeam: 1, score: [0, 1] }));      // classé : −9
  const a = s.snapshot('Mateo', CFG).session;
  assert.equal(a.mmr['2v2'].value, 1000);
  assert.equal(a.mmr['2v2'].delta, 0);
});

test('série courante et meilleure série de victoires', () => {
  const s = tmpStore();
  const t0 = Date.now() - 4000;
  ['W', 'W', 'W', 'L', 'W'].forEach((r, i) => {
    s.addMatch(snap(r === 'W'
      ? { endedAt: t0 + i }
      : { endedAt: t0 + i, winnerTeam: 1, score: [0, 2] }));
  });
  const a = s.snapshot('Mateo', CFG).session;
  assert.deepEqual(a.streak, { type: 'W', count: 1 });
  assert.equal(a.bestWinStreak, 3);
});

test('vider les matchs récents conserve journal, MMR, records', () => {
  const s = tmpStore();
  s.addMatch(snap({}));
  s.addMatch(snap({}));
  s.resetSession();
  const out = s.snapshot('Mateo', CFG);
  assert.equal(out.session.played, 0);
  assert.equal(out.session.mmr['2v2'].value, 1018);
  assert.equal(out.records.totalPlayed, 2);
  assert.equal(out.records.bestWinStreak, 2);
});

test('coupure de 2 h = nouvelle session, journal intact', () => {
  const s = tmpStore();
  s.addMatch(snap({ endedAt: Date.now() - 3 * 3600e3 }));
  s.addMatch(snap({ endedAt: Date.now() }));
  const out = s.snapshot('Mateo', CFG);
  assert.equal(out.session.played, 1);
  assert.equal(out.records.totalPlayed, 2);
});

test('courbe d’évolution : un point par match classé + base', () => {
  const s = tmpStore();
  s.addMatch(snap({}));
  s.addMatch(snap({ ranked: false }));
  s.addMatch(snap({ winnerTeam: 1, score: [1, 2] }));
  const evo = s.snapshot('Mateo', CFG).evolution['2v2'];
  assert.deepEqual(evo.map((p) => p.v), [1000, 1009, 1000]);
});

test('détection du pseudo : unique si les adversaires changent', () => {
  const s = tmpStore();
  // Coéquipier différent à chaque match → seul Mateo est partout.
  s.addMatch(snap({ players: snap({}).players.map((p, i) =>
    i === 1 ? { ...p, name: 'Pote1' } : p) }));
  s.addMatch(snap({ players: snap({}).players.map((p, i) =>
    i === 1 ? { ...p, name: 'Pote2' } : p) }));
  const d = s.detectPseudo();
  assert.equal(d.auto, 'Mateo');
});

test('changer de pseudo recalcule tout l’historique', () => {
  const s = tmpStore();
  const m = snap({});
  const opponent = m.players[2].name;     // un joueur de l'équipe perdante
  s.addMatch(m);
  assert.equal(s.snapshot('Mateo', CFG).session.wins, 1);
  assert.equal(s.snapshot(opponent, CFG).session.losses, 1);
});

test('persistance : relecture depuis le fichier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-test-'));
  const s1 = new SessionStore(dir);
  s1.addMatch(snap({}));
  const s2 = new SessionStore(dir);
  assert.equal(s2.matches.length, 1);
  assert.ok(s2.playersSeen.includes('Mateo'));
});
