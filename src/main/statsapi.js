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

const DEFAULT_HOST = process.env.STATSAPI_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.STATSAPI_PORT || '49123', 10);
const DEBUG = process.env.STATSAPI_DEBUG === '1';

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Devine le mode à partir du nombre de joueurs (2 → 1v1, 4 → 2v2, 6 → 3v3,
// 8 → 4v4). Le plafond est bien 4 : le chaos (4v4) existe, et le rabattre sur
// « 3v3 » polluait les stats par mode ET la courbe MMR du vrai 3v3.
function modeFromCount(n) {
  const t = Math.max(1, Math.min(4, Math.round(n / 2)));
  return t + 'v' + t;
}

// Plafond du buffer de réception. Un évènement de la Stats API est petit :
// au-delà, c'est qu'on s'est désynchronisé — on coupe et on resynchronise.
const MAX_BUFFER = 65536;
// Bornes anti-abus sur les données joueurs.
const MAX_PLAYERS = 8;
const MAX_NAME_LEN = 64;
// Borne du journal d'évènements marquants conservé avec chaque match.
const MAX_EVENTS = 40;
// Diffusion de l'état limitée à 1/s (la Stats API peut envoyer jusqu'à 120/s).
const STATE_INTERVAL = 1000;

class RLStatsAPI extends EventEmitter {
  // `opts.port` / `opts.host` : lus À LA CONSTRUCTION, pas au chargement du
  // module. Avant, le port était figé dans une constante évaluée au `require`,
  // donc AVANT que l'application n'ait pu poser process.env — le réglage
  // statsApiPort ne servait à rien et le connecteur composait toujours 49123.
  constructor(opts) {
    super();
    const o = opts || {};
    this.host = o.host || DEFAULT_HOST;
    this.port = numOr(o.port, DEFAULT_PORT);
    this.socket = null;
    this.connected = false;
    this.match = null;        // snapshot du match en cours, ou null
    this._afterEnd = false;   // entre matchended et le prochain matchcreated
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

  // Effectif cumulé du match : un joueur qui QUITTE disparaît des updatestate
  // suivants. En remplaçant bêtement la liste, un 1v1 dont l'adversaire se
  // déconnecte finissait à 1 joueur — donc classé « entraînement » et jeté,
  // alors que le jeu, lui, nous comptait la victoire. On fusionne donc par
  // identité en gardant les dernières stats connues de chacun.
  _mergeRoster(m, players) {
    if (!players.length) return;
    const key = (p) => (p.id ? 'id:' + p.id : 'name:' + norm(p.name));
    const seen = m._roster || (m._roster = new Map());
    for (const p of players) seen.set(key(p), p);
    m.players = Array.from(seen.values()).slice(0, MAX_PLAYERS);
    // Le mode se déduit du plus grand effectif vu SIMULTANÉMENT, pas du cumul
    // des joueurs croisés : en 3v3, un joueur qui part et se fait remplacer
    // porte le cumul à 7 et étiquetait le match « 4v4 » — soit exactement la
    // pollution des stats par mode que le déplafonnement cherchait à éviter.
    // L'effectif instantané, lui, reste borné par la taille réelle du mode,
    // tout en montant quand les joueurs finissent de charger.
    if (players.length > (m._maxPlayers || 0)) {
      m._maxPlayers = players.length;
      m.mode = modeFromCount(m._maxPlayers);
    }
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
      guid: this.match.guid || null,
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
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setEncoding('utf8');

    sock.on('connect', () => {
      this.connected = true;
      this.reconnectDelay = 2000;
      this._resetParser();
      this._afterEnd = false;
      if (DEBUG) console.log('[statsapi] connecté à ' + this.host + ':' + this.port);
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
      // Le jeu s'est fermé brutalement (Alt+F4, plantage) : le socket tombe
      // SANS matchdestroyed. On jette le match en cours au lieu de le laisser
      // traîner — sinon _ensureMatch le recyclait au prochain lancement du
      // jeu et le match suivant héritait de son mode (un 1v1 enregistré
      // « 3v3 »). On n'émet PAS 'abandoned' : une simple coupure du socket en
      // pleine partie compterait alors une fausse défaite.
      if (this.match) {
        if (DEBUG) console.log('[statsapi] socket fermé en plein match — match jeté');
        this.match = null;
      }
      this._afterEnd = false;
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

    // Les objets COMPLETS de ce paquet sont traités d'abord, même si le
    // resync ci-dessous doit couper la connexion : ils sont valides, et en
    // jeter un (matchcreated, un bHasWinner…) faisait disparaître le match
    // suivant du journal.
    for (const raw of objects) {
      try {
        this._handle(JSON.parse(raw));
      } catch (e) {
        if (DEBUG) console.log('[statsapi] JSON invalide ignoré:', e.message);
      }
    }

    // Garde-fou : un objet en cours qui dépasse le plafond = flux corrompu.
    if (this.buffer.length > MAX_BUFFER) {
      if (DEBUG) console.log('[statsapi] buffer saturé — fermeture pour resync');
      this._resetParser();
      if (this.socket) this.socket.destroy();
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
        this._afterEnd = false;
        this._onMatchStart();
        // MatchGuid n'est renseigné qu'en ligne, et il arrive vide sur
        // matchcreated : c'est matchinitialized qui porte le vrai identifiant.
        if (this.match && data.MatchGuid) this.match.guid = String(data.MatchGuid);
        this._trace(name, data);
        break;
      // Podium = le jeu a bel et bien conclu le match (le cycle documenté est
      // matchended → podiumstart → matchdestroyed). C'est notre seul signal
      // fiable pour distinguer « le match s'est terminé » de « NOUS avons
      // quitté en cours de partie » — voir le commentaire de matchdestroyed.
      case 'podiumstart':
        if (this.match) this.match.podium = true;
        this._trace(name, data);
        this.emit('podium', this.snapshot());
        break;
      case 'updatestate':
        // Après matchended, le jeu continue d'envoyer des updatestate pendant
        // l'écran de fin : les ignorer, sinon on recrée un « match fantôme »
        // que matchdestroyed compterait comme un abandon (double défaite).
        // Échappatoire : si matchcreated s'est perdu (resync du flux, JSON
        // illisible), ce verrou avalerait le match SUIVANT en entier. Un état
        // 0-0 avec une horloge pleine ne peut pas être un écran de fin — on
        // considère alors qu'un nouveau match a commencé.
        if (this._afterEnd) {
          if (!this._looksLikeFreshMatch(data)) break;
          if (DEBUG) console.log('[statsapi] nouveau match détecté sans matchcreated');
          this._afterEnd = false;
          this._onMatchStart();
        }
        this._onUpdateState(data);
        break;
      case 'goalscored':
        this._trace(name, this._goal(data));
        this.emit('goal', this._goal(data));
        break;
      case 'matchended':
        this._trace(name, data);
        // Fin déjà commise via bHasWinner (updatestate) : l'écran de fin peut
        // quand même envoyer un matchended — ne pas compter deux fois.
        if (this._afterEnd) break;
        this._onMatchEnd(data);
        break;
      case 'matchdestroyed':
        this._clearStateTimer();
        // Destruction SANS matchended préalable = abandon (forfait, départ en
        // cours de match, déconnexion). On émet le dernier état connu pour
        // que l'application puisse en tenir compte.
        if (this.match) {
          const snap = this.snapshot();
          snap.endedAt = Date.now();
          snap.forfeit = true;
          // Le vainqueur, s'il est quand même annoncé ici : c'est la dernière
          // occasion de récupérer un FF adverse que le flux d'état n'a pas eu
          // le temps de nous livrer.
          const w = data.Winner ?? data.WinnerTeamNum ?? data.winner_team_num
            ?? data.winner ?? data.WinningTeam;
          if (typeof w === 'number') snap.winnerTeam = w;
          else if (w === '0' || w === '1') snap.winnerTeam = Number(w);
          // Le podium a-t-il été atteint ? Si oui, le match s'est terminé
          // normalement (forfait adverse compris) et notre départ n'était
          // qu'une sortie d'écran de fin : ce n'est PAS un abandon de notre
          // part. Sans ce drapeau, quitter juste après un FF adverse se
          // retrouvait compté comme une défaite.
          snap.podium = !!this.match.podium;
          snap.events = this.match.events || [];
          this.match = null;
          this.emit('abandoned', snap);
        }
        this.emit('match', { phase: 'destroyed' });
        break;
      default:
        break;
    }
  }

  // Journal des évènements MARQUANTS du match (pas le flux d'état, qui arrive
  // jusqu'à 120 fois par seconde et ne se stocke pas). Une dizaine d'entrées
  // par match, conservées avec lui : quand la logique d'interprétation
  // s'améliore — comme pour le forfait —, on peut relire ce qui s'est
  // réellement passé au lieu de deviner à partir du résultat déjà calculé.
  _trace(name, data) {
    if (!this.match) return;
    const t = this.match.events || (this.match.events = []);
    if (t.length >= MAX_EVENTS) return;
    t.push({ at: Date.now(), event: name, data: data || {} });
  }

  _ensureMatch() {
    if (!this.match) {
      this.match = {
        startedAt: Date.now(), score: [0, 0],
        timeSeconds: null, isOT: false, players: [], mode: null,
        podium: false, events: [], _roster: new Map(), _maxPlayers: 0,
      };
      this.emit('match', { phase: 'start' });
    }
    return this.match;
  }

  // matchcreated / matchinitialized arrivent TOUJOURS avant le premier
  // updatestate : on repart d'un match neuf sans risque. Indispensable, sinon
  // un match resté en mémoire (jeu fermé brutalement) était recyclé et léguait
  // son mode et son horodatage au match suivant.
  _onMatchStart() {
    this.match = null;
    this._ensureMatch();
  }

  // Un état de match tout neuf : score vierge et horloge encore haute. Sert
  // uniquement à rattraper un matchcreated perdu (voir case 'updatestate').
  // Volontairement strict : mieux vaut manquer un rattrapage que redémarrer
  // un match sur l'écran de fin du précédent.
  _looksLikeFreshMatch(data) {
    const game = data.Game || data.game || data;
    const teams = game.Teams || game.teams || data.Teams || data.teams;
    if (!Array.isArray(teams) || teams.length < 2) return false;
    const s0 = numOr(teams[0] && (teams[0].Score ?? teams[0].score), 0);
    const s1 = numOr(teams[1] && (teams[1].Score ?? teams[1].score), 0);
    if (s0 !== 0 || s1 !== 0) return false;
    const t = game.TimeSeconds ?? game.time_seconds ?? game.Time ?? game.time;
    return typeof t === 'number' && t >= 60;
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

    this._mergeRoster(m, this._players(data, game));

    // Forfait : le jeu n'envoie PAS toujours matchended — quand une équipe
    // abandonne, le vainqueur est annoncé par bHasWinner/Winner dans le flux
    // d'état, puis le lobby est détruit. Sans ce commit, un FF adverse
    // passerait pour un abandon de NOTRE part (et serait compté défaite).
    // Règle d'omission du jeu : champ absent = 0/false — donc Winner absent
    // avec bHasWinner vrai signifie « équipe 0 gagne ».
    if (game.bHasWinner ?? game.BHasWinner ?? game.HasWinner) {
      this._onMatchEnd({
        Winner: numOr(game.Winner ?? game.WinnerTeamNum ?? game.WinningTeam, 0),
      });
      return;
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
    // Règle d'omission du jeu : un champ valant 0 est ABSENT du JSON. Or le
    // jeu n'envoie matchended que « quand un vainqueur est désigné » — un
    // vainqueur ABSENT signifie donc « équipe 0 ».
    // En revanche, un champ PRÉSENT mais d'une forme qu'on ne sait pas lire
    // (objet, autre clé) ne veut pas dire « équipe 0 » : mettre 0 par défaut
    // faisait enregistrer une défaite 1-4 comme une victoire, car _evaluate
    // préfère winnerTeam au score. Dans ce cas on laisse null et le score, qui
    // est fiable et présent dans le même instantané, tranche.
    // Pas de recoupement avec le score ici : un FORFAIT désigne légitimement
    // un vainqueur MENÉ au score (l'équipe qui abandonne mène souvent), et
    // c'est précisément le cas que ce connecteur doit savoir traiter.
    else if (winner === undefined) winnerTeam = 0;

    const snap = this.snapshot();
    snap.winnerTeam = winnerTeam;
    snap.endedAt = Date.now();
    // this.match peut être null : le socket est tombé en plein match (resync
    // du flux, coupure) et le jeu envoie matchended à la reconnexion. Sans
    // cette garde, la déréférence levait une TypeError avalée par le parseur
    // — et comme elle survenait AVANT `_afterEnd = true`, l'écran de fin
    // recréait un match fantôme que matchdestroyed comptait en défaite :
    // exactement le bug que ce drapeau existe pour empêcher.
    snap.podium = !!(this.match && this.match.podium);
    snap.events = (this.match && this.match.events) || [];
    this._afterEnd = true;
    this.emit('ended', snap);
    this.match = null;
  }
}

module.exports = RLStatsAPI;
