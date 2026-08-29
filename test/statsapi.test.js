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

// ───────── Forfaits (FF) via bHasWinner ─────────
// Lors d'un forfait, le jeu n'envoie pas toujours matchended : le vainqueur
// est annoncé par bHasWinner/Winner dans updatestate, puis le lobby est
// détruit. Sans ce commit, un FF ADVERSE passerait pour un abandon de notre
// part — et serait compté défaite.

test('FF adverse : bHasWinner sans matchended = fin normale, pas un abandon', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  // Les adversaires (équipe 1) votent FF : notre équipe 0 gagne. Règle
  // d'omission du jeu : Winner=0 est ABSENT du JSON.
  feed(api, 'UpdateState', {
    Game: { Teams: [{ Score: 1 }, { Score: 3 }], TimeSeconds: 12, bHasWinner: true },
    Players: PLAYERS,
  });
  feed(api, 'MatchDestroyed', {});
  assert.equal(got.ended, 1);
  assert.equal(got.abandoned, 0);
  assert.equal(snap.winnerTeam, 0);         // Winner omis = équipe 0
});

test('FF : bHasWinner PUIS matchended = une seule fin', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'UpdateState', {
    Game: { Teams: [{ Score: 1 }, { Score: 3 }], TimeSeconds: 12,
      bHasWinner: true, Winner: 1 },
    Players: PLAYERS,
  });
  feed(api, 'MatchEnded', { Winner: 1 });   // l'écran de fin arrive quand même
  feed(api, 'MatchDestroyed', {});
  assert.equal(got.ended, 1);
  assert.equal(got.abandoned, 0);
});

test('FF : le match suivant repart normalement après un commit bHasWinner', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', {
    Game: { Teams: [{ Score: 0 }, { Score: 2 }], bHasWinner: true, Winner: 1 },
    Players: PLAYERS,
  });
  feed(api, 'MatchDestroyed', {});
  feed(api, 'MatchCreated', {});
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

// ───────── Podium : distinguer un FF adverse de notre propre départ ─────────

test('podium atteint puis destruction : l’abandon porte le drapeau podium', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('abandoned', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'PodiumStart', {});
  feed(api, 'MatchDestroyed', {});
  assert.equal(snap.podium, true);
});

test('départ en pleine partie : pas de podium', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('abandoned', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchDestroyed', {});
  assert.equal(snap.podium, false);
});

test('matchdestroyed qui annonce quand même un vainqueur : on le récupère', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('abandoned', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchDestroyed', { Winner: 1 });
  assert.equal(snap.winnerTeam, 1);
});

// ───────── Règle d'omission : un champ à 0 est ABSENT du JSON ─────────

test('matchended sans champ Winner = victoire de l’équipe 0', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { MatchGuid: 'abc' });
  assert.equal(snap.winnerTeam, 0);
});

// ───────── Effectif : un joueur qui part ne doit pas rétrécir le match ─────────

test('adversaire déconnecté : le match reste un vrai match, pas un entraînement', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);                       // 2 joueurs
  // L'adversaire quitte : il disparaît des états suivants.
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 1 }, { Score: 3 }] },
    Players: { P1: PLAYERS.P1 } });
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(snap.players.length, 2);                  // l'adversaire est conservé
  assert.equal(snap.mode, '1v1');
});

test('mode déduit de l’effectif MAXIMAL, pas du premier aperçu', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  // Début de 2v2 : deux joueurs seulement sont encore chargés.
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 0 }, { Score: 0 }] },
    Players: { P1: PLAYERS.P1, P2: PLAYERS.P2 } });
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 0 }, { Score: 0 }] },
    Players: { P1: PLAYERS.P1, P2: PLAYERS.P2,
      P3: { Name: 'Pote', TeamNum: 0, Score: 10 },
      P4: { Name: 'Adv2', TeamNum: 1, Score: 20 } } });
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(snap.mode, '2v2');
});

test('chaos 4v4 : le mode n’est plus rabattu sur 3v3', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  const eight = {};
  for (let i = 0; i < 8; i++) {
    eight['P' + i] = { Name: 'J' + i, TeamNum: i % 2, Score: 10 };
  }
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 0 }, { Score: 0 }] }, Players: eight });
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(snap.mode, '4v4');
});

// ───────── Le match ne survit pas à la fermeture du socket ─────────

test('socket fermé en plein match : le match suivant n’hérite pas de son mode', () => {
  const api = new RLStatsAPI();
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 0 }, { Score: 0 }] },
    Players: { P1: PLAYERS.P1, P2: PLAYERS.P2,
      P3: { Name: 'A', TeamNum: 0, Score: 1 }, P4: { Name: 'B', TeamNum: 1, Score: 1 },
      P5: { Name: 'C', TeamNum: 0, Score: 1 }, P6: { Name: 'D', TeamNum: 1, Score: 1 } } });
  assert.equal(api.match.mode, '3v3');
  api.match = null;                       // ce que fait le handler 'close'
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(snap.mode, '1v1');
});

// ───────── Découpage du flux TCP (jamais testé jusqu'ici) ─────────
// C'est l'UNIQUE chemin d'ingestion de l'application : le JSON arrive
// concaténé, sans délimiteur, et un objet peut être coupé par la frontière
// d'un paquet TCP.

function collect(api) {
  const seen = [];
  const orig = api._handle.bind(api);
  api._handle = (env) => { seen.push(env); orig(env); };
  return seen;
}

test('flux : un objet coupé en deux paquets est réassemblé', () => {
  const api = new RLStatsAPI();
  const seen = collect(api);
  const raw = JSON.stringify({ event: 'MatchCreated', data: {} });
  api._onData(raw.slice(0, 12));
  assert.equal(seen.length, 0);                 // rien tant que l'objet est incomplet
  api._onData(raw.slice(12));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, 'MatchCreated');
});

