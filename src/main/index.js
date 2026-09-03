// index.js — Processus principal de RL Session Tracker.
//
// L'application est 100 % locale : pas de serveur, pas de compte. Elle :
//  • démarre avec Windows et vit dans la barre des tâches ;
//  • surveille Rocket League (processus + Stats API du jeu) ;
//  • ouvre automatiquement le dashboard en plein écran sur le 2ᵉ écran
//    quand le jeu se lance, et le ferme quand le jeu se ferme ;
//  • enregistre chaque match (victoires/défaites, série, stats par mode) ;
//  • se met à jour toute seule depuis les releases GitHub (sur accord).

const { app, Tray, Menu, ipcMain, shell, dialog, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const windows = require('./windows');
const updater = require('./updater');
const discord = require('./discord-rpc');
const obs = require('./obs-server');
const sos = require('./sos-bridge');
const SessionStore = require('./session');
const { MMR_STEP_MIN, MMR_STEP_MAX } = SessionStore;
const GameWatcher = require('./game-watcher');
const RLStatsAPI = require('./statsapi');
const RLLogReader = require('./rl-log');
const Cosmetics = require('./cosmetics');
const { enableStatsApi, checkStatsApi, detectInstalls, iniRate, ALPHA_RATE } = require('./enable-statsapi');

const SILENT = process.argv.includes('--silent');   // lancé par le démarrage auto
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');
const LOG_FILE = path.join(app.getPath('userData'), 'app.log');

// ───────── Journal fichier (l'application n'a pas de console) ─────────
function log(msg) {
  try {
    let flag = 'a';
    try { if (fs.statSync(LOG_FILE).size > 262144) flag = 'w'; } catch (e) {}
    fs.writeFileSync(LOG_FILE,
      '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: flag });
  } catch (e) {}
}
process.on('uncaughtException', (e) => log('uncaughtException : ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection : ' + (e && (e.message || e))));

// ───────── État partagé, poussé aux fenêtres ─────────
let store = null;
let tray = null;
let cosmetics = null;   // swaps cosmétiques (seul module qui touche aux fichiers du jeu)

const state = {
  version: app.getVersion(),
  firstRun: false,
  lang: 'fr',            // langue résolue (réglage, sinon langue du système)
  config: null,
  autostart: false,
  game: { processRunning: false, statsConnected: false, running: false, since: 0,
    statsApiBroken: false },   // ini réinitialisé par une màj / vérif Steam
  live: null,            // match en cours (snapshot Stats API), ou null
  currentRanked: null,   // le match en cours est-il classé ? (null = pas de match)
  currentRankedAuto: null,  // déduit de la playlist du journal ? (null = préférence)
  queue: null,           // dernière mise en file relevée dans le journal
  currentMatchmade: null,// match en cours issu d'une file ? null = indéterminable
  queueUsed: null,       // identité de la file déjà consommée par un match
  session: null,         // agrégats de session
  history: [],
  playersSeen: [],
  pseudoCandidates: [],  // si le pseudo n'a pas pu être deviné tout seul
  evolution: {},         // courbes MMR par mode calibré
  mmrLog: null,          // dernier vrai MMR lu dans le journal du jeu
  week: null,            // bilan des 7 derniers jours
  records: null,         // records de tous les temps
  h2h: null,             // « déjà croisé » : bilan contre les adversaires du match en cours
  obs: { running: false, port: 0, error: null },   // serveur overlay OBS
  sos: { running: false, port: 0, clients: 0 },    // pont compatible SOS
  hotkey: { accel: 'Ctrl+Alt+R', ok: false },      // raccourci global de la fenêtre
  cosmetics: { count: 0, applied: 0, reverted: 0, gameRunning: false },
  update: updater.getState(),
};

// ── Mode streamer : extrait de l'état envoyé à la page overlay OBS ──
function obsState() {
  const cfg = config.get();
  return {
    lang: state.lang,
    theme: cfg.theme,
    obsCfg: cfg.obs,             // style, échelle, contenu — appliqués en direct
    game: state.game.running,
    live: state.live,
    currentRanked: state.currentRanked,
    currentRankedAuto: state.currentRankedAuto,
    session: state.session,
    h2h: state.h2h,
    // L'overlay composable est la même page que le dashboard : il lui faut
    // donc de quoi nourrir TOUS les blocs, pas seulement le bandeau de score.
    // Rien de personnel n'y transite de plus que ce que la page affiche déjà,
    // et le serveur n'écoute que sur 127.0.0.1.
    history: state.history,
    evolution: state.evolution,
    week: state.week,
    records: state.records,
    config: {
      pseudo: cfg.pseudo, lang: cfg.lang, theme: cfg.theme, skin: cfg.skin,
      obsLayout: cfg.obsLayout, mmr: cfg.mmr, mmrStep: cfg.mmrStep,
      rankedOnly: cfg.rankedOnly, sessionGoal: cfg.sessionGoal, anim: cfg.anim,
    },
  };
}

function applyObsConfig() {
  const o = config.get().obs || {};
  if (o.enabled) {
    obs.start(o.port, log, (st) => { state.obs = st; pushState(); });
  } else if (obs.running()) {
    obs.stop();
  }
  applySosConfig();
}

// Pont compatible SOS : rend le flux du jeu lisible par tous les overlays de
// diffusion écrits pour le défunt plugin SOS, qui ne fonctionne plus en ligne
// depuis l'arrivée d'Easy Anti-Cheat.
function applySosConfig() {
  const o = config.get().obs || {};
  if (o.sosBridge) sos.start(o.sosPort, log);
  else sos.stop();
  state.sos = sos.status();
}

// ── Head-to-head : recalculé uniquement quand la liste d'adversaires change ──
let h2hKey = '';
function refreshH2h() {
  const live = state.live;
  const pseudo = (config.get().pseudo || '').trim().toLowerCase();
  if (!live || live.training || !pseudo || !Array.isArray(live.players)) {
    state.h2h = null;
    h2hKey = '';
    return;
  }
  const mine = live.players.find((p) => String(p.name).trim().toLowerCase() === pseudo);
  if (!mine) { state.h2h = null; h2hKey = ''; return; }
  const opponents = live.players.filter((p) => p.team !== mine.team).map((p) => p.name);
  const key = opponents.slice().sort().join('|');
  if (key === h2hKey) return;
  h2hKey = key;
  const all = store.headToHead(opponents, config.get().pseudo);
  // Sans prototype : les clés sont des pseudos adverses arbitraires (un joueur
  // nommé « constructor » ou « __proto__ » corrompait l'objet envoyé aux
  // fenêtres).
  const seen = Object.create(null);
  for (const name of Object.keys(all)) {
    if (all[name].played > 0) seen[name] = all[name];
  }
  state.h2h = Object.keys(seen).length ? seen : null;
}

// Le pseudo est configuré mais ne correspond à personne (changement de nom en
// jeu, espace insécable, variante unicode) : les matchs ne comptent ni
// victoire ni défaite. On propose alors les candidats détectés, sinon
// l'utilisateur lit « vérifie ton pseudo » sans savoir par quoi le remplacer.
function refreshPseudoCandidates() {
  if (!config.get().pseudo) return;          // déjà géré par la détection auto
  const unmatched = (state.session && state.session.unmatched) || 0;
  if (!unmatched) { state.pseudoCandidates = []; return; }
  try {
    const d = store.detectPseudo();
    const me = String(config.get().pseudo).trim().toLowerCase();
    state.pseudoCandidates = d.candidates
      .filter((n) => String(n).trim().toLowerCase() !== me);
  } catch (e) { state.pseudoCandidates = []; }
}

function refreshSession() {
  const snap = store.snapshot(config.get().pseudo, config.get());
  state.session = snap.session;
  state.history = snap.history;
  state.playersSeen = snap.playersSeen;
  state.evolution = snap.evolution;
  state.week = snap.week;
  state.records = snap.records;
  refreshPseudoCandidates();
}

function resolveLang() {
  const l = config.get().lang;
  if (l === 'fr' || l === 'en') return l;
  try {
    return String(app.getLocale()).toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch (e) { return 'fr'; }
}

function pushState() {
  state.config = config.get();
  state.lang = resolveLang();
  state.sos = sos.status();   // le serveur démarre en asynchrone : on relit
  refreshCosmetics();

  refreshH2h();
  discord.refresh(state);
  windows.broadcast('state', state);
  obs.broadcast(obsState());
}

// ───────── Démarrage automatique avec Windows ─────────
// IMPORTANT : sous Windows, getLoginItemSettings ne reconnaît l'entrée que si
// on lui passe les MÊMES args que ceux donnés à setLoginItemSettings — sans
// ça il répond toujours « désactivé » et la case se décoche toute seule.
const AUTOSTART_ARGS = ['--silent'];
function autostartEnabled() {
  try {
    return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin;
  } catch (e) { return false; }
}
function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: AUTOSTART_ARGS });
    state.autostart = autostartEnabled();
    log('démarrage auto : ' + (on ? 'activé' : 'désactivé'));
  } catch (e) {
    log('démarrage auto échec : ' + e.message);
  }
}

