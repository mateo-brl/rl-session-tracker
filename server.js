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

// ───────── Scrape profile + sessions in one page load ─────────
// Navigate to the profile page, intercept the profile XHR,
// then fetch sessions from within the page context (reuses CF cookies).

async function scrapeAll(platform, username) {
  const b = await getBrowser();
  const page = await b.newPage();
  const plat = PLATFORM_MAP[platform] || platform;

  let profileData = null;

  // Intercept the profile API response
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('api.tracker.gg') &&
        url.includes('/profile/') &&
        !url.includes('/sessions') &&
        !url.includes('/mmr') &&
        !url.includes('/segments/') &&
        !url.includes('/interactions') &&
        !url.includes('/search')) {
      try {
        const text = await resp.text();
        profileData = { status: resp.status(), body: text };
      } catch (e) {}
    }
  });

  const profileUrl = `https://rocketleague.tracker.network/rocket-league/profile/${plat}/${encodeURIComponent(username)}/overview`;

  try {
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    if (!profileData) await new Promise(r => setTimeout(r, 3000));

    if (!profileData) {
      await page.close();
      return { profile: null, sessions: null };
    }

    // Now fetch sessions from within the browser (has Cloudflare cookies)
    const sessionsUrl = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/${plat}/${encodeURIComponent(username)}/sessions`;
    const sessionsResult = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          credentials: 'include',
        });
        const text = await resp.text();
        return { status: resp.status, body: text };
      } catch (e) {
        return { status: 0, body: e.message };
      }
    }, sessionsUrl);

    await page.close();

    // Parse results
    let profile = null, sessions = null;
    try { profile = JSON.parse(profileData.body); } catch (e) {}
    if (sessionsResult.status === 200) {
      try { sessions = JSON.parse(sessionsResult.body); } catch (e) {}
    }

    return { profile, sessions };
  } catch (err) {
    await page.close();
    throw err;
  }
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
    console.log('  Chromium: ready\n');
  } catch (e) {
    console.log('  Chromium: failed -', e.message, '\n');
  }
});
