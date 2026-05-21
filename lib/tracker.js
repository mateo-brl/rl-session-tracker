// lib/tracker.js — Récupération des stats depuis api.tracker.gg.
//
// api.tracker.gg est protégé par Cloudflare. Les tests ont montré qu'un
// `fetch` depuis Node — même muni du cookie cf_clearance — est refusé (403) :
// la protection s'appuie sur l'empreinte TLS/navigateur, pas seulement sur un
// cookie. La SEULE méthode fiable est donc le `fetch` exécuté DANS une page
// Chromium réelle.
//
// Pour ne pas sérialiser tout le trafic sur une page unique (les `evaluate`
// d'une même page sont séquentiels), on maintient un POOL de pages warm :
// chaque scrape prend une page libre → N scrapes tournent en parallèle.
//
// Le pool se remplit de façon PROGRESSIVE (utilisable dès la 1re page prête)
// et ses pages sont RECYCLÉES périodiquement (anti-dérive mémoire).

const puppeteer = require('puppeteer-core');

const WARMUP_URL = 'https://rocketleague.tracker.network/rocket-league/profile/epic/FairyPeak/overview';
const API_ROOT = 'https://api.tracker.gg/api/v2/rocket-league/standard/profile';
const PLATFORM_MAP = { epic: 'epic', steam: 'steam', psn: 'psn', xbox: 'xbl' };

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const POOL_SIZE = Math.max(1, parseInt(process.env.SCRAPE_POOL || '4', 10));
const FETCH_TIMEOUT = parseInt(process.env.SCRAPE_TIMEOUT || '15000', 10);
const RECYCLE_INTERVAL = parseInt(process.env.SCRAPE_RECYCLE_MS || '2700000', 10); // 45 min
const DEBUG = process.env.SCRAPE_DEBUG === '1';
const BLOCKED = new Set([0, 403, 429, 503]);

let browser = null;
let pool = [];          // [{ page, busy }]
const waiters = [];     // resolveurs en attente d'un slot libre
let initPromise = null;
let recycleTimer = null;

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