// ───────── Dashboard auto sur le 2ᵉ écran ─────────
function setGameRunning(running) {
  if (state.game.running === running) return;
  state.game.running = running;
  state.game.since = running ? Date.now() : 0;
  log('Rocket League : ' + (running ? 'détecté' : 'fermé'));
  if (running) {
    // Le tracker démarre avec Windows et vit des jours : la vérification du
    // lancement date alors du login, et la suivante peut être à 4 h. Lancer le
    // jeu est LE moment où l'on regarde l'application — c'est donc là qu'une
    // mise à jour doit être proposée, pas au petit bonheur du minuteur.
    updater.check();
    if (config.get().autoDashboard) openDashboard();
    if (config.get().overlayEnabled) openOverlay();
    if (alphaEnabled()) openAlphaAudio();
  } else {
    state.live = null;
    state.currentRanked = null;
    state.currentRankedAuto = null;
    windows.closeDashboard();
    windows.closeOverlay();
    windows.closeAlphaAudio();
  }
  pushState();
}

// Débit de la Stats API suffisant pour le son Alpha Boost (120/s).
async function ensureAlphaRate() {
  if (process.platform !== 'win32') return;
  let low = [];
  try { low = checkStatsApi(config.get().statsApiPort).installs
    .filter((p) => iniRate(p) < ALPHA_RATE); } catch (e) { return; }
  if (!low.length) return;
  log('Alpha Boost : débit Stats API insuffisant dans ' + JSON.stringify(low) + ' — réécriture à ' + ALPHA_RATE + '/s');
  let r;
  try { r = await enableStatsApi(config.get().statsApiPort); } catch (e) { r = { ok: false, reason: e.message }; }
  logStatsApiResult(r);
  refreshStatsApiFlag();
  pushState();
}

// ───────── Son Alpha Boost ─────────
// Joué par une fenêtre invisible (WebAudio), pilotée par la télémétrie de la
// Stats API. 100 % externe : on ne touche ni aux fichiers ni à la mémoire du
// jeu — même approche que le reste de l'application.
function alphaEnabled() {
  const ab = config.get().alphaBoost;
  return !!(ab && ab.enabled);
}

function sendAlphaCfg() {
  const w = windows.getAlphaAudio();
  if (w) {
    try { w.webContents.send('alpha-cfg', config.get().alphaBoost); } catch (e) {}
  }
}

function openAlphaAudio() {
  windows.openAlphaAudio(() => sendAlphaCfg());
}

function openOverlay() {
  windows.openOverlay(config.get().overlayPos,
    (pos) => config.update({ overlayPos: pos }),
    config.get().overlayCfg);
}

function recomputeRunning() {
  setGameRunning(state.game.processRunning || state.game.statsConnected);
  pushState();
}

function openDashboard() {
  windows.openDashboard(
    { fullscreen: config.get().dashboardFullscreen },
    () => pushState());
}

// ───────── Barre des tâches ─────────
const TRAY_LABELS = {
  fr: { open: 'Ouvrir', dash: 'Ouvrir le dashboard', overlay: 'Mini-overlay',
    update: 'Vérifier les mises à jour', quit: 'Quitter' },
  en: { open: 'Open', dash: 'Open the dashboard', overlay: 'Mini-overlay',
    update: 'Check for updates', quit: 'Quit' },
};

