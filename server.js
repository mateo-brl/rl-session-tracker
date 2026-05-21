require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const players = require('./lib/players');
const tracker = require('./lib/tracker');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// Registre des joueurs autorisés (rechargé à chaud si players.json change).
players.load();
players.watch();

// ───────── Sécurité de base ─────────
// Le serveur tourne DERRIÈRE le reverse proxy / WAF SafeLine : il n'écoute
// que sur 127.0.0.1, le TLS et le filtrage WAF sont gérés en amont.
app.disable('x-powered-by');

// CSP stricte : le front est désormais pré-compilé (plus de Babel ni de CDN),
// donc tous les scripts viennent de notre origine.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // Les styles inline de React passent par la propriété DOM .style (non
      // concernée par la CSP). 'unsafe-inline' ne couvre ici que d'éventuels
      // attributs style ; les polices Google nécessitent leur domaine.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Nombre de proxys de confiance devant le serveur (SafeLine = 1).
// IMPORTANT : SafeLine doit ÉCRASER l'en-tête X-Forwarded-For entrant, sinon
// un client peut usurper son IP. Ne jamais mettre `true` ici.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// ───────── Limiteurs de débit (par IP) ─────────
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate limited' },
});
const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate limited' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate limited' },
});
const streamLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
});

// Fichiers statiques du dashboard (public/dist/app.js, styles.css, …).
app.use(express.static(path.join(__dirname, 'public')));

// ───────── Cache de scraping tracker.gg, par joueur ─────────
// Plusieurs spectateurs ne déclenchent qu'un seul appel ; les requêtes
// concurrentes sont mutualisées via `inflight`.
const PROFILE_TTL = 45 * 1000;
const MAX_CONCURRENT_SCRAPES = 6;
const profileCache = new Map(); // id → { at, data, inflight }
let activeScrapes = 0;

async function getPlayerData(player) {
  const now = Date.now();
  const c = profileCache.get(player.id);
  if (c && c.data && now - c.at < PROFILE_TTL) return c.data;   // cache frais
  if (c && c.inflight) return c.inflight;                        // déjà en cours

  // Surcharge : on sert le cache périmé si on en a un, sinon on refuse (503).
  if (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
    if (c && c.data) return c.data;
    const busy = new Error('server busy');
    busy.busy = true;
    throw busy;
  }

  const inflight = (async () => {
    activeScrapes++;
    try {
      return await tracker.scrapeProfile(player.platform, player.username);
    } finally {
      activeScrapes--;
    }
  })();
  profileCache.set(player.id, { at: c ? c.at : 0, data: c ? c.data : null, inflight });
  try {
    const data = await inflight;
    profileCache.set(player.id, { at: Date.now(), data, inflight: null });
    return data;
  } catch (e) {
    // On garde la donnée précédente si on en avait une, mais on libère le lock.
    profileCache.set(player.id, { at: c ? c.at : 0, data: c ? c.data : null, inflight: null });
    throw e;
  }
}

// ───────── État live multi-joueurs (alimenté par les agents) ─────────
const OFFLINE_MS = 60 * 1000;
const liveState = new Map(); // id → { connected, match, lastSeen }

function getLive(id) {
  const s = liveState.get(id);
  if (!s || Date.now() - s.lastSeen > OFFLINE_MS) {
    return { connected: false, match: { active: false } };
  }
  return { connected: s.connected, match: s.match || { active: false } };
}

// ───────── Flux temps réel vers les navigateurs (SSE), par joueur ─────────
const sseClients = new Map(); // id → Set<res>
const SSE_MAX_TOTAL = 500;
const SSE_MAX_PER_IP = 8;
let sseTotal = 0;
const sseByIp = new Map(); // ip → nombre de connexions

