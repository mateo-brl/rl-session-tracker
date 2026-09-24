// index.js — Processus principal de RL Session Tracker.
//
// L'application est 100 % locale : pas de serveur, pas de compte. Elle :
//  • démarre avec Windows et vit dans la barre des tâches ;
//  • surveille Rocket League (processus + Stats API du jeu) ;
//  • ouvre automatiquement le dashboard en plein écran sur le 2ᵉ écran
//    quand le jeu se lance, et le ferme quand le jeu se ferme ;
//  • enregistre chaque match (victoires/défaites, série, stats par mode) ;
//  • se met à jour toute seule depuis les releases GitHub (sur accord).

const { app, ipcMain, shell, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const windows = require('./windows');
const updater = require('./updater');
const discord = require('./discord-rpc');
const obs = require('./obs-server');
const sos = require('./sos-bridge');
const SessionStore = require('./session');
const MediaControl = require('./media');
const GameWatcher = require('./game-watcher');
const RLStatsAPI = require('./statsapi');
const RLLogReader = require('./rl-log');
const Cosmetics = require('./cosmetics');
const MapLibrary = require('./maps');
const diagnostic = require('./diagnostic');
const documents = require('./documents');
const { enableStatsApi, detectInstalls, iniRate, iniConfigured,
  userIniFiles, userConfigDirs, readIni } = require('./enable-statsapi');

const SILENT = process.argv.includes('--silent');   // lancé par le démarrage auto
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
let media = null;
let cosmetics = null;   // swaps cosmétiques (fichiers du jeu, jeu fermé)
let mapLib = null;      // cartes workshop : bibliothèque + emplacement Underpass
// Horodatage du dernier paquet EXPLOITÉ de la Stats API. Le connecteur peut
// être connecté sans que rien n'arrive (le jeu n'émet qu'en match) : sans cette
// date, le diagnostic ne pourrait pas distinguer « le flux coule » de « le
// socket tient tout seul depuis une heure ».
let statsApiSeenAt = 0;

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
  mmrPending: null,      // lecture de MMR mise de côté, en attente de confirmation (mmr-guard.js)
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

// Ce que les modules extraits d'index.js partagent avec lui. Les accesseurs
// (get store…) lisent la valeur au moment de l'appel : ces objets ne sont
// créés qu'une fois l'application prête, après le chargement des modules.
const ctx = {
  state, config, windows, log,
  pushState: () => pushState(),
  refreshSession: () => refreshSession(),
  get store() { return store; },
  get cosmetics() { return cosmetics; },
  get mapLib() { return mapLib; },
};
const repair = require('./statsapi-repair')(ctx);
const cosmeticsIpc = require('./ipc-cosmetics')(ctx, repair);
const mapsIpc = require('./ipc-maps')(ctx, cosmeticsIpc.withGameRights);
ctx.onQueue = (q) => mapsIpc.guardQueue(q);
const mmrLog = require('./mmr-log')(ctx);
require('./ipc-files')(ctx);
const tray = require('./tray')(ctx, {
  lang: () => resolveLang(),
  openDashboard: () => openDashboard(),
  toggleOverlay: () => toggleOverlay(),
  openMaps: () => mapsIpc.openWindow(),
});

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
  state.media = media ? media.status() : null;
  cosmeticsIpc.refresh();

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
  } else {
    state.live = null;
    state.currentRanked = null;
    state.currentRankedAuto = null;
    windows.closeDashboard();
    windows.closeOverlay();
  }
  pushState();
}

function openOverlay() {
  windows.openOverlay(config.get().overlayPos,
    (pos) => config.update({ overlayPos: pos }),
    config.get().overlayCfg);
}