// Crée une page « warm » : charger un profil tracker.network lève la
// protection Cloudflare pour le contexte de cette page ; ses fetch internes
// vers api.tracker.gg réutilisent ensuite cookies et empreinte.
async function makeWarmPage(b) {
  const page = await b.newPage();
  try {
    await page.goto(WARMUP_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    return page;
  } catch (e) {
    try { await page.close(); } catch (x) {}
    throw e;
  }
}

// Réveille les appelants en attente dès qu'un slot se libère.
function flushWaiters() {
  while (waiters.length > 0) {
    const free = pool.find((s) => !s.busy);
    if (!free) break;
    free.busy = true;
    waiters.shift()(free);
  }
}

async function doInit() {
  const b = await getBrowser();
  let firstResolve;
  const firstReady = new Promise((r) => { firstResolve = r; });
  let settled = 0;

  // Warmup des N pages EN PARALLÈLE. Chaque page rejoint le pool dès qu'elle
  // est prête (warmup PROGRESSIF) : le 1er scrape n'attend pas les N pages.
  for (let i = 0; i < POOL_SIZE; i++) {
    makeWarmPage(b)
      .then((page) => {
        pool.push({ page, busy: false });
        flushWaiters();
      })
      .catch((e) => { if (DEBUG) console.log('[tracker] warmup page échouée:', e.message); })
      .finally(() => {
        settled++;
        // Débloque dès qu'une page est prête, ou quand tout a été tenté.
        if (pool.length > 0 || settled === POOL_SIZE) firstResolve();
      });
  }

  await firstReady;
  if (pool.length === 0) throw new Error("aucune page tracker.gg n'a pu être préparée");
  startRecycler();
}

async function init() {
  if (pool.length > 0) return;
  if (!initPromise) {
    initPromise = doInit().catch((e) => { initPromise = null; throw e; });
  }
  return initPromise;
}

// Recyclage : recharge périodiquement une page inactive pour éviter la dérive
// mémoire de Chromium sur les serveurs qui tournent des jours d'affilée.
function startRecycler() {
  if (recycleTimer) return;
  recycleTimer = setInterval(async () => {
    const slot = pool.find((s) => !s.busy);
    if (!slot) return;                 // tout occupé : on réessaiera plus tard
    slot.busy = true;                  // réservé le temps du rechargement
    try { await rewarm(slot); }
    catch (e) { if (DEBUG) console.log('[tracker] recyclage échoué:', e.message); }
    finally { release(slot); }
  }, RECYCLE_INTERVAL);
  if (recycleTimer.unref) recycleTimer.unref();
}

// Acquiert un slot libre du pool (attend si tout est occupé).
function acquire() {
  return new Promise((resolve) => {
    const free = pool.find((s) => !s.busy);
    if (free) { free.busy = true; resolve(free); }
    else waiters.push(resolve);
  });
}

function release(slot) {
  const next = waiters.shift();
  if (next) next(slot);      // le slot reste occupé, passe directement au suivant
  else slot.busy = false;
}

// Recharge la page d'un slot (Cloudflare périmé, page morte, recyclage).
async function rewarm(slot) {
  try { if (slot.page && !slot.page.isClosed()) await slot.page.close(); }
  catch (e) { /* ignore */ }
  slot.page = await makeWarmPage(await getBrowser());
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'opération') + ' : délai dépassé')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Récupère profil + sessions DANS la page (le fetch hérite des cookies et de
// l'empreinte du vrai navigateur — seul moyen de passer Cloudflare).
async function fetchInPage(page, urls) {
  return page.evaluate(async (list) => {
    async function get(u) {
      try {
        // cache: 'no-store' — on évite le cache HTTP du navigateur : c'est le
        // cache serveur (TTL maîtrisé) qui doit faire autorité sur la fraîcheur.
        const r = await fetch(u, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
          cache: 'no-store',
        });
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    }
    return Promise.all(list.map(get));
  }, urls);
}

// ───────── API publique ─────────

// Récupère profil + sessions d'un joueur. Lève si la plateforme est inconnue.
async function scrapeProfile(platform, username) {
  const plat = PLATFORM_MAP[platform];
  if (!plat) throw new Error('plateforme inconnue : ' + platform);
  await init();

  const user = encodeURIComponent(username);
  const profileUrl = API_ROOT + '/' + plat + '/' + user;
  const sessionsUrl = profileUrl + '/sessions';

  const slot = await acquire();
  try {
    let res = await withTimeout(
      fetchInPage(slot.page, [profileUrl, sessionsUrl]), FETCH_TIMEOUT, 'scrape');
    // Cloudflare périmé sur cette page → on la recharge et on réessaie 1×.
    if (BLOCKED.has(res[0].status)) {
      await rewarm(slot);
      res = await withTimeout(
        fetchInPage(slot.page, [profileUrl, sessionsUrl]), FETCH_TIMEOUT, 'scrape');
    }
    let profile = null;
    let sessions = null;
    try { profile = JSON.parse(res[0].body); } catch (e) { /* profil illisible */ }
    if (res[1].status === 200) {
      try { sessions = JSON.parse(res[1].body); } catch (e) { /* sessions illisibles */ }
    }
    return { profile, sessions };
  } catch (e) {
    // La page est peut-être morte : on tente de la recharger pour la suite.
    try { await rewarm(slot); } catch (x) { /* ignore */ }
    throw e;
  } finally {
    release(slot);
  }
}

// Prépare le navigateur + le pool de pages au démarrage du serveur.
async function warmup() {
  return init();
}

async function close() {
  if (recycleTimer) { clearInterval(recycleTimer); recycleTimer = null; }
  pool = [];
  waiters.length = 0;
  initPromise = null;
  if (browser) {
    try { await browser.close(); } catch (e) { /* ignore */ }
    browser = null;
  }
}

module.exports = { scrapeProfile, warmup, close, PLATFORM_MAP };
