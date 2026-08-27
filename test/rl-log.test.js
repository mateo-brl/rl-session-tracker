// Tests du lecteur de journal Rocket League (src/main/rl-log.js) : le VRAI
// MMR, écrit en clair par le jeu à chaque mise en file classée.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseLatest, RANKED_PLAYLISTS } = require('../src/main/rl-log.js');

// Grappe telle que le jeu l'écrit : MMR, palier, puis playlist.
function queue(mu, tier, playlist) {
  return [
    '[0245.67] Matchmaking: Pre-divide PartyLeaderMMR: ' + mu,
    '[0245.67] Matchmaking: PartyLeaderTier=(' + tier + ')',
    '[0245.68] Matchmaking: StartMatchmaking at 2026-08-27 18:04:11 for playlists ' + playlist,
  ].join('\n');
}

test('relevé simple : MMR = Mu × 20 + 100, mode déduit de la playlist', () => {
  const r = parseLatest(queue('24.87', 18, 11));
  assert.equal(r.mode, '2v2');
  assert.equal(r.mmr, Math.round(24.87 * 20 + 100));   // 597
  assert.equal(r.tier, 18);
});

test('playlists classées reconnues : 1v1, 2v2, 3v3', () => {
  assert.equal(parseLatest(queue('30', 19, 10)).mode, '1v1');
  assert.equal(parseLatest(queue('30', 19, 11)).mode, '2v2');
  assert.equal(parseLatest(queue('30', 19, 13)).mode, '3v3');
  assert.equal(RANKED_PLAYLISTS[13], '3v3');
});

test('c’est le DERNIER relevé qui compte', () => {
  const log = [
    'du bruit de démarrage',
    queue('20', 15, 11),
    '[0300.00] rien à voir',
    queue('26.5', 19, 13),
  ].join('\n');
  const r = parseLatest(log);
  assert.equal(r.mode, '3v3');
  assert.equal(r.mmr, Math.round(26.5 * 20 + 100));    // 630
});

test('file casual : ignorée, on remonte au dernier relevé classé', () => {
  const log = [queue('24', 18, 11), queue('24', 18, 2)].join('\n');
  const r = parseLatest(log);
  assert.equal(r.mode, '2v2');                          // le 2v2 classé, pas le casual
});

test('journal sans mise en file classée = aucun relevé', () => {
  assert.equal(parseLatest('[0001.00] Log: démarrage du jeu\n[0002.00] Log: menu'), null);
  assert.equal(parseLatest(''), null);
  assert.equal(parseLatest(null), null);
});

test('MMR sans playlist identifiable : inexploitable', () => {
  assert.equal(parseLatest('[0245.67] Matchmaking: Pre-divide PartyLeaderMMR: 24.87'), null);
});

test('palier absent : le relevé reste valable', () => {
  const log = [
    '[0245.67] Matchmaking: Pre-divide PartyLeaderMMR: 31.2',
    '[0245.68] Matchmaking: StartMatchmaking at 2026-08-27 18:04:11 for playlists 10',
  ].join('\n');
  const r = parseLatest(log);
  assert.equal(r.mode, '1v1');
  assert.equal(r.mmr, Math.round(31.2 * 20 + 100));
  assert.equal(r.tier, null);
});

test('valeurs aberrantes rejetées', () => {
  assert.equal(parseLatest(queue('-5', 1, 11)), null);      // MMR négatif
  assert.equal(parseLatest(queue('999', 22, 11)), null);    // hors échelle
});

test('fins de ligne Windows supportées', () => {
  const r = parseLatest(queue('24.87', 18, 11).replace(/\n/g, '\r\n'));
  assert.equal(r.mmr, 597);
});

// ───────── Classé / casual déduit de la playlist ─────────
// Avant, « classé » n'était qu'une préférence (vraie par défaut) : chaque
// partie casual déplaçait le MMR estimé tant qu'on n'avait pas basculé le
// commutateur à la main, à chaque match.

const { parseLastQueue, playlistInfo } = require('../src/main/rl-log.js');

test('playlistInfo : classé, casual, inconnu', () => {
  assert.deepEqual(playlistInfo(11), { playlist: 11, ranked: true, mode: '2v2', known: true });
  assert.deepEqual(playlistInfo(2), { playlist: 2, ranked: false, mode: '2v2', known: true });
  const x = playlistInfo(999);
  assert.equal(x.ranked, false);
  assert.equal(x.known, false);          // inconnu : on ne prétend rien
});

test('parseLastQueue : retient la DERNIÈRE file, casual comprise', () => {
  const log = [queue('24', 18, 11), queue('24', 18, 2)].join('\n');
  const q = parseLastQueue(log);
  assert.equal(q.playlist, 2);
  assert.equal(q.ranked, false);         // la dernière file est casual
});

test('parseLastQueue : file classée', () => {
  const q = parseLastQueue(queue('26.5', 19, 13));
  assert.equal(q.ranked, true);
  assert.equal(q.mode, '3v3');
});

test('parseLastQueue : aucune file dans le journal', () => {
  assert.equal(parseLastQueue('[0001.00] Log: menu'), null);
  assert.equal(parseLastQueue(''), null);
});

// ───────── Fraîcheur d’une mise en file ─────────
// Le journal grossit en permanence pendant une partie. Identifier une file par
// la TAILLE du fichier faisait passer la même vieille ligne pour une nouvelle
// à chaque scrutation : l’horodatage était sans cesse rafraîchi, le garde de
// fraîcheur n’expirait jamais, et un évènement était réémis toutes les 20 s.

const fs = require('fs');
const os = require('os');
const path = require('path');
const RLLogReader = require('../src/main/rl-log.js');

test('relire le même journal ne réhorodate pas la file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rllog-'));
  const file = path.join(dir, 'Launch.log');
  fs.writeFileSync(file, queue('24', 18, 11) + '\n');
  const r = new RLLogReader({ file: file });

  const first = r.refreshQueue();
  assert.equal(first.playlist, 11);
  const at = first.at;
  const key = r._queueKey;

  // Le jeu continue d'écrire : le fichier grossit, mais AUCUNE nouvelle file.
  fs.appendFileSync(file, '[0300.00] Log: bruit de partie\n'.repeat(50));
  const again = r.refreshQueue();
  assert.equal(again.at, at, 'l’horodatage ne doit pas bouger');
  assert.equal(r._queueKey, key, 'la file doit rester la même');

  // Une VRAIE nouvelle file, même playlist : elle doit être reconnue.
  // On compare l'IDENTITÉ de la file, pas l'horodatage : les deux lectures
  // peuvent tomber dans la même milliseconde.
  fs.appendFileSync(file, queue('25', 18, 11) + '\n');
  const fresh = r.refreshQueue();
  assert.notEqual(r._queueKey, key, 'une nouvelle file doit être reconnue');
  assert.equal(fresh.playlist, 11);
});

test('parseLastQueue expose la position de la ligne trouvée', () => {
  const q = parseLastQueue('bruit\n' + queue('24', 18, 13));
  assert.equal(q.mode, '3v3');
  assert.ok(Number.isInteger(q.offset) && q.offset > 0);
});

test('playlist 4 (chaos) vaut 4v4, pas 3v3', () => {
  assert.equal(playlistInfo(4).mode, '4v4');
});