function buildTrayMenu() {
  if (!tray) return;
  const L = TRAY_LABELS[resolveLang()] || TRAY_LABELS.fr;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L.open, click: () => windows.showControl() },
    { label: L.dash, click: () => openDashboard() },
    { label: L.overlay, click: () => {
      if (windows.getOverlay()) {
        config.update({ overlayEnabled: false });
        windows.closeOverlay();
      } else {
        config.update({ overlayEnabled: true });
        openOverlay();
      }
      pushState();
    } },
    { type: 'separator' },
    { label: L.update, click: () => updater.check() },
    { type: 'separator' },
    { label: L.quit, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  try {
    tray = new Tray(ICON);
  } catch (e) {
    log('icône systray indisponible : ' + e.message);
    return;
  }
  tray.setToolTip('RL Session Tracker');
  buildTrayMenu();
  tray.on('click', () => windows.showControl());
  tray.on('double-click', () => windows.showControl());
}

// ───────── Stats API du jeu ─────────
// Entraînement / piste libre : le joueur est seul dans la « partie ». Un vrai
// match a toujours au moins 2 joueurs — en dessous, on affiche « entraînement »
// et on ne compte RIEN (ni buts, ni résultat).
function isTraining(d) {
  return !Array.isArray(d.players) || d.players.length < 2;
}

function startStatsApi() {
  // Le port est passé au constructeur : le poser dans process.env ne servait
  // à rien, la constante du module ayant déjà été évaluée au `require`.
  const api = new RLStatsAPI({ port: config.get().statsApiPort });
  let lastRecordedAt = 0;   // ceinture anti-doublon (fin de match + abandon)
  let matchSinceRecord = false;   // un NOUVEAU match a-t-il démarré depuis ?

  api.on('connection', (d) => {
    state.game.statsConnected = d.connected;
    // Socket coupé : le connecteur a jeté son match, mais l'état affiché
    // resterait figé sur le dernier score (le jeu tourne toujours, donc rien
    // ne le remet à zéro). Pire, `currentRanked` non nul faisait sauter la
    // détection classé/casual du match SUIVANT, qui héritait du verdict
    // précédent.
    if (!d.connected) {
      state.live = null;
      state.currentRanked = null;
      state.currentRankedAuto = null;
    }
    recomputeRunning();
  });
  api.on('state', (d) => {
    sos.send('state', d);
    state.live = d && d.active ? { ...d, training: isTraining(d) } : null;
    // Nouveau match : classé ou casual ? Pré-réglé sur la préférence, et
    // modifiable d'un clic sur le dashboard pendant la partie.
    if (state.live && !state.live.training && state.currentRanked === null) {
      const r = resolveRanked();
      state.currentRanked = r.ranked;
      state.currentRankedAuto = r.auto;
      state.currentMatchmade = resolveMatchmade();
      if (state.currentMatchmade === false) {
        log('match hors file (privé ou exhibition) — il ne sera pas compté');
      }
    }
    pushState();
  });
  api.on('match', (d) => {
    sos.send(d.phase, {});
    if (d.phase === 'start') matchSinceRecord = true;
    if (d.phase === 'destroyed') {
      state.live = null;
      state.currentRanked = null;
      state.currentRankedAuto = null;
      state.currentMatchmade = null;
      pushState();
    }
  });
  // Abandon (forfait, départ en cours de match, déconnexion). En CLASSÉ, le
  // jeu compte une défaite — nous aussi. En casual, quitter est normal : on
  // ignore le match.
  api.on('abandoned', (snap) => {
    state.live = null;
    const ranked = state.currentRanked !== null
      ? state.currentRanked : resolveRanked().ranked;
    state.currentRanked = null;
    state.currentRankedAuto = null;
    // Le podium avait été atteint : le match s'est terminé pour de bon (c'est
    // typiquement un forfait ADVERSE) et notre départ n'était qu'une sortie
    // d'écran de fin. Un vrai résultat, à compter même en casual — alors que
    // quitter une partie en cours ne se compte qu'en classé.
    const realEnd = !!snap.podium || snap.winnerTeam === 0 || snap.winnerTeam === 1;
    if (isTraining(snap) || (!ranked && !realEnd) || !countsAsMatch('abandon')) {
      state.currentMatchmade = null;
      pushState();
      if (isTraining(snap) || !ranked) log('abandon casual / entraînement — non compté');
      return;
    }
    // Un match vient d'être enregistré et AUCUN nouveau match n'a commencé
    // depuis ? Cet « abandon » n'est que la fin d'écran du même match (FF) :
    // on ne compte pas deux fois. Le seuil de 45 s seul était aveugle — il
    // avalait l'abandon d'un match suivant quand on se remettait en file tout
    // de suite.
    if (!matchSinceRecord && Date.now() - lastRecordedAt < 45 * 1000) {
      pushState();
      log('abandon ignoré — fin d’écran du match déjà enregistré');
      return;
    }
    lastRecordedAt = Date.now();
    matchSinceRecord = false;
    state.currentMatchmade = null;
    snap.ranked = ranked;
    // Doublon écarté (même MatchGuid) : history[0] serait le match PRÉCÉDENT,
    // et on rejouerait sa bannière et son jingle.
    const added = store.addMatch(snap);
    refreshSession();
    pushState();
    const last = added ? state.history[0] : null;
    if (last) { windows.broadcast('match-result', last); obs.emit('result', last); }
    sos.send('ended', snap);
    if (!added) { log('abandon ignoré — déjà au journal (MatchGuid)'); return; }
    log('abandon enregistré : ' + (snap.mode || '?')
      + ' — résultat ' + ((last && last.result) || '?')
      + (snap.podium ? ' (podium atteint)' : ''));
  });
  // Télémétrie boost → moteur audio Alpha Boost (fenêtre invisible).
  api.on('telemetry', (d) => {
    const w = windows.getAlphaAudio();
    if (w) {
      try { w.webContents.send('alpha-telemetry', d); } catch (e) {}
    }
  });
  api.on('podium', (d) => sos.send('podium', d));
  api.on('goal', (d) => {
    if (state.live && state.live.training) return;
    windows.broadcast('goal', d);
    obs.emit('goal', d);
    sos.send('goal', d);
  });
  api.on('ended', (snap) => {
    state.live = null;
    if (isTraining(snap) || !countsAsMatch('fin de match')) {
      state.currentRanked = null;
      state.currentRankedAuto = null;
      state.currentMatchmade = null;
      pushState();
      if (isTraining(snap)) log('entraînement terminé — non compté');
      return;
    }
    snap.ranked = state.currentRanked !== null
      ? state.currentRanked : resolveRanked().ranked;
    state.currentRanked = null;
    state.currentRankedAuto = null;
    state.currentMatchmade = null;
    lastRecordedAt = Date.now();
    matchSinceRecord = false;
    const added = store.addMatch(snap);
    // Pseudo pas encore configuré : on le devine (joueur présent dans tous
    // les derniers matchs). Zéro saisie pour l'utilisateur dans le cas normal.
    if (!config.get().pseudo) {
      const d = store.detectPseudo();
      state.pseudoCandidates = d.candidates;
      if (d.auto) {
        config.update({ pseudo: d.auto });
        log('pseudo détecté automatiquement : ' + d.auto);
      }
    } else {
      state.pseudoCandidates = [];
    }
    refreshPseudoCandidates();
    refreshSession();
    pushState();
    // Animation victoire / défaite sur le dashboard : le match qu'on vient
    // d'enregistrer est le premier de l'historique, déjà évalué (W/L, MVP).
    const last = added ? state.history[0] : null;
    if (last) { windows.broadcast('match-result', last); obs.emit('result', last); }
    sos.send('ended', snap);
    if (!added) { log('match ignoré — déjà au journal (MatchGuid)'); return; }
    log('match enregistré : ' + (snap.mode || '?') + ' '
      + (Array.isArray(snap.score) ? snap.score.join('-') : '?'));
  });
  api.start();
}

