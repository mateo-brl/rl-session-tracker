'use strict';
// Tests de la télécommande Spotify. Aucun appel réseau : `fetch` est injecté.
// Ce qui compte ici, c'est le contrat de sécurité (PKCE, état, jetons hors
// config) et le traitement honnête des réponses de Spotify.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Spotify = require('../src/main/spotify.js');

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-spo-')); }
function reply(status, body) {
  return {
    status, ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body || {}),
  };
}

test('PKCE : vérificateur secret, condensé S256 dans l’URL, portées minimales', () => {
  const { verifier, challenge } = Spotify.pkce();
  assert.ok(verifier.length >= 43);           // longueur minimale exigée par la RFC
  assert.notEqual(verifier, challenge);       // le secret ne part JAMAIS tel quel
  assert.ok(!/[+/=]/.test(challenge));        // base64url, sans caractère à échapper
  const url = Spotify.authUrl('abc123', challenge, 'st4te');
  assert.ok(url.includes('code_challenge_method=S256'));
  assert.ok(url.includes('code_challenge=' + challenge));
  assert.ok(url.includes('state=st4te'));
  assert.ok(!url.includes(verifier));
  // Rien sur la bibliothèque, les playlists ou le profil.
  assert.equal(Spotify.SCOPES,
    'user-read-playback-state user-modify-playback-state user-read-currently-playing');
  assert.ok(Spotify.REDIRECT_URI.startsWith('http://127.0.0.1:'));
});

test('identifiant client : validé, et rangé hors de config.json', () => {
  const d = dir();
  const s = new Spotify(d, {});
  assert.equal(s.setClientId('pas valide !').ok, false);
  assert.equal(s.setClientId('abc123DEF').ok, true);
  const file = path.join(d, 'spotify.json');
  assert.ok(fs.existsSync(file));             // fichier dédié, pas la configuration
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).clientId, 'abc123DEF');
  // Relecture : l'identifiant survit au redémarrage, sans jeton.
  const s2 = new Spotify(d, {});
  assert.equal(s2.status().configured, true);
  assert.equal(s2.status().connected, false);
});

test('« ce qui joue » : 204 signifie silence, pas erreur', async () => {
  const d = dir();
  const s = new Spotify(d, { fetch: () => Promise.resolve(reply(204)) });
  s.tokens = { access: 'a', refresh: 'r', expiresAt: Date.now() + 60000 };
  assert.equal(await s.poll(), null);
  assert.equal(s.status().error, null);
});

test('« ce qui joue » : titre, artistes, pochette et volume relevés', async () => {
  const d = dir();
  const body = {
    is_playing: true, progress_ms: 42000,
    device: { name: 'PC de Mateo', volume_percent: 63 },
    item: {
      name: 'Endgame', duration_ms: 210000,
      artists: [{ name: 'Bossfight' }, { name: 'Hayve' }],
      album: { name: 'RL', images: [{ url: 'big.jpg' }, { url: 'small.jpg' }] },
    },
  };
  const s = new Spotify(d, { fetch: () => Promise.resolve(reply(200, body)) });
  s.tokens = { access: 'a', refresh: 'r', expiresAt: Date.now() + 60000 };
  const n = await s.poll();
  assert.equal(n.title, 'Endgame');
  assert.equal(n.artist, 'Bossfight, Hayve');
  assert.equal(n.playing, true);
  assert.equal(n.volume, 63);
  assert.equal(n.durationMs, 210000);
  assert.equal(n.art, 'small.jpg');           // vignette pour le bloc
  assert.equal(n.artBig, 'big.jpg');
});

test('commandes : les refus de Spotify sont traduits, pas avalés', async () => {
  const d = dir();
  let status = 403;
  const s = new Spotify(d, { fetch: () => Promise.resolve(reply(status)) });
  s.tokens = { access: 'a', refresh: 'r', expiresAt: Date.now() + 60000 };
  let r = await s.command('next');
  assert.equal(r.ok, false);
  assert.match(r.error, /Premium/);
  status = 404;
  r = await s.command('next');
  assert.match(r.error, /appareil actif/);
  status = 204;
  assert.equal((await s.command('next')).ok, true);
  assert.equal((await s.command('inventée')).ok, false);
});

test('volume : borné à 0-100 et envoyé sur la bonne route', async () => {
  const d = dir();
  const seen = [];
  const s = new Spotify(d, {
    fetch: (url) => { seen.push(url); return Promise.resolve(reply(204)); },
  });
  s.tokens = { access: 'a', refresh: 'r', expiresAt: Date.now() + 60000 };
  await s.command('volume', 250);
  assert.ok(seen[0].endsWith('/me/player/volume?volume_percent=100'));
  await s.command('volume', -8);
  assert.ok(seen[1].endsWith('/me/player/volume?volume_percent=0'));
});

test('jeton expiré : rafraîchi une fois, et le refresh est conservé', async () => {
  const d = dir();
  const calls = [];
  const s = new Spotify(d, {
    fetch: (url, opts) => {
      calls.push(url);
      if (url.includes('/api/token')) {
        // Spotify ne renvoie pas toujours un nouveau jeton de rafraîchissement.
        return Promise.resolve(reply(200, { access_token: 'neuf', expires_in: 3600 }));
      }
      return Promise.resolve(reply(204));
    },
  });
  s.clientId = 'abc';
  s.tokens = { access: 'vieux', refresh: 'garde-moi', expiresAt: Date.now() - 1000 };
  assert.equal((await s.command('next')).ok, true);
  assert.ok(calls[0].includes('/api/token'));
  assert.equal(s.tokens.access, 'neuf');
  assert.equal(s.tokens.refresh, 'garde-moi');
});

test('refresh refusé : session effacée, pas de boucle de tentatives', async () => {
  const d = dir();
  let n = 0;
  const s = new Spotify(d, {
    fetch: () => { n++; return Promise.resolve(reply(400, { error: 'invalid_grant' })); },
  });
  s.clientId = 'abc';
  s.tokens = { access: 'a', refresh: 'mort', expiresAt: Date.now() - 1000 };
  const r = await s.command('next');
  assert.equal(r.ok, false);
  assert.equal(s.connected(), false);
  assert.match(s.status().error, /expirée/);
  assert.equal(n, 1);
  // Les jetons ont disparu du disque : rien de sensible ne traîne.
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'spotify.json'), 'utf8'));
  assert.equal(saved.refresh, '');
});

test('déconnexion : jetons effacés, sondage arrêté', () => {
  const d = dir();
  const s = new Spotify(d, {});
  s.clientId = 'abc';
  s.tokens = { access: 'a', refresh: 'r', expiresAt: Date.now() + 60000 };
  s._save();
  s.disconnect();
  assert.equal(s.connected(), false);
  assert.equal(s.timer, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'spotify.json'), 'utf8')).refresh, '');
});
