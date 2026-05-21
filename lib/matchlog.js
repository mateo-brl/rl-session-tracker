// lib/matchlog.js — Journal des matchs, alimenté par l'agent (API du jeu).
//
// Depuis la v2.3, le détail des matchs (résultat, buts, arrêts…) ne vient plus
// de tracker.gg mais de la Stats API de Rocket League, via l'agent. Ce module
// stocke ces matchs par joueur et sait les restituer dans le format de flux
// « sessions » que le dashboard sait déjà lire — la partie React est ainsi
// inchangée.
//
// tracker.gg ne sert plus QUE pour le MMR / le rang : chaque match est
// « tamponné » avec le MMR relevé après lui (stampMMR).

const fs = require('fs');
const path = require('path');

const FILE = process.env.MATCHLOG_FILE || path.join(__dirname, '..', 'matchlog.json');
const MAX_PER_PLAYER = 200;                 // borne la taille du journal
const SESSION_GAP_MS = 3 * 60 * 60 * 1000;  // 3 h sans match = nouvelle session

let logs = {};            // playerId → [ match ]
let loadedOnce = false;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    logs = (raw && typeof raw.players === 'object' && raw.players) || {};
    loadedOnce = true;
  } catch (e) {
    if (e.code === 'ENOENT') { logs = {}; loadedOnce = true; }
    else {
      console.error('[matchlog] lecture impossible (' + e.message + ')'
        + (loadedOnce ? ' — journal en mémoire conservé' : ''));
    }
  }
  return logs;
}

// Écriture atomique (fichier temporaire puis rename).
function persist() {
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ players: logs }, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

// Ajoute un match terminé. `m` : { mode, result:'W'|'L', goals, saves, assists,
// shots, mvp, endedAt }. Le MMR est inconnu ici — il sera renseigné par
// stampMMR au prochain relevé tracker.gg.
function addMatch(playerId, m) {
  const list = logs[playerId] || (logs[playerId] = []);
  list.push({
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    mode: m.mode,
    result: m.result,
    goals: m.goals | 0,
    saves: m.saves | 0,
    assists: m.assists | 0,
    shots: m.shots | 0,
    mvp: !!m.mvp,
    endedAt: m.endedAt || Date.now(),
    mmrAfter: null,
  });
  if (list.length > MAX_PER_PLAYER) list.splice(0, list.length - MAX_PER_PLAYER);
  persist();
}

// Renseigne le MMR des matchs après un relevé tracker.gg. `modeMMR` :
// { '2v2': 1234, … }. Le DERNIER match de chaque mode suit le MMR courant
// (tracker.gg met du temps à se mettre à jour) ; les matchs plus anciens sont
// figés une fois pour toutes dès qu'un match plus récent les remplace.
function stampMMR(playerId, modeMMR) {
  const list = logs[playerId];
  if (!list || !list.length) return;
  const lastIdxByMode = {};
  list.forEach((m, i) => { lastIdxByMode[m.mode] = i; });
  let changed = false;
  list.forEach((m, i) => {
    const mmr = modeMMR[m.mode];
    if (mmr == null) return;
    if (i === lastIdxByMode[m.mode]) {
      if (m.mmrAfter !== mmr) { m.mmrAfter = mmr; changed = true; }
    } else if (m.mmrAfter == null) {
      m.mmrAfter = mmr; changed = true;
    }
  });
  if (changed) persist();
}

// Restitue les matchs d'un joueur dans le format du flux « sessions » de
// tracker.gg, attendu tel quel par parseSessions() du dashboard.
function toSessionsPayload(playerId) {
  const list = (logs[playerId] || []).slice().sort((a, b) => a.endedAt - b.endedAt);

  // Delta de MMR par match : différence avec le match précédent DU MÊME MODE.
  const delta = {};
  const lastMmrByMode = {};
  for (const m of list) {
    const prev = lastMmrByMode[m.mode];
    delta[m.id] = (m.mmrAfter != null && prev != null) ? (m.mmrAfter - prev) : 0;
    if (m.mmrAfter != null) lastMmrByMode[m.mode] = m.mmrAfter;
  }

  // Découpage en sessions (coupure après 3 h sans match).
  const sessions = [];
  let cur = null;
  for (const m of list) {
    if (!cur || m.endedAt - cur._last > SESSION_GAP_MS) {
      cur = { matches: [], _last: m.endedAt };
      sessions.push(cur);
    }
    cur._last = m.endedAt;
    cur.matches.push(m);
  }

  const items = sessions.map((s) => ({
    matches: s.matches.map((m) => ({
      id: m.id,
      metadata: {
        result: m.result === 'W' ? 'victory' : 'defeat',
        playlist: m.mode,                 // '1v1' / '2v2' / '3v3'
        dateCollected: new Date(m.endedAt).toISOString(),
      },
      stats: {
        goals: { value: m.goals },
        saves: { value: m.saves },
        assists: { value: m.assists },
        shots: { value: m.shots },
        mvps: { value: m.mvp ? 1 : 0 },
        rating: {
          value: m.mmrAfter || 0,
          metadata: { ratingDelta: delta[m.id] || 0 },
        },
      },
    })),
  }));
  return { data: { items } };
}

// Retire les joueurs qui ne sont plus déclarés.
function prune(validIds) {
  let changed = false;
  for (const id of Object.keys(logs)) {
    if (!validIds.has(id)) { delete logs[id]; changed = true; }
  }
  if (changed) persist();
}

module.exports = { FILE, load, addMatch, stampMMR, toSessionsPayload, prune };
