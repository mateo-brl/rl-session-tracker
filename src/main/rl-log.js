// rl-log.js — Lecture du VRAI MMR dans le journal de Rocket League.
//
// La Stats API du jeu ne diffuse pas le MMR : jusqu'ici l'application partait
// d'une base saisie à la main et l'estimait à ±9 par match, une erreur qui
// s'accumule et ne se recale jamais.
//
// Or le jeu écrit son propre journal, en clair, dans
//   Documents\My Games\Rocket League\TAGame\Logs\Launch.log
// et y consigne le MMR à CHAQUE mise en file classée :
//   [..] Matchmaking: Pre-divide PartyLeaderMMR: 24.87
//   [..] Matchmaking: PartyLeaderTier=(18)
//   [..] Matchmaking: StartMatchmaking at .. for playlists 11
// Le MMR affiché par le jeu vaut Mu * 20 + 100.
//
// C'est une simple lecture de fichier, hors du processus du jeu : aucune
// injection, aucune lecture mémoire — rien qui puisse déplaire à l'anti-triche
// (même principe que le reste de l'application).
//
// LIMITES ASSUMÉES, et la raison pour laquelle l'estimation reste en place :
//  • le relevé a lieu au moment de la QUEUE, jamais après le match — le
//    dernier match d'une session n'apparaît qu'à la remise en file ;
//  • rien n'est écrit quand on n'est pas chef de groupe ;
//  • le format n'est pas documenté par Psyonix : il peut changer à tout patch.
// En cas d'échec de lecture, on ne casse rien : l'estimation continue seule.

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

// Identifiants de playlists classées → mode de l'application.
const RANKED_PLAYLISTS = {
  10: '1v1',   // Duel classé
  11: '2v2',   // Doubles classé
  12: '3v3',   // Standard solo (historique)
  13: '3v3',   // Standard classé
};

// Playlists NON classées connues (casual). Sert uniquement à distinguer « file
// casual identifiée » de « playlist inconnue » : une playlist absente des deux
// tables (nouveau mode, tournoi, partie privée) est traitée comme non classée,
// mais sans certitude — voir `known` dans le résultat.
const CASUAL_PLAYLISTS = {
  1: '1v1', 2: '2v2', 3: '3v3', 4: '3v3',   // duel / doubles / standard / chaos
};

// Toute mise en file, classée ou non. `ranked` décide si le match comptera
// pour le MMR ; `known` dit si la playlist nous est réellement connue.
function playlistInfo(id) {
  const n = Number(id);
  if (RANKED_PLAYLISTS[n]) {
    return { playlist: n, ranked: true, mode: RANKED_PLAYLISTS[n], known: true };
  }
  if (CASUAL_PLAYLISTS[n]) {
    return { playlist: n, ranked: false, mode: CASUAL_PLAYLISTS[n], known: true };
  }
  return { playlist: n, ranked: false, mode: null, known: false };
}

// Conversion Mu → MMR tel qu'affiché en jeu.
const MMR_SCALE = 20;
const MMR_OFFSET = 100;

// Le journal est réécrit à chaque lancement du jeu ; on n'en lit que la fin.
const TAIL_BYTES = 512 * 1024;
const POLL_MS = 20 * 1000;

