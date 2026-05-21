// lib/tracker.js — Récupération des stats depuis api.tracker.gg.
//
// api.tracker.gg est protégé par Cloudflare, qui exige un cookie `cf_clearance`.
// Stratégie :
//   1. On récupère ce cookie UNE fois via un Chromium headless (page warm) ;
//   2. ensuite on interroge l'API directement depuis Node avec ce cookie —
//      ce qui permet un parallélisme illimité et supprime le goulot d'une
//      page Chromium unique (les `page.evaluate` étaient sérialisés) ;
//   3. si Cloudflare refuse la requête Node (empreinte TLS différente), on
//      bascule en repli sur un fetch exécuté DANS la page Chromium.
//
// Le navigateur ne sert donc qu'à (ré)obtenir le cookie et, rarement, de
// repli. Le chemin courant est un simple `fetch` Node, parallélisable.

const puppeteer = require('puppeteer-core');

const WARMUP_URL = 'https://rocketleague.tracker.network/rocket-league/profile/epic/FairyPeak/overview';
const API_ROOT = 'https://api.tracker.gg/api/v2/rocket-league/standard/profile';
const PROBE_URL = API_ROOT + '/epic/FairyPeak';
const PLATFORM_MAP = { epic: 'epic', steam: 'steam', psn: 'psn', xbox: 'xbl' };

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const FETCH_TIMEOUT = parseInt(process.env.SCRAPE_TIMEOUT || '9000', 10);
const BLOCKED = new Set([0, 403, 429, 503]);

let browser = null;
let warmPage = null;
let clearance = null;          // { cookieHeader, userAgent }
let browserOp = Promise.resolve(); // sérialise les opérations Chromium

// Sérialise tout ce qui touche au navigateur (warmup, repli in-page) pour
// éviter deux navigations concurrentes sur la même page.
function withBrowser(fn) {
  const run = browserOp.then(fn, fn);
  browserOp = run.then(() => {}, () => {});
  return run;
}

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions',
    ],
  });
  return browser;
}

// (Ré)ouvre la page warm et récupère le cookie Cloudflare d'api.tracker.gg.
async function harvest() {
  const b = await getBrowser();
  let page = warmPage;
  try {
    if (!page || page.isClosed()) page = await b.newPage();
  } catch (e) {
    page = await b.newPage();
  }
  try {
    await page.goto(WARMUP_URL, { waitUntil: 'networkidle2', timeout: 40000 });
    // Une requête vers api.tracker.gg depuis la page établit la clearance CF.
    await page.evaluate(async (u) => {
      try { await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' }); }
      catch (e) { /* ignore */ }
    }, PROBE_URL);
    const cookies = await page.cookies('https://api.tracker.gg');
    const cookieHeader = cookies.map((c) => c.name + '=' + c.value).join('; ');
    const userAgent = await b.userAgent();
    warmPage = page;
    clearance = { cookieHeader, userAgent };
    return clearance;
  } catch (e) {
    // Échec : on ferme la page pour ne pas fuiter un onglet Chromium.
    try { if (page && !page.isClosed()) await page.close(); } catch (x) {}
    if (warmPage === page) warmPage = null;
    throw e;
  }
}

async function ensureClearance() {
  if (clearance) return clearance;
  return withBrowser(() => (clearance || harvest()));
}

// Rafraîchit le cookie. `stale` = la clearance qu'on vient de voir échouer ;
// si un autre appel l'a déjà rafraîchie entre-temps, on réutilise la nouvelle.
async function reharvest(stale) {
  return withBrowser(() => {
    if (clearance && clearance !== stale) return clearance;
    clearance = null;
    return harvest();
  });
}

// Requête directe depuis Node (chemin rapide, parallélisable).
async function directFetch(url, cl) {
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': cl.userAgent,
      Cookie: cl.cookieHeader,
      Referer: 'https://rocketleague.tracker.network/',
      Origin: 'https://rocketleague.tracker.network',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  return { status: resp.status, body: await resp.text() };
}

// Repli : fetch exécuté dans la page Chromium (vraie empreinte navigateur).
async function pageFetch(url) {
  return withBrowser(async () => {
    let page = warmPage;
    if (!page || page.isClosed()) {
      await harvest();
      page = warmPage;
    }
    return page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    }, url);
  });
}

// Récupère une URL de l'API : direct d'abord, re-clearance puis repli si besoin.
async function apiGet(url) {
  let cl = await ensureClearance();
  try {
    let r = await directFetch(url, cl);
    if (!BLOCKED.has(r.status)) return r;
    // Clearance probablement périmée : on la rafraîchit et on réessaie.
    cl = await reharvest(cl);
    r = await directFetch(url, cl);
    if (!BLOCKED.has(r.status)) return r;
  } catch (e) {
    // Timeout / erreur réseau : on tentera le repli ci-dessous.
  }
  // Repli via la page Chromium.
  return pageFetch(url);
}

// ───────── API publique ─────────

// Récupère profil + sessions d'un joueur. Lève si la plateforme est inconnue.
async function scrapeProfile(platform, username) {
  const plat = PLATFORM_MAP[platform];
  if (!plat) throw new Error('plateforme inconnue : ' + platform);
  const user = encodeURIComponent(username);
  const profileUrl = API_ROOT + '/' + plat + '/' + user;
  const sessionsUrl = profileUrl + '/sessions';

  const [p, s] = await Promise.all([apiGet(profileUrl), apiGet(sessionsUrl)]);

  let profile = null;
  let sessions = null;
  try { profile = JSON.parse(p.body); } catch (e) { /* profil illisible */ }
  if (s.status === 200) {
    try { sessions = JSON.parse(s.body); } catch (e) { /* sessions illisibles */ }
  }
  return { profile, sessions };
}

// Prépare le navigateur + la clearance au démarrage du serveur.
async function warmup() {
  return ensureClearance();
}

async function close() {
  if (browser) {
    try { await browser.close(); } catch (e) { /* ignore */ }
    browser = null;
    warmPage = null;
    clearance = null;
  }
}

module.exports = { scrapeProfile, warmup, close, PLATFORM_MAP };
