// spotify.js — Télécommande Spotify : ce qui joue, et de quoi le piloter.
//
// CE QUE ÇA FAIT, ET CE QUE ÇA NE FAIT PAS. L'API Web de Spotify ne diffuse
// aucun son vers une application tierce : seul le SDK de lecture web le fait,
// dans un navigateur, avec un module de DRM qu'Electron n'embarque pas. Le son
// continue donc de sortir de TON Spotify (application de bureau ou téléphone),
// et cette application en est la télécommande : elle lit ce qui joue et envoie
// suivant / précédent / pause / volume.
//
// AUTORISATION. OAuth 2.0 avec PKCE : aucun secret client n'est embarqué dans
// l'application (il serait lisible par n'importe qui). L'utilisateur crée sa
// propre application sur le tableau de bord Spotify, colle son identifiant
// client, et l'autorisation se fait dans son navigateur. La redirection revient
// sur un petit serveur local qui ne vit que le temps de la connexion.
//
// LES JETONS SONT DES SECRETS : ils ne vont pas dans config.json (que
// l'utilisateur ouvre et partage à l'occasion) mais dans spotify.json, écrit
// avec des droits restreints, et ne sont JAMAIS journalisés.
//
// Le contrôle de lecture (suivant, pause, volume) exige un compte Premium côté
// Spotify ; la lecture de « ce qui joue » fonctionne aussi en gratuit. L'API
// répond 403 pour un compte gratuit qui tente un contrôle : on le dit
// clairement plutôt que d'échouer en silence.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
// Portées minimales : lire l'état de lecture, et le piloter. Rien sur la
// bibliothèque, les playlists ou le profil.
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const POLL_MS = 4000;            // ce qui joue : 4 s suffit pour une barre fluide
const POLL_IDLE_MS = 15000;      // rien ne joue : on lève le pied
const REDIRECT_PORT = 49355;
const REDIRECT_URI = 'http://127.0.0.1:' + REDIRECT_PORT + '/callback';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE : un secret tiré au sort par connexion, dont seul le condensé part dans
// l'URL d'autorisation. Sans lui, le code d'autorisation intercepté suffirait.
function pkce() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authUrl(clientId, challenge, state) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: state,
    scope: SCOPES,
  });
  return AUTH_URL + '?' + q.toString();
}

class Spotify {
  // `opts.fetch` et `opts.openExternal` sont injectables : les tests n'ouvrent
  // pas de navigateur et ne parlent à personne.
  constructor(userDataDir, opts) {
    const o = opts || {};
    this.file = path.join(userDataDir || '.', 'spotify.json');
    this.fetch = o.fetch || ((...a) => globalThis.fetch(...a));
    this.openExternal = o.openExternal || (() => {});
    this.log = o.log || (() => {});
    this.onUpdate = o.onUpdate || (() => {});
    this.tokens = null;          // { access, refresh, expiresAt }
    this.clientId = '';
    this.now = null;             // dernier « ce qui joue » connu
    this.error = null;
    this.timer = null;
    this.server = null;
    this._pending = null;
    this._load();
  }

