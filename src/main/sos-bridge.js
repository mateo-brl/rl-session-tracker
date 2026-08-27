// sos-bridge.js — Réémet le flux de la Stats API au format du défunt plugin
// SOS, sur le port que celui-ci utilisait (49122).
//
// POURQUOI : avant l'arrivée d'Easy Anti-Cheat (avril 2026), tout
// l'écosystème d'overlays de diffusion parlait « SOS » — un WebSocket local
// servi par un plugin BakkesMod, avec des évènements nommés `game:update_state`,
// `game:goal_scored`, `game:match_ended`… Ces overlays sont désormais muets en
// ligne, alors que la donnée existe toujours : elle arrive simplement par la
// Stats API native. Ce pont fait la traduction, ce qui rend tous ces overlays
// utilisables tels quels avec le tracker.
//
// Le serveur WebSocket est écrit à la main (RFC 6455) : le projet n'a aucune
// dépendance d'exécution en dehors de l'updater, et on ne va pas en ajouter
// une pour émettre du texte. On n'implémente que ce dont on a besoin :
//  • la poignée de main HTTP → WebSocket ;
//  • l'émission de trames texte NON masquées (sens serveur → client) ;
//  • la lecture des trames client, uniquement pour répondre au ping et
//    traiter la fermeture — leur contenu ne nous intéresse pas.

const http = require('http');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // constante RFC 6455
const DEFAULT_PORT = 49122;
const MAX_CLIENTS = 10;
// Une trame reçue d'un overlay est minuscule (ping, close). Au-delà, on coupe :
// aucun client légitime n'envoie de gros messages sur ce pont.
const MAX_FRAME = 8192;

let server = null;
let clients = new Set();
let listenPort = 0;
// Port DEMANDÉ, connu dès l'appel à start(). `listenPort` n'est renseigné
// qu'au rappel de listen() : s'y fier pour l'idempotence laissait deux appels
// rapprochés (deux réglages OBS enchaînés) faire stop() puis listen() sur un
// port encore en cours de libération — EADDRINUSE, et le pont restait mort.
let wantedPort = 0;
let logFn = null;

function log(msg) {
  if (logFn) { try { logFn('[sos] ' + msg); } catch (e) {} }
}

// ───────── Encodage d'une trame texte (serveur → client) ─────────
// Le serveur n'a jamais le droit de masquer ses trames (RFC 6455 §5.1).
function encodeText(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81;                 // FIN + opcode texte
  return Buffer.concat([header, payload]);
}

function encodeClose() {
  return Buffer.from([0x88, 0x00]); // FIN + opcode close, sans charge utile
}

function encodePong(payload) {
  const p = payload && payload.length <= 125 ? payload : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x8a, p.length]), p]);
}

// ───────── Lecture des trames client ─────────
// On ne cherche pas à reconstituer les messages fragmentés : seuls les codes
// de contrôle nous intéressent. Toute trame mal formée ferme la connexion —
// c'est un pont local, la tolérance n'apporterait rien.
function readFrames(sock, buf) {
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      // Une charge utile de plus de 4 Go n'a aucun sens ici.
      if (buf.readUInt32BE(2) !== 0) { sock.destroy(); return Buffer.alloc(0); }
      len = buf.readUInt32BE(6);
      offset = 10;
    }
    if (len > MAX_FRAME) { sock.destroy(); return Buffer.alloc(0); }
    // Le client DOIT masquer ses trames : 4 octets de clé en plus.
    const total = offset + (masked ? 4 : 0) + len;
    if (buf.length < total) break;

    if (opcode === 0x8) {                       // fermeture demandée
      try { sock.end(encodeClose()); } catch (e) {}
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) {                       // ping → pong
      let payload = buf.slice(offset + (masked ? 4 : 0), total);
      if (masked) {
        const key = buf.slice(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      }
      try { sock.write(encodePong(payload)); } catch (e) {}
    }
    buf = buf.slice(total);
  }
  return buf;
}

// ───────── Poignée de main ─────────
function handleUpgrade(req, sock) {
  // TOUT PREMIER : après 'upgrade', Node retire ses propres écouteurs et nous
  // laisse le socket. Sans écouteur 'error' dès maintenant, un pair qui coupe
  // brutalement pendant la poignée de main (onglet fermé, OBS tué) émet un
  // ECONNRESET sans destinataire — ce qui fait tomber le processus principal,
  // donc l'application entière, en pleine partie.
  sock.on('error', () => {
    clients.delete(sock);
    try { sock.destroy(); } catch (e) {}
  });
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  // Même garde que le serveur OBS : sans validation du Host, une page web
  // pourrait atteindre ce port par rebinding DNS et lire le flux de jeu
  // (pseudos des adversaires compris).
  const host = String(req.headers.host || '');
  if (host !== '127.0.0.1:' + listenPort && host !== 'localhost:' + listenPort) {
    sock.destroy();
    return;
  }
  if (clients.size >= MAX_CLIENTS) { sock.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);

  let buf = Buffer.alloc(0);
  clients.add(sock);
  log('overlay connecté (' + clients.size + ')');

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    buf = readFrames(sock, buf);
  });
  const drop = () => {
    if (clients.delete(sock)) log('overlay déconnecté (' + clients.size + ')');
  };
  sock.on('close', drop);
  sock.on('error', drop);
  sock.on('end', drop);
}

