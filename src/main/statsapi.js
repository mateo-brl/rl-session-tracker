// statsapi.js — Connecteur temps réel pour la Stats API native de Rocket League.
//
// Depuis la mise à jour Easy Anti-Cheat d'avril 2026, BakkesMod (et donc le
// plugin SOS) ne fonctionne plus en match en ligne. La Stats API intégrée au
// jeu est désormais la seule source temps réel compatible EAC : un socket TCP
// brut sur 127.0.0.1:49123 qui diffuse du JSON concaténé pendant un match.
//
// Elle signale à la seconde le début / la fin d'un match, expose le score en
// direct et fournit les stats finales par joueur — c'est la seule source de
// données de l'application, tout est local.

const net = require('net');
const EventEmitter = require('events');

const HOST = process.env.STATSAPI_HOST || '127.0.0.1';
const PORT = parseInt(process.env.STATSAPI_PORT || '49123', 10);
const DEBUG = process.env.STATSAPI_DEBUG === '1';

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Devine le mode à partir du nombre de joueurs (2 → 1v1, 4 → 2v2, 6 → 3v3).
function modeFromCount(n) {
  const t = Math.max(1, Math.min(3, Math.round(n / 2)));
  return t + 'v' + t;
}

// Plafond du buffer de réception. Un évènement de la Stats API est petit :
// au-delà, c'est qu'on s'est désynchronisé — on coupe et on resynchronise.
const MAX_BUFFER = 65536;
// Bornes anti-abus sur les données joueurs.
const MAX_PLAYERS = 8;
const MAX_NAME_LEN = 64;
// Diffusion de l'état limitée à 1/s (la Stats API peut envoyer jusqu'à 120/s).
const STATE_INTERVAL = 1000;

