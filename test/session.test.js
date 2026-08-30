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

test('forfait sans vainqueur connu (notre départ) = défaite, quel que soit le score', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, score: [3, 0] }));
  const m = s.snapshot('Mateo', CFG).history[0];
  assert.equal(m.result, 'L');
  assert.equal(m.forfeit, true);
  assert.equal(m.me.mvp, false);
});

test('forfait avec vainqueur annoncé par le jeu : le vainqueur prime', () => {
  const s = tmpStore();
  // FF adverse : le jeu a annoncé notre équipe (0) gagnante avant la
  // destruction du lobby — victoire, même si on menait 0-2.
  s.addMatch(snap({ forfeit: true, winnerTeam: 0, score: [0, 2] }));
  // FF de notre équipe : vainqueur = équipe 1 — défaite.
  s.addMatch(snap({ forfeit: true, winnerTeam: 1, score: [2, 0] }));
  const h = s.snapshot('Mateo', CFG).history;   // récent → ancien
  assert.equal(h[1].result, 'W');
  assert.equal(h[0].result, 'L');
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

// ───────── Head-to-head (« déjà croisé ») ─────────

test('head-to-head : bilan contre un adversaire récurrent', () => {
  const s = tmpStore();
  // « Rival » nous bat une fois, perd deux fois.
  s.addMatch(snap({ players: [
    { name: 'Mateo', team: 0, goals: 1, saves: 0, assists: 0, shots: 2, score: 300 },
    { name: 'Rival', team: 1, goals: 3, saves: 1, assists: 0, shots: 5, score: 500 },
  ], mode: '1v1', winnerTeam: 1, score: [1, 3] }));
  s.addMatch(snap({ players: [
    { name: 'Mateo', team: 0, goals: 4, saves: 0, assists: 0, shots: 6, score: 700 },
    { name: 'Rival', team: 1, goals: 1, saves: 2, assists: 0, shots: 3, score: 350 },
  ], mode: '1v1', winnerTeam: 0, score: [4, 1] }));
  s.addMatch(snap({ players: [
    { name: 'Mateo', team: 1, goals: 2, saves: 0, assists: 0, shots: 3, score: 400 },
    { name: 'RIVAL', team: 0, goals: 0, saves: 1, assists: 0, shots: 1, score: 150 },
  ], mode: '1v1', winnerTeam: 1, score: [0, 2] }));    // équipes inversées + casse
  const h = s.headToHead(['Rival'], 'mateo');
  assert.equal(h.Rival.played, 3);
  assert.equal(h.Rival.wins, 2);
  assert.equal(h.Rival.losses, 1);
});

test('head-to-head : un coéquipier ne compte pas comme adversaire', () => {
  const s = tmpStore();
  s.addMatch(snap({}));   // « Mate1 » est dans notre équipe
  const h = s.headToHead(['Mate1'], 'Mateo');
  assert.equal(h.Mate1, undefined);
});

test('head-to-head : inconnu, soi-même ou pseudo absent = vide', () => {
  const s = tmpStore();
  s.addMatch(snap({}));
  assert.deepEqual(s.headToHead(['Personne'], 'Mateo'), {});
  assert.deepEqual(s.headToHead(['Mateo'], 'Mateo'), {});
  assert.deepEqual(s.headToHead(['Adv1a'], ''), {});
});

// ───────── Forfait : distinguer « on a quitté » de « l'adversaire a FF » ─────────
// Les deux arrivent au tracker sous la même forme (destruction du lobby sans
// vainqueur annoncé). Le seul discriminateur fiable est le PODIUM : s'il a été
// atteint, le jeu avait déjà conclu le match — notre départ n'était qu'une
// sortie d'écran de fin, pas un abandon.

test('forfait adverse : podium atteint + score en notre faveur = victoire', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, podium: true, score: [3, 0] }));
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'W');
});

test('forfait : podium atteint mais on était mené = défaite', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, podium: true, score: [0, 3] }));
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'L');
});

test('forfait : sans podium, quitter en menant reste une défaite', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, podium: false, score: [3, 0] }));
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'L');
});

