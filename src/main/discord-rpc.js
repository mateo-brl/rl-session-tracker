// discord-rpc.js — Statut Discord (Rich Presence), sans aucune dépendance.
//
// Discord expose un IPC local (named pipe « \\.\pipe\discord-ipc-N » sous
// Windows) au protocole simple : trame = [opcode int32 LE][taille int32 LE]
// [JSON]. Un handshake (op 0) avec un client_id, puis des trames op 1
// SET_ACTIVITY. Protocole repris du projet manucabral/RocketLeagueRPC (MIT),
// réimplémenté en Node pour rester sans dépendance.
//
// Tout est silencieux : Discord absent ou fermé = on réessaie de temps en
// temps, jamais d'erreur visible. Aucune donnée ne part ailleurs que dans le
// pipe local de Discord.

const net = require('net');
const path = require('path');

// Application Discord publique du projet RocketLeagueRPC (manucabral, MIT).
// Pour afficher un nom personnalisé, créer son application sur
// discord.com/developers et remplacer cet identifiant.
const CLIENT_ID = '1301217342012788826';

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const RETRY_MS = 30 * 1000;     // Discord pas lancé : on retente sans insister
const MIN_INTERVAL = 5000;      // SET_ACTIVITY est limité par Discord (~5/20 s)
const MAX_FRAME_SIZE = 65536;   // Une trame Discord (READY, ERROR…) tient largement dedans
const HANDSHAKE_TIMEOUT_MS = 10 * 1000; // pipe ouvert mais jamais de READY : on abandonne

const TEXTS = {
  fr: {
    ranked: 'Classé', casual: 'Casual', ot: 'Prolongation',
    training: 'En entraînement', menus: 'Dans les menus',
    session: (w, l) => 'Session : ' + w + 'V – ' + l + 'D',
    streak: (n, win) => 'Série de ' + n + (win ? ' victoires' : ' défaites'),
  },
  en: {
    ranked: 'Ranked', casual: 'Casual', ot: 'Overtime',
    training: 'In training', menus: 'In the menus',
    session: (w, l) => 'Session: ' + w + 'W – ' + l + 'L',
    streak: (n, win) => n + (win ? '-win streak' : '-loss streak'),
  },
};

let log = () => {};
let enabled = false;
let socket = null;
let ready = false;
let buffer = Buffer.alloc(0);
let retryTimer = null;
let handshakeTimer = null;
let nonce = 0;

// Dernière activité voulue + lissage des envois (bord de fuite garanti).
let pending;                 // undefined = rien à envoyer, sinon objet ou null
let lastSentAt = 0;
let sendTimer = null;
let matchStartAt = null;     // pour le chrono « depuis X min » du statut

function pipePaths() {
  const out = [];
  if (process.platform === 'win32') {
    for (let i = 0; i < 10; i++) out.push('\\\\.\\pipe\\discord-ipc-' + i);
  } else {
    const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
    for (let i = 0; i < 10; i++) out.push(path.join(dir, 'discord-ipc-' + i));
  }
  return out;
}

function send(op, obj) {
  if (!socket) return;
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(raw.length, 4);
  try { socket.write(Buffer.concat([head, raw])); } catch (e) {}
}

function teardown(retry) {
  ready = false;
  buffer = Buffer.alloc(0);
  // Un teardown met fin à toute tentative de handshake en cours : sans ce
  // nettoyage, le timer pourrait détruire un socket déjà remplacé (reconnexion
  // fantôme) ou survivre à un stop() volontaire.
  if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
  if (socket) {
    try { socket.destroy(); } catch (e) {}
    socket = null;
  }
  if (retry && enabled && !retryTimer) {
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, RETRY_MS);
  }
}

