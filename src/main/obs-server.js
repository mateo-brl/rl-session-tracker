// obs-server.js — Mode streamer : overlay OBS servi en local.
//
// Un mini serveur HTTP (Node natif, zéro dépendance) sert une page overlay
// transparente, à capturer dans OBS via une source « Navigateur » :
//
//     http://127.0.0.1:49350/overlay
//
// La page reçoit l'état en direct par Server-Sent Events (reconnexion
// automatique intégrée au navigateur), plus des évènements ponctuels
// (but, fin de match) pour les animations.
//
// Le serveur n'écoute QUE sur 127.0.0.1 : rien n'est exposé au réseau, et
// les données ne contiennent que des statistiques de jeu.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'renderer', 'obs.html');
const FONTS = path.join(__dirname, '..', 'renderer', 'fonts');
const HEARTBEAT_MS = 25 * 1000;   // garde les connexions SSE en vie

let server = null;
let port = 0;
let log = () => {};
let onStatus = () => {};
const clients = new Set();
let lastState = null;
let heartTimer = null;

function sse(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
}

function handler(req, res) {
  const url = String(req.url || '/').split('?')[0];

  if (url === '/' || url === '/overlay') {
    try {
      const html = fs.readFileSync(PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('overlay page missing');
    }
    return;
  }

  if (url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(lastState || {}));
    return;
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': ok\n\n');
    if (lastState) {
      res.write('event: state\ndata: ' + JSON.stringify(lastState) + '\n\n');
    }
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Polices de la page overlay (nom strictement filtré, dossier imposé).
  if (url.startsWith('/fonts/')) {
    const name = url.slice(7).replace(/[^a-z0-9.-]/gi, '');
    if (name.endsWith('.woff2')) {
      try {
        const buf = fs.readFileSync(path.join(FONTS, name));
        res.writeHead(200, { 'Content-Type': 'font/woff2',
          'Cache-Control': 'max-age=86400' });
        res.end(buf);
        return;
      } catch (e) { /* 404 ci-dessous */ }
    }
  }

  res.writeHead(404);
  res.end('not found');
}

function start(p, logger, statusCb) {
  if (logger) log = logger;
  if (statusCb) onStatus = statusCb;
  if (server) {
    if (p === port) return;
    stop();                        // changement de port : on redémarre
  }
  port = p;
  server = http.createServer(handler);
  server.on('error', (e) => {
    log('overlay OBS : serveur indisponible (' + e.code + ') sur le port ' + port);
    server = null;
    onStatus({ running: false, port: port, error: e.code });
  });
  // 127.0.0.1 uniquement : jamais exposé au réseau local.
  server.listen(port, '127.0.0.1', () => {
    port = server.address().port;   // port effectif (utile si 0 = éphémère)
    log('overlay OBS : http://127.0.0.1:' + port + '/overlay');
    onStatus({ running: true, port: port, error: null });
  });
  if (!heartTimer) {
    heartTimer = setInterval(() => sse('ping', Date.now()), HEARTBEAT_MS);
  }
}

function stop() {
  if (heartTimer) { clearInterval(heartTimer); heartTimer = null; }
  for (const res of clients) { try { res.end(); } catch (e) {} }
  clients.clear();
  if (server) {
    try { server.close(); } catch (e) {}
    server = null;
    onStatus({ running: false, port: port, error: null });
  }
}

function running() {
  return !!server;
}

// État courant (mémorisé pour les connexions futures) + diffusion.
function broadcast(state) {
  lastState = state;
  if (server) sse('state', state);
}

// Évènement ponctuel (goal, result) pour les animations de la page.
function emit(name, data) {
  if (server) sse(name, data);
}

module.exports = { start, stop, running, broadcast, emit };
