#!/usr/bin/env node
// agent/agent.js — Agent RL Session Tracker.
//
// Tourne sur le PC gaming. Il lit la Stats API native de Rocket League sur le
// socket local (127.0.0.1:49123) et pousse les évènements vers le serveur
// (ex. https://rl.mateobrl.fr) via des requêtes POST authentifiées.
//
// Aucune connexion entrante : c'est l'agent qui contacte le serveur.
// Se configure avec un fichier config.json placé à côté de l'exécutable.

const fs = require('fs');
const path = require('path');

// ───────── Garde la fenêtre console ouverte en cas d'erreur ─────────
function holdOpen(code) {
  console.log('\n  (Appuie sur Entrée pour fermer cette fenêtre)');
  try {
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(code || 0));
  } catch (e) { process.exit(code || 0); }
}

// ───────── Chargement de la configuration ─────────
// On cherche config.json à côté de l'exécutable puis dans le répertoire du
// module. On NE cherche PAS dans process.cwd() : un attaquant pourrait sinon
// déposer un config.json malveillant dans un dossier quelconque et détourner
// l'agent (serverUrl/token pirates) selon l'endroit d'où il est lancé.
function findConfig() {
  const dirs = [];
  try { dirs.push(path.dirname(process.execPath)); } catch (e) {} // à côté du .exe
  dirs.push(__dirname);                                            // à côté du module
  for (const d of dirs) {
    const p = path.join(d, 'config.json');
    if (fs.existsSync(p)) return p;
  }
  // Dernier recours uniquement : le répertoire courant. Détournable, donc
  // on l'annonce explicitement en console pour que ce ne soit pas silencieux.
  try {
    const cwdConfig = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(cwdConfig)) {
      console.warn('\n  ⚠  config.json chargé depuis le répertoire courant');
      console.warn('     (' + cwdConfig + ').');
      console.warn('     Place-le plutôt à côté de l\'exécutable : un config.json');
      console.warn('     déposé par un tiers dans ce dossier pourrait détourner l\'agent.');
      return cwdConfig;
    }
  } catch (e) {}
  return null;
}

function loadConfig() {
  const p = findConfig();
  if (!p) {
    console.error('\n  config.json introuvable.');
    console.error('  Place le fichier config.json (fourni avec ton token) à côté');
    console.error("  de l'agent, puis relance.");
    return null;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!cfg.serverUrl || !cfg.token) throw new Error('serverUrl ou token manquant');
    cfg.serverUrl = String(cfg.serverUrl).replace(/\/+$/, '');
    cfg.statsApiPort = cfg.statsApiPort || 49123;

    // Imposer HTTPS : le token est envoyé en clair dans l'en-tête
    // Authorization, donc en HTTP il fuite sur le réseau. On tolère HTTP
    // uniquement sur localhost/127.0.0.1 (pratique pour le développement).
    let serverHost = '';
    try { serverHost = new URL(cfg.serverUrl).hostname; } catch (e) {}
    const isLocal = serverHost === 'localhost'
      || serverHost === '127.0.0.1' || serverHost === '::1';
    if (!/^https:\/\//i.test(cfg.serverUrl) && !isLocal) {
      throw new Error(
        'serverUrl doit utiliser https:// (le token transiterait en clair). '
        + 'Reçu : ' + cfg.serverUrl);
    }
    return cfg;
  } catch (e) {
    console.error('\n  config.json invalide : ' + e.message);
    return null;
  }
}

// ───────── Démarrage ─────────
const config = loadConfig();
if (!config) {
  holdOpen(1);
} else {
  startAgent(config);
}

