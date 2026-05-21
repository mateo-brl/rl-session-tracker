// statsapi.js — Connecteur temps réel pour la Stats API native de Rocket League.
//
// Depuis la mise à jour Easy Anti-Cheat d'avril 2026, BakkesMod (et donc le
// plugin SOS) ne fonctionne plus en match en ligne. La Stats API intégrée au
// jeu est désormais la seule source temps réel compatible EAC : un socket TCP
// brut sur 127.0.0.1:49123 qui diffuse du JSON concaténé pendant un match.
//
// Ici on s'en sert comme déclencheur et vue live : elle signale à la seconde
// le début / la fin d'un match (fini le délai de 5 min de tracker.gg pour
// l'évènement lui-même) et expose le score en direct. Le MMR et le résultat
// W/L font toujours autorité via tracker.gg — mais on va le rafraîchir
// PILE au moment où ce connecteur dit « match terminé », au lieu de poller
// à l'aveugle toutes les 15 s.

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

// Plafond du buffer de réception. Un évènement de la Stats API est petit
// (quelques Ko au plus) : au-delà de cette taille, c'est qu'on s'est
// désynchronisé sur du bruit — on coupe et on laisse la reconnexion
// resynchroniser proprement.
const MAX_BUFFER = 65536;
// Bornes anti-abus sur les données joueurs.
const MAX_PLAYERS = 8;
const MAX_NAME_LEN = 64;

class RLStatsAPI extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    // Position de scan déjà atteinte dans `buffer` : `_nextObject` ne
    // ré-examine pas les octets déjà parcourus à l'appel précédent.
    this._scanPos = 0;
    this.reconnectDelay = 2000;
    this.match = null;        // snapshot du match en cours, ou null
    this._lastStateEmit = 0;
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

  // ───────── Connexion TCP + reconnexion automatique ─────────
  _connect() {
    const sock = net.createConnection({ host: HOST, port: PORT });
    this.socket = sock;
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      this.connected = true;
      this.reconnectDelay = 2000;
      this.buffer = '';
      this._scanPos = 0;
      if (DEBUG) console.log('[statsapi] connecté à ' + HOST + ':' + PORT);
      this.emit('connection', { connected: true });
    });

    sock.on('data', (chunk) => this._onData(chunk));

    // L'erreur est suivie d'un évènement 'close' qui gère la reconnexion ;
    // on se contente de la tracer en mode debug au lieu de l'avaler.
    sock.on('error', (err) => {
      if (DEBUG) console.log('[statsapi] erreur socket:', err && err.message);
    });

    sock.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this.emit('connection', { connected: false });
      }
      this.socket = null;
      // Jitter ±20 % : évite que plusieurs agents/relances se reconnectent
      // tous à la même milliseconde après une coupure commune.
      const jitter = 1 + (Math.random() * 0.4 - 0.2);
      setTimeout(() => this._connect(), Math.round(this.reconnectDelay * jitter));
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
    });
  }

  // ───────── Découpage du flux JSON concaténé ─────────
  // La Stats API n'utilise pas de délimiteur fiable : on extrait chaque objet
  // {...} en comptant les accolades, en respectant les chaînes et échappements.
  _onData(chunk) {
    this.buffer += chunk;
    let raw;
    while ((raw = this._nextObject()) !== null) {
      try {
        this._handle(JSON.parse(raw));
      } catch (e) {
        if (DEBUG) console.log('[statsapi] JSON invalide ignoré:', e.message);
      }
    }
    // Garde-fou : un évènement RL est petit. Si le buffer dépasse le plafond
    // sans qu'on ait pu en extraire un objet complet, c'est qu'on est
    // désynchronisé. On ferme le socket : la reconnexion repartira sur un
    // buffer vide et resynchronisera (plutôt que de vider en place, ce qui
    // pourrait couper un objet valide en deux).
    if (this.buffer.length > MAX_BUFFER) {
      if (DEBUG) console.log('[statsapi] buffer saturé (' + this.buffer.length +
        ' o) — fermeture pour resynchronisation');
      if (this.socket) this.socket.destroy();
    }
  }

  _nextObject() {
    const buf = this.buffer;
    // `_scanPos` mémorise l'avancée du scan entre deux appels : on ne
    // ré-examine pas les octets déjà parcourus (sinon coût O(n²) global).
    let i = this._scanPos;
    let start = -1, depth = 0, inStr = false, esc = false;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (start === -1) {
        if (c === '{') { start = i; depth = 1; }
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          this.buffer = buf.slice(i + 1);
          this._scanPos = 0;   // le buffer est tronqué : on repart de 0
          return buf.slice(start, i + 1);
        }
      }
    }
    // Pas d'objet complet sur ce passage. On jette le bruit éventuel avant
    // la 1re accolade et on garde la position de scan pour le prochain appel.
    if (start > 0) {
      this.buffer = buf.slice(start);
      this._scanPos = buf.length - start;
    } else {
      // start === -1 : aucune accolade vue, tout est du bruit à oublier.
      // start === 0  : objet en cours depuis le début, rien à tronquer.
      this._scanPos = start === -1 ? 0 : buf.length;
      if (start === -1) this.buffer = '';
    }
    return null;
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

    // On limite la diffusion à ~1/s : la Stats API peut envoyer jusqu'à 120/s.
    const now = Date.now();
    if (now - this._lastStateEmit > 1000) {
      this._lastStateEmit = now;
      this.emit('state', this.snapshot());
    }
  }

  _players(data, game) {
    const raw = data.Players || data.players || game.Players || game.players;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    // Borne anti-abus : un match RL compte 8 joueurs au maximum ; les noms
    // sont tronqués pour éviter qu'une source hostile gonfle les snapshots.
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
