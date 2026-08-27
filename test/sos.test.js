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
  assert.deepEqual(msg.data, { scorer: 'Mateo', team: 0 });
  sock.destroy();
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