function sseFrame(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

// Diffuse à tous les spectateurs d'un joueur. La trame n'est sérialisée
// qu'UNE fois, pas par client.
function sseBroadcast(id, event, data) {
  const set = sseClients.get(id);
  if (!set || set.size === 0) return;
  const frame = sseFrame(event, data);
  for (const res of set) {
    try { res.write(frame); } catch (e) { set.delete(res); }
  }
}

// ───────── Validation des données reçues d'un agent ─────────
// Les agents sont authentifiés, mais leurs données restent non fiables :
// on borne, on type et on tronque tout avant de les rediffuser.
const MODES_OK = new Set(['1v1', '2v2', '3v3']);

function clampNum(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function sanitizeMatch(m) {
  if (!m || typeof m !== 'object' || !m.active) return { active: false };
  const score = Array.isArray(m.score)
    ? [clampNum(m.score[0], 0, 0, 99), clampNum(m.score[1], 0, 0, 99)]
    : [0, 0];
  const list = Array.isArray(m.players) ? m.players.slice(0, 8) : [];
  return {
    active: true,
    mode: MODES_OK.has(m.mode) ? m.mode : null,
    score,
    timeSeconds: m.timeSeconds == null ? null : clampNum(m.timeSeconds, null, 0, 3600),
    isOT: !!m.isOT,
    players: list.map((p) => ({
      name: String((p && p.name) || '').slice(0, 48),
      team: clampNum(p && p.team, 0, 0, 1),
      goals: clampNum(p && p.goals, 0, 0, 99),
      saves: clampNum(p && p.saves, 0, 0, 99),
      assists: clampNum(p && p.assists, 0, 0, 99),
      shots: clampNum(p && p.shots, 0, 0, 99),
      score: clampNum(p && p.score, 0, 0, 99999),
    })).filter((p) => p.name),
  };
}

const EVENT_TYPES = new Set(['match-start', 'match-end', 'match-destroyed', 'goal']);

function sanitizeEvents(evs) {
  if (!Array.isArray(evs)) return [];
  return evs.slice(0, 32).map((e) => {
    if (!e || !EVENT_TYPES.has(e.type)) return null;
    if (e.type === 'goal') {
      return {
        type: 'goal',
        scorer: String(e.scorer || '').slice(0, 48),
        team: e.team === 0 || e.team === 1 ? e.team : -1,
      };
    }
    if (e.type === 'match-end') {
      return {
        type: 'match-end',
        winnerTeam: e.winnerTeam === 0 || e.winnerTeam === 1 ? e.winnerTeam : null,
        mode: MODES_OK.has(e.mode) ? e.mode : null,
        players: Array.isArray(e.players)
          ? e.players.slice(0, 8).map((p) => ({
              name: String((p && p.name) || '').slice(0, 48),
              team: p && p.team === 1 ? 1 : 0,
            })).filter((p) => p.name)
          : [],
      };
    }
    return { type: e.type };
  }).filter(Boolean);
}

// ───────── Routes API ─────────

// Réception des stats d'un agent. Authentifié par token Bearer.
// Le corps JSON est borné à 32 ko et n'est parsé QUE pour cette route.
app.post('/api/ingest', ingestLimiter, express.json({ limit: '32kb' }), (req, res) => {
  const auth = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const player = auth ? players.resolveToken(auth[1].trim()) : null;
  if (!player) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const connected = !!body.connected;
  const match = sanitizeMatch(body.match);
  const events = sanitizeEvents(body.events);

  const prev = liveState.get(player.id);
  const wasConnected = prev ? prev.connected : false;
  liveState.set(player.id, { connected, match, lastSeen: Date.now() });

  sseBroadcast(player.id, 'state', match.active ? match : { active: false });
  if (connected !== wasConnected) {
    sseBroadcast(player.id, 'connection', { connected });
  }
  for (const ev of events) {
    if (ev.type === 'goal') {
      sseBroadcast(player.id, 'goal', ev);
    } else if (ev.type === 'match-start') {
      sseBroadcast(player.id, 'match', { phase: 'start' });
    } else if (ev.type === 'match-destroyed') {
      sseBroadcast(player.id, 'match', { phase: 'destroyed' });
    } else if (ev.type === 'match-end') {
      sseBroadcast(player.id, 'ended', ev);
      // Un match vient de se terminer → le MMR tracker.gg va changer :
      // on invalide le cache pour que le prochain poll récupère du frais.
      profileCache.delete(player.id);
    }
  }
  res.json({ ok: true });
});

// Liste publique des joueurs configurés + leur statut live.
app.get('/api/players', apiLimiter, (_req, res) => {
  res.json({
    players: players.listPlayers().map((p) => ({
      id: p.id, name: p.name, platform: p.platform, live: getLive(p.id),
    })),
  });
});

// Profil + sessions d'un joueur connu (tracker.gg, mis en cache).
// Aucun scraping de profil arbitraire : seuls les joueurs déclarés.
app.get('/api/player/:id/live', scrapeLimiter, async (req, res) => {
  const player = players.getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: 'unknown player' });
  try {
    const data = await getPlayerData(player);
    const profile = data && data.profile;
    if (profile && profile.errors) {
      return res.status(404).json({ error: 'profile not found' });
    }
    if (!profile || !profile.data || !Array.isArray(profile.data.segments)) {
      return res.status(502).json({ error: 'tracker.gg unavailable' });
    }
    res.json({
      profile,
      sessions: data.sessions,
      player: {
        id: player.id, name: player.name,
        platform: player.platform, username: player.username,
      },
      live: getLive(player.id),
    });
  } catch (err) {
    if (err && err.busy) return res.status(503).json({ error: 'server busy' });
    console.error('Scrape error:', err.message);
    res.status(502).json({ error: 'scraping failed' });
  }
});