test('forfait : le vainqueur annoncé prime toujours sur le podium', () => {
  const s = tmpStore();
  // Podium atteint et on menait 3-0, mais le jeu a désigné l'équipe 1.
  s.addMatch(snap({ forfeit: true, winnerTeam: 1, podium: true, score: [3, 0] }));
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'L');
});

test('head-to-head : un adversaire nommé « constructor » ne casse pas le bilan', () => {
  const s = tmpStore();
  s.addMatch(snap({ players: [
    { name: 'Mateo', team: 0, goals: 3, saves: 0, assists: 0, shots: 4, score: 600 },
    { name: 'constructor', team: 1, goals: 0, saves: 1, assists: 0, shots: 2, score: 150 },
  ], mode: '1v1', winnerTeam: 0, score: [3, 0] }));
  const h = s.headToHead(['constructor'], 'Mateo');
  assert.equal(h.constructor.played, 1);
  assert.equal(h.constructor.wins, 1);
  assert.equal(h.constructor.losses, 0);
});

test('journal illisible : sauvegardé au lieu d’être écrasé', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-test-'));
  const file = path.join(dir, 'matches.json');
  fs.writeFileSync(file, '{"matches":[{"id":"m1"');     // JSON tronqué
  const s = new SessionStore(dir);
  assert.equal(s.matches.length, 0);                    // on repart à vide…
  s.resetSession();                                     // …et on réécrit aussitôt
  const saved = fs.readdirSync(dir).filter((f) => f.startsWith('matches.json.corrupt-'));
  assert.equal(saved.length, 1);                        // l'original est conservé
  assert.match(fs.readFileSync(path.join(dir, saved[0]), 'utf8'), /^\{"matches"/);
});

test('premier lancement : aucune sauvegarde parasite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-test-'));
  new SessionStore(dir).resetSession();
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 0);
});

// ───────── MatchGuid : le journal devient idempotent ─────────

test('même MatchGuid : le match n’est pas enregistré deux fois', () => {
  const s = tmpStore();
  s.addMatch(snap({ guid: 'abc-123' }));
  s.addMatch(snap({ guid: 'abc-123' }));      // fin normale PUIS abandon
  assert.equal(s.matches.length, 1);
});

test('sans MatchGuid (hors ligne), le dédoublonnage ne bloque rien', () => {
  const s = tmpStore();
  s.addMatch(snap({}));
  s.addMatch(snap({}));
  assert.equal(s.matches.length, 2);
});

// ───────── Pas MMR appris ─────────

test('pas MMR appris : utilisé à la place de la moyenne figée à 9', () => {
  const s = tmpStore();
  s.addMatch(snap({}));                        // une victoire classée
  const cfg = { mmr: { '2v2': { base: 1000, setAt: 0 } }, mmrCounts: true,
    mmrStep: { '2v2': 12 } };
  const a = s.snapshot('Mateo', cfg).session;
  assert.equal(a.mmr['2v2'].value, 1012);
  assert.equal(a.mmr['2v2'].step, 12);
});

test('pas MMR aberrant ignoré : repli sur la valeur par défaut', () => {
  const s = tmpStore();
  s.addMatch(snap({}));
  for (const bad of [0, 1, 40, -9, NaN]) {
    const cfg = { mmr: { '2v2': { base: 1000, setAt: 0 } }, mmrStep: { '2v2': bad } };
    assert.equal(s.snapshot('Mateo', cfg).session.mmr['2v2'].value, 1009);
  }
});

test('decidedBetween : victoires nettes d’un mode sur un intervalle', () => {
  const s = tmpStore();
  const t = Date.now();
  s.addMatch(snap({ endedAt: t - 5000 }));                              // W (hors)
  s.addMatch(snap({ endedAt: t - 1000 }));                              // W
  s.addMatch(snap({ endedAt: t - 500, winnerTeam: 1, score: [0, 2] })); // L
  s.addMatch(snap({ endedAt: t - 400 }));                               // W
  s.addMatch(snap({ endedAt: t - 300, ranked: false }));                // casual, ignoré
  const d = s.decidedBetween('2v2', t - 2000, t, 'Mateo');
  assert.equal(d.wins, 2);
  assert.equal(d.losses, 1);
  assert.equal(d.net, 1);
});

