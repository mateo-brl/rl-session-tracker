require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const players = require('./lib/players');

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
// CSP désactivée : l'app charge React/Babel depuis un CDN et utilise du JSX
// in-browser (eval). Le rendu passe par React (échappement auto) → surface
// XSS faible. Le reste des en-têtes Helmet est conservé.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// Une seule couche de proxy de confiance (SafeLine) pour obtenir la vraie IP.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
});
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  // Limite par token d'agent plutôt que par IP (plusieurs PC peuvent partager
  // une IP, et un PC garde sa limite propre).
  keyGenerator: (req) => {
    const m = (req.get('authorization') || '').match(/Bearer\s+(.+)/i);
    return m ? 'tok:' + m[1].slice(0, 24) : req.ip;
  },
});

app.use(express.static(path.join(__dirname, 'public')));
// Corps JSON borné : un agent n'envoie que de petits paquets.
app.use(express.json({ limit: '64kb' }));
// Corps JSON malformé / trop gros → 400 propre.
app.use((err, _req, res, next) => {
  if (err && err.type) return res.status(400).json({ error: 'bad request' });
  next(err);
});

// ───────── Navigateur headless (scraping tracker.gg) ─────────
const PLATFORM_MAP = { epic: 'epic', steam: 'steam', psn: 'psn', xbox: 'xbl' };
let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions',
    ],
  });
  return browser;
}

// Page « warm » : un profil chargé une fois lève la protection Cloudflare
// pour api.tracker.gg ; les requêtes suivantes réutilisent ses cookies.
const WARMUP_URL = 'https://rocketleague.tracker.network/rocket-league/profile/epic/FairyPeak/overview';
let warmPage = null;
let warmPagePromise = null;

async function getWarmPage() {
  try { if (warmPage && !warmPage.isClosed()) return warmPage; } catch (e) { warmPage = null; }
  if (warmPagePromise) return warmPagePromise;
  warmPagePromise = (async () => {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.goto(WARMUP_URL, { waitUntil: 'networkidle2', timeout: 35000 });
    warmPage = page;
    return page;
  })();
  try { return await warmPagePromise; }
  finally { warmPagePromise = null; }
}

async function rewarmPage() {
  try { if (warmPage && !warmPage.isClosed()) await warmPage.close(); } catch (e) {}
  warmPage = null;
  return getWarmPage();
}

// ───────── Profil + sessions depuis api.tracker.gg ─────────
async function scrapeAll(platform, username) {
  const plat = PLATFORM_MAP[platform] || platform;
  const user = encodeURIComponent(username);
  const profileUrl  = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/${plat}/${user}`;
  const sessionsUrl = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/${plat}/${user}/sessions`;

  async function fetchBoth() {
    const page = await getWarmPage();
    return page.evaluate(async (pUrl, sUrl) => {
      async function get(u) {
        try {
          const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
          return { status: r.status, body: await r.text() };
        } catch (e) { return { status: 0, body: String(e) }; }
      }
      const [p, s] = await Promise.all([get(pUrl), get(sUrl)]);
      return { p, s };
    }, profileUrl, sessionsUrl);
  }

  let res;
  try {
    res = await fetchBoth();
  } catch (e) {
    await rewarmPage();
    res = await fetchBoth();
  }
  if ([0, 403, 429, 503].includes(res.p.status)) {
    await rewarmPage();
    res = await fetchBoth();
  }

  let profile = null, sessions = null;
  try { profile = JSON.parse(res.p.body); } catch (e) {}
  if (res.s.status === 200) { try { sessions = JSON.parse(res.s.body); } catch (e) {} }
  return { profile, sessions };
}

// Cache de scraping par joueur : plusieurs spectateurs ne déclenchent qu'un
// seul appel tracker.gg, et les requêtes concurrentes sont mutualisées.
const PROFILE_TTL = 12 * 1000;
const profileCache = new Map(); // id → { at, data, inflight }

