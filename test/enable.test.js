// Tests de la détection des installations (src/main/enable-statsapi.js) :
// parsing des bibliothèques Steam et validation d'un dossier Rocket League.
// (Régression du bug « pote sur Steam » : la détection doit se faire côté
// application, dans la session du vrai utilisateur — pas sous élévation.)
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseLibraryFolders, isRLInstall, iniConfigured, iniRate, readIni,
  userConfigDirs, userIniFiles, writeUserIni } = require('../src/main/enable-statsapi.js');

test('libraryfolders.vdf : tous les chemins, antislashs déséchappés', () => {
  const vdf = [
    '"libraryfolders"',
    '{',
    '  "0"',
    '  {',
    '    "path"    "C:\\\\Program Files (x86)\\\\Steam"',
    '    "label"   ""',
    '  }',
    '  "1"',
    '  {',
    '    "path"    "D:\\\\SteamLibrary"',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(parseLibraryFolders(vdf),
    ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
});

test('isRLInstall : exige le binaire ET le dossier de config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-rl-'));
  assert.equal(isRLInstall(root), false);            // vide

  fs.mkdirSync(path.join(root, 'Binaries', 'Win64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Binaries', 'Win64', 'RocketLeague.exe'), 'x');
  assert.equal(isRLInstall(root), false);            // config manquante

  fs.mkdirSync(path.join(root, 'TAGame', 'Config'), { recursive: true });
  assert.equal(isRLInstall(root), true);

  assert.equal(isRLInstall(path.join(root, 'ailleurs')), false);
  assert.equal(isRLInstall(null), false);
});

// Une vérification d'intégrité Steam / réparation Epic réinitialise l'ini :
// la détection de panne doit distinguer « configuré pour nous » de tout le
// reste (absent, section manquante, API coupée, mauvais port).
test('iniConfigured : détecte un DefaultStatsAPI.ini réinitialisé', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-ini-'));
  const cfgDir = path.join(root, 'TAGame', 'Config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const ini = path.join(cfgDir, 'DefaultStatsAPI.ini');

  assert.equal(iniConfigured(root, 49123), false);   // fichier absent

  fs.writeFileSync(ini, '[TAGame.MatchStatsExporter_TA]\r\nPort=49123\r\nPacketSendRate=120\r\n');
  assert.equal(iniConfigured(root, 49123), true);    // configuré par nous

  fs.writeFileSync(ini, '[TAGame.MatchStatsExporter_TA]\r\nPort=49123\r\nPacketSendRate=0\r\n');
  assert.equal(iniConfigured(root, 49123), false);   // API coupée (défaut du jeu)

  fs.writeFileSync(ini, '; fichier restauré par la vérification Steam\r\n');
  assert.equal(iniConfigured(root, 49123), false);   // section manquante

  fs.writeFileSync(ini, '[TAGame.MatchStatsExporter_TA]\r\nPort=49999\r\nPacketSendRate=120\r\n');
  assert.equal(iniConfigured(root, 49123), false);   // mauvais port
});

const OURS = '[TAGame.MatchStatsExporter_TA]\r\nPort=49123\r\nPacketSendRate=60\r\n';

// Installation factice dont DefaultStatsAPI.ini est parfait.
function goodInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-ini-'));
  fs.mkdirSync(path.join(root, 'TAGame', 'Config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'TAGame', 'Config', 'DefaultStatsAPI.ini'), OURS);
  return root;
}
function userIni(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-user-')), 'TAStatsAPI.ini');
  fs.writeFileSync(f, content);
  return f;
}

test('TAStatsAPI.ini : une surcharge à 0 coupe la Stats API malgré un bon DefaultStatsAPI.ini', () => {
  const root = goodInstall();
  assert.equal(iniConfigured(root, 49123, []), true);

  const coupe = userIni('[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\n');
  assert.equal(iniConfigured(root, 49123, [coupe]), false);
  assert.equal(iniRate(root, [coupe]), 0);                 // le profil prime

  const autrePort = userIni('[TAGame.MatchStatsExporter_TA]\r\nPort=50000\r\n');
  assert.equal(iniConfigured(root, 49123, [autrePort]), false);
  assert.equal(iniRate(root, [autrePort]), 60);            // débit non fixé : celui de Default

  const neutre = userIni('[SomeOtherSection]\r\nPacketSendRate=0\r\n');
  assert.equal(iniConfigured(root, 49123, [neutre]), true); // autre section : ne surcharge rien

  const nous = userIni(OURS.replace('60', '30'));
  assert.equal(iniConfigured(root, 49123, [nous]), true);
  assert.equal(iniRate(root, [nous]), 30);
});

test('readIni : clé absente et clé à zéro ne se confondent pas', () => {
  assert.equal(readIni(path.join(os.tmpdir(), 'rlst-absent-' + Date.now() + '.ini')), null);
  const f = userIni('[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\n');
  assert.deepEqual(readIni(f), { section: true, port: null, rate: 0 });
});

test('TAStatsAPI.ini : écrit dans le Documents où le jeu vit, OneDrive compris', (t) => {
  const saved = { USERPROFILE: process.env.USERPROFILE, OneDrive: process.env.OneDrive };
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-home-'));
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-onedrive-'));
  process.env.USERPROFILE = home;
  process.env.OneDrive = drive;

  // Aucun dossier du jeu encore : le Documents classique par défaut.
  assert.deepEqual(userConfigDirs(),
    [path.join(home, 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config')]);

  // Le jeu a écrit sous OneDrive : c'est là qu'il lira sa surcharge.
  fs.mkdirSync(path.join(drive, 'Documents', 'My Games', 'Rocket League'), { recursive: true });
  const cfg = path.join(drive, 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Config');
  assert.deepEqual(userConfigDirs(), [cfg]);
  assert.deepEqual(userIniFiles(), []);

  // Un fichier préexistant est sauvegardé une seule fois, puis remplacé.
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'TAStatsAPI.ini'), 'origine');
  assert.deepEqual(writeUserIni(49123), [path.join(cfg, 'TAStatsAPI.ini')]);
  writeUserIni(49123);
  assert.equal(fs.readFileSync(path.join(cfg, 'TAStatsAPI.ini.bak'), 'utf8'), 'origine');
  assert.deepEqual(readIni(path.join(cfg, 'TAStatsAPI.ini')),
    { section: true, port: 49123, rate: 60 });
  assert.deepEqual(userIniFiles(), [path.join(cfg, 'TAStatsAPI.ini')]);
});