test('évènements bruts conservés pour le match, purgés sur les anciens', () => {
  const s = tmpStore();
  const ev = [{ at: 1, event: 'matchended', data: { Winner: 0 } }];
  s.addMatch(snap({ events: ev }));
  assert.equal(s.matches[0].events.length, 1);
  // Au-delà du seuil de conservation, les anciens perdent leurs évènements.
  for (let i = 0; i < 101; i++) s.addMatch(snap({ events: ev }));
  assert.equal(s.matches[0].events.length, 0);
  assert.equal(s.matches[s.matches.length - 1].events.length, 1);
});

// ───────── Régressions relevées en revue de code ─────────

test('addMatch signale s’il a réellement enregistré', () => {
  const s = tmpStore();
  assert.equal(s.addMatch(snap({ guid: 'g1' })), true);
  assert.equal(s.addMatch(snap({ guid: 'g1' })), false);   // doublon
  assert.equal(s.addMatch({ players: [] }), false);        // entraînement
});

test('unmatched ne compte QUE le pseudo introuvable', () => {
  const s = tmpStore();
  // Pseudo absent du match : c'est bien un problème de pseudo.
  s.addMatch(snap({}));
  assert.equal(s.snapshot('Inconnu', CFG).session.unmatched, 1);
  // Forfait indécidable (podium, score à égalité) : le joueur EST identifié,
  // le pseudo n'a rien à voir — il ne doit pas être mis en cause.
  const s2 = tmpStore();
  s2.addMatch(snap({ forfeit: true, winnerTeam: null, podium: true, score: [2, 2] }));
  const a = s2.snapshot('Mateo', CFG).session;
  assert.equal(a.unknown, 1);
  assert.equal(a.unmatched, 0);
});

test('decidedBetween signale les matchs non attribués', () => {
  const s = tmpStore();
  const t = Date.now();
  s.addMatch(snap({ endedAt: t - 1000 }));                     // W pour Mateo
  s.addMatch(snap({ endedAt: t - 900, players: [
    { name: 'Autre', team: 0, goals: 1, saves: 0, assists: 0, shots: 1, score: 100 },
    { name: 'AdvX', team: 1, goals: 0, saves: 0, assists: 0, shots: 1, score: 50 },
  ] }));                                                        // Mateo absent
  const d = s.decidedBetween('2v2', t - 2000, t, 'Mateo');
  assert.equal(d.wins, 1);
  assert.equal(d.unmatched, 1);
});

test('export : le JSON garde les joueurs, le vainqueur et les évènements', () => {
  const s = tmpStore();
  s.addMatch(snap({ guid: 'g9', events: [{ at: 1, event: 'matchended', data: {} }] }));
  const rows = s.exportRows('Mateo');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 'W');            // point de vue calculé
  assert.equal(rows[0].winnerTeam, 0);          // …ET données brutes
  assert.equal(rows[0].guid, 'g9');
  assert.equal(rows[0].players.length, 4);
  assert.equal(rows[0].events.length, 1);
});

test('bornes du pas MMR exportées une seule fois', () => {
  assert.equal(SessionStore.MMR_STEP_MIN, 4);
  assert.equal(SessionStore.MMR_STEP_MAX, 20);
  assert.equal(SessionStore.MMR_STEP, 9);
});

// ───────── Courbe d'évolution ancrée sur les relevés du jeu ─────────
// Régression : le recalage repoussait `setAt` à « maintenant » à chaque mise
// en file, et la courbe — qui ne gardait que les matchs postérieurs — se
// réduisait à un seul point. Les relevés sont désormais des ANCRES datées.

function withReadings(readings) {
  const s = tmpStore();
  s.mmrReadings = readings;
  return s;
}
const LOGCFG = { mmr: { '2v2': { base: 1000, setAt: 0, fromLog: true } }, mmrCounts: true };

