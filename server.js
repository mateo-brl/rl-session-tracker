require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const PLATFORM_MAP = {
  epic: 'epic',
  steam: 'steam',
  psn: 'psn',
  xbox: 'xbl',
};

// ───────── Headless browser singleton ─────────
let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });
  return browser;
}

// ───────── Warm page for fast username search ─────────
// The search endpoint needs Cloudflare clearance just like profiles. Opening
// a fresh page per keystroke would be far too slow, so we keep one page warm:
// loading a real profile once clears CF for api.tracker.gg, and the search
// fetches run inside that page to reuse its cookies.
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

// ───────── Username search across every platform ─────────
const SEARCH_PLATFORMS = ['epic', 'steam', 'psn', 'xbl'];
// tracker.gg slug → the platform id our frontend / live route expects.
const SLUG_TO_ID = { epic: 'epic', steam: 'steam', psn: 'psn', xbl: 'xbox', playstation: 'psn', xbox: 'xbox' };

// Fan out one search request per platform from inside the warm page.
// `blocked` flags a Cloudflare/non-JSON response so the caller can re-warm.
async function runSearch(query) {
  const page = await getWarmPage();
  return page.evaluate(async (q, plats) => {
    const items = [];
    let blocked = false;
    await Promise.all(plats.map(async (p) => {
      try {
        const resp = await fetch(
          'https://api.tracker.gg/api/v2/rocket-league/standard/search?platform=' +
          p + '&query=' + encodeURIComponent(q),
          { headers: { Accept: 'application/json' }, credentials: 'include' }
        );
        if (resp.status === 403 || resp.status === 429 || resp.status === 503) { blocked = true; return; }
        if (resp.status !== 200) return;
        if (!(resp.headers.get('content-type') || '').includes('json')) { blocked = true; return; }
        const data = await resp.json();
        if (data && Array.isArray(data.data)) data.data.forEach(it => items.push(it));
      } catch (e) { blocked = true; }
    }));
    return { items, blocked };
  }, query, SEARCH_PLATFORMS);
}

async function searchAllPlatforms(query) {
  let raw;
  try {
    raw = await runSearch(query);
  } catch (e) {
    // Page or browser died — rebuild it and try once more.
    await rewarmPage();
    raw = await runSearch(query);
  }
  // Empty results + a blocked signal usually means CF clearance lapsed.
  if (raw.blocked && raw.items.length === 0) {
    await rewarmPage();
    raw = await runSearch(query);
  }

  const seen = new Set();
  const results = [];
  for (const it of raw.items) {
    const platform = SLUG_TO_ID[it.platformSlug] || it.platformSlug;
    const identifier = it.platformUserIdentifier || it.platformUserId;
    if (!platform || !identifier) continue;
    const key = platform + ':' + identifier;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      platform,
      identifier: String(identifier),
      handle: it.platformUserHandle || String(identifier),
      avatar: it.avatarUrl || null,
    });
  }
  // Exact handle matches first, then a stable platform order.
  const lc = query.toLowerCase();
  const order = { epic: 0, steam: 1, psn: 2, xbox: 3 };
  results.sort((a, b) => {
    const ax = a.handle.toLowerCase() === lc ? 0 : 1;
    const bx = b.handle.toLowerCase() === lc ? 0 : 1;
    if (ax !== bx) return ax - bx;
    return (order[a.platform] ?? 9) - (order[b.platform] ?? 9);
  });
  return results.slice(0, 12);
}

// ───────── Fetch profile + sessions ─────────
// Both come straight from api.tracker.gg, fetched inside the warm page so its
// Cloudflare cookies are reused — no slow full-page navigation per request.
// This takes ~1-2s instead of ~20s for a full page load.
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
  // A blocked/empty profile response means Cloudflare clearance lapsed.
  if ([0, 403, 429, 503].includes(res.p.status)) {
    await rewarmPage();
    res = await fetchBoth();
  }

  let profile = null, sessions = null;
  try { profile = JSON.parse(res.p.body); } catch (e) {}
  if (res.s.status === 200) { try { sessions = JSON.parse(res.s.body); } catch (e) {} }
  return { profile, sessions };
}

// ───────── Routes ─────────

app.get('/api/config', (_req, res) => {
  res.json({ mode: 'headless' });
});

// Profile + sessions (initial search)
app.get('/api/live/:platform/:username', async (req, res) => {
  const { platform, username } = req.params;
  try {
    const data = await scrapeAll(platform, username);
    if (!data.profile) {
      return res.status(404).json({ error: 'Player not found' });
    }
    if (data.profile.errors) {
      return res.status(404).json({ error: data.profile.errors[0]?.message || 'Player not found' });
    }
    res.json(data);
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(502).json({ error: 'Scraping failed', detail: err.message });
  }
});

// Profile only (for polling)
app.get('/api/profile/:platform/:username', async (req, res) => {
  const { platform, username } = req.params;
  try {
    const data = await scrapeAll(platform, username);
    if (!data.profile) return res.status(502).json({ error: 'No response captured' });
    if (data.profile.errors) {
      return res.status(404).json({ error: data.profile.errors[0]?.message || 'Player not found' });
    }
    res.json(data.profile);
  } catch (err) {
    console.error('Profile scrape error:', err.message);
    res.status(502).json({ error: 'Scraping failed', detail: err.message });
  }
});

// Username search / autocomplete across all platforms
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 3 || q.length > 64) return res.json({ results: [] });
  try {
    const results = await searchAllPlatforms(q);
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(502).json({ error: 'Search failed', detail: err.message });
  }
});

// Fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });

app.listen(PORT, process.env.HOST || '127.0.0.1', async () => {
  console.log(`\n  RL Session Tracker running at http://localhost:${PORT}`);
  console.log('  Mode: headless Chromium + live sessions');
  try {
    await getBrowser();
    console.log('  Chromium: ready');
    // Warm the Cloudflare page up front so the first request is already fast.
    getWarmPage()
      .then(() => console.log('  Warm page: ready\n'))
      .catch(() => console.log('  Warm page: will retry on first request\n'));
  } catch (e) {
    console.log('  Chromium: failed -', e.message, '\n');
  }
});
