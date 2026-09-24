// e2e/smoke.js — Test de fumée : la VRAIE application, dans le vrai Electron.
//
// Les tests unitaires (npm test) vérifient la logique sans Electron. Ce qui
// leur échappe : le câblage. Un gestionnaire IPC mal nommé, un module qui
// lève au chargement, une fenêtre dont le script plante ; aucun test
// unitaire ne le voit, et l'utilisateur le découvre au lancement. Ce
// script démarre l'application complète dans un dossier de données jetable,
// ouvre chaque fenêtre, appelle l'API des fenêtres comme le ferait un clic,
// et échoue à la moindre exception ou erreur de console.
//
//   npm run smoke            (Windows, macOS)
//   xvfb-run -a npm run smoke (Linux sans écran, comme en CI)
//
// Aucun accès réseau n'est exigé : le site de la fenêtre Cartes peut ne pas
// charger, ses erreurs sont ignorées (page tierce, pas notre code).
// Captures d'écran dans e2e/out/ (ignoré par git), utiles quand ça casse.
'use strict';

const { app, BrowserWindow, webContents, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-smoke-'));
app.setPath('userData', data);
// Jamais de navigateur ouvert pendant un test.
shell.openExternal = async () => {};

const problems = [];
const steps = [];
const fail = (m) => { problems.push(m); console.error('ÉCHEC ' + m); };
const ok = (m) => { steps.push(m); console.log('ok   ' + m); };

process.on('uncaughtException', (e) => fail('exception du processus principal : ' + (e && e.stack)));
process.on('unhandledRejection', (e) => fail('promesse rejetée non gérée : ' + (e && e.stack)));
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_ev, level, message, line, source) => {
    // Seules nos pages comptent : la page du site bakkesplugins a ses propres
    // erreurs (pubs, traqueurs) qui ne nous regardent pas.
    if (level >= 3 && String(source || wc.getURL()).startsWith('file:')) {
      fail('erreur de console (' + path.basename(String(source)) + ':' + line + ') : ' + message);
    }
  });
  wc.on('render-process-gone', (_ev, d) => fail('fenêtre plantée : ' + d.reason));
});

const main = require('../src/main/index.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Un « paquet » Unreal minimal (signature, puis un contenu reconnaissable).
function pkg(label) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(0x9E2A83C1, 0);
  return Buffer.concat([head, Buffer.from(label)]);
}
function fakeInstall() {
  const install = path.join(data, 'rocketleague');
  const cooked = path.join(install, 'TAGame', 'CookedPCConsole');
  fs.mkdirSync(cooked, { recursive: true });
  fs.writeFileSync(path.join(cooked, 'Labs_Underpass_P.upk'), pkg('UNDERPASS-ORIGINAL'));
  fs.writeFileSync(path.join(cooked, 'Labs_Octagon_02_P.upk'), pkg('OCTAGON-ORIGINAL'));
  return install;
}
function fakeMap() {
  const f = path.join(data, 'Carte.udk');
  fs.writeFileSync(f, pkg('CARTE-TEST'));
  return f;
}
async function until(what, fn, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* on réessaie */ }
    await wait(200);
  }
  throw new Error('délai dépassé : ' + what);
}
const byTitle = (re) => BrowserWindow.getAllWindows().find((w) => re.test(w.getTitle()));
const ourPage = (file) => webContents.getAllWebContents()
  .find((w) => w.getURL().startsWith('file:') && w.getURL().includes(file));
const js = (wc, code) => wc.executeJavaScript(code, true);

async function shot(wc, name) {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  } catch (e) { /* capture impossible sans écran : pas un échec */ }
}