// Flux SSE temps réel d'un joueur donné.
app.get('/api/stats/stream/:id', streamLimiter, (req, res) => {
  const player = players.getPlayer(req.params.id);
  if (!player) return res.status(404).end();

  // Plafonds anti-épuisement de ressources.
  const ip = req.ip || 'unknown';
  if (sseTotal >= SSE_MAX_TOTAL || (sseByIp.get(ip) || 0) >= SSE_MAX_PER_IP) {
    return res.status(503).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let set = sseClients.get(player.id);
  if (!set) { set = new Set(); sseClients.set(player.id, set); }
  set.add(res);
  sseTotal++;
  sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);

  // État courant immédiat.
  const l = getLive(player.id);
  res.write(sseFrame('connection', { connected: l.connected }));
  if (l.match && l.match.active) res.write(sseFrame('state', l.match));

  let closed = false;
  req.on('close', () => {
    if (closed) return;
    closed = true;
    set.delete(res);
    if (set.size === 0) sseClients.delete(player.id);
    sseTotal--;
    const n = (sseByIp.get(ip) || 1) - 1;
    if (n <= 0) sseByIp.delete(ip); else sseByIp.set(ip, n);
  });
});

// Toute autre route /api/* inconnue → 404 JSON (et non la page du SPA).
app.all('/api/*', (_req, res) => res.status(404).json({ error: 'not found' }));

// ───────── Dashboard (SPA) ─────────
// Seules les routes connues servent la page ; le reste est un vrai 404.
app.get(['/', '/u/:id'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((_req, res) => res.status(404).send('Not found'));

// Corps JSON malformé / trop gros → 400 propre.
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed')) {
    return res.status(400).json({ error: 'bad request' });
  }
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'internal error' });
});

// ───────── Tâche de fond : hors-ligne + purge mémoire ─────────
setInterval(() => {
  const now = Date.now();
  const validIds = new Set(players.listPlayers().map((p) => p.id));

  for (const [id, s] of liveState) {
    if (!validIds.has(id)) { liveState.delete(id); continue; } // joueur retiré
    if (s.connected && now - s.lastSeen > OFFLINE_MS) {
      s.connected = false;
      s.match = { active: false };
      sseBroadcast(id, 'connection', { connected: false });
      sseBroadcast(id, 'state', { active: false });
    }
  }
  for (const id of profileCache.keys()) {
    if (!validIds.has(id)) profileCache.delete(id);
  }
  for (const [id, set] of sseClients) {
    if (set.size === 0) sseClients.delete(id);
  }
}, 10 * 1000);

// Ping SSE global (une seule boucle, pas un timer par connexion).
setInterval(() => {
  for (const set of sseClients.values()) {
    for (const res of set) {
      try { res.write(': ping\n\n'); } catch (e) { set.delete(res); }
    }
  }
}, 25 * 1000);

// ───────── Démarrage / arrêt ─────────
const server = app.listen(PORT, HOST, async () => {
  console.log(`\n  RL Session Tracker (multi-joueurs) — http://${HOST}:${PORT}`);
  console.log('  Joueurs configurés : ' + players.listPlayers().length);
  try {
    await tracker.warmup();
    console.log('  tracker.gg : clearance Cloudflare prête\n');
  } catch (e) {
    console.log('  tracker.gg : warmup différé (' + e.message + ')\n');
  }
});
// Les connexions SSE sont longues : pas de timeout global de requête.
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { await tracker.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