  // ───────── Jetons : lecture, écriture, effacement ─────────
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.clientId = String(raw.clientId || '');
        if (raw.refresh) {
          this.tokens = {
            access: String(raw.access || ''),
            refresh: String(raw.refresh),
            expiresAt: Number(raw.expiresAt) || 0,
          };
        }
      }
    } catch (e) { /* pas encore connecté */ }
  }

  _save() {
    const data = {
      clientId: this.clientId,
      access: this.tokens ? this.tokens.access : '',
      refresh: this.tokens ? this.tokens.refresh : '',
      expiresAt: this.tokens ? this.tokens.expiresAt : 0,
    };
    try {
      // 0600 : lisible par le seul utilisateur. Sous Windows le mode est
      // ignoré, mais le fichier reste dans son profil.
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      this.log('spotify : impossible d’écrire les jetons (' + e.code + ')');
    }
  }

  connected() { return !!(this.tokens && this.tokens.refresh); }

  status() {
    return {
      configured: !!this.clientId,
      connected: this.connected(),
      redirectUri: REDIRECT_URI,
      error: this.error,
      now: this.now,
    };
  }

  setClientId(id) {
    const clean = String(id || '').trim().slice(0, 64);
    if (!/^[a-z0-9]*$/i.test(clean)) return { ok: false, error: 'Identifiant client invalide.' };
    this.clientId = clean;
    this._save();
    return { ok: true };
  }

  disconnect() {
    this.stop();
    this.tokens = null;
    this.now = null;
    this.error = null;
    this._save();
    this.onUpdate(this.status());
    return { ok: true };
  }

  // ───────── Connexion ─────────
  // Un serveur local reçoit la redirection, échange le code contre des jetons,
  // puis se referme. Il n'écoute que sur 127.0.0.1 et seulement pendant la
  // connexion — pas de port ouvert en permanence.
  connect() {
    if (!this.clientId) return Promise.resolve({ ok: false, error: 'Renseigne d’abord ton identifiant client.' });
    if (this.server) return Promise.resolve({ ok: false, error: 'Connexion déjà en cours.' });
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(16));
    this._pending = { verifier, state };

    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        this._closeServer();
        this._pending = null;
        this.onUpdate(this.status());
        resolve(res);
      };
      const timeout = setTimeout(() => finish({ ok: false, error: 'Connexion expirée.' }), 3 * 60 * 1000);
      if (timeout.unref) timeout.unref();

      this.server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, REDIRECT_URI); } catch (e) { res.writeHead(400); res.end(); return; }
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const code = u.searchParams.get('code');
        const got = u.searchParams.get('state');
        const err = u.searchParams.get('error');
        const reply = (msg) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><body style="background:#0c0e11;color:#e3e8ef;'
            + 'font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">'
            + '<p>' + msg + '</p>');
        };
        if (err) { reply('Autorisation refusée. Tu peux fermer cet onglet.'); clearTimeout(timeout); finish({ ok: false, error: 'Autorisation refusée.' }); return; }
        // L'état lie la redirection à CETTE demande : sans cette vérification,
        // une page tierce pourrait faire aboutir un code qu'elle contrôle.
        if (!code || got !== state) { reply('Réponse inattendue.'); clearTimeout(timeout); finish({ ok: false, error: 'Réponse d’autorisation inattendue.' }); return; }
        reply('C’est bon. Tu peux fermer cet onglet et revenir dans RL Session Tracker.');
        clearTimeout(timeout);
        this._exchange(code, verifier).then(finish);
      });
      this.server.on('error', (e) => {
        clearTimeout(timeout);
        finish({ ok: false, error: 'Port ' + REDIRECT_PORT + ' indisponible (' + e.code + ').' });
      });
      this.server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        this.openExternal(authUrl(this.clientId, challenge, state));
      });
    });
  }

  _closeServer() {
    if (this.server) {
      try { this.server.close(); } catch (e) { /* déjà fermé */ }
      this.server = null;
    }
  }

  async _exchange(code, verifier) {
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: this.clientId,
        code_verifier: verifier,
      });
      const r = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const d = await r.json();
      if (!r.ok || !d.access_token) {
        return { ok: false, error: 'Spotify a refusé la connexion (' + (d.error || r.status) + ').' };
      }
      this._setTokens(d);
      this.error = null;
      this.log('spotify : connecté');
      this.start();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Connexion impossible : ' + e.message };
    }
  }

  _setTokens(d) {
    this.tokens = {
      access: String(d.access_token),
      // Spotify ne renvoie pas toujours un nouveau jeton de rafraîchissement :
      // on garde l'ancien, sinon la session se perdrait au premier renouvellement.
      refresh: String(d.refresh_token || (this.tokens && this.tokens.refresh) || ''),
      expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000 - 60000,
    };
    this._save();
  }

  async _refresh() {
    if (!this.tokens || !this.tokens.refresh) return false;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh,
      client_id: this.clientId,
    });
    const r = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) {
      // Jeton révoqué côté Spotify : inutile de réessayer en boucle.
      if (r.status === 400 || r.status === 401) {
        this.tokens = null;
        this._save();
        this.error = 'Session Spotify expirée : reconnecte-toi.';
      }
      return false;
    }
    this._setTokens(d);
    return true;
  }

  async _call(method, endpoint, opts) {
    const o = opts || {};
    if (!this.connected()) return { status: 401 };
    if (Date.now() >= this.tokens.expiresAt && !(await this._refresh())) return { status: 401 };
    const send = () => this.fetch(API + endpoint, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + this.tokens.access },
        o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body,
    });
    let r = await send();
    if (r.status === 401 && await this._refresh()) r = await send();
    return r;
  }

  // ───────── Ce qui joue ─────────
  async poll() {
    if (!this.connected()) return null;
    try {
      const r = await this._call('GET', '/me/player');
      // 204 : Spotify est ouvert mais rien ne joue. Ce n'est pas une erreur.
      if (r.status === 204) { this._setNow(null); return null; }
      if (r.status === 401) { this._setNow(null); return null; }
      if (!r.ok) { return this.now; }
      const d = await r.json();
      if (!d || !d.item) { this._setNow(null); return null; }
      this._setNow({
        title: String(d.item.name || ''),
        artist: (d.item.artists || []).map((a) => a.name).join(', '),
        album: d.item.album ? String(d.item.album.name || '') : '',
        art: d.item.album && d.item.album.images && d.item.album.images.length
          ? String(d.item.album.images[d.item.album.images.length - 1].url) : null,
        artBig: d.item.album && d.item.album.images && d.item.album.images.length
          ? String(d.item.album.images[0].url) : null,
        durationMs: Number(d.item.duration_ms) || 0,
        progressMs: Number(d.progress_ms) || 0,
        playing: !!d.is_playing,
        volume: d.device && typeof d.device.volume_percent === 'number' ? d.device.volume_percent : null,
        device: d.device ? String(d.device.name || '') : '',
        at: Date.now(),
      });
      this.error = null;
      return this.now;
    } catch (e) {
      return this.now;
    }
  }

  _setNow(v) {
    const before = this.now && this.now.title + this.now.progressMs + this.now.playing;
    this.now = v;
    const after = v && v.title + v.progressMs + v.playing;
    if (before !== after) this.onUpdate(this.status());
  }

  start() {
    this.stop();
    if (!this.connected()) return;
    const tick = () => {
      this.poll().then(() => {
        const wait = this.now && this.now.playing ? POLL_MS : POLL_IDLE_MS;
        this.timer = setTimeout(tick, wait);
        if (this.timer.unref) this.timer.unref();
      });
    };
    tick();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  // ───────── Télécommande ─────────
  // `next`, `previous`, `play`, `pause`, `toggle`, `volume` (0-100).
  async command(cmd, value) {
    if (!this.connected()) return { ok: false, error: 'Pas connecté à Spotify.' };
    const map = {
      next: ['POST', '/me/player/next'],
      previous: ['POST', '/me/player/previous'],
      play: ['PUT', '/me/player/play'],
      pause: ['PUT', '/me/player/pause'],
    };
    let route = map[cmd];
    if (cmd === 'toggle') route = map[this.now && this.now.playing ? 'pause' : 'play'];
    if (cmd === 'volume') {
      const v = Math.max(0, Math.min(100, Math.round(Number(value))));
      if (!Number.isFinite(v)) return { ok: false, error: 'Volume invalide.' };
      route = ['PUT', '/me/player/volume?volume_percent=' + v];
    }
    if (!route) return { ok: false, error: 'Commande inconnue.' };
    try {
      const r = await this._call(route[0], route[1]);
      if (r.status === 403) {
        return { ok: false, error: 'Spotify refuse le contrôle : un compte Premium est requis.' };
      }
      if (r.status === 404) {
        return { ok: false, error: 'Aucun appareil actif : lance une lecture dans Spotify d’abord.' };
      }
      if (r.status === 401) return { ok: false, error: 'Session expirée : reconnecte-toi.' };
      if (!r.ok && r.status !== 204) return { ok: false, error: 'Spotify a répondu ' + r.status + '.' };
      // Retour immédiat sans attendre le prochain sondage : la commande vient
      // d'aboutir, l'état local peut refléter l'intention.
      if (this.now && (cmd === 'play' || cmd === 'pause' || cmd === 'toggle')) {
        this.now = Object.assign({}, this.now, { playing: cmd === 'play' || (cmd === 'toggle' && !this.now.playing) });
        this.onUpdate(this.status());
      }
      if (this.now && cmd === 'volume') {
        this.now = Object.assign({}, this.now, { volume: Math.round(Number(value)) });
        this.onUpdate(this.status());
      }
      setTimeout(() => this.poll(), 400);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Commande impossible : ' + e.message };
    }
  }
}

module.exports = Spotify;
module.exports.pkce = pkce;
module.exports.authUrl = authUrl;
module.exports.REDIRECT_URI = REDIRECT_URI;
module.exports.SCOPES = SCOPES;
