// documents.js — Où vit « Documents\My Games\Rocket League » sur ce PC.
//
// Le jeu y écrit son journal (Launch.log, seule source du vrai MMR) et y lit
// TAStatsAPI.ini. Supposer %USERPROFILE%\Documents ne suffit pas :
//  • OneDrive redirige souvent Documents vers %OneDrive%\Documents ;
//  • Windows permet de déplacer Documents n'importe où (D:\Docs…).
// Dans ces deux cas l'application ne trouvait pas le journal et le MMR ne se
// relevait jamais, sans aucun message.
//
// La source sûre est le dossier connu de Windows, qu'Electron donne via
// app.getPath('documents') : index.js le transmet ici au démarrage (setKnown).
// Ce module reste sans Electron pour être testable ; les autres candidats
// servent de filet si ce chemin manque.

const fs = require('fs');
const os = require('os');
const path = require('path');

let known = null;

function setKnown(p) {
  known = typeof p === 'string' && p ? p : null;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// Dossiers Documents candidats, du plus sûr au moins sûr, sans doublon.
function documentsDirs() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const k = path.resolve(p).toLowerCase();
    if (!out.some((q) => path.resolve(q).toLowerCase() === k)) out.push(p);
  };
  add(known);
  const home = process.env.USERPROFILE || os.homedir();
  if (home) add(path.join(home, 'Documents'));
  for (const v of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[v]) add(path.join(process.env[v], 'Documents'));
  }
  return out;
}

// « My Games\Rocket League » de chaque candidat.
function rocketLeagueDirs() {
  return documentsDirs().map((d) => path.join(d, 'My Games', 'Rocket League'));
}

// Ceux que le jeu a réellement créés.
function existingRocketLeagueDirs() {
  return rocketLeagueDirs().filter(isDir);
}

// Journal du jeu. S'il en existe plusieurs (ancien dossier resté en place
// après une migration OneDrive), le plus récemment écrit est celui du jeu.
function launchLogPath() {
  const all = rocketLeagueDirs().map((d) => path.join(d, 'TAGame', 'Logs', 'Launch.log'));
  let best = null;
  let bestAt = -1;
  for (const f of all) {
    let at;
    try { at = fs.statSync(f).mtimeMs; } catch (e) { continue; }
    if (at > bestAt) { best = f; bestAt = at; }
  }
  return best || all[0] || null;
}

module.exports = { setKnown, documentsDirs, rocketLeagueDirs, existingRocketLeagueDirs, launchLogPath };