function startAgent(cfg) {
  // La Stats API lit son port via une variable d'environnement : il faut la
  // poser AVANT de charger le connecteur.
  process.env.STATSAPI_PORT = String(cfg.statsApiPort);
  if (cfg.debug) process.env.STATSAPI_DEBUG = '1';
  const RLStatsAPI = require('../statsapi');

  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   RL Session Tracker — Agent         ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('  Serveur          : ' + cfg.serverUrl);
  console.log('  Stats API locale : 127.0.0.1:' + cfg.statsApiPort);
  console.log('');

  const ingestUrl = cfg.serverUrl + '/api/ingest';
  const latest = { connected: false, match: { active: false } };
  let queue = [];          // évènements discrets en attente d'envoi
  let lastFlush = 0;
  let sending = false;

  // ───────── Affichage d'état console ─────────
  let gameStatus = 'en attente de Rocket League';
  let serverStatus = 'pas encore contacté';
  function logStatus() {
    const t = new Date().toLocaleTimeString();
    console.log('  [' + t + ']  jeu : ' + gameStatus + '   |   serveur : ' + serverStatus);
  }
  function setGameStatus(s) { if (s !== gameStatus) { gameStatus = s; logStatus(); } }
  function setServerStatus(s) { if (s !== serverStatus) { serverStatus = s; logStatus(); } }

  // ───────── Envoi vers le serveur ─────────
  async function flush() {
    if (sending) return;
    sending = true;
    const events = queue;
    queue = [];
    const payload = { connected: latest.connected, match: latest.match, events };
    try {
      const resp = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.status === 401) {
        setServerStatus('TOKEN REFUSÉ (401) — vérifie config.json');
      } else if (resp.status === 429 || resp.status >= 500) {
        // 429 (limité) ou 5xx (erreur serveur) : le serveur n'a rien traité.
        // On remet les évènements en file pour les renvoyer plus tard. On
        // garde les plus RÉCENTS si la file déborde (slice(-100)).
        queue = events.concat(queue).slice(-100);
        setServerStatus(resp.status === 429
          ? 'limité (429) — ralentissement, évènements remis en file'
          : 'erreur serveur ' + resp.status + ' — évènements remis en file');
      } else if (!resp.ok) {
        setServerStatus('erreur HTTP ' + resp.status);
      } else {
        setServerStatus('connecté');
      }
    } catch (e) {
      // Le serveur est injoignable : on remet les évènements en file pour ne
      // pas les perdre. Si la file déborde, on garde les plus RÉCENTS.
      queue = events.concat(queue).slice(-100);
      setServerStatus('injoignable (' + (e.code || e.name || 'réseau') + ')');
    } finally {
      sending = false;
    }
  }

  function triggerFlush() { lastFlush = Date.now(); flush(); }

  // ───────── Connexion à la Stats API du jeu ─────────
  const api = new RLStatsAPI();

  api.on('connection', (d) => {
    latest.connected = d.connected;
    setGameStatus(d.connected ? 'Rocket League connecté' : 'en attente de Rocket League');
    triggerFlush();
  });
  api.on('match', (d) => {
    if (d.phase === 'start') {
      queue.push({ type: 'match-start' });
      setGameStatus('match en cours');
      triggerFlush();
    } else if (d.phase === 'destroyed') {
      // Le match a été détruit sans 'ended' propre (déconnexion, abandon...).
      // On le signale au serveur et on remet le snapshot à l'état inactif.
      queue.push({ type: 'match-destroyed' });
      latest.match = { active: false };
      setGameStatus('Rocket League connecté');
      triggerFlush();
    }
  });
  api.on('state', (d) => { latest.match = d; });
  api.on('goal', (d) => {
    queue.push({ type: 'goal', scorer: d.scorer, team: d.team });
  });
  api.on('ended', (d) => {
    latest.match = { active: false };
    queue.push({
      type: 'match-end',
      winnerTeam: d.winnerTeam,
      mode: d.mode,
      players: (d.players || []).map((p) => ({ name: p.name, team: p.team })),
    });
    setGameStatus('Rocket League connecté');
    triggerFlush();
  });

  api.start();
  logStatus();

  // Astuce si la Stats API ne répond pas (souvent : .ini non activé).
  setTimeout(() => {
    if (!latest.connected) {
      console.log('');
      console.log('  ⚠  Stats API injoignable sur le port ' + cfg.statsApiPort + '.');
      console.log('     Lance enable-statsapi.bat puis redémarre Rocket League.');
      console.log('');
    }
  }, 20 * 1000);

  // ───────── Boucle d'envoi ─────────
  // En match : ~1 envoi/s (score live). Sinon : battement toutes les 20 s.
  setInterval(() => {
    const now = Date.now();
    const inMatch = latest.match && latest.match.active;
    const due = queue.length > 0
      || (inMatch && now - lastFlush >= 1000)
      || (now - lastFlush >= 20 * 1000);
    if (due) triggerFlush();
  }, 1000);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