// ───────── Traduction Stats API → format SOS ─────────
// Traduire le NOM de l'évènement ne suffit pas : les overlays SOS ont été
// écrits contre le SCHÉMA de SOS, pas contre celui de la Stats API. Un overlay
// lit `data.game.teams[0].score`, `data.players['<id>'].name` ou
// `data.scorer.name` — leur passer le instantané brut de la Stats API
// (`score: [a, b]`, `players` en tableau, `scorer` en chaîne) ne produirait
// que des `undefined`. On reconstruit donc les charges utiles à la forme
// attendue.
//
// La correspondance est faite au mieux, à partir de la documentation
// communautaire de SOS : les champs que la Stats API ne fournit pas (position
// de la balle, couleurs d'équipe, démolitions…) sont simplement absents. Un
// overlay qui en dépend affichera un trou à cet endroit, pas une erreur.
const EVENT_NAMES = {
  start: 'game:match_created',
  destroyed: 'game:match_destroyed',
  state: 'game:update_state',
  goal: 'game:goal_scored',
  ended: 'game:match_ended',
  podium: 'game:podium_start',
};

// SOS indexe les joueurs par identifiant, pas par position dans un tableau.
function sosPlayers(list) {
  const out = {};
  const players = Array.isArray(list) ? list : [];
  players.forEach((p, i) => {
    const id = p.id || (p.name ? p.name + '_' + p.team : 'p' + i);
    out[id] = {
      id: id,
      name: p.name,
      team: p.team,
      score: p.score,
      goals: p.goals,
      assists: p.assists,
      saves: p.saves,
      shots: p.shots,
    };
  });
  return out;
}

function sosTeams(score) {
  const s = Array.isArray(score) ? score : [0, 0];
  return { 0: { score: s[0] | 0 }, 1: { score: s[1] | 0 } };
}

function toSos(kind, data) {
  const d = data || {};
  if (kind === 'state') {
    return {
      hasGame: !!d.active,
      match_guid: d.guid || '',
      game: {
        teams: sosTeams(d.score),
        time_seconds: d.timeSeconds === null || d.timeSeconds === undefined
          ? 0 : d.timeSeconds,
        isOT: !!d.isOT,
        hasWinner: false,
      },
      players: sosPlayers(d.players),
    };
  }
  if (kind === 'goal') {
    return {
      scorer: {
        name: d.scorer || '',
        teamnum: typeof d.team === 'number' ? d.team : -1,
      },
    };
  }
  if (kind === 'ended') {
    return {
      match_guid: d.guid || '',
      winner_team_num: (d.winnerTeam === 0 || d.winnerTeam === 1) ? d.winnerTeam : -1,
    };
  }
  if (kind === 'podium') return { match_guid: d.guid || '' };
  if (kind === 'start') return { match_guid: d.guid || '' };
  return {};
}

function send(kind, data) {
  if (!clients.size) return;
  const name = EVENT_NAMES[kind];
  if (!name) return;
  let frame;
  try {
    frame = encodeText(JSON.stringify({ event: name, data: toSos(kind, data) }));
  } catch (e) { return; }
  for (const sock of Array.from(clients)) {
    try { sock.write(frame); } catch (e) { clients.delete(sock); }
  }
}

function start(port, onLog) {
  logFn = onLog || null;
  const want = Number(port) || DEFAULT_PORT;
  if (server && wantedPort === want) return;
  stop();
  wantedPort = want;

  server = http.createServer((req, res) => {
    // Le pont ne sert aucune page : seul l'upgrade WebSocket a du sens.
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Utiliser une connexion WebSocket.\n');
  });
  server.on('upgrade', (req, sock) => handleUpgrade(req, sock));
  server.on('error', (e) => {
    log('port ' + want + ' indisponible : ' + e.message);
    server = null;
    listenPort = 0;
    wantedPort = 0;
  });
  // 127.0.0.1 uniquement : le pont ne sort jamais de la machine.
  server.listen(want, '127.0.0.1', () => {
    listenPort = server.address().port;
    log('pont compatible SOS à l’écoute sur 127.0.0.1:' + listenPort);
  });
}

function stop() {
  for (const sock of Array.from(clients)) {
    try { sock.end(encodeClose()); } catch (e) {}
    try { sock.destroy(); } catch (e) {}
  }
  clients = new Set();
  if (server) { try { server.close(); } catch (e) {} server = null; }
  listenPort = 0;
  wantedPort = 0;
}

function status() {
  return { running: !!server && listenPort > 0, port: listenPort, clients: clients.size };
}

module.exports = { start, stop, send, status, encodeText, readFrames, EVENT_NAMES,
  toSos };