async function getPlayerData(player) {
  const now = Date.now();
  const c = profileCache.get(player.id);
  if (c && c.data && now - c.at < PROFILE_TTL) return c.data;
  if (c && c.inflight) return c.inflight;

  const inflight = (async () => {
    const data = await scrapeAll(player.platform, player.username);
    profileCache.set(player.id, { at: Date.now(), data, inflight: null });
    return data;
  })();
  profileCache.set(player.id, {
    at: c ? c.at : 0, data: c ? c.data : null, inflight,
  });
  try {
    return await inflight;
  } catch (e) {
    profileCache.set(player.id, {
      at: c ? c.at : 0, data: c ? c.data : null, inflight: null,
    });
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

// Un agent qui ne donne plus signe de vie passe « hors ligne » et ses
// spectateurs en sont notifiés.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of liveState) {
    if (s.connected && now - s.lastSeen > OFFLINE_MS) {
      s.connected = false;
      s.match = { active: false };
      sseBroadcast(id, 'connection', { connected: false });
      sseBroadcast(id, 'state', { active: false });
    }
  }
}, 10 * 1000);

// ───────── Flux temps réel vers les navigateurs (SSE), par joueur ─────────
const sseClients = new Map(); // id → Set<res>

function sseSend(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function sseBroadcast(id, event, data) {
  const set = sseClients.get(id);
  if (!set) return;
  for (const res of set) {
    try { sseSend(res, event, data); } catch (e) { set.delete(res); }
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

const EVENT_TYPES = new Set(['match-start', 'match-end', 'goal']);

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
    return { type: 'match-start' };
  }).filter(Boolean);
}

// ───────── Routes API ─────────

// Réception des stats d'un agent. Authentifié par token Bearer.
app.post('/api/ingest', ingestLimiter, (req, res) => {
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

  // Rediffusion immédiate vers les spectateurs de CE joueur.
  sseBroadcast(player.id, 'state', match.active ? match : { active: false });
  if (connected !== wasConnected) {
    sseBroadcast(player.id, 'connection', { connected });
  }
  for (const ev of events) {
    if (ev.type === 'goal') sseBroadcast(player.id, 'goal', ev);
    else if (ev.type === 'match-start') sseBroadcast(player.id, 'match', { phase: 'start' });
    else if (ev.type === 'match-end') sseBroadcast(player.id, 'ended', ev);
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
app.get('/api/player/:id/live', apiLimiter, async (req, res) => {
  const player = players.getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: 'unknown player' });
  try {
    const data = await getPlayerData(player);
    if (!data.profile) return res.status(502).json({ error: 'tracker.gg unavailable' });
    if (data.profile.errors) return res.status(404).json({ error: 'profile not found' });
    res.json({
      profile: data.profile,
      sessions: data.sessions,
      player: {
        id: player.id, name: player.name,
        platform: player.platform, username: player.username,
      },
      live: getLive(player.id),
    });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(502).json({ error: 'scraping failed' });
  }
});

// Flux SSE temps réel d'un joueur donné.
app.get('/api/stats/stream/:id', apiLimiter, (req, res) => {
  const player = players.getPlayer(req.params.id);
  if (!player) return res.status(404).end();

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

  // État courant immédiat.
  const l = getLive(player.id);
  sseSend(res, 'connection', { connected: l.connected });
  if (l.match && l.match.active) sseSend(res, 'state', l.match);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25 * 1000);

  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
  });
});

// ───────── Dashboard (SPA) ─────────
// `/` = accueil (liste des joueurs), `/u/:id` = dashboard d'un joueur.
app.get(['/', '/u/:id'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Repli SPA pour toute autre route.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });

app.listen(PORT, HOST, async () => {
  console.log(`\n  RL Session Tracker (multi-joueurs) — http://${HOST}:${PORT}`);
  console.log('  Joueurs configurés : ' + players.listPlayers().length);
  try {
    await getBrowser();
    console.log('  Chromium : prêt');
    getWarmPage()
      .then(() => console.log('  Page warm tracker.gg : prête\n'))
      .catch(() => console.log('  Page warm : sera réessayée à la 1re requête\n'));
  } catch (e) {
    console.log('  Chromium : échec -', e.message, '\n');
  }
});