// ───────── Vrai MMR, lu dans le journal du jeu ─────────
// Le relevé du journal est la VÉRITÉ : on s'en sert comme nouvelle base de
// calibrage, horodatée au moment de la mise en file. Les matchs joués APRÈS
// ce relevé continuent d'être estimés à ±9 (session.js ne compte que les
// matchs postérieurs à `setAt`) — la dérive est donc remise à zéro à chaque
// file au lieu de s'accumuler indéfiniment.
let logReader = null;

// Le match en cours est-il classé ? La playlist relevée au moment de la mise
// en file fait autorité ; à défaut (pas chef de groupe, journal illisible,
// playlist inconnue), on retombe sur la préférence de l'utilisateur.
const QUEUE_FRESH_MS = 30 * 60 * 1000;

// Un match privé (ou une exhibition) ne passe par aucune file : le journal ne
// contient pas de ligne StartMatchmaking pour lui. Une mise en file ne vaut
// donc que pour UN match — sinon le match privé joué juste après une partie
// classée héritait de sa file, était compté, et son effectif de deux joueurs
// le faisait passer pour un 1v1.
// Renvoie null quand on ne peut pas savoir (journal désactivé, hors Windows,
// aucune file jamais vue) : dans le doute, on compte, comme avant.
function resolveMatchmade() {
  if (config.get().mmrFromLog === false || !logReader) return null;
  let q = null;
  try { q = logReader.refreshQueue(); } catch (e) { q = null; }
  if (!q || !q.at) return state.queueUsed ? false : null;
  const key = q.playlist + '@' + q.at;
  if (key === state.queueUsed) return false;      // file déjà consommée
  if (Date.now() - q.at > QUEUE_FRESH_MS) return false;
  state.queueUsed = key;
  return true;
}

// Un match hors file compte-t-il ? Non par défaut : c'est ce que l'utilisateur
// attend d'un match privé entre amis.
function countsAsMatch(where) {
  if (state.currentMatchmade !== false || config.get().countPrivate) return true;
  log(where + ' — match hors file, non compté');
  return false;
}
function resolveRanked() {
  const pref = config.get().mmrCounts !== false;
  if (config.get().mmrFromLog === false || !logReader) return { ranked: pref, auto: null };
  let q = null;
  try { q = logReader.refreshQueue(); } catch (e) { q = null; }
  if (!q || !q.known || Date.now() - q.at > QUEUE_FRESH_MS) return { ranked: pref, auto: null };
  return { ranked: q.ranked, auto: q.ranked };
}

// Apprend le VRAI pas MMR du joueur en comparant deux relevés successifs du
// journal : la variation réelle de MMR, divisée par le nombre de victoires
// nettes jouées entre les deux. Les gains varient (~6 à 12 selon l'écart de
// MMR), donc la moyenne figée à 9 introduisait une erreur systématique entre
// deux recalages. Lissé de moitié pour ne pas suivre le bruit d'un seul écart.
function learnMmrStep(reading, previous) {
  if (!previous || !previous.fromLog || !Number.isFinite(previous.base)) return;
  const d = store.decidedBetween(reading.mode, previous.setAt, Date.now(),
    config.get().pseudo);
  if (!d.net) return;                      // autant de victoires que de défaites
  // Un match non attribué (pseudo qui ne correspond pas) est absent de `net`
  // alors qu'il a bel et bien bougé le MMR : le pas déduit serait gonflé.
  if (d.unmatched) return;
  const delta = reading.mmr - previous.base;
  // Le signe doit concorder : gagner net tout en PERDANT du MMR (ou l'inverse)
  // signale des données contradictoires — relevé manqué, playlist mal
  // attribuée, parties jouées sur un autre compte. On n'apprend rien de ça.
  if (Math.sign(delta) !== Math.sign(d.net)) return;
  const observed = Math.abs(delta / d.net);
  if (!Number.isFinite(observed) || observed < MMR_STEP_MIN || observed > MMR_STEP_MAX) return;
  const steps = { ...(config.get().mmrStep || {}) };
  const prev = Number(steps[reading.mode]);
  steps[reading.mode] = Number.isFinite(prev)
    ? Math.round(((prev + observed) / 2) * 10) / 10
    : Math.round(observed * 10) / 10;
  config.update({ mmrStep: steps });
  log('pas MMR appris pour ' + reading.mode + ' : ' + steps[reading.mode]
    + ' (observé ' + observed.toFixed(1) + ' sur ' + d.net + ' victoire(s) nette(s))');
}