test('la courbe survit au recalage : elle garde tout l’historique', () => {
  const t0 = Date.now() - 100000;
  const s = withReadings({ '2v2': [{ t: t0 - 1000, v: 1000, tier: 18 }] });
  [1, 0, 1, 1, 0].forEach((w, i) => s.addMatch(snap(w
    ? { endedAt: t0 + i * 1000 }
    : { endedAt: t0 + i * 1000, winnerTeam: 1, score: [0, 2] })));
  const evo = s.snapshot('Mateo', LOGCFG).evolution['2v2'];
  assert.deepEqual(evo.map((p) => p.v), [1000, 1009, 1000, 1009, 1018, 1009]);
});

test('un nouveau relevé reprend la main sur l’estimation', () => {
  const t0 = Date.now() - 100000;
  const s = withReadings({ '2v2': [
    { t: t0 - 1000, v: 1000, tier: 18 },
    { t: t0 + 1500, v: 1042, tier: 19 },   // le vrai MMR a bougé plus que prévu
  ] });
  s.addMatch(snap({ endedAt: t0 }));                 // victoire estimée : 1009
  s.addMatch(snap({ endedAt: t0 + 3000 }));          // après l'ancre : 1042 + 9
  const evo = s.snapshot('Mateo', LOGCFG).evolution['2v2'];
  assert.deepEqual(evo.map((p) => p.v), [1000, 1009, 1042, 1051]);
  assert.deepEqual(evo.map((p) => !!p.real), [true, false, true, false]);
});

test('rang déduit du palier du dernier relevé', () => {
  const s = withReadings({ '2v2': [{ t: Date.now() - 5000, v: 1400, tier: 18 }] });
  s.addMatch(snap({}));
  const m = s.snapshot('Mateo', LOGCFG).session.mmr['2v2'];
  assert.equal(m.rank, 'Champion III');
  assert.equal(m.tier, 18);
  assert.equal(SessionStore.tierName(22), 'Supersonic Legend');
  assert.equal(SessionStore.tierName(0), 'Non classé');
  assert.equal(SessionStore.tierName(99), null);
});

test('variation de session mesurée sur les vrais relevés', () => {
  const t0 = Date.now() - 50000;
  const s = withReadings({ '2v2': [{ t: t0 - 1000, v: 1000, tier: 18 }] });
  s.addMatch(snap({ endedAt: t0 }));
  s.addMatch(snap({ endedAt: t0 + 1000 }));
  const m = s.snapshot('Mateo', LOGCFG).session.mmr['2v2'];
  assert.equal(m.delta, 18);          // deux victoires depuis le début
  assert.equal(m.deltaReal, true);
});

test('un même relevé répété ne crée pas de point en double', () => {
  const s = tmpStore();
  assert.equal(s.addMmrReading('2v2', 1200, 18), true);
  assert.equal(s.addMmrReading('2v2', 1200, 18), false);
  assert.equal(s.addMmrReading('2v2', 1209, 18), true);
  assert.equal(s.mmrReadings['2v2'].length, 2);
  assert.deepEqual(s.lastReading('2v2').v, 1209);
});

test('relevés persistés et relus depuis le fichier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-test-'));
  new SessionStore(dir).addMmrReading('3v3', 950, 15);
  const s2 = new SessionStore(dir);
  assert.equal(s2.lastReading('3v3').v, 950);
  assert.equal(s2.lastReading('3v3').tier, 15);
});

// ───────── « Ne compter que le classé » ─────────

test('rankedOnly retire le casual de la session sans toucher au journal', () => {
  const s = tmpStore();
  s.addMatch(snap({}));                       // classé, victoire
  s.addMatch(snap({ ranked: false }));        // casual, victoire
  const all = s.snapshot('Mateo', { mmr: {}, mmrCounts: true });
  const only = s.snapshot('Mateo', { mmr: {}, mmrCounts: true, rankedOnly: true });
  assert.equal(all.session.played, 2);
  assert.equal(only.session.played, 1);
  assert.equal(s.matches.length, 2);          // rien n'est supprimé
});

