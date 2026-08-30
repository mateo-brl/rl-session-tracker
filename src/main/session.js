// session.js — Journal des matchs et statistiques.
//
// Chaque match terminé (ou abandonné) est enregistré BRUT dans
// userData/matches.json : score, vainqueur, stats de tous les joueurs,
// classé/casual, forfait. Le point de vue du joueur suivi (victoire/défaite,
// stats perso, MVP) est dérivé au calcul à partir du pseudo configuré —
// changer de pseudo recalcule donc tout rétroactivement.
//
// Le journal est PERMANENT (borné aux 2000 derniers matchs) : il alimente la
// courbe d'évolution du MMR, le bilan des 7 derniers jours et les records.
// La liste des « matchs récents », elle, repart de zéro à chaque lancement
// (ou via le bouton « Vider »), simple curseur dans le journal.

const fs = require('fs');
const path = require('path');

const MAX_MATCHES = 2000;                      // borne la taille du journal
// Les évènements bruts ne sont conservés que pour les matchs RÉCENTS : gardés
// sur les 2000, ils feraient gonfler matches.json de plusieurs mégaoctets, or
// le fichier est réécrit intégralement après chaque match. Passé ce seuil,
// seul le résultat déjà calculé subsiste — ce qui suffit largement.
const EVENTS_KEPT = 100;
const MAX_READINGS = 400;    // ancres de MMR conservées par mode
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;     // 2 h sans match = nouvelle session
const HISTORY_SHOWN = 30;                      // matchs envoyés au dashboard
const MMR_STEP = 9;                            // gain/perte moyen d'un match classé
// Bornes de plausibilité du pas appris : en dessous/au-dessus, c'est que le
// calcul a été faussé (matchs joués sur un autre compte, playlist mal
// attribuée, relevé manqué) — on préfère alors garder la valeur par défaut.
const MMR_STEP_MIN = 4;
const MMR_STEP_MAX = 20;
const EVOLUTION_POINTS = 80;                   // points max de la courbe MMR
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Paliers Rocket League : le journal du jeu donne un numéro (PartyLeaderTier),
// le joueur, lui, raisonne en rang. 0 = non classé, 22 = Supersonic Legend.
const TIERS = [
  'Non classé',
  'Bronze I', 'Bronze II', 'Bronze III',
  'Argent I', 'Argent II', 'Argent III',
  'Or I', 'Or II', 'Or III',
  'Platine I', 'Platine II', 'Platine III',
  'Diamant I', 'Diamant II', 'Diamant III',
  'Champion I', 'Champion II', 'Champion III',
  'Grand Champion I', 'Grand Champion II', 'Grand Champion III',
  'Supersonic Legend',
];

function tierName(tier) {
  const n = Number(tier);
  return Number.isInteger(n) && n >= 0 && n < TIERS.length ? TIERS[n] : null;
}

// Seuils de MMR (début de division 1 de chaque palier), PAR playlist : les
// échelles diffèrent — 640 en 1v1 est Platine quand 640 en 2v2 est encore Or.
//
// POURQUOI dériver le rang du MMR plutôt que lire `PartyLeaderTier` dans le
// journal : constaté en jeu (30 août 2026), ce champ n'est pas le palier de la
// playlist mise en file — un joueur Platine en 1v1 se voyait « Champion », son
// meilleur rang ailleurs. Le MMR relevé, lui, est validé exact. Les seuils
// bougent de quelques points à chaque saison : le rang affiché est donc juste
// au palier près, ce qui est l'objectif (pas la division).
const RANK_THRESHOLDS = {
  '1v1': [0, 150, 213, 275, 335, 395, 445, 514, 575, 635, 695, 755,
    815, 875, 935, 995, 1076, 1188, 1300, 1436, 1573, 1710],
  '2v2': [0, 174, 235, 295, 355, 415, 475, 535, 595, 655, 715, 775,
    835, 915, 995, 1075, 1195, 1315, 1435, 1575, 1715, 1876],
  '3v3': [0, 174, 235, 295, 355, 415, 475, 535, 595, 655, 715, 775,
    835, 915, 995, 1075, 1195, 1315, 1435, 1575, 1715, 1876],
};