function startMmrFromLog() {
  const reader = logReader = new RLLogReader();
  reader.on('queue', (q) => {
    state.queue = q;
    pushState();
    log('mise en file détectée : playlist ' + q.playlist
      + (q.known ? ' (' + (q.ranked ? 'classé ' + q.mode : 'casual') + ')' : ' (inconnue)'));
  });
  reader.on('mmr', (r) => {
    if (config.get().mmrFromLog === false) return;
    const cur = (config.get().mmr || {})[r.mode];
    if (cur && cur.base === r.mmr && cur.fromLog) return;   // déjà calé là-dessus
    learnMmrStep(r, cur);
    // Réconciliation AVANT d'ancrer : le relevé qui arrive est la vérité, et
    // c'est en le comparant au bilan enregistré depuis l'ancre PRÉCÉDENTE
    // qu'un forfait mal compté se trahit (écart de deux pas exactement).
    const prevAnchor = store.lastReading(r.mode);
    if (prevAnchor) {
      const learned = (config.get().mmrStep || {})[r.mode];
      const step = (Number.isFinite(learned)
        && learned >= MMR_STEP_MIN && learned <= MMR_STEP_MAX)
        ? learned : SessionStore.MMR_STEP;
      const fixed = store.reconcileForfeits(r.mode, prevAnchor, Date.now(),
        r.mmr, step, config.get().pseudo);
      if (fixed) {
        log('forfait réconcilié par le vrai MMR : match ' + fixed.id
          + ' recompté ' + (fixed.flipped === 'W' ? 'victoire' : 'défaite'));
      }
    }
    // L'ancre est archivée dans le journal : c'est elle qui porte la courbe.
    // La base de configuration ne sert plus qu'au cas « aucun relevé ».
    store.addMmrReading(r.mode, r.mmr, r.tier);
    config.update({ mmrSet: { mode: r.mode, value: r.mmr, fromLog: true } });
    state.mmrLog = { mode: r.mode, mmr: r.mmr, tier: r.tier, at: Date.now() };
    refreshSession();
    pushState();
    log('MMR relevé dans le journal du jeu : ' + r.mode + ' = ' + r.mmr
      + (r.tier ? ' (palier ' + r.tier + ')' : ''));
  });
  reader.start();
}

// Journalise le détail d'une activation de la Stats API (diagnostic).
function logStatsApiResult(r) {
  if (!r) { log('Stats API : résultat vide'); return; }
  if (r.skipped) { log('Stats API : ignorée (' + (r.reason || '') + ')'); return; }
  log('Stats API : détectées=' + JSON.stringify(r.installs || [])
    + ' configurées=' + JSON.stringify(r.configured || null)
    + (r.ok ? '' : ' ÉCHEC : ' + (r.reason || '?')));
}

// ───────── Réparation automatique de la Stats API ─────────
// Steam (vérification d'intégrité, grosses mises à jour) et la réparation
// Epic réinitialisent DefaultStatsAPI.ini — jusqu'ici le tracker mourait en
// silence et il fallait penser à cliquer « Réactiver ». Désormais : lecture
// de l'ini (sans élévation) à chaque lancement, et réactivation automatique
// (une invite UAC) uniquement si la panne est avérée.
let repairing = false;
// Une réparation demande une élévation (UAC) tant que l'ACL n'est pas posée.
// Si l'utilisateur refuse — ou n'est pas administrateur — réessayer sans fin
// lui collerait une invite toutes les 10 minutes pendant des jours. On borne
// donc les tentatives automatiques ; le bouton « Réactiver » reste toujours
// disponible, et le compteur repart à chaque réparation réussie.
const MAX_AUTO_REPAIRS = 3;
let autoRepairFails = 0;
async function repairStatsApiIfNeeded(origin) {
  if (repairing) return;            // une invite UAC à la fois
  if (autoRepairFails >= MAX_AUTO_REPAIRS) return;
  let check;
  try { check = checkStatsApi(config.get().statsApiPort); } catch (e) { return; }
  if (!check.installs.length || !check.broken.length) {
    if (state.game.statsApiBroken) { state.game.statsApiBroken = false; pushState(); }
    return;
  }
  log('Stats API coupée dans ' + JSON.stringify(check.broken) + ' (' + origin
    + ') — ini réinitialisé par une mise à jour / vérification du jeu, réactivation…');
  state.game.statsApiBroken = true;
  pushState();
  repairing = true;
  let r;
  try { r = await enableStatsApi(config.get().statsApiPort); }
  catch (e) { r = { ok: false, reason: e.message }; }
  finally { repairing = false; }
  logStatsApiResult(r);
  // On RELIT l'ini au lieu de croire le script sur parole : il rendait « ok »
  // dès qu'UNE installation avait été écrite. Si c'est justement celle de
  // Steam qui a échoué, le voyant passait au vert alors que rien ne marchait.
  refreshStatsApiFlag();
  if (state.game.statsApiBroken) {
    autoRepairFails++;
    if (autoRepairFails >= MAX_AUTO_REPAIRS) {
      log('réparation automatique abandonnée après ' + autoRepairFails
        + ' échecs — utiliser le bouton « Réactiver »');
    }
  } else {
    autoRepairFails = 0;
  }
  pushState();
}

// Steam est le cas fragile : DefaultStatsAPI.ini vit DANS le dossier du jeu,
// donc dans le dépôt Steam — chaque mise à jour de Rocket League et chaque
// « vérification de l'intégrité des fichiers » le restaure. Comme le tracker
// démarre avec Windows et tourne pendant des jours, la panne survenait en
// pleine vie de l'application et n'était vue qu'au lancement SUIVANT.
const STATSAPI_WATCH_MS = 10 * 60 * 1000;
function startStatsApiWatch() {
  if (process.platform !== 'win32') return;
  setInterval(() => {
    // Pendant que le jeu tourne, réparer ne servirait à rien (l'ini n'est lu
    // qu'au démarrage du jeu) et l'invite UAC passerait par-dessus la partie.
    // On se contente donc de rafraîchir le drapeau pour prévenir le joueur.
    if (state.game.processRunning) refreshStatsApiFlag();
    else repairStatsApiIfNeeded('veille');
  }, STATSAPI_WATCH_MS).unref();
}

// Relevé sans élévation ni réparation : rafraîchit juste le drapeau pour que
// la fenêtre de contrôle guide l'utilisateur dès le lancement du jeu.
function refreshStatsApiFlag() {
  try {
    const c = checkStatsApi(config.get().statsApiPort);
    state.game.statsApiBroken = c.installs.length > 0 && c.broken.length > 0;
  } catch (e) { /* le drapeau garde sa valeur */ }
}