test('flux : plusieurs objets concaténés dans un même paquet', () => {
  const api = new RLStatsAPI();
  const seen = collect(api);
  api._onData(JSON.stringify({ event: 'MatchCreated', data: {} })
    + JSON.stringify({ event: 'GoalScored', data: {} })
    + JSON.stringify({ event: 'MatchDestroyed', data: {} }));
  assert.deepEqual(seen.map((e) => e.event),
    ['MatchCreated', 'GoalScored', 'MatchDestroyed']);
});

test('flux : accolades et guillemets échappés dans un pseudo ne trompent pas le parseur', () => {
  const api = new RLStatsAPI();
  const seen = collect(api);
  const raw = JSON.stringify({ event: 'UpdateState',
    data: { Players: { P1: { Name: 'a{"}\\b', TeamNum: 0 } } } });
  // Coupé pile sur la séquence d'échappement.
  const cut = raw.indexOf('\\\\') + 1;
  api._onData(raw.slice(0, cut));
  api._onData(raw.slice(cut));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.Players.P1.Name, 'a{"}\\b');
});

test('flux : le bruit entre deux objets est ignoré', () => {
  const api = new RLStatsAPI();
  const seen = collect(api);
  api._onData('\r\n  ' + JSON.stringify({ event: 'MatchCreated', data: {} }) + '\n\n');
  assert.equal(seen.length, 1);
});

test('flux : enveloppe dont data est une chaîne JSON', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  api._onData(JSON.stringify({ event: 'MatchCreated', data: '{}' }));
  api._onData(JSON.stringify({ event: 'UpdateState', data: JSON.stringify(STATE) }));
  api._onData(JSON.stringify({ event: 'MatchEnded', data: '{"Winner":1}' }));
  assert.equal(snap.winnerTeam, 1);
  assert.deepEqual(snap.score, [1, 3]);
});

test('flux : les objets valides d’un paquet sont traités même si le resync suit', () => {
  const api = new RLStatsAPI();
  const seen = collect(api);
  // Un objet complet, puis un objet géant jamais terminé qui sature le buffer.
  api._onData(JSON.stringify({ event: 'MatchCreated', data: {} })
    + '{"event":"UpdateState","data":"' + 'x'.repeat(70000));
  assert.equal(seen.length, 1);                 // le matchcreated n'est PAS perdu
  assert.equal(seen[0].event, 'MatchCreated');
  assert.equal(api.buffer, '');                 // parseur resynchronisé
});

// ───────── Régression : matchended alors que le match a disparu ─────────
// Le socket tombe en plein match (resync du flux, coupure) : `close` remet
// this.match à null. Le jeu envoie ensuite matchended à la reconnexion. Une
// déréférence non gardée levait alors une exception AVANT `_afterEnd = true`,
// et l'écran de fin recréait un match fantôme compté en défaite — exactement
// ce que ce drapeau existe pour empêcher.

test('matchended sans match en cours : pas d’exception, pas de faux abandon', () => {
  const api = new RLStatsAPI();
  const got = listen(api);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  api.match = null;                     // ce que fait le handler 'close'
  api._afterEnd = false;
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(api._afterEnd, true);    // le verrou DOIT être posé
  feed(api, 'UpdateState', STATE);      // écran de fin
  feed(api, 'MatchDestroyed', {});
  assert.equal(got.abandoned, 0);       // aucune fausse défaite
});

test('podiumstart est diffusé (les overlays SOS basculent dessus)', () => {
  const api = new RLStatsAPI();
  let podium = 0;
  api.on('podium', () => podium++);
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'PodiumStart', {});
  assert.equal(podium, 1);
});

// ───────── Régression : vainqueur d’une forme inattendue ─────────
// La règle d'omission du jeu (« champ à 0 = absent ») ne vaut que pour un
// champ ABSENT. Un champ PRÉSENT mais illisible (objet, autre clé) mis à 0
// par défaut faisait enregistrer une défaite 1-4 comme une victoire, car
// _evaluate préfère winnerTeam au score.

test('matchended avec un Winner illisible : on laisse le score trancher', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);                 // score 1-3
  feed(api, 'MatchEnded', { Winner: { Name: 'foo', TeamNum: 1 } });
  assert.equal(snap.winnerTeam, null);             // et non 0
});

test('matchended avec Winner absent : équipe 0 (règle d’omission)', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  feed(api, 'UpdateState', STATE);
  feed(api, 'MatchEnded', { MatchGuid: 'x' });
  assert.equal(snap.winnerTeam, 0);
});

// ───────── Régression : un remplaçant ne change pas le mode ─────────

test('remplacement en cours de match : le mode reste celui joué', () => {
  const api = new RLStatsAPI();
  let snap = null;
  api.on('ended', (s) => { snap = s; });
  feed(api, 'MatchCreated', {});
  const six = {};
  for (let i = 0; i < 6; i++) six['P' + i] = { Name: 'J' + i, TeamNum: i % 2, Score: 10 };
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 0 }, { Score: 0 }] }, Players: six });
  assert.equal(api.match.mode, '3v3');
  // « J1 » part, « Remplacant » arrive : 6 joueurs simultanés, 7 au cumul.
  const after = { ...six, P1: { Name: 'Remplacant', TeamNum: 1, Score: 5 } };
  feed(api, 'UpdateState', { Game: { Teams: [{ Score: 0 }, { Score: 0 }] }, Players: after });
  feed(api, 'MatchEnded', { Winner: 0 });
  assert.equal(snap.mode, '3v3');        // et non « 4v4 »
  assert.equal(snap.players.length, 7);  // le partant reste dans les stats
});