// Palier (1-22) déduit du MMR pour une playlist. `null` hors classé (4v4) ou
// sans relevé — on préfère ne rien afficher qu'afficher faux.
function tierFromMmr(mode, mmr) {
  const table = RANK_THRESHOLDS[mode];
  const v = Number(mmr);
  if (!table || !Number.isFinite(v) || v <= 0) return null;
  let tier = 1;
  for (let i = 0; i < table.length; i++) {
    if (v >= table[i]) tier = i + 1;
  }
  return tier;
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

class SessionStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'matches.json');
    this.matches = [];        // ordre chronologique, données brutes
    this.resetAt = 0;         // début de la liste des « matchs récents »
    this.playersSeen = [];    // pseudos croisés récemment (aide à la config)
    // Relevés de MMR lus dans le journal du jeu : '2v2' → [{ t, v, tier }].
    // Ce sont des ANCRES : chacune est une valeur vraie, datée. La courbe est
    // reconstruite à partir d'elles, au lieu d'être remise à zéro à chaque
    // recalage — ce qui la réduisait à un point unique.
    this.mmrReadings = {};
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.matches = Array.isArray(raw.matches) ? raw.matches : [];
      this.resetAt = raw.resetAt || 0;
      this.playersSeen = Array.isArray(raw.playersSeen) ? raw.playersSeen : [];
      this.mmrReadings = (raw.mmrReadings && typeof raw.mmrReadings === 'object')
        ? raw.mmrReadings : {};
    } catch (e) {
      // ENOENT = vrai premier lancement, rien à sauver.
      // Tout le reste = le fichier EXISTE mais est illisible. Or l'application
      // appelle resetSession() dès le démarrage, qui réécrit aussitôt le
      // fichier : sans copie de sauvegarde, un JSON simplement tronqué (souvent
      // récupérable à la main) était définitivement remplacé par un journal
      // vide quelques millisecondes après le lancement — 2000 matchs, courbe
      // MMR et records perdus sans le moindre message.
      if (e && e.code !== 'ENOENT') this._backupCorrupt(e);
    }
  }

  _backupCorrupt(cause) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(this.file, this.file + '.corrupt-' + stamp);
      this.corrupt = { at: Date.now(), reason: String((cause && cause.message) || cause) };
    } catch (e) { /* rien de plus à tenter : on démarre sur un journal vide */ }
  }

  // Écriture atomique (fichier temporaire puis rename).
  _persist() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        matches: this.matches,
        resetAt: this.resetAt,
        playersSeen: this.playersSeen,
        mmrReadings: this.mmrReadings,
      }) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) { /* le journal en mémoire reste valable */ }
  }

  // Enregistre un match, et renvoie `true` s'il a réellement été ajouté au
  // journal. L'appelant DOIT s'y fier avant de rejouer la bannière et le
  // jingle de fin : sur un doublon, `history[0]` est le match PRÉCÉDENT, et
  // on le fêtait une seconde fois.
  // `snap` : snapshot de la Stats API ({ mode, score,
  // isOT, winnerTeam, players, endedAt }), enrichi par l'appelant de
  // `ranked` (classé ou casual) et `forfeit` (abandon).
  addMatch(snap) {
    const players = Array.isArray(snap.players) ? snap.players : [];
    if (players.length < 2) return false;   // entraînement / piste libre — jamais compté
    // MatchGuid : identifiant du match côté serveur (en ligne uniquement). Il
    // rend le journal idempotent — un même match ne peut plus être enregistré
    // deux fois, quelle que soit la route d'arrivée (fin normale puis abandon,
    // reconnexion du socket pendant l'écran de fin...).
    if (snap.guid && this.matches.some((m) => m.guid === snap.guid)) return false;
    this._rememberPlayers(players);

    this.matches.push({
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      endedAt: snap.endedAt || Date.now(),
      mode: snap.mode || '?',
      score: Array.isArray(snap.score) ? snap.score : null,
      isOT: !!snap.isOT,
      winnerTeam: (snap.winnerTeam === 0 || snap.winnerTeam === 1) ? snap.winnerTeam : null,
      ranked: snap.ranked !== false,
      forfeit: !!snap.forfeit,
      podium: !!snap.podium,
      guid: snap.guid || null,
      // Évènements marquants tels que le jeu les a envoyés. Conservés pour
      // pouvoir réinterpréter un match a posteriori quand la logique
      // s'affine, sans dépendre du résultat déjà calculé.
      events: Array.isArray(snap.events) ? snap.events : [],
      players: players.map((p) => ({
        name: p.name, team: p.team,
        goals: p.goals | 0, saves: p.saves | 0, assists: p.assists | 0,
        shots: p.shots | 0, score: p.score | 0,
      })),
    });
    if (this.matches.length > MAX_MATCHES) {
      this.matches.splice(0, this.matches.length - MAX_MATCHES);
    }
    for (let i = 0; i < this.matches.length - EVENTS_KEPT; i++) {
      if (this.matches[i].events) this.matches[i].events = [];
    }
    this._persist();
    return true;
  }

  // Enregistre un relevé de MMR. Renvoie `true` si c'est une nouvelle ancre.
  // Un même relevé répété (le joueur relance une file sans avoir joué) ne
  // crée pas de point supplémentaire.
  addMmrReading(mode, value, tier) {
    const v = Math.round(Number(value));
    if (!mode || !Number.isFinite(v) || v <= 0) return false;
    const list = this.mmrReadings[mode] || (this.mmrReadings[mode] = []);
    const last = list[list.length - 1];
    if (last && last.v === v) return false;
    list.push({ t: Date.now(), v: v, tier: Number.isFinite(tier) ? tier : null });
    if (list.length > MAX_READINGS) list.splice(0, list.length - MAX_READINGS);
    this._persist();
    return true;
  }

  // Dernière ancre connue d'un mode.
  lastReading(mode) {
    const list = this.mmrReadings[mode] || [];
    return list.length ? list[list.length - 1] : null;
  }

  // Correction manuelle du résultat d'un match : 'W', 'L', ou null pour
  // revenir au calcul automatique. Le dernier recours quand ni le flux ni le
  // journal n'ont permis de trancher un forfait — l'utilisateur, lui, sait.
  overrideResult(id, result, pseudo) {
    const m = this.matches.find((x) => x.id === id);
    if (!m) return false;
    if (result !== 'W' && result !== 'L') {
      delete m.overrideWinner;
      this._persist();
      return true;
    }
    const me = m.players.find((p) => norm(p.name) === norm(pseudo));
    if (!me) return false;              // sans équipe connue, pas de correction
    m.overrideWinner = result === 'W' ? me.team : (me.team === 0 ? 1 : 0);
    this._persist();
    return true;
  }

  // ───────── Réconciliation des forfaits par le vrai MMR ─────────
  // Un forfait adverse suivi d'un départ immédiat peut arriver au tracker
  // sans AUCUN signal exploitable (ni vainqueur annoncé, ni podium) : il est
  // alors compté défaite. Mais la vérité finit toujours par arriver — le
  // prochain relevé du journal du jeu. Si la variation RÉELLE du MMR entre
  // deux relevés contredit le bilan enregistré d'exactement deux pas (la
  // signature d'un résultat inversé) et qu'UN SEUL forfait ambigu peut
  // l'expliquer, on le corrige. Ambiguïté ou intervalle troué : on ne touche
  // à rien — la correction manuelle reste possible.
  reconcileForfeits(mode, from, to, newValue, step, pseudo) {
    if (!from || !Number.isFinite(from.v) || !Number.isFinite(newValue)) return null;
    const d = this.decidedBetween(mode, from.t, to, pseudo);
    if (d.unmatched) return null;                 // intervalle troué : refus
    const total = d.wins + d.losses;
    if (!total || total > 8) return null;         // trop de bruit accumulé
    const diff = (newValue - from.v) - d.net * step;

    const me = norm(pseudo);
    const candidates = this.matches.filter((m) => {
      if (m.mode !== mode || m.ranked === false) return false;
      if (m.endedAt <= from.t || m.endedAt > to) return false;
      if (!m.forfeit || m.winnerTeam !== null) return false;
      if (m.overrideWinner === 0 || m.overrideWinner === 1) return false;
      return m.players.some((p) => norm(p.name) === me);
    });

    // Un « L » qui aurait dû être « W » gonfle diff de +2 pas (à un pas près
    // de tolérance : les vrais gains varient d'un match à l'autre).
    let want = null;
    if (diff >= step && diff <= 3 * step) want = 'L';
    else if (diff <= -step && diff >= -3 * step) want = 'W';
    if (!want) return null;

    const fixable = candidates.filter((m) => this._evaluate(m, pseudo).result === want);
    if (fixable.length !== 1) return null;        // zéro ou plusieurs : ambigu

    const m = fixable[0];
    const mine = m.players.find((p) => norm(p.name) === me);
    if (!mine) return null;
    m.overrideWinner = want === 'L'
      ? mine.team                                  // le L devient W : notre équipe
      : (mine.team === 0 ? 1 : 0);                 // le W devient L : l'autre
    this._persist();
    return { id: m.id, flipped: want === 'L' ? 'W' : 'L' };
  }

  _rememberPlayers(players) {
    for (const p of players) {
      const name = String(p.name || '').trim();
      if (!name) continue;
      const i = this.playersSeen.findIndex((n) => norm(n) === norm(name));
      if (i !== -1) this.playersSeen.splice(i, 1);
      this.playersSeen.unshift(name);
    }
    this.playersSeen = this.playersSeen.slice(0, 12);
  }

  // Vide la liste des matchs récents (le journal, lui, est conservé : la
  // courbe d'évolution et les records continuent de tout voir).
  resetSession() {
    this.resetAt = Date.now();
    this._persist();
  }

  // Devine le pseudo du joueur suivi sans rien demander : c'est le seul nom
  // présent dans TOUS les derniers matchs (lui est toujours là, les
  // adversaires changent). Ambigu si un coéquipier fixe joue toute la
  // session — dans ce cas on renvoie les candidats et l'interface propose
  // un choix en un clic.
  detectPseudo() {
    const recent = this.matches.slice(-3);
    if (recent.length < 2) return { auto: null, candidates: [] };
    let names = recent[0].players.map((p) => norm(p.name));
    for (const m of recent.slice(1)) {
      const set = new Set(m.players.map((p) => norm(p.name)));
      names = names.filter((n) => set.has(n));
    }
    const last = recent[recent.length - 1];
    const candidates = names
      .map((n) => (last.players.find((p) => norm(p.name) === n) || {}).name)
      .filter(Boolean);
    return { auto: candidates.length === 1 ? candidates[0] : null, candidates };
  }

  // Bilan « déjà croisé » : pour chaque adversaire du match en cours, tous
  // les matchs du journal où ce joueur était dans l'équipe ADVERSE, et le
  // résultat de notre point de vue. Le match en cours n'est pas encore dans
  // le journal : le bilan est purement historique.
  headToHead(names, pseudo) {
    const me = norm(pseudo);
    // Object.create(null) : les clés sont des PSEUDOS ADVERSES arbitraires.
    // Sur un objet ordinaire, un joueur nommé « constructor », « toString » ou
    // « __proto__ » renvoyait la propriété héritée d'Object.prototype — le
    // bilan s'écrivait alors dans le prototype au lieu de l'entrée attendue,
    // et l'interface affichait « undefinedV – undefinedD ».
    const out = Object.create(null);
    if (!me || !Array.isArray(names) || !names.length) return out;
    const wanted = new Map();              // nom normalisé → nom affiché
    for (const n of names) {
      const k = norm(n);
      if (k && k !== me) wanted.set(k, String(n));
    }
    if (!wanted.size) return out;

    for (const m of this.matches) {
      const mine = m.players.find((p) => norm(p.name) === me);
      if (!mine) continue;
      let result;                          // évalué au premier adversaire trouvé
      for (const p of m.players) {
        const k = norm(p.name);
        if (!wanted.has(k) || p.team === mine.team) continue;
        if (result === undefined) result = this._evaluate(m, pseudo).result;
        const h = out[wanted.get(k)] ||
          (out[wanted.get(k)] = { played: 0, wins: 0, losses: 0 });
        h.played++;
        if (result === 'W') h.wins++;
        else if (result === 'L') h.losses++;
      }
    }
    return out;
  }

  // Dérive le point de vue du joueur suivi sur un match brut.
  _evaluate(m, pseudo) {
    const me = m.players.find((p) => norm(p.name) === norm(pseudo)) || null;

    // Correction (manuelle ou réconciliée par le vrai MMR) : elle est stockée
    // en ÉQUIPE gagnante, pas en « victoire/défaite » — le point de vue
    // dépend du pseudo, qui peut changer, alors que l'équipe est un fait.
    const ow = (m.overrideWinner === 0 || m.overrideWinner === 1)
      ? m.overrideWinner : null;

    let result = null;                  // 'W' | 'L' | null (joueur non identifié)
    let mvp = false;
    if (ow !== null) {
      if (me) result = me.team === ow ? 'W' : 'L';
      if (me && result === 'W' && me.score > 0) {
        mvp = m.players.every((p) => p === me || p.score <= me.score);
      }
    } else if (m.forfeit) {
      // Abandon : si le jeu a eu le temps d'annoncer un vainqueur (forfait
      // ADVERSE attrapé via bHasWinner), on le respecte.
      const w = (m.winnerTeam === 0 || m.winnerTeam === 1) ? m.winnerTeam : null;
      if (me && w !== null) {
        result = me.team === w ? 'W' : 'L';
      } else if (me && m.podium) {
        // Pas de vainqueur annoncé, MAIS le podium avait été atteint : le jeu
        // avait donc déjà conclu le match (c'est le cas du forfait ADVERSE) et
        // notre départ n'était qu'une sortie d'écran de fin. On déduit du
        // score — une équipe ne vote pas le forfait en étant devant.
        if (m.score && m.score[0] !== m.score[1]) {
          result = (m.score[0] > m.score[1] ? 0 : 1) === me.team ? 'W' : 'L';
        }
      } else if (me) {
        // Ni vainqueur, ni podium : nous avons quitté une partie EN COURS.
        // En classé le jeu compte une défaite, quel que soit le score.
        result = 'L';
      }
    } else {
      // Vainqueur : annoncé par le jeu, sinon déduit du score.
      let winner = m.winnerTeam;
      if (winner === null && m.score && m.score[0] !== m.score[1]) {
        winner = m.score[0] > m.score[1] ? 0 : 1;
      }
      if (me && winner !== null) result = me.team === winner ? 'W' : 'L';
      // MVP : meilleur score du match ET dans l'équipe gagnante (règle du jeu).
      if (me && result === 'W' && me.score > 0) {
        mvp = m.players.every((p) => p === me || p.score <= me.score);
      }
    }

    return {
      id: m.id, endedAt: m.endedAt, mode: m.mode,
      score: m.score, isOT: m.isOT,
      ranked: m.ranked !== false,
      forfeit: !!m.forfeit,
      podium: !!m.podium,
      overridden: ow !== null,
      result: result,
      myTeam: me ? me.team : null,
      me: me ? {
        goals: me.goals, saves: me.saves, assists: me.assists,
        shots: me.shots, score: me.score, mvp: mvp,
      } : null,
    };
  }

  // Pas réellement observé pour ce mode, quand on a pu l'apprendre en
  // comparant deux relevés du journal du jeu ; sinon la moyenne générique.
  // Les vrais gains varient (~6 à 12 selon l'écart de MMR), donc un pas figé
  // à 9 introduisait une erreur systématique entre deux recalages.
  _step(mode, cfg) {
    const learned = cfg && cfg.mmrStep && Number(cfg.mmrStep[mode]);
    if (Number.isFinite(learned) && learned >= MMR_STEP_MIN && learned <= MMR_STEP_MAX) {
      return learned;
    }
    return MMR_STEP;
  }

  // Bilan des matchs classés d'un mode sur un intervalle : sert à apprendre le
  // vrai pas MMR (variation réelle entre deux relevés ÷ victoires nettes).
  decidedBetween(mode, from, to, pseudo) {
    let wins = 0;
    let losses = 0;
    let unmatched = 0;
    for (const m of this.matches) {
      if (m.mode !== mode || m.ranked === false) continue;
      if (m.endedAt <= from || m.endedAt > to) continue;
      const e = this._evaluate(m, pseudo);
      if (e.result === 'W') wins++;
      else if (e.result === 'L') losses++;
      // TOUT match sans verdict troue l'intervalle : qu'on ne s'y soit pas
      // reconnu OU que le résultat soit indécidable (forfait à score égal), il
      // a bougé le vrai MMR sans apparaître dans `net`. Ne compter que le
      // premier cas laissait passer des intervalles troués et le pas appris
      // sortait gonflé d'autant.
      else unmatched++;
    }
    return { wins, losses, unmatched, net: wins - losses };
  }

  // ───────── Courbe d'évolution du MMR ─────────
  // Construite sur une CHRONOLOGIE : chaque relevé du journal du jeu est une
  // ancre (valeur vraie, datée) ; entre deux ancres, les matchs classés font
  // bouger la valeur du pas estimé. La courbe suit donc la réalité et se
  // corrige à chaque file, au lieu d'être remise à zéro.
  //
  // C'était le bug : le recalage repoussait `setAt` à « maintenant » et la
  // courbe, qui ne gardait que les matchs postérieurs, se réduisait à un seul
  // point à chaque mise en file.
  _timeline(mode, entry, pseudo, step) {
    const anchors = (this.mmrReadings[mode] || [])
      .filter((a) => a && Number.isFinite(a.v))
      .slice()
      .sort((a, b) => a.t - b.t);

    // Point de départ : la première ancre si on en a une, sinon la base
    // saisie à la main (comportement historique, sans relevé du journal).
    const startAt = anchors.length ? anchors[0].t : (entry ? entry.setAt : 0);
    let v = anchors.length ? anchors[0].v : (entry ? entry.base : null);
    if (v === null || !Number.isFinite(v)) return [];

    const events = [];
    for (const a of anchors.slice(1)) events.push({ t: a.t, anchor: a });
    for (const m of this.matches) {
      if (m.mode !== mode || m.ranked === false || m.endedAt <= startAt) continue;
      const r = this._evaluate(m, pseudo).result;
      if (r === 'W' || r === 'L') events.push({ t: m.endedAt, win: r === 'W' });
    }
    events.sort((a, b) => a.t - b.t);

    const points = [{ t: startAt, v: Math.round(v), real: true }];
    for (const e of events) {
      if (e.anchor) v = e.anchor.v;                 // la vérité reprend la main
      else v += e.win ? step : -step;
      points.push({ t: e.t, v: Math.round(v), real: !!e.anchor });
    }
    return points;
  }

  // Valeur courante : le dernier point de la chronologie.
  _mmrForMode(mode, entry, pseudo, step) {
    const pts = this._timeline(mode, entry, pseudo, step);
    return pts.length ? pts[pts.length - 1].v : (entry ? entry.base : null);
  }

  // Variation depuis un instant donné (début de session) : différence entre la
  // valeur d'alors et la valeur courante. C'est le « +27 en 2v2 ce soir » que
  // l'on veut lire d'un coup d'œil.
  _mmrDeltaSince(mode, entry, pseudo, step, since) {
    const pts = this._timeline(mode, entry, pseudo, step);
    if (pts.length < 2) return null;
    let before = null;
    for (const p of pts) {
      if (p.t <= since) before = p;
      else break;
    }
    if (before === null) return null;
    return pts[pts.length - 1].v - before.v;
  }

  _evolutionForMode(mode, entry, pseudo, step) {
    return this._timeline(mode, entry, pseudo, step).slice(-EVOLUTION_POINTS);
  }

  // Bilan des 7 derniers jours + records de tous les temps.
  _longTerm(pseudo) {
    const weekStart = Date.now() - WEEK_MS;
    const week = { played: 0, wins: 0, losses: 0, winrate: null };
    const records = { bestWinStreak: 0, bestDayWins: 0, totalPlayed: 0 };
    const dayWins = {};
    let run = 0;
    for (const raw of this.matches) {
      const m = this._evaluate(raw, pseudo);
      records.totalPlayed++;
      if (m.endedAt >= weekStart) {
        week.played++;
        if (m.result === 'W') week.wins++;
        else if (m.result === 'L') week.losses++;
      }
      if (m.result === 'W') {
        run++;
        if (run > records.bestWinStreak) records.bestWinStreak = run;
        const day = new Date(m.endedAt).toISOString().slice(0, 10);
        dayWins[day] = (dayWins[day] || 0) + 1;
        if (dayWins[day] > records.bestDayWins) records.bestDayWins = dayWins[day];
      } else if (m.result === 'L') {
        run = 0;
      }
    }
    const decided = week.wins + week.losses;
    week.winrate = decided ? Math.round((week.wins / decided) * 100) : null;
    return { week, records };
  }

  // Matchs récents : depuis le dernier « Vider » (ou le lancement de
  // l'application), sans coupure de plus de 2 h entre deux matchs.
  _sessionMatches() {
    const out = [];
    for (let i = this.matches.length - 1; i >= 0; i--) {
      const m = this.matches[i];
      // <= : un match enregistré dans la même milliseconde que le « Vider »
      // appartient au passé, lui aussi.
      if (m.endedAt <= this.resetAt) break;
      if (out.length && out[0].endedAt - m.endedAt > SESSION_GAP_MS) break;
      out.unshift(m);
    }
    return out;
  }

  // Lignes d'export : le point de vue calculé (victoire/défaite, stats perso)
  // ET les données brutes du match. Le JSON doit rester ré-importable et
  // ré-interprétable — n'exporter que l'évaluation aurait laissé de côté les
  // adversaires, leurs stats, le vainqueur annoncé et la trace d'évènements.
  exportRows(pseudo) {
    return this.matches.map((m) => ({
      ...this._evaluate(m, pseudo),
      winnerTeam: m.winnerTeam,
      guid: m.guid || null,
      players: m.players,
      events: m.events || [],
    }));
  }

  // Statistiques agrégées envoyées aux fenêtres.
  snapshot(pseudo, cfg) {
    // « Ne compter que le classé » : les parties casual restent au journal
    // (rien n'est perdu) mais disparaissent de la session et de ses totaux.
    const rankedOnly = !!(cfg && cfg.rankedOnly);
    const session = this._sessionMatches()
      .filter((m) => !rankedOnly || m.ranked !== false)
      .map((m) => this._evaluate(m, pseudo));

    const agg = {
      startedAt: session.length ? session[0].endedAt : null,
      played: session.length,
      wins: 0, losses: 0, unknown: 0,
      unmatched: 0,      // sous-ensemble d'`unknown` : pseudo introuvable
      streak: { type: null, count: 0 },
      bestWinStreak: 0,
      perMode: {},        // '2v2' → { played, wins, losses, streak, rankedDiff }
      totals: { goals: 0, saves: 0, assists: 0, shots: 0, score: 0, mvps: 0 },
    };

    let run = 0;
    for (const m of session) {
      if (m.result === 'W') agg.wins++;
      else if (m.result === 'L') agg.losses++;
      else {
        agg.unknown++;
        // Seul le cas « on ne s'est pas trouvé dans le match » relève du
        // pseudo. Un forfait indécidable (score à égalité, aucun vainqueur
        // annoncé) n'a rien à voir avec lui : le signaler comme tel envoyait
        // l'utilisateur corriger un pseudo pourtant correct.
        if (!m.me) agg.unmatched++;
      }

      if (m.result === 'W') {
        run = run >= 0 ? run + 1 : 1;
        if (run > agg.bestWinStreak) agg.bestWinStreak = run;
      } else if (m.result === 'L') {
        run = run <= 0 ? run - 1 : -1;
      }

      const mode = agg.perMode[m.mode] ||
        (agg.perMode[m.mode] = {
          played: 0, wins: 0, losses: 0,
          streak: { type: null, count: 0 }, rankedDiff: 0,
        });
      mode.played++;
      if (m.result === 'W') mode.wins++;
      else if (m.result === 'L') mode.losses++;
      if (m.result === 'W' || m.result === 'L') {
        if (mode.streak.type === m.result) mode.streak.count++;
        else { mode.streak.type = m.result; mode.streak.count = 1; }
        if (m.ranked) mode.rankedDiff += (m.result === 'W' ? 1 : -1);
      }

      if (m.me) {
        agg.totals.goals += m.me.goals;
        agg.totals.saves += m.me.saves;
        agg.totals.assists += m.me.assists;
        agg.totals.shots += m.me.shots;
        agg.totals.score += m.me.score;
        if (m.me.mvp) agg.totals.mvps++;
      }
    }
    agg.streak = run > 0 ? { type: 'W', count: run }
      : run < 0 ? { type: 'L', count: -run }
      : { type: null, count: 0 };
    const decided = agg.wins + agg.losses;
    agg.winrate = decided ? Math.round((agg.wins / decided) * 100) : null;

    // MMR estimé + courbe d'évolution, par mode calibré.
    agg.mmr = {};
    const evolution = {};
    const mmrCfg = (cfg && cfg.mmr) || {};
    for (const mode of Object.keys(mmrCfg)) {
      const entry = mmrCfg[mode];
      if (!entry || !Number.isFinite(entry.base)) continue;
      const pm = agg.perMode[mode];
      const step = this._step(mode, cfg);
      const value = this._mmrForMode(mode, entry, pseudo, step);
      // Variation de la session : mesurée sur la chronologie quand elle
      // remonte assez loin (donc au vrai MMR), sinon estimée au pas.
      const since = agg.startedAt ? agg.startedAt - 1 : null;
      const real = since === null
        ? null : this._mmrDeltaSince(mode, entry, pseudo, step, since);
      // Rang dérivé du MMR courant, jamais du palier du journal (peu fiable
      // par playlist — voir RANK_THRESHOLDS). Sans relevé du journal pour ce
      // mode, le MMR n'est qu'une base saisie à la main : on n'affiche un rang
      // que si un vrai relevé existe.
      const hasReading = !!this.lastReading(mode);
      const tier = hasReading ? tierFromMmr(mode, value) : null;
      agg.mmr[mode] = {
        value: value === null ? null : Math.round(value),
        delta: real !== null ? real : (pm ? Math.round(step * pm.rankedDiff) : 0),
        deltaReal: real !== null,
        step: step,
        fromLog: !!entry.fromLog,
        tier: tier,
        rank: tierName(tier),
      };
      evolution[mode] = this._evolutionForMode(mode, entry, pseudo, step);
    }

    const lt = this._longTerm(pseudo);

    return {
      session: agg,
      history: session.slice(-HISTORY_SHOWN).reverse(),
      playersSeen: this.playersSeen,
      evolution: evolution,
      week: lt.week,
      records: lt.records,
    };
  }
}

module.exports = SessionStore;
// Exportées : config.js et index.js valident et apprennent le pas MMR avec
// les MÊMES bornes — les répéter en littéraux les désynchronisait au premier
// ajustement.
module.exports.MMR_STEP_MIN = MMR_STEP_MIN;
module.exports.MMR_STEP_MAX = MMR_STEP_MAX;
module.exports.MMR_STEP = MMR_STEP;
module.exports.tierName = tierName;
module.exports.tierFromMmr = tierFromMmr;
module.exports.TIERS = TIERS;
