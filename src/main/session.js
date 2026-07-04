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
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;     // 2 h sans match = nouvelle session
const HISTORY_SHOWN = 30;                      // matchs envoyés au dashboard
const MMR_STEP = 9;                            // gain/perte moyen d'un match classé
const EVOLUTION_POINTS = 80;                   // points max de la courbe MMR
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

class SessionStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'matches.json');
    this.matches = [];        // ordre chronologique, données brutes
    this.resetAt = 0;         // début de la liste des « matchs récents »
    this.playersSeen = [];    // pseudos croisés récemment (aide à la config)
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.matches = Array.isArray(raw.matches) ? raw.matches : [];
      this.resetAt = raw.resetAt || 0;
      this.playersSeen = Array.isArray(raw.playersSeen) ? raw.playersSeen : [];
    } catch (e) { /* premier lancement */ }
  }

  // Écriture atomique (fichier temporaire puis rename).
  _persist() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        matches: this.matches,
        resetAt: this.resetAt,
        playersSeen: this.playersSeen,
      }) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) { /* le journal en mémoire reste valable */ }
  }

  // Enregistre un match. `snap` : snapshot de la Stats API ({ mode, score,
  // isOT, winnerTeam, players, endedAt }), enrichi par l'appelant de
  // `ranked` (classé ou casual) et `forfeit` (abandon).
  addMatch(snap) {
    const players = Array.isArray(snap.players) ? snap.players : [];
    if (players.length < 2) return;   // entraînement / piste libre — jamais compté
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
      players: players.map((p) => ({
        name: p.name, team: p.team,
        goals: p.goals | 0, saves: p.saves | 0, assists: p.assists | 0,
        shots: p.shots | 0, score: p.score | 0,
      })),
    });
    if (this.matches.length > MAX_MATCHES) {
      this.matches.splice(0, this.matches.length - MAX_MATCHES);
    }
    this._persist();
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
    const out = {};
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

    let result = null;                  // 'W' | 'L' | null (joueur non identifié)
    let mvp = false;
    if (m.forfeit) {
      // Abandon : si le jeu a eu le temps d'annoncer un vainqueur (forfait
      // ADVERSE attrapé via bHasWinner), on le respecte. Sinon c'est notre
      // départ : défaite, quel que soit le score au moment où l'on part.
      const w = (m.winnerTeam === 0 || m.winnerTeam === 1) ? m.winnerTeam : null;
      if (me) result = (w === null) ? 'L' : (me.team === w ? 'W' : 'L');
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
      result: result,
      myTeam: me ? me.team : null,
      me: me ? {
        goals: me.goals, saves: me.saves, assists: me.assists,
        shots: me.shots, score: me.score, mvp: mvp,
      } : null,
    };
  }

  // Seuls les matchs CLASSÉS font bouger le MMR estimé.
  _mmrForMode(mode, entry, pseudo) {
    let v = entry.base;
    for (const m of this.matches) {
      if (m.mode !== mode || m.ranked === false || m.endedAt <= entry.setAt) continue;
      const r = this._evaluate(m, pseudo).result;
      if (r === 'W') v += MMR_STEP;
      else if (r === 'L') v -= MMR_STEP;
    }
    return v;
  }

  // Courbe d'évolution du MMR d'un mode : un point par match classé depuis
  // le calibrage, en partant de la base.
  _evolutionForMode(mode, entry, pseudo) {
    const points = [{ t: entry.setAt, v: entry.base }];
    let v = entry.base;
    for (const m of this.matches) {
      if (m.mode !== mode || m.ranked === false || m.endedAt <= entry.setAt) continue;
      const r = this._evaluate(m, pseudo).result;
      if (r === 'W') v += MMR_STEP;
      else if (r === 'L') v -= MMR_STEP;
      else continue;
      points.push({ t: m.endedAt, v: v });
    }
    return points.slice(-EVOLUTION_POINTS);
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

  // Statistiques agrégées envoyées aux fenêtres.
  snapshot(pseudo, cfg) {
    const session = this._sessionMatches().map((m) => this._evaluate(m, pseudo));

    const agg = {
      startedAt: session.length ? session[0].endedAt : null,
      played: session.length,
      wins: 0, losses: 0, unknown: 0,
      streak: { type: null, count: 0 },
      bestWinStreak: 0,
      perMode: {},        // '2v2' → { played, wins, losses, streak, rankedDiff }
      totals: { goals: 0, saves: 0, assists: 0, shots: 0, score: 0, mvps: 0 },
    };

    let run = 0;
    for (const m of session) {
      if (m.result === 'W') agg.wins++;
      else if (m.result === 'L') agg.losses++;
      else agg.unknown++;

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
      agg.mmr[mode] = {
        value: this._mmrForMode(mode, entry, pseudo),
        delta: pm ? MMR_STEP * pm.rankedDiff : 0,
      };
      evolution[mode] = this._evolutionForMode(mode, entry, pseudo);
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
