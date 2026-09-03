// diagnostic.js — Rapport d'état des mécanismes qui tournent en aveugle.
//
// Deux d'entre eux n'ont jamais été validés en conditions réelles :
//  • l'activation de la Stats API sur une installation STEAM — l'ini vit dans
//    le dépôt Steam, donc chaque mise à jour du jeu et chaque « vérification de
//    l'intégrité des fichiers » le restaure, et la réparation silencieuse ne
//    marche que si l'ACL a bien été posée. Lire l'ini ne demande AUCUN droit :
//    une installation peut donc paraître saine alors que la prochaine
//    réparation échouera ;
//  • la réconciliation d'un forfait adverse — le match arrive au tracker sans
//    vainqueur ni podium, il est compté défaite, et seule la comparaison au
//    vrai MMR relevé dans le journal du jeu le corrige plus tard.
//
// Sans rapport, une séance de test ne conclut rien : on ne saurait pas
// distinguer « le mécanisme a échoué » de « le cas ne s'est simplement pas
// présenté ». D'où le parti pris de chaque contrôle : un `detail` FACTUEL (la
// valeur trouvée, le chemin, le nombre) et un `hint` qui dit quoi faire.
//
// Le module ne require NI electron NI rien de propre à Windows : toutes ses
// dépendances arrivent en paramètres, ce qui le rend vérifiable par
// `node --test` sur n'importe quelle machine.
//
// RÈGLE ABSOLUE : `run` ne lève jamais. Une dépendance qui casse devient un
// contrôle en échec dans le rapport — c'est justement l'information qu'on
// cherche, et un rapport partiel vaut infiniment mieux qu'une exception au
// milieu d'une séance de test chez un ami.

const fsDefault = require('fs');
const path = require('path');
// La moyenne générique du pas MMR vit dans session.js : la recopier ici, ce
// serait la voir dériver au premier ajustement.
const { MMR_STEP } = require('./session');

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const SKIP = 'skip';

const DEFAULT_PORT = 49123;
// En dessous, le score et le chrono avancent par à-coups sur le dashboard :
// l'ini est alors resté sur une valeur écrite par autre chose que nous.
const RATE_MIN = 30;
// Le jeu réécrit son journal à chaque lancement : au-delà, il n'a tout
// simplement pas tourné depuis, et tout ce qu'on en lit est périmé.
const LOG_STALE_MS = 7 * 24 * 60 * 60 * 1000;
// La Stats API n'émet qu'en match : quelques secondes de silence sont normales
// dans les menus, mais un flux vivant se voit à moins de 10 s.
const PACKET_FRESH_MS = 10 * 1000;