// ───────── Correction d'un résultat (manuelle et réconciliée) ─────────
// Un forfait adverse suivi d'un départ immédiat peut arriver sans AUCUN
// signal exploitable : ni vainqueur annoncé, ni podium. Deux filets :
// la correction manuelle, et la réconciliation par le vrai MMR.

test('correction manuelle : W, L, retour à l’automatique', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, score: [3, 0] }));
  const id = s.matches[0].id;
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'L');   // le bug vécu

  assert.equal(s.overrideResult(id, 'W', 'Mateo'), true);
  const fixed = s.snapshot('Mateo', CFG).history[0];
  assert.equal(fixed.result, 'W');
  assert.equal(fixed.overridden, true);

  assert.equal(s.overrideResult(id, null, 'Mateo'), true);
  assert.equal(s.snapshot('Mateo', CFG).history[0].result, 'L');
  assert.equal(s.snapshot('Mateo', CFG).history[0].overridden, false);
});

test('correction stockée en équipe : survit à un changement de casse du pseudo', () => {
  const s = tmpStore();
  s.addMatch(snap({ forfeit: true, winnerTeam: null, score: [3, 0] }));
  s.overrideResult(s.matches[0].id, 'W', 'MATEO');
  assert.equal(s.snapshot('mateo', CFG).history[0].result, 'W');
});

test('correction refusée si le pseudo n’est pas dans le match', () => {
  const s = tmpStore();
  s.addMatch(snap({}));
  assert.equal(s.overrideResult(s.matches[0].id, 'W', 'Inconnu'), false);
  assert.equal(s.overrideResult('id-inexistant', 'W', 'Mateo'), false);
});

test('réconciliation : le faux L devient W quand le vrai MMR le trahit', () => {
  const t0 = Date.now() - 100000;
  const s = tmpStore();
  // Deux victoires normales + un forfait adverse compté L à tort.
  s.addMatch(snap({ endedAt: t0 + 1000 }));
  s.addMatch(snap({ endedAt: t0 + 2000, forfeit: true, winnerTeam: null, score: [3, 0] }));
  s.addMatch(snap({ endedAt: t0 + 3000 }));
  // Bilan enregistré : +1 net (W, L, W) → attendu +9. Vrai MMR : +27 (3 W).
  const fixed = s.reconcileForfeits('2v2', { t: t0, v: 1000 }, t0 + 10000, 1027, 9, 'Mateo');
  assert.ok(fixed);
  assert.equal(fixed.flipped, 'W');
  assert.equal(s.snapshot('Mateo', CFG).history.find((m) => m.forfeit).result, 'W');
});

test('réconciliation : rien sans écart significatif', () => {
  const t0 = Date.now() - 100000;
  const s = tmpStore();
  s.addMatch(snap({ endedAt: t0 + 1000, forfeit: true, winnerTeam: null, score: [3, 0] }));
  // Le vrai MMR colle au bilan (-9) : le L était un vrai L.
  assert.equal(s.reconcileForfeits('2v2', { t: t0, v: 1000 }, t0 + 10000, 991, 9, 'Mateo'), null);
});

test('réconciliation : ambiguïté (deux candidats) = on ne touche à rien', () => {
  const t0 = Date.now() - 100000;
  const s = tmpStore();
  s.addMatch(snap({ endedAt: t0 + 1000, forfeit: true, winnerTeam: null, score: [3, 0] }));
  s.addMatch(snap({ endedAt: t0 + 2000, forfeit: true, winnerTeam: null, score: [2, 0] }));
  assert.equal(s.reconcileForfeits('2v2', { t: t0, v: 1000 }, t0 + 10000, 1000, 9, 'Mateo'), null);
});

