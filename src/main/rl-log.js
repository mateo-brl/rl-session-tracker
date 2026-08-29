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
  1: '1v1', 2: '2v2', 3: '3v3', 4: '4v4',   // duel / doubles / standard / chaos
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
    // `from` = position absolue du début de la fenêtre lue. Elle permet de
    // situer une ligne dans le FICHIER, pas seulement dans la fenêtre.
    return { text: buf.toString('utf8'), size: size, from: size - len };
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

function tailText(file, bytes) {
  const t = readTail(file, bytes);
  return t ? t.text : null;
}

// Extrait le dernier relevé de MMR d'une file CLASSÉE.
//
// Le jeu écrit toujours dans cet ordre, par mise en file :
//   PartyLeaderMMR  →  PartyLeaderTier  →  StartMatchmaking … playlists N
// On balaie donc vers l'AVANT en accumulant le MMR et le palier en attente,
// et on ne les valide qu'en arrivant sur leur ligne StartMatchmaking.
//
// Un balayage arrière ne marche PAS ici : en remontant, on rencontre d'abord
// le StartMatchmaking d'une file casual, puis le MMR de cette même file
// casual, et enfin le StartMatchmaking classé précédent — le MMR casual se
// retrouvait alors attribué au mode classé, et écrasait la base de calibrage
// avec une valeur qui n'a rien à voir.
function parseLatest(text) {
  if (!text) return null;
  let pendingMmr = null;
  let pendingTier = null;
  let found = null;

  for (const line of String(text).split(/\r?\n/)) {
    const m = /PartyLeaderMMR[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(line);
    if (m) { pendingMmr = Number(m[1]); continue; }
    const t = /PartyLeaderTier\s*=?\s*\(?\s*(\d+)/i.exec(line);
    if (t) { pendingTier = Number(t[1]); continue; }
    const p = /StartMatchmaking\b[^\n]*?\bfor playlists?\s+(\d+)/i.exec(line);
    if (!p) continue;
    const mode = RANKED_PLAYLISTS[Number(p[1])];
    // Le relevé n'appartient qu'à SA file : classée ou non, on repart à zéro.
    if (mode && pendingMmr !== null) {
      const mmr = Math.round(pendingMmr * MMR_SCALE + MMR_OFFSET);
      if (Number.isFinite(mmr) && mmr > 0 && mmr <= 5000) {
        found = { mode: mode, mmr: mmr, tier: pendingTier };
      }
    }
    pendingMmr = null;
    pendingTier = null;
  }
  return found;
}

// Dernière mise en file, classée OU casual. C'est ce qui permet enfin de
// savoir si un match compte pour le MMR : jusqu'ici « classé » n'était qu'une
// préférence utilisateur (vraie par défaut), donc chaque partie casual
// déplaçait le MMR estimé de ±9 tant qu'on n'avait pas basculé le
// commutateur à la main — à chaque match.
function parseLastQueue(text) {
  if (!text) return null;
  const str = String(text);
  const re = /StartMatchmaking\b[^\n]*?\bfor playlists?\s+(\d+)/gi;
  let last = null;
  let m;
  while ((m = re.exec(str)) !== null) last = m;
  if (!last) return null;
  // `offset` : position de la ligne dans le texte fourni. Sert à identifier
  // CETTE mise en file précise — la taille du fichier ne convient pas, elle
  // change à chaque écriture du jeu et faisait passer une vieille file pour
  // une nouvelle à chaque scrutation.
  return { ...playlistInfo(last[1]), offset: last.index };
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
    return parseLatest(tailText(this.file, TAIL_BYTES));
  }

  // Relit le journal MAINTENANT pour connaître la dernière mise en file.
  // Appelé au début de chaque match : la scrutation périodique suffirait la
  // plupart du temps, mais une lecture à la demande garantit qu'on ne rate
  // pas la file qui vient tout juste de mener à ce match.
  refreshQueue() {
    const t = readTail(this.file, TAIL_BYTES);
    if (!t) return this.lastQueue;
    this._applyQueue(parseLastQueue(t.text), t.from, t.text);
    return this.lastQueue;
  }

  // Retient une mise en file, et n'horodate QUE si c'en est une nouvelle.
  // L'identité d'une file, c'est la position absolue de sa ligne dans le
  // journal : deux files successives sur la même playlist sont bien
  // distinguées, et relire la même ligne ne rafraîchit pas son horodatage —
  // sans quoi le garde de fraîcheur n'expirait jamais.
  _applyQueue(q, from, text) {
    if (!q) return false;
    // `from` est un décalage en OCTETS, `q.offset` un index de CARACTÈRES : les
    // additionner dérivait dès le moindre caractère non-ASCII dans le journal
    // (pseudo accentué, chemin Windows, U+FFFD d'une fenêtre coupée en plein
    // caractère). La même ligne changeait alors de clé à chaque scrutation, et
    // le garde de fraîcheur n'expirait jamais.
    const bytes = Buffer.byteLength(String(text).slice(0, q.offset), 'utf8');
    const key = q.playlist + '@' + (from + bytes);
    if (key === this._queueKey) return false;
    this._queueKey = key;
    this.lastQueue = { ...q, at: Date.now() };
    return true;
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

    const t = readTail(this.file, TAIL_BYTES);
    if (!t) return;
    if (this._applyQueue(parseLastQueue(t.text), t.from, t.text)) {
      this.emit('queue', this.lastQueue);
    }

    const found = parseLatest(t.text);
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
module.exports.readTail = readTail;
module.exports.RANKED_PLAYLISTS = RANKED_PLAYLISTS;
module.exports.CASUAL_PLAYLISTS = CASUAL_PLAYLISTS;