// Mini-overlay allumé ou éteint depuis le menu de la zone de notification.
function toggleOverlay() {
  if (windows.getOverlay()) {
    config.update({ overlayEnabled: false });
    windows.closeOverlay();
  } else {
    config.update({ overlayEnabled: true });
    openOverlay();
  }
  pushState();
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

// ───────── Stats API du jeu ─────────
// Entraînement / piste libre : le joueur est seul dans la « partie ». Un vrai
// match a toujours au moins 2 joueurs — en dessous, on affiche « entraînement »
// et on ne compte RIEN (ni buts, ni résultat).
function isTraining(d) {
  return !Array.isArray(d.players) || d.players.length < 2;
}

let statsApi = null;
function startStatsApi() {
  // Le port est passé au constructeur : le poser dans process.env ne servait
  // à rien, la constante du module ayant déjà été évaluée au `require`.
  const api = statsApi = new RLStatsAPI({ port: config.get().statsApiPort });
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
    statsApiSeenAt = Date.now();
    sos.send('state', d);
    state.live = d && d.active ? { ...d, training: isTraining(d) } : null;
    // Nouveau match : classé ou casual ? Pré-réglé sur la préférence, et
    // modifiable d'un clic sur le dashboard pendant la partie.
    if (state.live && !state.live.training && state.currentRanked === null) {
      const r = mmrLog.resolveRanked();
      state.currentRanked = r.ranked;
      state.currentRankedAuto = r.auto;
      state.currentMatchmade = mmrLog.resolveMatchmade();
      if (state.currentMatchmade === false) {
        log('match hors file (privé ou exhibition) — il ne sera pas compté');
      }
    }
    pushState();
  });
  api.on('match', (d) => {
    statsApiSeenAt = Date.now();
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
      ? state.currentRanked : mmrLog.resolveRanked().ranked;
    state.currentRanked = null;
    state.currentRankedAuto = null;
    // Le podium avait été atteint : le match s'est terminé pour de bon (c'est
    // typiquement un forfait ADVERSE) et notre départ n'était qu'une sortie
    // d'écran de fin. Un vrai résultat, à compter même en casual — alors que
    // quitter une partie en cours ne se compte qu'en classé.
    const realEnd = !!snap.podium || snap.winnerTeam === 0 || snap.winnerTeam === 1;
    if (isTraining(snap) || (!ranked && !realEnd) || !mmrLog.countsAsMatch('abandon')) {
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
  api.on('podium', (d) => sos.send('podium', d));
  // Journalisé pour apprendre la forme réelle de ces évènements en partie
  // (voir statsapi.js) ; rien n'en dépend encore.
  api.on('player', (p) => {
    log('Stats API : joueur ' + (p.phase === 'left' ? 'parti' : 'arrivé') + ' : '
      + (p.name || '?') + ' (équipe ' + (p.team === null ? '?' : p.team) + ')');
  });
  api.on('goal', (d) => {
    statsApiSeenAt = Date.now();
    if (state.live && state.live.training) return;
    windows.broadcast('goal', d);
    obs.emit('goal', d);
    sos.send('goal', d);
  });
  api.on('ended', (snap) => {
    state.live = null;
    if (isTraining(snap) || !mmrLog.countsAsMatch('fin de match')) {
      state.currentRanked = null;
      state.currentRankedAuto = null;
      state.currentMatchmade = null;
      pushState();
      if (isTraining(snap)) log('entraînement terminé — non compté');
      return;
    }
    snap.ranked = state.currentRanked !== null
      ? state.currentRanked : mmrLog.resolveRanked().ranked;
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
    repair.logResult(r);
    repair.refreshFlag();
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
  if (partial && partial.lang) tray.rebuild();
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

// ───────── Diagnostic ─────────
// Deux mécanismes n'ont jamais été validés en conditions réelles : l'activation
// de la Stats API sur une installation Steam et la réconciliation d'un forfait
// adverse. Ils échouent en silence — d'où ce rapport, qui dit ce qui va et ce
// qui ne va pas plutôt que de laisser une séance de test sans conclusion.
// Toutes les dépendances sont passées explicitement : le module reste ainsi
// testable sans Electron ni Windows.
ipcMain.handle('run-diagnostic', () => {
  let r;
  try {
    r = diagnostic.run({
      config: config.get(),
      game: state.game,
      lastPacketAt: statsApiSeenAt,
      // Hors Windows, la détection n'a pas d'objet : on rend une liste vide
      // plutôt que de laisser reg.exe échouer contrôle par contrôle.
      detectInstalls: () => (process.platform === 'win32' ? detectInstalls() : []),
      iniConfigured: iniConfigured,
      iniRate: iniRate,
      userIni: () => (process.platform === 'win32'
        ? { dirs: userConfigDirs(), files: userIniFiles() } : { dirs: [], files: [] }),
      readIni: readIni,
      logFile: RLLogReader.defaultLogPath(),
      readQueue: () => (mmrLog.reader ? mmrLog.reader.refreshQueue() : null),
      readMmr: () => (mmrLog.reader ? mmrLog.reader.read() : null),
      mmrPending: state.mmrPending || null,
      history: state.history,
      playersSeen: state.playersSeen,
      obs: state.obs,
      cosmetics: cosmetics ? cosmetics.list() : null,
      maps: () => (mapLib ? mapLib.slotStatus() : null),
    });
  } catch (e) {
    // `diagnostic.run` ne doit jamais lever — mais s'il le faisait, la fenêtre
    // resterait sur un bouton qui ne rend rien. On répond quand même.
    log('diagnostic : échec inattendu : ' + e.message);
    return { at: Date.now(), ok: false, checks: [{ id: 'diagnostic', state: 'fail',
      label: 'Diagnostic', detail: 'échec inattendu : ' + e.message, hint: null }] };
  }
  const ko = r.checks.filter((c) => c.state === 'fail').map((c) => c.id);
  log('diagnostic : ' + r.checks.length + ' contrôle(s), '
    + (ko.length ? 'en échec : ' + ko.join(', ') : 'aucun échec'));
  return r;
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
  app.on('before-quit', () => {
    app.isQuitting = true;
    discord.stop();
    obs.stop();
    sos.stop();
    // Sans cet arrêt, le PowerShell du contrôleur média survivait à la
    // fermeture : invisible, il continuait d'interroger le système, et il
    // s'en accumulait un par lancement jusqu'au redémarrage de la machine.
    if (media) media.stop();
  });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });

  app.whenReady().then(async () => {
    try { app.setAppUserModelId('com.rlsessiontracker.app'); } catch (e) {}

    const firstRun = !configExists();
    config.init(app.getPath('userData'));
    // Le vrai dossier Documents de Windows (OneDrive ou déplacé compris) :
    // c'est là que le jeu écrit son journal, source du MMR.
    try { documents.setKnown(app.getPath('documents')); } catch (e) { /* candidats par défaut */ }
    store = new SessionStore(app.getPath('userData'));
    // Ce qui joue sur la machine : le contrôleur média de Windows, celui de
    // la tuile du volume. Il couvre tous les lecteurs, sans clé ni compte.
    media = new MediaControl(app.getPath('userData'), {
      log,
      onUpdate: () => { state.media = media.status(); pushState(); },
    });
    media.start();
    cosmetics = new Cosmetics(app.getPath('userData'), {
      detectInstalls: () => (process.platform === 'win32' ? detectInstalls() : []),
      isGameRunning: () => !!state.game.processRunning,
      log: log,
    });
    cosmeticsIpc.refresh();
    mapLib = new MapLibrary(app.getPath('userData'), {
      detectInstalls: () => (process.platform === 'win32' ? detectInstalls() : []),
      log: log,
    });
    // Chaque lancement démarre une nouvelle liste de « matchs récents ».
    // Le journal complet est conservé : courbe MMR, 7 jours et records
    // continuent de tout voir.
    store.resetSession();
    state.autostart = autostartEnabled();
    refreshSession();

    tray.create();
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
        repair.refreshFlag();
      } else if (process.platform === 'win32') {
        // Le jeu vient de se fermer : c'est LE bon moment pour réparer. L'ini
        // n'est relu qu'au démarrage du jeu, donc réparer maintenant rend la
        // prochaine session saine, et l'invite UAC ne tombe pas en pleine
        // partie. Sans ça, une mise à jour Steam coûtait une session entière.
        repair.repairIfNeeded('fermeture du jeu');
        // Même logique pour les swaps cosmétiques : si une mise à jour a remis
        // les originaux, on les réapplique maintenant, jeu fermé.
        if (cosmetics) { cosmetics.reapplyReverted(); cosmeticsIpc.refresh(); }
      }
      recomputeRunning();
    });
    watcher.start();
    repair.startWatch();
    mmrLog.start();

    if (firstRun) {
      await firstRunSetup();
      windows.showControl();           // premier lancement : on se montre
      pushState();
    } else if (process.platform === 'win32') {
      await repair.repairIfNeeded('lancement');
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

// Pour e2e/smoke.js : le test ne peut ni lancer Rocket League ni recevoir un
// vrai flux de match. Il rejoue donc des évènements de la Stats API dans le
// connecteur réel, et simule l'ouverture et la fermeture du jeu, pour que
// tout le câblage en aval (session, fenêtres, overlay) soit parcouru.
module.exports = {
  feedStatsApi: (event, data) => { if (statsApi) statsApi._handle({ event: event, data: data }); },
  simulateGame: (running) => { state.game.processRunning = !!running; recomputeRunning(); },
  ctx: ctx,
};