async function run() {
  // Fenêtre de contrôle.
  const control = await until('fenêtre de contrôle chargée', () => {
    const wc = ourPage('control.html');
    return wc && !wc.isLoading() ? wc : null;
  });
  ok('fenêtre de contrôle chargée');

  const st = await js(control, 'window.rl.getState()');
  if (!st || !st.config) fail('get-state : pas de configuration');
  else ok('get-state répond (langue ' + st.lang + ')');

  const diag = await js(control, 'window.rl.runDiagnostic()');
  if (!diag || !Array.isArray(diag.checks) || !diag.checks.length) fail('diagnostic vide');
  else ok('diagnostic : ' + diag.checks.length + ' contrôles');

  const cos = await js(control, 'window.rl.cosmeticsList()');
  if (!cos || !Array.isArray(cos.swaps)) fail('cosmetics-list : réponse invalide');
  else ok('cosmetics-list répond');

  const maps = await js(control, 'window.rl.mapsList()');
  if (!maps || !Array.isArray(maps.maps)) fail('maps-list : réponse invalide');
  else ok('maps-list répond');

  // Chaque section de la fenêtre de contrôle s'affiche sans erreur.
  const sections = await js(control,
    'Array.from(document.querySelectorAll(".nav[data-sec]")).map(b => b.dataset.sec)');
  for (const sec of sections) {
    await js(control, 'document.querySelector(\'.nav[data-sec="' + sec + '"]\').click()');
    await wait(150);
  }
  ok('sections parcourues : ' + sections.join(', '));
  await shot(control, 'control');

  // Dashboard.
  await js(control, 'window.rl.openDashboard()');
  const dash = await until('dashboard chargé', () => {
    const wc = ourPage('dashboard.html');
    return wc && !wc.isLoading() ? wc : null;
  });
  await wait(800);
  ok('dashboard ouvert');
  await shot(dash, 'dashboard');

  // Un match complet rejoué dans le vrai connecteur Stats API : il doit
  // arriver au journal, au bon résultat, et le dashboard doit le recevoir.
  await js(control, 'window.rl.setConfig({ pseudo: "Mateo" })');
  const players = {
    P1: { Name: 'Mateo', TeamNum: 0, Goals: 2, Saves: 1, Assists: 0, Shots: 4, Score: 520 },
    P2: { Name: 'Adversaire', TeamNum: 1, Goals: 1, Saves: 0, Assists: 0, Shots: 3, Score: 310 },
  };
  main.simulateGame(true);
  main.feedStatsApi('MatchCreated', {});
  main.feedStatsApi('UpdateState', { Game: { Teams: [{ Score: 2 }, { Score: 1 }], TimeSeconds: 40 },
    Players: players });
  main.feedStatsApi('MatchEnded', { Winner: 0 });
  main.feedStatsApi('MatchDestroyed', {});
  const after = await until('match enregistré', async () => {
    const s = await js(control, 'window.rl.getState()');
    return s.history && s.history.length ? s : null;
  });
  const last = after.history[0];
  if (last.result !== 'W' || last.mode !== '1v1') {
    fail('match rejoué : attendu victoire en 1v1, obtenu ' + last.result + ' en ' + last.mode);
  } else ok('match rejoué : victoire 1v1 enregistrée');

  // Fermeture du jeu : dashboard fermé, état poussé aux fenêtres. C'est ici
  // qu'un appel à une fonction disparue (closeAlphaAudio, 3.27 à 3.34) levait.
  main.simulateGame(false);
  await until('jeu marqué fermé', async () => {
    const s = await js(control, 'window.rl.getState()');
    return s.game && s.game.running === false;
  });
  await wait(300);
  if (ourPage('dashboard.html')) fail('fermeture du jeu : le dashboard est resté ouvert');
  else ok('fermeture du jeu : dashboard fermé, état à jour');

  // Fenêtre Cartes, sur une fausse installation du jeu (deux arènes Labs) et
  // une carte en bibliothèque : choix de l'emplacement, chargement par le
  // bouton de la tuile, fichier réellement remplacé, puis remise.
  const install = fakeInstall();
  main.ctx.mapLib.detectInstalls = () => [install];
  await main.ctx.mapLib.importFile(fakeMap(), { title: 'Carte de test', author: 'Smoke' });
  await js(control, 'document.getElementById("mapsNav").click()');
  const mapsWc = await until('fenêtre Cartes chargée', () => {
    const wc = ourPage('maps.html');
    return wc && !wc.isLoading() ? wc : null;
  });
  await until('emplacements affichés', () =>
    js(mapsWc, 'document.querySelectorAll(".slot-pick").length === 2'));
  await js(mapsWc, 'document.getElementById("tabLib").click()');
  await js(mapsWc, 'document.querySelector(\'.slot-pick[data-slot="octagon"]\').click()');
  await until('bouton de la tuile vers Octagon', () =>
    js(mapsWc, '/octagon/i.test(document.querySelector("[data-act=load]").textContent)'));
  await js(mapsWc, 'document.querySelector("[data-act=load]").click()');
  const octagon = path.join(install, 'TAGame', 'CookedPCConsole', 'Labs_Octagon_02_P.upk');
  await until('carte posée dans Octagon', () => fs.readFileSync(octagon, 'latin1').includes('CARTE-TEST'));
  ok('fenêtre Cartes : carte chargée dans Octagon par le bouton');
  await wait(400);
  await shot(mapsWc, 'maps');
  await js(mapsWc, 'document.querySelector("[data-restore=octagon]").click()');
  await until('Octagon d’origine remis', () => fs.readFileSync(octagon, 'latin1').includes('OCTAGON-ORIGINAL'));
  ok('fenêtre Cartes : Octagon d’origine remis par le bouton');
  const win = byTitle(/cartes|maps/i);
  if (win) win.close();
  await wait(500);
}

app.whenReady().then(async () => {
  await wait(1500);
  try {
    await run();
  } catch (e) {
    fail(e.message);
  }
  console.log('\n' + steps.length + ' étape(s) réussie(s), ' + problems.length + ' problème(s)');
  try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) { /* dossier temporaire */ }
  app.isQuitting = true;
  app.exit(problems.length ? 1 : 0);
});
