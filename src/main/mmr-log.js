// mmr-log.js — Le vrai MMR et la file de matchmaking, lus dans Launch.log.
//
// Extrait d'index.js : le branchement du lecteur de journal (rl-log.js) sur
// la session. Décide si un match est classé et s'il vient d'une file, ancre
// les lectures de MMR (après le garde-fou de mmr-guard.js), apprend le gain
// moyen par match et corrige les forfaits mal comptés.

const RLLogReader = require('./rl-log');
const SessionStore = require('./session');
const mmrGuard = require('./mmr-guard');

const { MMR_STEP_MIN, MMR_STEP_MAX } = SessionStore;

// `ctx` : { state, config, log, pushState, refreshSession, store, onQueue }.
module.exports = function createMmrLog(ctx) {
  const { state, config, log } = ctx;
  const pushState = () => ctx.pushState();
  const refreshSession = () => ctx.refreshSession();

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
    const d = ctx.store.decidedBetween(reading.mode, previous.setAt, Date.now(),
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

  // Gain moyen par match d'un mode : celui appris sur les lectures du journal
  // s'il est plausible, sinon la moyenne générale.
  function stepFor(mode) {
    const learned = (config.get().mmrStep || {})[mode];
    return (Number.isFinite(learned) && learned >= MMR_STEP_MIN && learned <= MMR_STEP_MAX)
      ? learned : SessionStore.MMR_STEP;
  }

  function start() {
    const reader = logReader = new RLLogReader();
    reader.on('queue', (q) => {
      state.queue = q;
      // Les cartes workshop posées dans le jeu doivent partir avant que le
      // match ne charge (voir ipc-maps.js).
      ctx.onQueue(q);
      pushState();
      log('mise en file détectée : playlist ' + q.playlist
        + (q.known ? ' (' + (q.ranked ? 'classé ' + q.mode : 'casual') + ')' : ' (inconnue)'));
    });
    reader.on('mmr', (r) => {
      if (config.get().mmrFromLog === false) return;
      const cur = (config.get().mmr || {})[r.mode];
      if (cur && cur.base === r.mmr && cur.fromLog) return;   // déjà calé là-dessus

      // Garde-fou : une lecture qui s'écarte trop de ce que les matchs
      // enregistrés prévoient n'est pas ancrée tout de suite (voir mmr-guard.js).
      const now = Date.now();
      const pseudo = config.get().pseudo;
      const anchor = ctx.store.lastReading(r.mode);
      const pend = state.mmrPending && state.mmrPending.mode === r.mode ? state.mmrPending : null;
      const verdict = mmrGuard.judge({
        prev: anchor, reading: r, now, step: stepFor(r.mode),
        decided: anchor ? ctx.store.decidedBetween(r.mode, anchor.t, now, pseudo) : null,
        pending: pend,
        decidedPending: pend ? ctx.store.decidedBetween(r.mode, pend.at, now, pseudo) : null,
      });
      if (verdict.action === 'hold') {
        state.mmrPending = { mode: r.mode, mmr: r.mmr, tier: r.tier, at: now,
          expected: Math.round(verdict.expected), tolerance: Math.round(verdict.tolerance) };
        log('MMR relevé mis de côté : ' + r.mode + ' = ' + r.mmr + ', attendu ~'
          + Math.round(verdict.expected) + ' ± ' + Math.round(verdict.tolerance)
          + ' (' + verdict.reason + ')');
        pushState();
        return;
      }
      if (pend) state.mmrPending = null;
      if (verdict.action === 'accept-pending') {
        // La lecture mise de côté était juste : on l'ancre à SA date, sans
        // apprentissage ni correction de forfait (l'intervalle qui la précède
        // est justement celui que nos matchs n'expliquaient pas).
        ctx.store.addMmrReading(pend.mode, pend.mmr, pend.tier, pend.at);
        config.update({ mmrSet: { mode: pend.mode, value: pend.mmr, fromLog: true, at: pend.at } });
        log('MMR mis de côté confirmé : ' + pend.mode + ' = ' + pend.mmr);
      } else if (pend) {
        log('MMR mis de côté abandonné : ' + pend.mode + ' = ' + pend.mmr + ' (' + verdict.reason + ')');
      }
      const curNow = (config.get().mmr || {})[r.mode];
      learnMmrStep(r, curNow);
      // Réconciliation AVANT d'ancrer : le relevé qui arrive est la vérité, et
      // c'est en le comparant au bilan enregistré depuis l'ancre PRÉCÉDENTE
      // qu'un forfait mal compté se trahit (écart de deux pas exactement).
      const prevAnchor = ctx.store.lastReading(r.mode);
      if (prevAnchor) {
        const fixed = ctx.store.reconcileForfeits(r.mode, prevAnchor, Date.now(),
          r.mmr, stepFor(r.mode), config.get().pseudo);
        if (fixed) {
          log('forfait réconcilié par le vrai MMR : match ' + fixed.id
            + ' recompté ' + (fixed.flipped === 'W' ? 'victoire' : 'défaite'));
        }
      }
      // L'ancre est archivée dans le journal : c'est elle qui porte la courbe.
      // La base de configuration ne sert plus qu'au cas « aucun relevé ».
      ctx.store.addMmrReading(r.mode, r.mmr, r.tier);
      config.update({ mmrSet: { mode: r.mode, value: r.mmr, fromLog: true } });
      state.mmrLog = { mode: r.mode, mmr: r.mmr, tier: r.tier, at: Date.now() };
      refreshSession();
      pushState();
      log('MMR relevé dans le journal du jeu : ' + r.mode + ' = ' + r.mmr
        + (r.tier ? ' (palier ' + r.tier + ')' : ''));
    });
    reader.start();
  }

  return {
    start, resolveMatchmade, countsAsMatch, resolveRanked, stepFor,
    get reader() { return logReader; },
  };
};