// ───────── Premier lancement ─────────
async function firstRunSetup() {
  state.firstRun = true;
  log('premier lancement — activation de la Stats API + démarrage auto');
  config.save();                       // crée config.json (fin du premier lancement)
  setAutostart(true);
  if (process.platform === 'win32') {
    let r;
    try { r = await enableStatsApi(config.get().statsApiPort); }
    catch (e) { r = { ok: false, reason: e.message }; }
    logStatsApiResult(r);
    refreshStatsApiFlag();
  }
}

// ───────── IPC (depuis les fenêtres) ─────────
ipcMain.handle('get-state', () => { state.config = config.get(); return state; });
ipcMain.handle('set-config', (_e, partial) => {
  config.update(partial);
  // Le plein écran s'applique immédiatement si le dashboard est ouvert.
  if (partial && typeof partial.dashboardFullscreen === 'boolean') {
    windows.setDashboardFullscreen(partial.dashboardFullscreen);
  }
  // L'overlay suit son réglage sans attendre le prochain lancement du jeu.
  if (partial && typeof partial.overlayEnabled === 'boolean') {
    if (partial.overlayEnabled && state.game.running) openOverlay();
    else if (!partial.overlayEnabled) windows.closeOverlay();
  }
  if (partial && partial.overlayCfg) {
    windows.applyOverlayCfg(config.get().overlayCfg);
  }
  // Le son Alpha Boost suit son réglage sans redémarrage. À l'activation, on
  // s'assure aussi que la Stats API débite 120 paquets/s : un ini écrit à 30
  // (le réglage par défaut sans le son) rendrait le son en retard, et la
  // vérification ordinaire, qui n'exige qu'un débit > 0, ne l'aurait jamais
  // relevé. Réécriture silencieuse grâce aux droits déjà posés ; il faudra
  // redémarrer Rocket League pour qu'elle prenne effet.
  if (partial && partial.alphaBoost) {
    if (alphaEnabled()) {
      if (state.game.running) openAlphaAudio();
      sendAlphaCfg();
      ensureAlphaRate();
    } else {
      windows.closeAlphaAudio();
    }
  }
  if (partial && partial.lang) buildTrayMenu();
  if (partial && typeof partial.trayOnly === 'boolean') windows.setTrayOnly(partial.trayOnly);
  if (partial && typeof partial.discordRpc === 'boolean') {
    discord.setEnabled(partial.discordRpc, log);
  }
  if (partial && partial.obs) applyObsConfig();
  refreshSession();                    // le pseudo peut changer les résultats
  pushState();
  return config.get();
});
// Prévisualise l'animation de fin de match sur le dashboard (réglages).
ipcMain.on('preview-animation', (_e, result) => {
  const win = result === 'W';
  const fake = {
    result: win ? 'W' : 'L',
    score: win ? [3, 2] : [1, 3],
    mode: '2v2',
    isOT: false,
    ranked: true,
    forfeit: false,
    me: { goals: 2, saves: 1, assists: 0, shots: 4, score: 520, mvp: win },
    preview: true,
  };
  const already = !!windows.getDashboard();
  windows.openDashboard({ fullscreen: config.get().dashboardFullscreen });
  // Si la fenêtre vient d'être créée, on lui laisse le temps de charger.
  // L'overlay OBS reçoit aussi le test : le streamer voit sa bannière.
  setTimeout(() => {
    windows.broadcast('match-result', fake);
    obs.emit('result', fake);
  }, already ? 50 : 900);
});

// Lit un sample Alpha Boost pour le moteur audio (nom strictement filtré,
// dossier imposé : aucun chemin arbitraire ne peut sortir d'ici).
ipcMain.handle('alpha-read-sound', (_e, name) => {
  const safe = String(name).replace(/[^a-z0-9]/g, '');
  return fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'sounds', 'alpha', safe + '.ogg'));
});

// Essai du son Alpha Boost depuis les réglages : la fenêtre audio joue une
// montée en vitesse simulée. Créée au besoin, refermée après si le jeu ne
// tourne pas (pour ne pas garder un renderer inutile en mémoire).
let alphaTestTimer = null;
ipcMain.on('alpha-test', () => {
  windows.openAlphaAudio(() => {
    sendAlphaCfg();
    const w = windows.getAlphaAudio();
    if (w) {
      try { w.webContents.send('alpha-test'); } catch (e) {}
    }
  });
  // Le minuteur est REPOUSSÉ à chaque essai : avant, seul le tout premier
  // essai en armait un, et il refermait la fenêtre en plein milieu d'un essai
  // suivant — le son s'arrêtait net sans raison visible.
  if (alphaTestTimer) { clearTimeout(alphaTestTimer); alphaTestTimer = null; }
  if (!state.game.running) {
    // L'essai dure ~4 s : large marge avant de refermer la fenêtre.
    alphaTestTimer = setTimeout(() => {
      alphaTestTimer = null;
      if (!state.game.running) windows.closeAlphaAudio();
    }, 12000);
  }
});

// Marque le match EN COURS comme classé ou casual.
ipcMain.on('set-current-ranked', (_e, ranked) => {
  if (state.live && !state.live.training) {
    state.currentRanked = !!ranked;
    state.currentRankedAuto = null;   // choix manuel : il prime
    pushState();
  }
});
ipcMain.on('dashboard-fullscreen-toggle', () => {
  const on = !config.get().dashboardFullscreen;
  config.update({ dashboardFullscreen: on });
  windows.setDashboardFullscreen(on);
  pushState();
});
// Correction manuelle d'un résultat depuis l'historique : 'W', 'L', ou null
// pour revenir au calcul automatique. Stats, courbe et records se recalculent
// rétroactivement — c'est le filet de sécurité quand un forfait est arrivé
// sans aucun signal exploitable.
ipcMain.handle('set-match-result', (_e, id, result) => {
  const r = (result === 'W' || result === 'L') ? result : null;
  const ok = store.overrideResult(String(id || ''), r, config.get().pseudo);
  if (ok) {
    refreshSession();
    pushState();
    log('résultat corrigé à la main : match ' + id + ' → ' + (r || 'auto'));
  }
  return { ok: ok };
});