function reason(e) {
  return String((e && (e.code || e.message)) || e || 'erreur inconnue');
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Âge lisible par quelqu'un de pressé : « 3 s », « 5 min », « 2 h », « 4 j ».
function age(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'date inconnue';
  if (ms < 1000) return 'moins d’une seconde';
  if (ms < 60 * 1000) return Math.round(ms / 1000) + ' s';
  if (ms < 60 * 60 * 1000) return Math.round(ms / 60000) + ' min';
  if (ms < 24 * 60 * 60 * 1000) return Math.round(ms / 3600000) + ' h';
  return Math.round(ms / 86400000) + ' j';
}

// Même chose, tournée dans la phrase. « il y a à l'instant » ne se dit pas :
// le cas tout juste écoulé mérite sa propre formulation.
function since(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'date inconnue';
  if (ms < 1000) return 'à l’instant';
  return 'il y a ' + age(ms);
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'taille inconnue';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' Ko';
  return String(Math.round(bytes / 104857.6) / 10).replace('.', ',') + ' Mo';
}

// Horodatage local court (« 03/09 21:55 ») : le rapport est lu par un humain
// assis devant sa machine, pas par un serveur — un ISO en UTC l'obligerait à
// convertir de tête pour vérifier « c'était bien le match de tout à l'heure ».
function stamp(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '?';
  const dt = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(dt.getDate()) + '/' + p2(dt.getMonth() + 1)
    + ' ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes());
}

// Dernier segment d'un chemin. On ne passe PAS par path.basename : les chemins
// relevés sont des chemins Windows (antislashs) alors que le rapport peut être
// produit ailleurs — en test, path.basename POSIX rendrait le chemin entier.
function lastSegment(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

// États d'un swap cosmétique, tels que cosmetics.js les nomme. Le rapport est
// lu par l'utilisateur, pas par un développeur : « 1 reverted » ne lui dit rien.
const SWAP_STATES = {
  applied: 'posé(s)',
  reverted: 'défait(s) par une mise à jour du jeu',
  pending: 'en attente d’application',
  missing: 'fichier cible introuvable',
};

// D'où vient une installation ? Steam est le cas fragile : le rapport doit le
// dire, sinon l'utilisateur ne sait pas laquelle des deux lignes surveiller.
function origin(p) {
  const s = String(p || '');
  if (/steamapps/i.test(s)) return 'Steam';
  if (/epic/i.test(s)) return 'Epic';
  return 'Installation';
}

// Droits d'écriture RÉELS. Lire l'ini ne demande aucun droit : une
// installation Steam sous Program Files répond donc « configurée » alors que
// la prochaine réparation silencieuse échouera en EACCES. Seule une écriture
// réelle tranche — d'où le fichier temporaire, aussitôt supprimé.
function writeTest(fs, dir, token) {
  const probe = path.join(dir, 'rl-tracker-diagnostic-' + token + '.tmp');
  try {
    fs.writeFileSync(probe, 'rl-session-tracker');
  } catch (e) {
    return { state: FAIL, detail: 'écriture refusée dans ' + dir + ' (' + reason(e) + ')',
      hint: 'Clique « Réactiver la Stats API du jeu » et accepte la fenêtre Windows :'
        + ' l’élévation pose les droits une fois pour toutes, et les réparations'
        + ' suivantes (après une mise à jour ou une vérification Steam) se font'
        + ' ensuite sans aucune invite.' };
  }
  try {
    fs.unlinkSync(probe);
  } catch (e) {
    return { state: WARN,
      detail: 'écriture possible, mais le fichier de test n’a pas pu être supprimé : ' + probe,
      hint: 'Supprime-le à la main — il ne gêne pas le jeu.' };
  }
  return { state: OK, detail: 'écriture et suppression réussies dans ' + dir };
}

// Produit le rapport. `deps` porte TOUT ce qui touche au monde extérieur :
//   fs, now, platform, config, game, lastPacketAt, detectInstalls, iniConfigured,
//   iniRate, logFile, readQueue, readMmr, history, playersSeen, obs, cosmetics.
// Chacune est facultative : absente, le contrôle correspondant est « skip »
// plutôt qu'en échec — un contrôle qu'on n'a pas pu faire n'est pas une panne.
function run(deps) {
  const d = deps || {};
  const fs = d.fs || fsDefault;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const at = now();
  const checks = [];

  const add = (id, label, fn) => {
    let r;
    try {
      r = fn();
    } catch (e) {
      // Une dépendance qui casse EST un résultat de diagnostic : on l'écrit
      // dans le rapport au lieu de laisser l'exception l'emporter tout entier.
      r = { state: FAIL, detail: 'contrôle impossible : ' + reason(e),
        hint: 'Ce contrôle n’a pas pu s’exécuter. Note le message et joins le'
          + ' journal de l’application (app.log) au rapport.' };
    }
    if (!r) return;
    checks.push({ id: id, label: label, state: r.state,
      detail: r.detail || '', hint: r.hint || null });
  };

  const cfg = (d.config && typeof d.config === 'object') ? d.config : {};
  const game = (d.game && typeof d.game === 'object') ? d.game : {};
  const port = numOr(cfg.statsApiPort, DEFAULT_PORT);
  const hist = Array.isArray(d.history) ? d.history.filter(Boolean) : [];

  // ───────── Installations de Rocket League ─────────
  let installs = [];
  add('installs', 'Installations de Rocket League', () => {
    if (typeof d.detectInstalls !== 'function') {
      return { state: SKIP, detail: 'détection indisponible dans ce contexte' };
    }
    const found = d.detectInstalls();
    installs = Array.isArray(found) ? found.filter((p) => typeof p === 'string' && p) : [];
    if (!installs.length) {
      return { state: FAIL, detail: 'aucune installation détectée',
        hint: 'Lance Rocket League une fois depuis Steam ou l’Epic Games Launcher,'
          + ' puis relance ce diagnostic : sans installation détectée, la Stats API'
          + ' ne peut être activée nulle part.' };
    }
    return { state: OK, detail: installs.length + ' détectée(s) : ' + installs.join(' · ') };
  });

  installs.forEach((p, i) => {
    const who = origin(p) + ' · ' + lastSegment(p);
    const cfgDir = path.join(p, 'TAGame', 'Config');

    add('install-' + i + '-config', 'Dossier de configuration (' + who + ')', () => {
      if (!fs.existsSync(cfgDir)) {
        return { state: FAIL, detail: 'introuvable — ' + cfgDir,
          hint: 'Installation incomplète ou déplacée : vérifie l’intégrité des'
            + ' fichiers du jeu, puis relance le diagnostic.' };
      }
      return { state: OK, detail: cfgDir };
    });

    add('install-' + i + '-ini', 'DefaultStatsAPI.ini (' + who + ')', () => {
      const ini = path.join(cfgDir, 'DefaultStatsAPI.ini');
      if (!fs.existsSync(ini)) {
        return { state: FAIL, detail: 'absent — ' + ini,
          hint: 'Clique « Réactiver la Stats API du jeu », accepte la fenêtre'
            + ' Windows, puis REDÉMARRE Rocket League : le jeu ne relit son ini'
            + ' qu’à son lancement.' };
      }
      const ok = typeof d.iniConfigured === 'function' ? d.iniConfigured(p, port) : null;
      if (ok === false) {
        return { state: FAIL, detail: 'présent mais pas configuré pour le port ' + port
            + ' — ' + ini,
          hint: 'C’est la panne typique après une mise à jour du jeu ou une'
            + ' « vérification de l’intégrité des fichiers » : réactive la Stats'
            + ' API, puis redémarre Rocket League.' };
      }
      if (ok === null) return { state: SKIP, detail: 'présent — ' + ini + ' (contenu non vérifié)' };
      return { state: OK, detail: 'présent et configuré sur le port ' + port };
    });

    add('install-' + i + '-rate', 'Débit de la Stats API (' + who + ')', () => {
      if (typeof d.iniRate !== 'function') {
        return { state: SKIP, detail: 'relevé du débit indisponible' };
      }
      const rate = Number(d.iniRate(p));
      if (!Number.isFinite(rate) || rate <= 0) {
        return { state: FAIL, detail: 'PacketSendRate = 0 — la Stats API n’émet rien',
          hint: 'C’est la valeur par défaut du jeu : réactive la Stats API, puis'
            + ' redémarre Rocket League.' };
      }
      if (rate < RATE_MIN) {
        return { state: WARN, detail: rate + ' paquets/s',
          hint: 'Débit faible : le score et le chrono avanceront par à-coups.'
            + ' Réactiver la Stats API réécrit l’ini à 60 paquets/s.' };
      }
      return { state: OK, detail: rate + ' paquets/s' };
    });

    add('install-' + i + '-write', 'Droits d’écriture (' + who + ')',
      () => writeTest(fs, cfgDir, at + '-' + i));
  });

  // ───────── Stats API ─────────
  add('statsapi-port', 'Port de la Stats API', () => {
    if (port === DEFAULT_PORT) return { state: OK, detail: 'port ' + port + ' (défaut)' };
    return { state: WARN, detail: 'port ' + port + ' (personnalisé)',
      hint: 'Le jeu doit écrire le MÊME port dans son ini : après tout changement'
        + ' de port, clique « Réactiver la Stats API du jeu » et redémarre le jeu.' };
  });

  // Le connecteur de l'application est connecté en permanence et se reconnecte
  // tout seul : son état DIT si le serveur du jeu répond. Ouvrir un second
  // socket pour « vérifier » n'apprendrait rien de plus et rendrait tout le
  // rapport asynchrone, donc capable de traîner ou d'expirer.
  add('statsapi-link', 'Connexion à la Stats API', () => {
    if (game.statsConnected) return { state: OK, detail: 'connecté à 127.0.0.1:' + port };
    if (game.processRunning) {
      return { state: FAIL,
        detail: 'Rocket League tourne, mais rien n’écoute sur 127.0.0.1:' + port,
        hint: 'L’ini n’était pas actif au DÉMARRAGE du jeu. Réactive la Stats API,'
          + ' puis redémarre Rocket League — le jeu ne relit son ini qu’au lancement.' };
    }
    return { state: SKIP,
      detail: 'Rocket League est fermé — la Stats API n’existe que pendant le jeu' };
  });

  add('statsapi-packet', 'Dernier paquet reçu', () => {
    const seen = Number(d.lastPacketAt);
    if (!Number.isFinite(seen) || seen <= 0) {
      return { state: game.statsConnected ? WARN : SKIP,
        detail: 'aucun paquet exploité depuis le lancement de l’application',
        hint: game.statsConnected
          ? 'Connecté mais muet : le jeu n’émet qu’en match. Entre dans une partie'
            + ' (l’entraînement libre suffit à voir arriver le flux).'
          : null };
    }
    const ecoule = at - seen;
    const detail = since(ecoule) + ' (' + stamp(seen) + ')';
    if (ecoule < PACKET_FRESH_MS) return { state: OK, detail: detail };
    if (game.statsConnected && game.processRunning) {
      return { state: WARN, detail: detail,
        hint: 'Connecté mais plus rien n’arrive : c’est normal dans les menus (le'
          + ' flux ne coule qu’en match). Si ça dure EN PLEINE partie, redémarre'
          + ' Rocket League.' };
    }
    return { state: OK, detail: detail };
  });

  // ───────── Journal du jeu (Launch.log) ─────────
  add('log-file', 'Journal du jeu (Launch.log)', () => {
    if (!d.logFile) return { state: SKIP, detail: 'chemin du journal inconnu' };
    let st;
    try {
      st = fs.statSync(d.logFile);
    } catch (e) {
      return { state: FAIL, detail: 'introuvable — ' + d.logFile,
        hint: 'Sans journal, ni le vrai MMR ni la réconciliation automatique d’un'
          + ' forfait ne fonctionnent. Lance Rocket League une fois (le jeu le crée'
          + ' au démarrage) et vérifie Documents\\My Games\\Rocket League\\TAGame\\Logs.' };
    }
    const written = Number(st.mtimeMs);
    const ecoule = at - written;
    const detail = size(Number(st.size)) + ', écrit ' + since(ecoule)
      + ' (' + stamp(written) + ') — ' + d.logFile;
    if (ecoule > LOG_STALE_MS) {
      return { state: WARN, detail: detail,
        hint: 'Le jeu réécrit son journal à chaque lancement : celui-ci est vieux,'
          + ' donc tout ce qu’on en lit est périmé. Lance Rocket League.' };
    }
    return { state: OK, detail: detail };
  });

  add('log-queue', 'Dernière mise en file relevée', () => {
    if (typeof d.readQueue !== 'function') {
      return { state: SKIP, detail: 'lecture du journal indisponible' };
    }
    const q = d.readQueue();
    if (!q || !q.at) {
      return { state: WARN, detail: 'aucune mise en file dans la fin du journal',
        hint: 'Le jeu n’écrit cette ligne que si c’est TOI qui lances la recherche'
          + ' (chef de groupe). Lance une file toi-même, puis relance le diagnostic.' };
    }
    const quoi = q.known
      ? (q.ranked ? 'classé ' + (q.mode || '?') : 'casual ' + (q.mode || '?'))
      : 'playlist non répertoriée';
    const detail = 'playlist ' + q.playlist + ' — ' + quoi
      + ', ' + since(at - q.at) + ' (' + stamp(q.at) + ')';
    if (!q.known) {
      return { state: WARN, detail: detail,
        hint: 'Nouveau mode, tournoi ou partie privée : le match sera traité comme'
          + ' casual et ne bougera pas le MMR. Si c’était bien du classé, bascule'
          + ' le commutateur Classé/Casual sur le match en direct.' };
    }
    return { state: OK, detail: detail };
  });

  add('log-mmr', 'Dernier MMR relevé dans le journal', () => {
    if (typeof d.readMmr !== 'function') {
      return { state: SKIP, detail: 'lecture du journal indisponible' };
    }
    const r = d.readMmr();
    if (!r || !Number.isFinite(Number(r.mmr))) {
      return { state: WARN, detail: 'aucun relevé exploitable dans la fin du journal',
        hint: 'Le MMR n’est écrit qu’à une mise en file CLASSÉE, et seulement si tu'
          + ' es chef de groupe. Sans relevé, un forfait mal compté ne peut pas être'
          + ' réconcilié tout seul — il reste la correction à la main dans'
          + ' l’historique.' };
    }
    return { state: OK, detail: (r.mode || '?') + ' = ' + Math.round(Number(r.mmr))
      + (Number.isFinite(Number(r.tier)) ? ' (palier ' + r.tier + ')' : '') };
  });

  // ───────── Pseudo suivi ─────────
  add('pseudo', 'Pseudo suivi', () => {
    const pseudo = String(cfg.pseudo || '').trim();
    const seen = Array.isArray(d.playersSeen) ? d.playersSeen.filter(Boolean) : [];
    if (!pseudo) {
      return { state: FAIL,
        detail: 'aucun pseudo configuré — aucun match ne peut être attribué',
        hint: seen.length
          ? 'Choisis-toi parmi les joueurs croisés récemment : ' + seen.slice(0, 6).join(', ') + '.'
          : 'Joue deux ou trois matchs : l’application devine le pseudo toute seule'
            + ' (le seul joueur présent dans toutes tes parties).' };
    }
    if (!hist.length) {
      return { state: SKIP, detail: '« ' + pseudo + ' » — aucun match récent pour le vérifier' };
    }
    // L'historique du dashboard porte `me` (non nul quand le pseudo a été
    // reconnu) ; un journal brut porte `players`. On accepte les deux formes :
    // le diagnostic doit marcher sur ce qu'on lui donne, pas sur une seule.
    const me = norm(pseudo);
    const found = hist.filter((m) => m.me
      || (Array.isArray(m.players) && m.players.some((p) => norm(p && p.name) === me))).length;
    if (!found) {
      return { state: FAIL,
        detail: '« ' + pseudo + ' » ne correspond à aucun joueur des '
          + hist.length + ' derniers matchs',
        hint: (seen.length ? 'Joueurs réellement vus : ' + seen.slice(0, 6).join(', ') + '. ' : '')
          + 'Un changement de nom en jeu, un espace insécable ou une variante'
          + ' unicode suffisent : recopie le pseudo EXACT depuis les suggestions.' };
    }
    if (found < hist.length) {
      return { state: WARN,
        detail: '« ' + pseudo + ' » reconnu dans ' + found + ' des ' + hist.length
          + ' derniers matchs',
        hint: 'Les matchs restants ne comptent ni victoire ni défaite. Un changement'
          + ' de pseudo en cours de session explique le partage.' };
    }
    return { state: OK,
      detail: '« ' + pseudo + ' » reconnu dans les ' + hist.length + ' derniers matchs' };
  });

  // ───────── Calibrage MMR ─────────
  const mmr = (cfg.mmr && typeof cfg.mmr === 'object') ? cfg.mmr : {};
  const steps = (cfg.mmrStep && typeof cfg.mmrStep === 'object') ? cfg.mmrStep : {};
  const modes = Object.keys(mmr)
    .filter((k) => mmr[k] && Number.isFinite(Number(mmr[k].base)));

  add('mmr', 'Modes calibrés en MMR', () => {
    if (!modes.length) {
      return { state: WARN, detail: 'aucun mode calibré',
        hint: 'Recopie ton MMR affiché en jeu, ou lance simplement une file classée :'
          + ' le journal du jeu calera la base tout seul. Sans base, ni la courbe ni'
          + ' la réconciliation d’un forfait ne fonctionnent.' };
    }
    return { state: OK, detail: modes.length + ' mode(s) : ' + modes.join(', ') };
  });

  modes.forEach((mode) => {
    add('mmr-' + mode, 'MMR ' + mode, () => {
      const e = mmr[mode];
      const learned = Number(steps[mode]);
      const detail = 'base ' + Math.round(Number(e.base))
        + ' — ' + (e.fromLog ? 'relevé dans le journal du jeu' : 'saisi à la main')
        + (Number.isFinite(Number(e.setAt)) && e.setAt > 0
          ? ', ' + since(at - e.setAt) : '')
        + ' — ' + (Number.isFinite(learned)
          ? 'pas appris ' + learned
          : 'pas non appris (moyenne ' + MMR_STEP + ')');
      if (!e.fromLog) {
        return { state: WARN, detail: detail,
          hint: 'Base saisie à la main : la réconciliation d’un forfait s’appuie sur'
            + ' les relevés du JOURNAL, pas sur elle. Lance une file classée en '
            + mode + ' pour en obtenir un.' };
      }
      return { state: OK, detail: detail };
    });
  });

  // ───────── Matchs indécidables (symptôme d'un forfait mal compté) ─────────
  add('undecided', 'Matchs au résultat indécidable', () => {
    if (!hist.length) return { state: SKIP, detail: 'aucun match récent' };
    // On ne retient QUE les matchs où le joueur a été reconnu : un match où le
    // pseudo ne correspond à personne est un problème de pseudo, déjà signalé
    // plus haut — le compter ici enverrait chercher un forfait inexistant.
    const bad = hist.filter((m) => m.me && m.result !== 'W' && m.result !== 'L');
    if (!bad.length) {
      return { state: OK, detail: 'aucun sur les ' + hist.length + ' derniers matchs' };
    }
    const oldest = bad.reduce((a, b) => (Number(a.endedAt) <= Number(b.endedAt) ? a : b));
    return { state: bad.length > 2 ? FAIL : WARN,
      detail: bad.length + ' sur ' + hist.length + ' — le plus ancien '
        + since(at - Number(oldest.endedAt)) + ' (' + stamp(Number(oldest.endedAt)) + ')',
      hint: 'C’est la signature d’un forfait adverse arrivé sans aucun signal (ni'
        + ' vainqueur annoncé, ni podium). Corrige le résultat d’un clic dans'
        + ' l’historique du dashboard ; une prochaine file classée peut aussi le'
        + ' réconcilier toute seule à partir du vrai MMR.' };
  });

  // ───────── Overlay OBS ─────────
  add('obs', 'Overlay OBS', () => {
    const o = (cfg.obs && typeof cfg.obs === 'object') ? cfg.obs : {};
    const st = (d.obs && typeof d.obs === 'object') ? d.obs : {};
    if (!o.enabled) return { state: SKIP, detail: 'mode streamer désactivé' };
    if (st.running) {
      return { state: OK,
        detail: 'servi sur http://127.0.0.1:' + (st.port || o.port) + '/overlay' };
    }
    return { state: FAIL,
      detail: 'activé, mais le serveur n’est pas démarré'
        + (st.error ? ' (' + st.error + ')' : ''),
      hint: 'Le port ' + (o.port || '?') + ' est probablement déjà pris : change-le'
        + ' dans les réglages, puis mets à jour l’URL de la source Navigateur d’OBS.' };
  });

  // ───────── Cosmétiques ─────────
  add('cosmetics', 'Swaps cosmétiques', () => {
    const c = d.cosmetics;
    if (!c || typeof c !== 'object') return { state: SKIP, detail: 'module indisponible' };
    const swaps = Array.isArray(c.swaps) ? c.swaps.filter(Boolean) : [];
    if (!swaps.length) return { state: SKIP, detail: 'aucun swap posé' };
    const by = {};
    for (const s of swaps) {
      const k = String(s.status || 'inconnu');
      by[k] = (by[k] || 0) + 1;
    }
    const detail = swaps.length + ' swap(s) : '
      + Object.keys(by).map((k) => by[k] + ' ' + (SWAP_STATES[k] || k)).join(', ')
      + (c.gameRunning ? ' — jeu ouvert, aucune écriture possible' : '');
    if (by.missing) {
      return { state: FAIL, detail: detail,
        hint: 'Un fichier cible a disparu : retire le swap concerné, puis lance une'
          + ' « Vérification de l’intégrité des fichiers » dans Steam.' };
    }
    if (by.reverted) {
      return { state: WARN, detail: detail,
        hint: 'Une mise à jour du jeu a remis les fichiers d’origine. Ils seront'
          + ' réappliqués tout seuls à la prochaine FERMETURE de Rocket League.' };
    }
    return { state: OK, detail: detail };
  });

  // `ok` ne retient que les vraies pannes : un « warn » signale quelque chose à
  // regarder, pas un mécanisme cassé, et un « skip » veut dire qu'on n'a pas pu
  // conclure. Le passer au rouge pour ça rendrait le voyant inutile — il serait
  // rouge en permanence, jeu fermé.
  return {
    at: at,
    ok: !checks.some((c) => c.state === FAIL),
    checks: checks,
  };
}

module.exports = { run };
module.exports.STATES = { OK: OK, WARN: WARN, FAIL: FAIL, SKIP: SKIP };
