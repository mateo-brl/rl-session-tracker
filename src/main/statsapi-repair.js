// statsapi-repair.js — Surveillance et réparation de la Stats API du jeu.
//
// Extrait d'index.js : tout ce qui décide QUAND réécrire l'ini du jeu (au
// lancement, à la fermeture du jeu, en veille) et combien de fois insister.
// Le « comment » vit dans enable-statsapi.js.

const { ipcMain } = require('electron');
const { enableStatsApi, checkStatsApi, ensureUserIni } = require('./enable-statsapi');

// `ctx` : { state, config, log, pushState } (voir index.js).
module.exports = function createStatsApiRepair(ctx) {
  const { state, config, log } = ctx;
  const pushState = () => ctx.pushState();

  // Journalise le détail d'une activation de la Stats API (diagnostic).
  function logResult(r) {
    if (!r) { log('Stats API : résultat vide'); return; }
    if (r.skipped) { log('Stats API : ignorée (' + (r.reason || '') + ')'); return; }
    log('Stats API : détectées=' + JSON.stringify(r.installs || [])
      + ' configurées=' + JSON.stringify(r.configured || null)
      + ' profil=' + JSON.stringify(r.userIni || [])
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
  async function repairIfNeeded(origin) {
    if (repairing) return;            // une invite UAC à la fois
    if (autoRepairFails >= MAX_AUTO_REPAIRS) return;
    let check;
    try { check = checkStatsApi(config.get().statsApiPort); } catch (e) { return; }
    if (!check.installs.length || !check.broken.length) {
      if (state.game.statsApiBroken) { state.game.statsApiBroken = false; pushState(); }
      // Tout marche : on en profite pour poser TAStatsAPI.ini s'il manque. Ce
      // fichier survit aux vérifications d'intégrité Steam ; l'écrire seulement
      // après la panne arriverait trop tard pour l'éviter.
      if (check.installs.length) {
        try {
          const w = ensureUserIni(config.get().statsApiPort);
          if (w.length) log('Stats API : TAStatsAPI.ini posé dans ' + JSON.stringify(w));
        } catch (e) { /* sans conséquence : DefaultStatsAPI.ini fait déjà le travail */ }
      }
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
    logResult(r);
    // On RELIT l'ini au lieu de croire le script sur parole : il rendait « ok »
    // dès qu'UNE installation avait été écrite. Si c'est justement celle de
    // Steam qui a échoué, le voyant passait au vert alors que rien ne marchait.
    refreshFlag();
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
  function startWatch() {
    if (process.platform !== 'win32') return;
    setInterval(() => {
      // Pendant que le jeu tourne, réparer ne servirait à rien (l'ini n'est lu
      // qu'au démarrage du jeu) et l'invite UAC passerait par-dessus la partie.
      // On se contente donc de rafraîchir le drapeau pour prévenir le joueur.
      if (state.game.processRunning) refreshFlag();
      else repairIfNeeded('veille');
    }, STATSAPI_WATCH_MS).unref();
  }

  // Relevé sans élévation ni réparation : rafraîchit juste le drapeau pour que
  // la fenêtre de contrôle guide l'utilisateur dès le lancement du jeu.
  function refreshFlag() {
    try {
      const c = checkStatsApi(config.get().statsApiPort);
      state.game.statsApiBroken = c.installs.length > 0 && c.broken.length > 0;
    } catch (e) { /* le drapeau garde sa valeur */ }
  }

  ipcMain.handle('enable-statsapi', async () => {
    let r;
    try { r = await enableStatsApi(config.get().statsApiPort); }
    catch (e) { r = { ok: false, reason: e.message }; }
    logResult(r);
    refreshFlag();     // on relit l'ini plutôt que de croire le script
    autoRepairFails = 0;       // action volontaire : on refait confiance à l'auto
    pushState();
    return r;
  });

  return { logResult, repairIfNeeded, startWatch, refreshFlag };
};
