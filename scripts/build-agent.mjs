// scripts/build-agent.mjs — Construit l'application agent (Electron).
//
// L'agent est une vraie application de bureau Electron. Ce script :
//  1) fige le serveur d'enrôlement dans l'app ;
//  2) empaquette l'app pour Windows x64 via @electron/packager ;
//  3) produit une archive ZIP prête au téléchargement (dist/rl-agent.zip).
//
// Fonctionne depuis Windows OU Linux/macOS. L'icône du fichier .exe et les
// métadonnées Windows ne sont posées que si la construction a lieu SUR Windows
// (sinon rcedit exigerait Wine) ; l'icône de la fenêtre et de la barre des
// tâches, elle, est appliquée à l'exécution et marche quel que soit l'OS.
//
//   npm run build:agent

import packagerPkg from '@electron/packager';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packager = packagerPkg.packager || packagerPkg.default || packagerPkg;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(root, 'agent');
const distDir = path.join(root, 'dist');
const APP_NAME = 'RL Session Tracker';
const DEFAULT_SERVER = process.env.AGENT_DEFAULT_SERVER || 'https://rl.mateobrl.fr';

fs.mkdirSync(distDir, { recursive: true });

// ───────── 1) Serveur d'enrôlement figé dans l'app ─────────
fs.writeFileSync(
  path.join(agentDir, 'default-server.json'),
  JSON.stringify({ server: DEFAULT_SERVER }, null, 2) + '\n');
console.log('  [1/3] Serveur d\'enrôlement figé : ' + DEFAULT_SERVER);

// ───────── 2) Empaquetage Electron (Windows x64) ─────────
// Version d'Electron : celle installée dans node_modules.
const electronVersion = JSON.parse(fs.readFileSync(
  path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

const opts = {
  dir: agentDir,
  out: distDir,
  platform: 'win32',
  arch: 'x64',
  electronVersion: electronVersion,
  overwrite: true,
  asar: true,
  appCopyright: 'RL Session Tracker',
};
if (process.platform === 'win32') {
  // rcedit disponible nativement : on personnalise l'icône et les métadonnées.
  opts.icon = path.join(agentDir, 'assets', 'icon.ico');
  opts.win32metadata = {
    CompanyName: 'RL Session Tracker',
    FileDescription: 'RL Session Tracker — agent',
    ProductName: 'RL Session Tracker',
    OriginalFilename: 'RL Session Tracker.exe',
  };
}

const appPaths = await packager(opts);
const appDir = appPaths[0];
console.log('  [2/3] Application empaquetée (Electron ' + electronVersion + ')');

// ───────── 3) Archive ZIP prête au téléchargement ─────────
const zipPath = path.join(distDir, 'rl-agent.zip');
await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', resolve);
  archive.on('error', reject);
  archive.pipe(output);
  archive.directory(appDir, APP_NAME);  // contenu sous un dossier « RL Session Tracker »
  archive.finalize();
});
const sizeMo = Math.round(fs.statSync(zipPath).size / 1048576);
console.log('  [3/3] Archive : ' + zipPath + ' (' + sizeMo + ' Mo)');

console.log('\n  ✓ Agent construit. Téléchargeable via /download/agent.');
if (process.platform !== 'win32') {
  console.log('  (icône du .exe par défaut : build hors Windows — l\'icône de la');
  console.log('   fenêtre et de la barre des tâches reste correcte.)');
}
console.log('');