function onData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 8) {
    const size = buffer.readInt32LE(4);
    // Taille aberrante (négative, ou disproportionnée) : trame corrompue ou
    // pipe squatté par un tiers qui ne parle pas le protocole Discord (un
    // process local peut créer discord-ipc-0 avant Discord). Avec une taille
    // négative, `buffer.length < 8 + size` est toujours faux et
    // `buffer.slice(8 + size)` ne progresse jamais : la boucle tournerait à
    // l'infini et gèlerait le main process. On abandonne la connexion et on
    // se resynchronise en reconnectant plutôt que de continuer à lire un flux
    // dont on ne peut plus faire confiance au découpage.
    if (size < 0 || size > MAX_FRAME_SIZE) { teardown(true); return; }
    if (buffer.length < 8 + size) break;
    let payload = null;
    try { payload = JSON.parse(buffer.slice(8, 8 + size).toString('utf8')); } catch (e) {}
    buffer = buffer.slice(8 + size);
    if (payload && payload.evt === 'READY') {
      // Handshake abouti : plus besoin du filet de sécurité du timeout.
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      ready = true;
      log('Discord RPC connecté');
      flush();
    }
  }
}

// Essaie chaque pipe (Discord, Canary… peuvent décaler l'index).
function connect(idx) {
  if (!enabled || socket) return;
  const paths = pipePaths();
  idx = idx || 0;
  if (idx >= paths.length) { teardown(true); return; }
  const sock = net.createConnection({ path: paths[idx] });
  socket = sock;
  sock.on('connect', () => {
    send(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID });
    // Le pipe peut être ouvert par un pair qui n'est pas Discord (ou par un
    // Discord zombie) et n'enverra jamais READY : sans filet, `ready` resterait
    // bloqué à false pour toujours, aucun retryTimer ne serait armé et les
    // pipes suivants ne seraient jamais essayés. On se laisse une fenêtre de
    // grâce, puis on passe au pipe suivant si rien n'est arrivé.
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (socket === sock) {
        try { sock.destroy(); } catch (e) {}
        socket = null;
        connect(idx + 1);
      }
    }, HANDSHAKE_TIMEOUT_MS);
  });
  sock.on('data', onData);
  sock.on('error', () => {
    if (socket === sock) {
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      socket = null;
      connect(idx + 1);
    }
  });
  sock.on('close', () => {
    if (socket === sock) teardown(true);
  });
}

function flush() {
  if (!ready || pending === undefined) return;
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastSentAt);
  if (wait > 0) {
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; flush(); }, wait);
    return;
  }
  lastSentAt = now;
  const activity = pending;
  pending = undefined;
  send(OP_FRAME, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity: activity },
    nonce: String(++nonce),
  });
}

function setActivity(activity) {
  pending = activity;
  flush();
}

// Construit l'activité depuis l'état de l'application et la pousse.
function refresh(state) {
  if (!enabled) return;
  const T = TEXTS[state.lang] || TEXTS.fr;
  let activity = null;

  if (state.game && state.game.running) {
    const live = state.live;
    const ses = state.session;
    const sessionLine = ses && ses.played ? T.session(ses.wins, ses.losses) : null;
    if (live && live.active) {
      if (!matchStartAt) matchStartAt = Date.now();
      if (live.training) {
        activity = { details: T.training, state: sessionLine || undefined };
      } else {
        const score = Array.isArray(live.score) ? live.score.join(' – ') : '';
        const kind = state.currentRanked === false ? T.casual : T.ranked;
        const details = kind + ' ' + (live.mode || '') + ' · ' + score
          + (live.isOT ? ' · ' + T.ot : '');
        const line = (ses && ses.streak && ses.streak.count >= 2)
          ? T.streak(ses.streak.count, ses.streak.type === 'W')
          : sessionLine;
        activity = {
          details: details,
          state: line || undefined,
          timestamps: { start: Math.round(matchStartAt / 1000) },
        };
      }
    } else {
      matchStartAt = null;
      activity = { details: T.menus, state: sessionLine || undefined };
    }
  } else {
    matchStartAt = null;
  }

  setActivity(activity);
}

function setEnabled(on, logger) {
  if (logger) log = logger;
  on = !!on;
  if (on === enabled) return;
  enabled = on;
  if (enabled) {
    connect();
  } else {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (ready) {
      send(OP_FRAME, { cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null }, nonce: String(++nonce) });
    }
    pending = undefined;
    teardown(false);
  }
}

// À la fermeture de l'application : efface le statut et coupe proprement.
function stop() {
  if (ready) {
    send(OP_FRAME, { cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: null }, nonce: String(++nonce) });
    send(OP_CLOSE, {});
  }
  enabled = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  teardown(false);
}

module.exports = { setEnabled, refresh, stop };
