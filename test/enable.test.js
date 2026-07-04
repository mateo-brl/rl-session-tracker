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

const { parseLibraryFolders, isRLInstall, iniConfigured } =
  require('../src/main/enable-statsapi.js');

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