test('réconciliation : intervalle troué (match non attribué) = refus', () => {
  const t0 = Date.now() - 100000;
  const s = tmpStore();
  s.addMatch(snap({ endedAt: t0 + 1000, forfeit: true, winnerTeam: null, score: [3, 0] }));
  s.addMatch(snap({ endedAt: t0 + 2000, players: [
    { name: 'Autre', team: 0, goals: 1, saves: 0, assists: 0, shots: 1, score: 100 },
    { name: 'AdvZ', team: 1, goals: 0, saves: 0, assists: 0, shots: 1, score: 50 },
  ] }));
  assert.equal(s.reconcileForfeits('2v2', { t: t0, v: 1000 }, t0 + 10000, 1009, 9, 'Mateo'), null);
});

test('réconciliation symétrique : un W de podium à tort redevient L', () => {
  const t0 = Date.now() - 100000;
  const s = tmpStore();
  // Forfait avec podium et score en notre faveur → compté W… mais c'était
  // NOTRE forfait (cas rare) : le vrai MMR a baissé.
  s.addMatch(snap({ endedAt: t0 + 1000, forfeit: true, winnerTeam: null,
    podium: true, score: [3, 0] }));
  const fixed = s.reconcileForfeits('2v2', { t: t0, v: 1000 }, t0 + 10000, 991, 9, 'Mateo');
  assert.ok(fixed);
  assert.equal(fixed.flipped, 'L');
});

// ───────── Rang dérivé du MMR, par playlist ─────────
// Constaté en jeu : le palier écrit dans le journal (PartyLeaderTier) n'est
// pas celui de la playlist mise en file — un Platine 1v1 s'affichait
// « Champion », son meilleur rang ailleurs. Le rang vient donc du MMR, dont
// l'exactitude est validée, avec les seuils PROPRES à chaque playlist.

test('640 de MMR : Platine en 1v1, encore Or en 2v2 — les échelles diffèrent', () => {
  assert.match(SessionStore.tierName(SessionStore.tierFromMmr('1v1', 640)), /^Platine/);
  assert.match(SessionStore.tierName(SessionStore.tierFromMmr('2v2', 640)), /^Or/);
  // Le cas rapporté : 700 en 1v1 = Platine.
  assert.match(SessionStore.tierName(SessionStore.tierFromMmr('1v1', 700)), /^Platine/);
});

test('le cas vécu : 700 en 1v1 ne doit JAMAIS afficher Champion', () => {
  const name = SessionStore.tierName(SessionStore.tierFromMmr('1v1', 700));
  assert.ok(!/Champion/.test(name), name);
});

test('paliers plausibles sur toute l’échelle 2v2', () => {
  assert.match(SessionStore.tierName(SessionStore.tierFromMmr('2v2', 100)), /^Bronze/);
  assert.match(SessionStore.tierName(SessionStore.tierFromMmr('2v2', 1264)), /^Champion/);
  assert.match(SessionStore.tierName(SessionStore.tierFromMmr('2v2', 1500)), /^Grand Champion/);
  assert.equal(SessionStore.tierName(SessionStore.tierFromMmr('2v2', 1950)), 'Supersonic Legend');
});

test('pas de table pour un mode : pas de rang, jamais un rang faux', () => {
  assert.equal(SessionStore.tierFromMmr('4v4', 900), null);
  assert.equal(SessionStore.tierFromMmr('2v2', null), null);
  assert.equal(SessionStore.tierFromMmr('2v2', 0), null);
});

test('le rang affiché vient du MMR courant, pas du palier du journal', () => {
  const s = tmpStore();
  // Le journal prétend « Champion I » (tier 16) sur un relevé 1v1 à 700 :
  // c'est le symptôme constaté — le rang doit sortir Platine quand même.
  s.mmrReadings = { '1v1': [{ t: Date.now() - 5000, v: 700, tier: 16 }] };
  s.addMatch(snap({ mode: '1v1', players: [
    { name: 'Mateo', team: 0, goals: 1, saves: 0, assists: 0, shots: 2, score: 300 },
    { name: 'Solo', team: 1, goals: 0, saves: 1, assists: 0, shots: 1, score: 150 },
  ] }));
  const cfg = { mmr: { '1v1': { base: 700, setAt: 0, fromLog: true } }, mmrCounts: true };
  const m = s.snapshot('Mateo', cfg).session.mmr['1v1'];
  assert.match(m.rank, /^Platine/);
});
