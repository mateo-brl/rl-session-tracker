// Test d'intégration du client Discord RPC (src/main/discord-rpc.js) :
// un faux Discord écoute sur un socket local (discord-ipc-0), répond READY
// au handshake, et on vérifie la trame SET_ACTIVITY envoyée.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// Le module choisit son chemin de pipe au require : on impose le nôtre AVANT.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-ipc-'));
process.env.XDG_RUNTIME_DIR = dir;

const discord = require('../src/main/discord-rpc.js');

function frame(op, obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(raw.length, 4);
  return Buffer.concat([head, raw]);
}

// Découpe les trames reçues et les transmet à `onFrame(op, payload)`.
function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readInt32LE(4);
      if (buf.length < 8 + size) break;
      onFrame(buf.readInt32LE(0), JSON.parse(buf.slice(8, 8 + size).toString('utf8')));
      buf = buf.slice(8 + size);
    }
  };
}

test('handshake puis SET_ACTIVITY avec le match en cours', { timeout: 10000 },
  async () => {
    if (process.platform === 'win32') return;   // socket unix : test CI/dev

    const got = { handshake: null, activities: [] };
    const server = net.createServer((sock) => {
      sock.on('data', frameReader((op, payload) => {
        if (op === 0) {
          got.handshake = payload;
          sock.write(frame(1, { evt: 'READY', data: { user: { username: 'test' } } }));
        } else if (op === 1 && payload.cmd === 'SET_ACTIVITY') {
          got.activities.push(payload.args.activity);
        }
      }));
    });
    await new Promise((r) => server.listen(path.join(dir, 'discord-ipc-0'), r));

    discord.setEnabled(true);
    // Connexion + handshake : on attend que le faux Discord ait répondu READY.
    for (let i = 0; i < 100 && !got.handshake; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(got.handshake, 'handshake jamais reçu');
    assert.equal(got.handshake.v, 1);
    assert.ok(got.handshake.client_id);

    discord.refresh({
      lang: 'fr',
      game: { running: true },
      currentRanked: true,
      live: { active: true, training: false, mode: '2v2', score: [3, 2], isOT: false },
      session: { played: 4, wins: 3, losses: 1, streak: { type: 'W', count: 3 } },
    });
    for (let i = 0; i < 100 && !got.activities.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(got.activities.length, 'aucune activité reçue');
    const act = got.activities[0];
    assert.equal(act.details, 'Classé 2v2 · 3 – 2');
    assert.equal(act.state, 'Série de 3 victoires');
    assert.ok(act.timestamps && act.timestamps.start > 0);

    // Désactivation : le statut est effacé (activité nulle).
    discord.setEnabled(false);
    for (let i = 0; i < 100 && got.activities.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(got.activities[got.activities.length - 1], null);

    discord.stop();
    await new Promise((r) => server.close(r));
  });