ipcMain.handle('reset-session', () => {
  store.resetSession();
  refreshSession();
  pushState();
});
ipcMain.handle('set-autostart', (_e, on) => { setAutostart(!!on); pushState(); });
ipcMain.handle('enable-statsapi', async () => {
  let r;
  try { r = await enableStatsApi(config.get().statsApiPort); }
  catch (e) { r = { ok: false, reason: e.message }; }
  logStatsApiResult(r);
  refreshStatsApiFlag();     // on relit l'ini plutôt que de croire le script
  autoRepairFails = 0;       // action volontaire : on refait confiance à l'auto
  pushState();
  return r;
});
// Export du journal : 2000 matchs ne doivent pas rester enfermés dans un
// fichier interne. CSV (une ligne par match, ouvrable dans un tableur) ou
// JSON complet, au choix de l'extension retenue dans la boîte de dialogue.
function toCsv(rows, pseudo) {
  const cell = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    // Un pseudo peut contenir « ; », un guillemet ou un retour à la ligne.
    return /[";\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  // Coéquipiers ou adversaires, du point de vue du joueur suivi.
  // Le joueur suivi est écarté de la colonne « coéquipiers » par son PSEUDO :
  // le reconnaître à ses stats effaçait un coéquipier ayant fini avec les
  // mêmes points et buts — cas courant en 2v2.
  const me = String(pseudo || '').trim().toLowerCase();
  const names = (m, mine) => (Array.isArray(m.players) && m.myTeam !== null
    ? m.players.filter((p) => (p.team === m.myTeam) === mine
        && !(mine && String(p.name || '').trim().toLowerCase() === me))
      .map((p) => p.name).join(', ')
    : '');
  const head = ['date', 'mode', 'classe', 'resultat', 'score', 'prolongation',
    'forfait', 'buts', 'passes', 'arrets', 'tirs', 'points', 'mvp',
    'coequipiers', 'adversaires'];
  const lines = [head.join(';')];
  for (const m of rows) {
    lines.push([
      new Date(m.endedAt).toISOString(),
      m.mode,
      m.ranked ? 'classe' : 'casual',
      m.result || '',
      Array.isArray(m.score) ? m.score.join('-') : '',
      m.isOT ? 'oui' : 'non',
      m.forfeit ? 'oui' : 'non',
      m.me ? m.me.goals : '', m.me ? m.me.assists : '',
      m.me ? m.me.saves : '', m.me ? m.me.shots : '',
      m.me ? m.me.score : '', m.me && m.me.mvp ? 'oui' : 'non',
      // C'est ici qu'un pseudo peut contenir « ; » ou un guillemet : la
      // fonction `cell` ci-dessus existe pour ces deux colonnes.
      names(m, true), names(m, false),
    ].map(cell).join(';'));
  }
  // BOM UTF-8 : sans lui, Excel lit le CSV en ANSI et massacre les accents.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ───────── Cosmétiques (swaps de paquets du jeu) ─────────
function refreshCosmetics() {
  if (cosmetics) state.cosmetics = cosmetics.summary();
}
function cosmeticsResult(r) {
  refreshCosmetics();
  pushState();
  return r;
}
// Les paquets vivent sous Program Files : la première écriture échoue tant
// que l'utilisateur n'a pas de droits sur CookedPCConsole. Plutôt que de lui
// demander d'aller cliquer ailleurs, on lance l'élévation (qui pose l'ACL)
// et on rejoue l'opération une fois. Une seule invite UAC, puis plus jamais.
async function withGameRights(op) {
  let r = op();
  if (r && r.ok === false && (r.code === 'EACCES' || r.code === 'EPERM')
      && process.platform === 'win32') {
    log('cosmétiques : accès refusé, élévation pour poser les droits…');
    try { await enableStatsApi(config.get().statsApiPort, { forceElevate: true }); }
    catch (e) { log('cosmétiques : élévation échouée : ' + e.message); }
    refreshStatsApiFlag();
    r = op();
  }
  return cosmeticsResult(r);
}
ipcMain.handle('cosmetics-list', () => (cosmetics ? cosmetics.list()
  : { installs: [], swaps: [], gameRunning: false }));
ipcMain.handle('cosmetics-targets', (_e, install, query) =>
  (cosmetics ? cosmetics.targets(String(install || ''), String(query || '')) : []));
ipcMain.handle('cosmetics-add', async (_e, opts) => {
  if (!cosmetics) return { ok: false, error: 'Module indisponible.' };
  const o = opts || {};
  if (cosmetics.isGameRunning()) {
    return { ok: false, error: 'Rocket League est ouvert : ferme le jeu d’abord.' };
  }
  const ext = String(o.target || '').split('.').pop().toLowerCase();
  const r = await dialog.showOpenDialog({
    title: state.lang === 'en' ? 'Replacement file' : 'Fichier de remplacement',
    properties: ['openFile'],
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  return cosmeticsResult(cosmetics.add({
    install: o.install, target: o.target, label: o.label, sourcePath: r.filePaths[0],
  }));
});
ipcMain.handle('cosmetics-presets', () => (cosmetics ? cosmetics.presets() : []));
ipcMain.on('open-overlay-composer', () => {
  const w = windows.openOverlayComposer();
  // La fenêtre reçoit l'état comme les autres (windows.broadcast la couvre
  // dès qu'elle existe) ; on pousse tout de suite pour ne pas attendre.
  if (w) w.webContents.once('did-finish-load', () => pushState());
});

ipcMain.handle('cosmetics-check-targets', (_e, id, install) =>
  (cosmetics ? cosmetics.checkTargets(id, install) : { ok: false, error: 'indisponible' }));

ipcMain.handle('cosmetics-add-preset', (_e, id, opts) =>
  cosmeticsResult(cosmetics ? cosmetics.addPreset(String(id || ''), opts || {})
    : { ok: false, error: 'Module indisponible.' }));
ipcMain.handle('cosmetics-apply', (_e, id) =>
  withGameRights(() => (cosmetics ? cosmetics.apply(String(id || '')) : { ok: false, error: 'Module indisponible.' })));
ipcMain.handle('cosmetics-restore', (_e, id) =>
  withGameRights(() => (cosmetics ? cosmetics.restore(String(id || '')) : { ok: false, error: 'Module indisponible.' })));
ipcMain.handle('cosmetics-remove', (_e, id) =>
  cosmeticsResult(cosmetics ? cosmetics.remove(String(id || '')) : { ok: false, error: 'Module indisponible.' }));
ipcMain.handle('cosmetics-toggle', (_e, id, enabled) =>
  cosmeticsResult(cosmetics ? cosmetics.toggle(String(id || ''), !!enabled) : { ok: false, error: 'Module indisponible.' }));
ipcMain.handle('cosmetics-apply-all', () =>
  withGameRights(() => (cosmetics ? cosmetics.applyAll() : { ok: false, error: 'Module indisponible.' })));
ipcMain.handle('cosmetics-restore-all', () =>
  withGameRights(() => (cosmetics ? cosmetics.restoreAll() : { ok: false, error: 'Module indisponible.' })));

ipcMain.handle('export-matches', async () => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog({
      title: state.lang === 'en' ? 'Export matches' : 'Exporter les matchs',
      defaultPath: 'rl-matchs-' + stamp + '.csv',
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    // Le point de vue du joueur (victoire/défaite, stats perso) est dérivé au
    // calcul : on exporte donc l'historique évalué, pas les données brutes.
    const rows = store.exportRows(config.get().pseudo);
    const json = /\.json$/i.test(r.filePath);
    fs.writeFileSync(r.filePath,
      json ? JSON.stringify(rows, null, 2) + '\n' : toCsv(rows, config.get().pseudo));
    log('export de ' + rows.length + ' match(s) vers ' + r.filePath);
    return { ok: true, file: r.filePath, count: rows.length };
  } catch (e) {
    log('export échoué : ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.on('open-dashboard', () => openDashboard());
ipcMain.on('close-dashboard', () => windows.closeDashboard());
ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(url);
});
ipcMain.on('update-check', () => updater.check());
ipcMain.on('update-download', () => updater.download());
ipcMain.on('update-install', () => updater.install());
ipcMain.on('win-minimize', () => { const w = windows.getControl(); if (w) w.minimize(); });
ipcMain.on('win-maximize', () => windows.toggleMaximizeControl());
ipcMain.on('win-close', () => { const w = windows.getControl(); if (w) w.hide(); });
ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit(); });

// ───────── Cycle de vie ─────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Avant que l'application ne soit prête, créer une BrowserWindow lève une
  // exception : au démarrage de Windows (autostart --silent) suivi d'un clic
  // sur l'icône, la seconde instance ne montrait alors jamais rien.
  app.on('second-instance', () => {
    if (app.isReady()) windows.showControl();
    else app.whenReady().then(() => windows.showControl());
  });
  app.on('window-all-closed', () => { /* on vit dans la barre des tâches */ });
  app.on('before-quit', () => { app.isQuitting = true; discord.stop(); obs.stop(); sos.stop(); });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });

  app.whenReady().then(async () => {
    try { app.setAppUserModelId('com.rlsessiontracker.app'); } catch (e) {}

    const firstRun = !configExists();
    config.init(app.getPath('userData'));
    store = new SessionStore(app.getPath('userData'));
    cosmetics = new Cosmetics(app.getPath('userData'), {
      detectInstalls: () => (process.platform === 'win32' ? detectInstalls() : []),
      isGameRunning: () => !!state.game.processRunning,
      log: log,
    });
    refreshCosmetics();
    // Chaque lancement démarre une nouvelle liste de « matchs récents ».
    // Le journal complet est conservé : courbe MMR, 7 jours et records
    // continuent de tout voir.
    store.resetSession();
    state.autostart = autostartEnabled();
    refreshSession();

    createTray();
    windows.setTrayOnly(config.get().trayOnly !== false);
    windows.createControl(!SILENT, () => pushState(), {
      bounds: config.get().controlBounds,
      onBounds: (b) => config.update({ controlBounds: b }),
    });

    // Raccourci global : la fenêtre se cache dans la zone de notification,
    // que Windows replie souvent derrière une flèche — d'où l'impression de
    // ne jamais la retrouver. Ctrl+Alt+R la fait apparaître de n'importe où,
    // jeu compris. Un refus (combinaison déjà prise) est signalé à l'écran.
    try {
      state.hotkey.ok = globalShortcut.register('CommandOrControl+Alt+R',
        () => windows.toggleControl());
    } catch (e) { state.hotkey.ok = false; }
    if (!state.hotkey.ok) log('raccourci Ctrl+Alt+R indisponible (déjà utilisé ailleurs)');

    updater.init((u) => { state.update = u; pushState(); }, log);
    discord.setEnabled(config.get().discordRpc, log);
    applyObsConfig();
    startStatsApi();

    const watcher = new GameWatcher();
    watcher.on('change', (running) => {
      state.game.processRunning = running;
      if (running) {
        // Le jeu démarre : l'ini a pu être réinitialisé par une mise à jour
        // pendant que l'application tournait — on rafraîchit le drapeau (sans
        // élévation) pour guider tout de suite au lieu du délai de 2 min.
        refreshStatsApiFlag();
      } else if (process.platform === 'win32') {
        // Le jeu vient de se fermer : c'est LE bon moment pour réparer. L'ini
        // n'est relu qu'au démarrage du jeu, donc réparer maintenant rend la
        // prochaine session saine, et l'invite UAC ne tombe pas en pleine
        // partie. Sans ça, une mise à jour Steam coûtait une session entière.
        repairStatsApiIfNeeded('fermeture du jeu');
        // Même logique pour les swaps cosmétiques : si une mise à jour a remis
        // les originaux, on les réapplique maintenant, jeu fermé.
        if (cosmetics) { cosmetics.reapplyReverted(); refreshCosmetics(); }
      }
      recomputeRunning();
    });
    watcher.start();
    startStatsApiWatch();
    startMmrFromLog();

    if (firstRun) {
      await firstRunSetup();
      windows.showControl();           // premier lancement : on se montre
      pushState();
    } else if (process.platform === 'win32') {
      await repairStatsApiIfNeeded('lancement');
    }

    // PAS de réapplication automatique au lancement de l'application. Leçon
    // du terrain : après un swap qui avait cassé le jeu, l'utilisateur a
    // restauré ses fichiers via Steam — et l'application, relancée au
    // démarrage de Windows, les aurait re-cassés dans son dos. La
    // réapplication n'a lieu qu'à la FERMETURE du jeu, quand l'utilisateur
    // vient de jouer et a la main pour retirer un swap qui pose problème.
    log('application lancée v' + state.version + (SILENT ? ' (silencieux)' : ''));
  });
}

function configExists() {
  try {
    return fs.existsSync(path.join(app.getPath('userData'), 'config.json'));
  } catch (e) { return false; }
}
