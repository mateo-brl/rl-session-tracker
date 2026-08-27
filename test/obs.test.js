// Test d'intégration du serveur overlay OBS (src/main/obs-server.js) :
// vrai serveur HTTP sur un port éphémère, page, état JSON et flux SSE.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const obs = require('../src/main/obs-server.js');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('page, état JSON, flux SSE et évènements', { timeout: 10000 }, async () => {
  const status = await new Promise((resolve) => {
    obs.start(0, () => {}, resolve);          // port 0 = éphémère
  });
  assert.equal(status.running, true);
  const port = status.port;
  assert.ok(port > 0);

  // La page overlay est servie sur / et /overlay.
  const page = await get(port, '/overlay');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('RL Session Tracker'));
  assert.ok(page.body.includes('EventSource'));

  // L'état courant est exposé en JSON et suit broadcast().
  obs.broadcast({ session: { wins: 3, losses: 1 }, lang: 'fr' });
  const st = await get(port, '/state');
  assert.equal(JSON.parse(st.body).session.wins, 3);

  // Flux SSE : l'état arrive à la connexion, puis les évènements.
  const events = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/events' });
  await new Promise((resolve) => {
    req.on('response', (res) => {
      res.on('data', (chunk) => {
        events.push(String(chunk));
        resolve();
      });
    });
  });
  assert.ok(events.join('').includes('event: state'));

  const more = new Promise((resolve) => {
    req.on('response', () => {});
    const want = ['goal', 'result'];
    const seen = [];
    const check = (s) => {
      for (const w of want) if (s.includes('event: ' + w)) seen.push(w);
      if (seen.length >= 2) resolve(events.join(''));
    };
    req.once('error', () => {});
    // le flux est déjà ouvert : on écoute la suite
    req.socket.on('data', (c) => { events.push(String(c)); check(events.join('')); });
    check(events.join(''));
  });
  obs.emit('goal', { scorer: 'Mateo' });
  obs.emit('result', { result: 'W', score: [3, 2] });
  const all = await more;
  assert.ok(all.includes('event: goal'));
  assert.ok(all.includes('event: result'));
  assert.ok(all.includes('"scorer":"Mateo"'));

  // Inconnu = 404, et les chemins de police sont filtrés.
  assert.equal((await get(port, '/autre')).status, 404);
  assert.equal((await get(port, '/fonts/../../package.json')).status, 404);

  req.destroy();
  obs.stop();
  assert.equal(obs.running(), false);
});

test('en-tête Host étranger refusé (barrière anti DNS-rebinding)', { timeout: 10000 }, async () => {
  const status = await new Promise((resolve) => {
    obs.start(0, () => {}, resolve);          // port 0 = éphémère
  });
  const port = status.port;

  // Un Host qui n'est ni 127.0.0.1:<port> ni localhost:<port> — celui qu'un
  // domaine attaquant enverrait après un rebind DNS vers 127.0.0.1 — doit
  // être rejeté avant même de servir la route.
  const forbidden = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/state',
      headers: { Host: 'evil.example.com' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(forbidden.status, 403);

  // 127.0.0.1:<port> et localhost:<port> — les deux façons dont OBS ou un
  // navigateur pointent vers l'overlay — continuent de fonctionner.
  const viaIp = await get(port, '/state');
  assert.equal(viaIp.status, 200);
  const viaLocalhost = await new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port, path: '/overlay',
      headers: { Host: 'localhost:' + port },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal(viaLocalhost.status, 200);

  obs.stop();
  assert.equal(obs.running(), false);
});