class RLStatsAPI extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.match = null;        // snapshot du match en cours, ou null
    this.reconnectDelay = 2000;
    this._lastStateEmit = 0;
    this._stateTimer = null;  // timer du « trailing edge » de la diffusion
    // ── État du parseur de flux (persistant entre deux paquets TCP) ──
    this.buffer = '';
    this._scanPos = 0;        // prochain octet à examiner dans `buffer`
    this._objStart = -1;      // index du début de l'objet en cours, ou -1
    this._depth = 0;          // profondeur d'accolades
    this._inStr = false;      // dans une chaîne JSON ?
    this._esc = false;        // caractère d'échappement en cours ?
  }

  start() {
    this._connect();
  }

  getStatus() {
    return { connected: this.connected, match: this.snapshot() };
  }

  snapshot() {
    if (!this.match) return { active: false };
    return {
      active: true,
      mode: this.match.mode,
      score: this.match.score,
      timeSeconds: this.match.timeSeconds,
      isOT: this.match.isOT || false,
      players: this.match.players,
    };
  }

  // Réinitialise complètement le parseur (à la connexion, ou après une
  // désynchronisation).
  _resetParser() {
    this.buffer = '';
    this._scanPos = 0;
    this._objStart = -1;
    this._depth = 0;
    this._inStr = false;
    this._esc = false;
  }

  _clearStateTimer() {
    if (this._stateTimer) { clearTimeout(this._stateTimer); this._stateTimer = null; }
  }

  // ───────── Connexion TCP + reconnexion automatique ─────────
  _connect() {
    const sock = net.createConnection({ host: HOST, port: PORT });
    this.socket = sock;
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      this.connected = true;
      this.reconnectDelay = 2000;
      this._resetParser();
      if (DEBUG) console.log('[statsapi] connecté à ' + HOST + ':' + PORT);
      this.emit('connection', { connected: true });
    });

    sock.on('data', (chunk) => this._onData(chunk));

    // L'erreur est suivie d'un évènement 'close' qui gère la reconnexion ;
    // on se contente de la tracer en mode debug.
    sock.on('error', (err) => {
      if (DEBUG) console.log('[statsapi] erreur socket:', err && err.message);
    });

    sock.on('close', () => {
      this._clearStateTimer();
      if (this.connected) {
        this.connected = false;
        this.emit('connection', { connected: false });
      }
      this.socket = null;
      // Jitter ±20 % : évite des reconnexions toutes synchronisées.
      const jitter = 1 + (Math.random() * 0.4 - 0.2);
      setTimeout(() => this._connect(), Math.round(this.reconnectDelay * jitter));
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
    });
  }

  // ───────── Découpage du flux JSON concaténé ─────────
  // La Stats API n'utilise pas de délimiteur fiable. On compte les accolades
  // (en respectant chaînes et échappements). CRUCIAL : l'état du parseur
  // (`_objStart`, `_depth`, `_inStr`, `_esc`, `_scanPos`) est conservé entre
  // les paquets TCP — un objet à cheval sur deux `data` est donc correctement
  // assemblé, et on ne ré-examine jamais deux fois le même octet.
  _onData(chunk) {
    this.buffer += chunk;
    const buf = this.buffer;
    const objects = [];

    for (let i = this._scanPos; i < buf.length; i++) {
      const c = buf[i];
      if (this._objStart === -1) {
        // Hors objet : on cherche une accolade ouvrante, le reste est du bruit.
        if (c === '{') {
          this._objStart = i;
          this._depth = 1;
          this._inStr = false;
          this._esc = false;
        }
        continue;
      }
      if (this._inStr) {
        if (this._esc) this._esc = false;
        else if (c === '\\') this._esc = true;
        else if (c === '"') this._inStr = false;
      } else if (c === '"') {
        this._inStr = true;
      } else if (c === '{') {
        this._depth++;
      } else if (c === '}') {
        this._depth--;
        if (this._depth === 0) {
          objects.push(buf.slice(this._objStart, i + 1));
          this._objStart = -1;
        }
      }
    }

    // Compactage du buffer : on retire tout ce qui précède l'objet en cours
    // (ou tout, si aucun objet n'est en cours). L'état du parseur survit.
    if (this._objStart === -1) {
      this.buffer = '';
      this._scanPos = 0;
    } else {
      this.buffer = buf.slice(this._objStart);
      this._objStart = 0;
      this._scanPos = this.buffer.length;
    }

    // Garde-fou : un objet en cours qui dépasse le plafond = flux corrompu.
    if (this.buffer.length > MAX_BUFFER) {
      if (DEBUG) console.log('[statsapi] buffer saturé — fermeture pour resync');
      this._resetParser();
      if (this.socket) this.socket.destroy();
      return;
    }

    for (const raw of objects) {
      try {
        this._handle(JSON.parse(raw));
      } catch (e) {
        if (DEBUG) console.log('[statsapi] JSON invalide ignoré:', e.message);
      }
    }
  }

  // ───────── Routage des évènements ─────────
  _handle(env) {
    // Enveloppe : { event, data }. `data` est souvent une chaîne JSON à
    // re-parser. Les noms d'évènements peuvent être préfixés (game:, Events.).
    const name = String(env.event || env.Event || '')
      .replace(/^.*[:.]/, '')
      .toLowerCase();
    let data = env.data !== undefined ? env.data : env.Data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { /* laissée brute */ }
    }
    data = data || {};
    if (DEBUG) console.log('[statsapi] évènement:', name);

    switch (name) {
      case 'matchcreated':
      case 'matchinitialized':
        this._onMatchStart();
        break;
      case 'updatestate':
        this._onUpdateState(data);
        break;
      case 'goalscored':
        this.emit('goal', this._goal(data));
        break;
      case 'matchended':
        this._onMatchEnd(data);
        break;
      case 'matchdestroyed':
        this._clearStateTimer();
        this.match = null;
        this.emit('match', { phase: 'destroyed' });
        break;
      default:
        break;
    }
  }

  _ensureMatch() {
    if (!this.match) {
      this.match = {
        startedAt: Date.now(), score: [0, 0],
        timeSeconds: null, isOT: false, players: [], mode: null,
      };
      this.emit('match', { phase: 'start' });
    }
    return this.match;
  }

  _onMatchStart() {
    this._ensureMatch();
  }

  _onUpdateState(data) {
    const m = this._ensureMatch();
    const game = data.Game || data.game || data;

    const teams = game.Teams || game.teams || data.Teams || data.teams;
    if (Array.isArray(teams) && teams.length >= 2) {
      m.score = [
        numOr(teams[0] && (teams[0].Score ?? teams[0].score), m.score[0]),
        numOr(teams[1] && (teams[1].Score ?? teams[1].score), m.score[1]),
      ];
    }

    const t = game.TimeSeconds ?? game.time_seconds ?? game.Time ?? game.time;
    if (typeof t === 'number') m.timeSeconds = t;
    m.isOT = !!(game.IsOT ?? game.isOT ?? game.IsOvertime);

    const players = this._players(data, game);
    if (players.length) {
      m.players = players;
      if (!m.mode) m.mode = modeFromCount(players.length);
    }

    this._scheduleStateEmit();
  }

  // Diffuse `state` à ~1/s, AVEC trailing edge : le dernier état d'une rafale
  // est garanti d'être émis (sinon le score final reste figé jusqu'à `ended`).
  _scheduleStateEmit() {
    const now = Date.now();
    const since = now - this._lastStateEmit;
    if (since >= STATE_INTERVAL) {
      this._lastStateEmit = now;
      this.emit('state', this.snapshot());
    } else if (!this._stateTimer) {
      this._stateTimer = setTimeout(() => {
        this._stateTimer = null;
        this._lastStateEmit = Date.now();
        if (this.match) this.emit('state', this.snapshot());
      }, STATE_INTERVAL - since);
    }
  }

  _players(data, game) {
    const raw = data.Players || data.players || game.Players || game.players;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    // Borne anti-abus : 8 joueurs max, noms tronqués.
    return list.map((p) => ({
      name: String(p.Name || p.name || '').slice(0, MAX_NAME_LEN),
      team: numOr(p.TeamNum ?? p.Team ?? p.team, 0),
      goals: numOr(p.Goals ?? p.goals, 0),
      saves: numOr(p.Saves ?? p.saves, 0),
      assists: numOr(p.Assists ?? p.assists, 0),
      shots: numOr(p.Shots ?? p.shots, 0),
      score: numOr(p.Score ?? p.score, 0),
      id: p.PrimaryId || p.primaryID || p.Id || p.id || '',
    })).filter((p) => p.name).slice(0, MAX_PLAYERS);
  }

  _goal(data) {
    const scorer = data.Scorer || data.scorer || {};
    return {
      scorer: scorer.Name || scorer.name || data.PlayerName || '',
      team: numOr(data.Team ?? scorer.TeamNum ?? scorer.Team, -1),
    };
  }

  _onMatchEnd(data) {
    // Si une diffusion d'état était en attente (trailing edge), on la flushe
    // maintenant : le score final doit partir avant l'évènement 'ended'.
    const hadPending = !!this._stateTimer;
    this._clearStateTimer();
    if (hadPending && this.match) this.emit('state', this.snapshot());

    const winner = data.Winner ?? data.WinnerTeamNum ?? data.winner_team_num
      ?? data.winner ?? data.WinningTeam;
    let winnerTeam = null;
    if (typeof winner === 'number') winnerTeam = winner;
    else if (winner === '0' || winner === '1') winnerTeam = Number(winner);

    const snap = this.snapshot();
    snap.winnerTeam = winnerTeam;
    snap.endedAt = Date.now();
    this.emit('ended', snap);
    this.match = null;
  }
}

module.exports = RLStatsAPI;