function defaultLogPath() {
  const docs = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Documents')
    : path.join(os.homedir(), 'Documents');
  return path.join(docs, 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log');
}

// Lit les derniers octets d'un fichier sans le charger en entier.
function readTail(file, bytes) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

// Extrait le DERNIER relevé de MMR du texte fourni.
// Les trois lignes (MMR, palier, playlist) sont consécutives dans le journal :
// on balaie de la fin vers le début et on retient la première grappe complète.
// Le palier et la playlist sont facultatifs — un MMR sans mode identifiable
// n'est pas exploitable, mais un MMR sans palier l'est.
function parseLatest(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  let mmr = null;
  let tier = null;
  let mode = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (mode === null) {
      const p = /StartMatchmaking\b[^\n]*?\bfor playlists?\s+(\d+)/i.exec(line);
      if (p) {
        mode = RANKED_PLAYLISTS[Number(p[1])] || null;
        // Playlist non classée (casual, extra modes) : ce relevé ne nous
        // intéresse pas, on continue de remonter.
        if (mode === null) { mmr = null; tier = null; }
        continue;
      }
    }
    if (tier === null) {
      const t = /PartyLeaderTier\s*=?\s*\(?\s*(\d+)/i.exec(line);
      if (t) { tier = Number(t[1]); continue; }
    }
    if (mmr === null) {
      const m = /PartyLeaderMMR[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(line);
      if (m) {
        mmr = Math.round(Number(m[1]) * MMR_SCALE + MMR_OFFSET);
        continue;
      }
    }
    if (mmr !== null && mode !== null) break;
  }

  if (mmr === null || mode === null) return null;
  if (!Number.isFinite(mmr) || mmr <= 0 || mmr > 5000) return null;
  return { mode, mmr, tier };
}

// Dernière mise en file, classée OU casual. C'est ce qui permet enfin de
// savoir si un match compte pour le MMR : jusqu'ici « classé » n'était qu'une
// préférence utilisateur (vraie par défaut), donc chaque partie casual
// déplaçait le MMR estimé de ±9 tant qu'on n'avait pas basculé le
// commutateur à la main — à chaque match.
function parseLastQueue(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = /StartMatchmaking\b[^\n]*?\bfor playlists?\s+(\d+)/i.exec(lines[i]);
    if (p) return playlistInfo(p[1]);
  }
  return null;
}

class RLLogReader extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.file = o.file || defaultLogPath();
    this._timer = null;
    this._lastSize = -1;
    this._lastKey = '';       // dernier relevé émis (évite les doublons)
    this._queueKey = '';
    this.lastQueue = null;    // { playlist, ranked, mode, known, at }
  }

  // Retourne le relevé courant, ou null si le journal est absent/illisible.
  read() {
    return parseLatest(readTail(this.file, TAIL_BYTES));
  }

  // Relit le journal MAINTENANT pour connaître la dernière mise en file.
  // Appelé au début de chaque match : la scrutation périodique suffirait la
  // plupart du temps, mais une lecture à la demande garantit qu'on ne rate
  // pas la file qui vient tout juste de mener à ce match.
  refreshQueue() {
    const q = parseLastQueue(readTail(this.file, TAIL_BYTES));
    if (!q) return this.lastQueue;
    const key = q.playlist + ':' + this._lastSize;
    if (key !== this._queueKey) {
      this._queueKey = key;
      this.lastQueue = { ...q, at: Date.now() };
    }
    return this.lastQueue;
  }

  start() {
    if (process.platform !== 'win32') return;   // journal propre à la version PC
    const tick = () => this._tick();
    tick();
    this._timer = setInterval(tick, POLL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _tick() {
    let size;
    try { size = fs.statSync(this.file).size; } catch (e) { return; }
    // Rien de nouveau : on évite de relire 512 Ko toutes les 20 s. Une taille
    // qui DIMINUE signale un nouveau lancement du jeu (journal réécrit).
    if (size === this._lastSize) return;
    this._lastSize = size;

    const text = readTail(this.file, TAIL_BYTES);
    const q = parseLastQueue(text);
    if (q) {
      const key = q.playlist + ':' + size;
      if (key !== this._queueKey) {
        this._queueKey = key;
        this.lastQueue = { ...q, at: Date.now() };
        this.emit('queue', this.lastQueue);
      }
    }

    const found = parseLatest(text);
    if (!found) return;
    const key = found.mode + ':' + found.mmr;
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.emit('mmr', found);
  }
}

module.exports = RLLogReader;
module.exports.parseLatest = parseLatest;
module.exports.parseLastQueue = parseLastQueue;
module.exports.playlistInfo = playlistInfo;
module.exports.defaultLogPath = defaultLogPath;
module.exports.RANKED_PLAYLISTS = RANKED_PLAYLISTS;
module.exports.CASUAL_PLAYLISTS = CASUAL_PLAYLISTS;
