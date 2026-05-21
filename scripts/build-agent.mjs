// scripts/build-agent.mjs — Construit rl-agent.exe
//
// Méthode : Node SEA (Single Executable Application).
//
// Vis-à-vis des antivirus :
//  • On part du node.exe Windows OFFICIEL, téléchargé depuis nodejs.org
//    (binaire signé Microsoft, déjà connu des antivirus) — et non d'un
//    binaire Node modifié comme le fait `pkg`.
//  • AUCUNE compression (pas d'UPX) : c'est le déclencheur n°1 de faux positifs.
//  • On ajoute des métadonnées de version complètes (éditeur, description,
//    version) : un .exe anonyme paraît suspect à l'heuristique.
//
// Cela réduit fortement les faux positifs sans les supprimer à 100 % : seule
// la signature de code (Authenticode) le garantit. Voir BUILD-AGENT.md.
//
// Le build fonctionne depuis Windows OU Linux/macOS (cross-build).
//   npm run build:agent

import { build } from 'esbuild';
import { inject } from 'postject';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const NODE_VERSION = process.version; // ex. v22.22.2

// Serveur figé dans le binaire : l'agent l'utilise pour l'enrôlement initial
// (échange du code de configuration). Surchargeable via AGENT_DEFAULT_SERVER.
const DEFAULT_SERVER = process.env.AGENT_DEFAULT_SERVER || 'https://rl.mateobrl.fr';

fs.mkdirSync(dist, { recursive: true });

// ───────── 1) Bundle agent + statsapi en un seul fichier ─────────
const bundlePath = path.join(dist, 'agent-bundle.cjs');
await build({
  entryPoints: [path.join(root, 'agent', 'agent.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: bundlePath,
  legalComments: 'none',
  // Le serveur d'enrôlement est figé à la compilation : l'utilisateur final
  // n'a jamais à le saisir, il ne tape que son code de configuration.
  define: {
    'process.env.AGENT_DEFAULT_SERVER': JSON.stringify(DEFAULT_SERVER),
  },
});
console.log('  [1/5] Bundle créé (serveur : ' + DEFAULT_SERVER + ')');

// ───────── 2) Génération du blob SEA ─────────
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundlePath,
  output: path.join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
console.log('  [2/5] Blob SEA généré');

// ───────── 3) node.exe Windows officiel (téléchargé, mis en cache) ─────────
// Vérification supply-chain : on récupère le SHASUMS256.txt officiel de
// nodejs.org pour la version visée, on en extrait le SHA-256 attendu de
// win-x64/node.exe, et on AVORTE le build si le binaire reçu (ou le cache)
// ne correspond pas. Le cache n'est jamais réutilisé sans revérification.

// Récupère le hash SHA-256 attendu pour win-x64/node.exe.
async function expectedNodeHash() {
  const shaUrl = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
  const resp = await fetch(shaUrl);
  if (!resp.ok) {
    throw new Error('Téléchargement de SHASUMS256.txt échoué (HTTP ' + resp.status + ')');
  }
  const text = await resp.text();
  // Format de chaque ligne : "<hash>  win-x64/node.exe"
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+win-x64\/node\.exe\s*$/);
    if (m) return m[1].toLowerCase();
  }
  throw new Error('Hash de win-x64/node.exe introuvable dans SHASUMS256.txt');
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const baseExe = path.join(dist, `node-${NODE_VERSION}-win-x64.exe`);
const wantHash = await expectedNodeHash();

// On (re)télécharge si le cache est absent OU si son hash ne correspond plus.
let needDownload = true;
if (fs.existsSync(baseExe)) {
  const cachedHash = sha256OfFile(baseExe);
  if (cachedHash === wantHash) {
    needDownload = false;
    console.log('        Cache node.exe vérifié (SHA-256 ' + wantHash + ')');
  } else {
    console.warn('        Cache node.exe invalide (hash ' + cachedHash +
      ') — re-téléchargement');
  }
}

if (needDownload) {
  const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
  console.log('        Téléchargement de ' + url);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error('Téléchargement de node.exe échoué (HTTP ' + resp.status + ')');
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const gotHash = crypto.createHash('sha256').update(buf).digest('hex');
  if (gotHash !== wantHash) {
    throw new Error('Vérification SHA-256 de node.exe ÉCHOUÉE — build avorté.\n' +
      '  attendu : ' + wantHash + '\n  reçu    : ' + gotHash);
  }
  fs.writeFileSync(baseExe, buf);
  console.log('        node.exe téléchargé et vérifié (SHA-256 ' + wantHash + ')');
}

const exePath = path.join(dist, 'rl-agent.exe');
fs.copyFileSync(baseExe, exePath);
console.log('  [3/5] node.exe Windows officiel vérifié et prêt');

// ───────── 4) Injection du code de l'agent ─────────
await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(path.join(dist, 'sea-prep.blob')), {
  sentinelFuse: FUSE,
  overwrite: true,
});
console.log('  [4/5] Code de l\'agent injecté');

// ───────── 5) Métadonnées de version (anti faux positif) ─────────
// ignoreCert : l'injection du code a de toute façon invalidé la signature
// d'origine de node.exe ; on retire ce certificat résiduel proprement
// (un reste de signature corrompue est plus suspect que pas de signature).
const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = NtExecutableResource.from(exe);

const [maj = 2, min = 0, pat = 0] = String(pkg.version).split('.').map(Number);
const vi = Resource.VersionInfo.createEmpty();
vi.setFileVersion(maj, min, pat, 0, 1033);
vi.setProductVersion(maj, min, pat, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  CompanyName: 'RL Session Tracker',
  ProductName: 'RL Session Tracker Agent',
  FileDescription: 'RL Session Tracker - agent de statistiques',
  FileVersion: `${maj}.${min}.${pat}.0`,
  ProductVersion: `${maj}.${min}.${pat}.0`,
  InternalName: 'rl-agent',
  OriginalFilename: 'rl-agent.exe',
  LegalCopyright: 'RL Session Tracker',
});
vi.outputToResourceEntries(res.entries);

// Icône optionnelle : ajoute assets/agent.ico avant le build pour l'embarquer
// (un .exe avec icône paraît plus légitime à l'heuristique antivirus).
const icoPath = path.join(root, 'assets', 'agent.ico');
if (fs.existsSync(icoPath)) {
  try {
    const ico = Data.IconFile.from(fs.readFileSync(icoPath));
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, 1, 1033, ico.icons.map((i) => i.data)
    );
    console.log('        Icône embarquée (assets/agent.ico)');
  } catch (e) {
    console.warn('        Icône ignorée : ' + e.message);
  }
}

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('  [5/5] Métadonnées de version appliquées');

console.log('\n  ✓ Agent construit : ' + exePath);
console.log('');
console.log('  Le .exe n\'est PAS signé : pour supprimer l\'avertissement');
console.log('  SmartScreen / antivirus, signe-le (voir BUILD-AGENT.md) —');
console.log('  SignPath.io (gratuit, open source) ou Azure Trusted Signing.');
console.log('');
