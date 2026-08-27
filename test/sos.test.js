// Tests du pont compatible SOS (src/main/sos-bridge.js) : réémission du flux
// du jeu au format du défunt plugin SOS, sur son port historique.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const sos = require('../src/main/sos-bridge.js');

const PORT = 49422;   // port de test, pour ne pas heurter un vrai overlay

test.after(() => sos.stop());

// Décode une trame texte NON masquée (sens serveur → client).
function decodeText(buf) {
  assert.equal(buf[0], 0x81, 'FIN + opcode texte attendus');
  let len = buf[1] & 0x7f;
  let off = 2;
  assert.equal(buf[1] & 0x80, 0, 'le serveur ne doit JAMAIS masquer');
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = buf.readUInt32BE(6); off = 10; }
  return buf.slice(off, off + len).toString('utf8');
}

function connect(host) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      port: PORT, host: '127.0.0.1', path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Host: host || ('127.0.0.1:' + PORT),
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, sock) => resolve({ res, sock, key }));
    req.on('error', reject);
    req.on('response', (res) => reject(new Error('pas d’upgrade : ' + res.statusCode)));
    req.end();
  });
}

const started = new Promise((resolve) => {
  sos.start(PORT, () => {});
  const wait = () => (sos.status().running ? resolve() : setTimeout(wait, 20));
  wait();
});

test('poignée de main : Sec-WebSocket-Accept conforme à la RFC 6455', async () => {
  await started;
  const { res, sock, key } = await connect();
  const expected = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.equal(res.headers['sec-websocket-accept'], expected);
  assert.equal(String(res.headers.upgrade).toLowerCase(), 'websocket');
  sock.destroy();
});

test('les évènements du jeu arrivent au format SOS', async () => {
  await started;
  const { sock } = await connect();
  const got = new Promise((resolve) => sock.once('data', (b) => resolve(decodeText(b))));
  // Laisse le serveur enregistrer le client avant de diffuser.
  await new Promise((r) => setTimeout(r, 50));
  sos.send('goal', { scorer: 'Mateo', team: 0 });
  const msg = JSON.parse(await got);
  assert.equal(msg.event, 'game:goal_scored');
  // Forme SOS : les overlays lisent data.scorer.name, pas une chaîne.
  assert.deepEqual(msg.data, { scorer: { name: 'Mateo', teamnum: 0 } });
  sock.destroy();
});

// Traduire le NOM de l'évènement ne suffit pas : les overlays SOS ont été
// écrits contre le SCHÉMA de SOS. Leur passer l'instantané brut de la Stats
// API ne produirait que des `undefined`.
test('les charges utiles ont bien la forme attendue par SOS', () => {
  const st = sos.toSos('state', {
    active: true, guid: 'g1', score: [2, 3], timeSeconds: 60, isOT: false,
    players: [{ id: 'x1', name: 'Mateo', team: 0, score: 400,
      goals: 2, assists: 0, saves: 1, shots: 4 }],
  });
  assert.equal(st.game.teams[0].score, 2);      // et non score: [2, 3]
  assert.equal(st.game.teams[1].score, 3);
  assert.equal(st.game.time_seconds, 60);
  assert.equal(st.players.x1.name, 'Mateo');    // indexé par identifiant
  assert.equal(st.match_guid, 'g1');

  assert.equal(sos.toSos('ended', { winnerTeam: 1 }).winner_team_num, 1);
  // Vainqueur inconnu : -1, jamais `undefined` (un overlay teste === 0 / === 1).
  assert.equal(sos.toSos('ended', { winnerTeam: null }).winner_team_num, -1);
});

test('un joueur sans identifiant reste indexable', () => {
  const st = sos.toSos('state', { active: true, players: [{ name: 'Sans', team: 1 }] });
  const keys = Object.keys(st.players);
  assert.equal(keys.length, 1);
  assert.equal(st.players[keys[0]].name, 'Sans');
});

test('noms d’évènements attendus par les overlays SOS', () => {
  assert.equal(sos.EVENT_NAMES.state, 'game:update_state');
  assert.equal(sos.EVENT_NAMES.ended, 'game:match_ended');
  assert.equal(sos.EVENT_NAMES.start, 'game:match_created');
});

test('Host étranger refusé (rebinding DNS)', async () => {
  await started;
  await assert.rejects(() => connect('evil.example.com'));
});

test('une requête HTTP simple reçoit 426, pas une page', async () => {
  await started;
  const code = await new Promise((resolve, reject) => {
    http.get({ port: PORT, host: '127.0.0.1', path: '/' },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(code, 426);
});

test('trame client aberrante : la connexion est coupée, pas le serveur', async () => {
  await started;
  const { sock } = await connect();
  await new Promise((r) => setTimeout(r, 50));
  const closed = new Promise((resolve) => sock.on('close', resolve));
  // Trame masquée annonçant une charge utile de 4 Go.
  const evil = Buffer.alloc(10);
  evil[0] = 0x81; evil[1] = 0xff;
  evil.writeUInt32BE(0xffffffff, 2);
  sock.write(evil);
  await closed;
  assert.equal(sos.status().running, true);   // le serveur tient toujours
});

test('stop() ferme le serveur et libère le port', async () => {
  await started;
  sos.stop();
  assert.equal(sos.status().running, false);
  // Le port doit être réutilisable immédiatement.
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => srv.close(resolve));
  });
});
