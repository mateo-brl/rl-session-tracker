// agent/enable-statsapi.js — Active la Stats API de Rocket League depuis l'agent.
//
// Au premier lancement, l'agent active lui-même la Stats API : l'utilisateur
// n'a plus rien à exécuter (fini le enable-statsapi.bat manuel).
//
// ARCHITECTURE (et leçon apprise sur un PC Steam) : la détection des
// installations se fait ICI, dans le processus de l'application — donc dans
// la session du VRAI utilisateur. Le script PowerShell élevé reçoit la liste
// toute prête. Pourquoi : quand UAC élève vers un AUTRE compte (utilisateur
// non-administrateur), le HKCU du script élevé est la ruche de l'admin, où
// la clé Steam n'existe pas — Rocket League dans D:\SteamLibrary devenait
// introuvable et l'ini n'était jamais écrit.
//
// Le script élevé écrit son résultat (chemins configurés, ou NONE) dans un
// fichier que l'application relit : on peut enfin dire à l'utilisateur si
// l'activation a réellement réussi.
//
// Hors Windows : opération sans objet (la Stats API n'existe que sur PC).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ───────── Détection des installations (session utilisateur) ─────────

// ATTENTION ENCODAGE : reg.exe redirigé vers un tube écrit dans la page de
// code ANSI/OEM du système (CP850/CP1252 sur un Windows français), JAMAIS en
// UTF-8. Décoder en 'utf8' transformait « Mathéo » en U+FFFD : le SteamPath
// devenait un chemin fantôme, libraryfolders.vdf n'était jamais lu, et TOUTES
// les bibliothèques Steam (même celles au chemin sans accent) étaient perdues.
//
// On lit donc reg.exe en latin1 — instantané (~30 ms) et correct pour un
// chemin ASCII, c'est-à-dire l'immense majorité. PowerShell (~1 s de démarrage
// à froid, sur le thread principal) n'est appelé QU'EN DERNIER RECOURS, quand
// le chemin obtenu contient du non-ASCII ou n'existe pas sur le disque :
// l'appeler systématiquement figeait le dashboard et l'overlay une à trois
// secondes au lancement du jeu, puis toutes les 10 minutes.
function regQuery(key, value) {
  let raw = null;
  try {
    const out = spawnSync('reg', ['query', key, '/v', value],
      { windowsHide: true, timeout: 10000 });
    const txt = out.stdout ? Buffer.from(out.stdout).toString('latin1') : '';
    const m = /REG_SZ\s+(.+)/.exec(txt);
    if (m) raw = m[1].trim();
  } catch (e) { /* on tente PowerShell ci-dessous */ }

  // Chemin propre et existant : rien de plus à faire.
  if (raw && !/[^\x00-\x7F]/.test(raw)) return raw;
  if (raw) {
    try { if (fs.existsSync(raw)) return raw; } catch (e) {}
  }

  // Repli coûteux : sortie forcée en UTF-8, seul moyen sûr pour un chemin
  // accentué (fréquent chez les utilisateurs francophones du projet).
  try {
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
      + '(Get-ItemProperty -LiteralPath ' + psQuote(toPsPath(key))
      + ' -Name ' + psQuote(value) + ').' + psQuote(value);
    const out = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const v = String((out && out.stdout) || '').trim();
    if (v) return v;
  } catch (e) { /* on garde ce que reg.exe a donné */ }
  return raw;
}

// « HKCU\Software\… » → « HKCU:\Software\… » (forme attendue par PowerShell).
function toPsPath(key) {
  return String(key).replace(/^(HKCU|HKLM|HKCR|HKU)\\/i, '$1:\\');
}

// Extrait les chemins de bibliothèques d'un libraryfolders.vdf de Steam.
function parseLibraryFolders(text) {
  const out = [];
  for (const m of String(text).matchAll(/"path"\s+"([^"]+)"/g)) {
    out.push(m[1].replace(/\\\\/g, '\\'));
  }
  return out;
}

// Un vrai dossier d'installation de Rocket League ?
function isRLInstall(p) {
  try {
    return fs.existsSync(path.join(p, 'Binaries', 'Win64', 'RocketLeague.exe'))
      && fs.existsSync(path.join(p, 'TAGame', 'Config'));
  } catch (e) { return false; }
}

// Forme canonique d'un chemin Windows : le registre livre le dossier Steam
// tantôt « c:/program files (x86)/steam » (HKCU), tantôt « C:\Program Files
// (x86)\Steam » (HKLM). Comparés tels quels, la MÊME installation apparaissait
// deux fois — et la section Cosmétiques sauvegardait alors comme « original »
// un fichier déjà remplacé via l'autre entrée. Constaté en jeu.
function canonicalPath(p) {
  let out = path.resolve(String(p));
  if (process.platform === 'win32') out = out.replace(/\//g, '\\');
  return out;
}
function pathKey(p) {
  return process.platform === 'win32' ? canonicalPath(p).toLowerCase() : canonicalPath(p);
}

function detectInstalls() {
  const found = [];
  const keys = new Set();
  const add = (p) => {
    if (!p || typeof p !== 'string') return;
    const k = pathKey(p);
    if (keys.has(k)) return;
    keys.add(k);
    found.push(canonicalPath(p));
  };

  // Epic Games : manifestes du launcher (ProgramData, lisible sans élévation).
  try {
    const dir = path.join(process.env.ProgramData || 'C:\\ProgramData',
      'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.item')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (/rocket league/i.test(m.DisplayName || '') && m.InstallLocation) {
          add(m.InstallLocation);
        }
      } catch (e) { /* manifeste illisible : suivant */ }
    }
  } catch (e) { /* pas d'Epic */ }

  // Steam : registre + TOUTES les bibliothèques (y compris autres disques).
  // HKCU d'abord (le chemin réellement utilisé par l'utilisateur), puis HKLM
  // en repli — HKLM est indépendant du compte, donc il survit aux profils
  // exotiques où HKCU\Valve\Steam n'existe pas.
  if (process.platform === 'win32') {
    const roots = [];
    const sp = regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    if (sp) roots.push(sp);
    const ip = regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')
      || regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath');
    if (ip) roots.push(ip);
    const libs = [];
    for (const root of roots) {
      libs.push(root);
      try {
        libs.push(...parseLibraryFolders(
          fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
      } catch (e) { /* vdf absent : bibliothèque principale seulement */ }
    }
    for (const l of libs) {
      add(path.join(l, 'steamapps', 'common', 'rocketleague'));
      // Le dossier peut avoir été renommé : on lit le nom réel dans le
      // manifeste de l'app 252950 (Rocket League) quand il est présent.
      try {
        const acf = fs.readFileSync(
          path.join(l, 'steamapps', 'appmanifest_252950.acf'), 'utf8');
        const m = /"installdir"\s+"([^"]+)"/i.exec(acf);
        if (m) add(path.join(l, 'steamapps', 'common', m[1]));
      } catch (e) { /* manifeste absent : nom par défaut déjà tenté */ }
    }
  }

  // Chemins par défaut, au cas où.
  add('C:\\Program Files\\Epic Games\\rocketleague');
  add('C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague');

  return found.filter(isRLInstall);
}

// ───────── Vérification silencieuse (sans élévation) ─────────
// Une « Vérification de l'intégrité des fichiers » Steam, une grosse mise à
// jour du jeu ou une réparation Epic RÉINITIALISENT DefaultStatsAPI.ini : la
// Stats API se coupe sans que l'utilisateur ait touché à rien, et le tracker
// meurt en silence. Lire l'ini ne demande aucun droit admin : on peut donc
// détecter la panne à chaque lancement et ne réactiver (élévation UAC) que
// quand c'est réellement nécessaire.

// L'ini d'une installation est-il configuré pour nous ?
function iniConfigured(install, port) {
  try {
    const txt = fs.readFileSync(
      path.join(install, 'TAGame', 'Config', 'DefaultStatsAPI.ini'), 'utf8');
    if (!/\[TAGame\.MatchStatsExporter_TA\]/i.test(txt)) return false;
    const p = /^\s*Port\s*=\s*(\d+)/im.exec(txt);
    const r = /^\s*PacketSendRate\s*=\s*(\d+)/im.exec(txt);
    return !!(p && Number(p[1]) === port && r && Number(r[1]) > 0);
  } catch (e) { return false; }   // absent ou illisible : à refaire
}

// Débit actuellement configuré dans l'ini d'une installation (0 si absent).
function iniRate(install) {
  try {
    const txt = fs.readFileSync(
      path.join(install, 'TAGame', 'Config', 'DefaultStatsAPI.ini'), 'utf8');
    const r = /^\s*PacketSendRate\s*=\s*(\d+)/im.exec(txt);
    return r ? Number(r[1]) : 0;
  } catch (e) { return 0; }
}

// Retourne { installs, broken } — broken : installations détectées dont
// l'ini n'active pas (ou plus) la Stats API sur le port attendu.
function checkStatsApi(port) {
  if (process.platform !== 'win32') return { installs: [], broken: [] };
  const installs = detectInstalls();
  const want = Number(port) || 49123;
  return { installs, broken: installs.filter((p) => !iniConfigured(p, want)) };
}

// ───────── Script PowerShell élevé ─────────
// Reçoit la liste des installations (__INSTALLS__) et le fichier de résultat
// (__RESULT__). Garde une re-détection Epic + chemins par défaut en filet de
// sécurité, mais PLUS de lecture du registre Steam sous élévation.
const PS_LINES = [
  "$ErrorActionPreference='SilentlyContinue'",
  // Le port vient de la configuration : il était figé à 49123 ici alors que la
  // vérification, elle, comparait au port configuré — un port personnalisé
  // provoquait donc une invite UAC à CHAQUE lancement, sans jamais converger.
  '$Port=__PORT__',
  // 120 paquets/s : nécessaire à la réactivité du son Alpha Boost.
  '$Rate=120',
  "$Result='__RESULT__'",
  "$GrantUser='__USER__'",
  // ── Élévation automatique : sans droits admin, on se relance élevé et on
  // ATTEND la fin (le résultat est écrit par l'instance élevée). ──
  '$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
  'if(-not $pr.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)){',
  "  try{ Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('\"'+$PSCommandPath+'\"')) }catch{}",
  '  exit',
  '}',
  // ── Validation d'un vrai dossier d'installation Rocket League. ──
  'function Test-RL($p){',
  '  if([string]::IsNullOrWhiteSpace($p)){return $null}',
  '  try{$c=[System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $p -ErrorAction Stop).Path)}catch{return $null}',
  "  if(-not(Test-Path -LiteralPath (Join-Path $c 'Binaries\\Win64\\RocketLeague.exe') -PathType Leaf)){return $null}",
  "  if(-not(Test-Path -LiteralPath (Join-Path $c 'TAGame\\Config') -PathType Container)){return $null}",
  '  return $c',
  '}',
  // ── Installations détectées par l'application (session utilisateur). ──
  '$found=@(__INSTALLS__)',
  // ── Filet de sécurité : Epic (ProgramData, indépendant du compte). ──
  "$em=Join-Path $env:ProgramData 'Epic\\EpicGamesLauncher\\Data\\Manifests'",
  'if(Test-Path $em){',
  '  Get-ChildItem $em -Filter *.item -ErrorAction SilentlyContinue|ForEach-Object{',
  '    try{$m=Get-Content $_.FullName -Raw|ConvertFrom-Json',
  "      if($m.DisplayName -like '*Rocket League*' -and $m.InstallLocation){$found+=$m.InstallLocation}}catch{}",
  '  }',
  '}',
  "$found+='C:\\Program Files\\Epic Games\\rocketleague'",
  "$found+='C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague'",
  // ── Écriture du .ini dans chaque installation valide trouvée. ──
  '$ini="[TAGame.MatchStatsExporter_TA]`r`nPort=$Port`r`nPacketSendRate=$Rate`r`n"',
  '$ok=@()',
  'foreach($p in ($found|Select-Object -Unique)){',
  '  $c=Test-RL $p',
  '  if($c){',
  "    $cfg=Join-Path $c 'TAGame\\Config'",
  "    $ip=Join-Path $cfg 'DefaultStatsAPI.ini'",
  '    try{',
  "      if((Test-Path $ip) -and -not(Test-Path ($ip+'.bak'))){Copy-Item $ip ($ip+'.bak') -ErrorAction SilentlyContinue}",
  '      Set-Content -Path $ip -Value $ini -Encoding ASCII -Force',
  '      $ok+=$c',
  // ── LE point qui rend Steam durable ──
  // DefaultStatsAPI.ini vit dans le dossier du jeu, donc dans le dépôt Steam :
  // chaque mise à jour de Rocket League et chaque « vérification de
  // l'intégrité des fichiers » le restaure. Jusqu'ici, chaque restauration
  // imposait une nouvelle invite UAC — souvent ratée, d'où l'impression que
  // le tracker marche « une fois sur deux » sur Steam. On accorde donc une
  // fois pour toutes la modification du dossier de config à l'utilisateur :
  // les réparations suivantes se font en silence, sans élévation.
  '      if($GrantUser){',
  "        icacls \"$cfg\" /grant (\"${GrantUser}:(OI)(CI)M\") /T /C 2>$null | Out-Null",
  // Même droit sur CookedPCConsole : c'est là que vivent les paquets que la
  // section Cosmétiques remplace. Sans ça, sur une installation Steam sous
  // Program Files (x86), chaque swap échouerait sur « accès refusé ».
  "        $cooked=Join-Path $c 'TAGame\\CookedPCConsole'",
  "        if(Test-Path $cooked){ icacls \"$cooked\" /grant (\"${GrantUser}:(OI)(CI)M\") /C 2>$null | Out-Null }",
  '      }',
  '    }catch{}',
  '  }',
  '}',
  // UTF8 (pas ASCII) : un chemin accentué (« D:\Jeux vidéo\… ») doit survivre
  // au fichier de résultat. Node retire le BOM à la lecture.
  "if($ok.Count -gt 0){Set-Content -Path $Result -Value ($ok -join \"`r`n\") -Encoding UTF8 -Force}",
  "else{Set-Content -Path $Result -Value 'NONE' -Encoding UTF8 -Force}",
];

// Échappe un chemin pour une chaîne PowerShell entre apostrophes.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// 120 paquets/s : nécessaire à la réactivité du son Alpha Boost (le tracker
// seul se contenterait de 10). Un ini déjà écrit à une autre cadence reste
// valide pour la vérification (débit > 0) ; l'activation du son, elle,
// réécrit à 120 si besoin.
const PACKET_RATE = 120;
const ALPHA_RATE = 120;
const DEFAULT_PORT = 49123;

function numOrPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

// Compte à qui accorder l'écriture du dossier de config. On vise le compte
// RÉEL de l'utilisateur (DOMAINE\nom) : sous élévation vers un autre compte,
// le script ne pourrait pas le deviner tout seul.
function currentUserForIcacls() {
  const user = process.env.USERNAME || os.userInfo().username || '';
  const dom = process.env.USERDOMAIN || '';
  if (!user) return '';
  return dom ? dom + '\\' + user : user;
}

// Lance une commande et résout dès qu'elle se termine (ou expire).
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    try {
      const cp = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        // Le processus n'est PAS tué : c'est lui qui porte l'invite UAC encore
        // affichée. Le tuer annulerait une élévation que l'utilisateur est
        // peut-être en train d'accorder.
        finish({ ok: false, reason: 'délai dépassé' });
      }, timeoutMs);
      cp.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: e.message }); });
      cp.on('exit', () => { clearTimeout(timer); finish({ ok: true }); });
    } catch (e) {
      finish({ ok: false, reason: e.message });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Active la Stats API. Retourne { ok, installs, configured, reason? } :
//  • installs   — installations détectées côté application ;
//  • configured — celles où le script élevé a réellement écrit l'ini.
// Contenu attendu de l'ini, une seule définition pour les deux chemins
// d'écriture (direct et élevé).
function iniBody(port) {
  return '[TAGame.MatchStatsExporter_TA]\r\nPort=' + port
    + '\r\nPacketSendRate=' + PACKET_RATE + '\r\n';
}

// Écriture SANS élévation. Elle réussit dès que l'utilisateur a le droit
// d'écrire dans TAGame\Config — ce que l'activation précédente lui a accordé
// via icacls. C'est ce qui permet de réparer en silence après chaque mise à
// jour Steam, au lieu de redemander UAC à chaque fois.
function writeIniDirect(installs, port) {
  const done = [];
  for (const p of installs) {
    const file = path.join(p, 'TAGame', 'Config', 'DefaultStatsAPI.ini');
    try {
      // La sauvegarde n'est faite QU'UNE FOIS : chaque réparation silencieuse
      // recopiait par-dessus l'ini que Steam venait de restaurer, détruisant
      // le seul retour en arrière dont disposait l'utilisateur.
      if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
      fs.writeFileSync(file, iniBody(port));
      done.push(p);
    } catch (e) { /* droits insuffisants : il faudra passer par l'élévation */ }
  }
  return done;
}

// `opts.forceElevate` : passer directement par l'élévation même si l'ini
// est déjà accessible — c'est l'élévation qui pose les droits sur
// CookedPCConsole, dont la section Cosmétiques a besoin. Sans ça, une machine
// où l'ini était déjà accessible n'obtenait jamais ces droits.
async function enableStatsApi(port, opts) {
  if (process.platform !== 'win32') {
    return { skipped: true, reason: 'Stats API disponible uniquement sur Windows' };
  }
  const want = numOrPort(port);
  const installs = detectInstalls();
  const force = !!(opts && opts.forceElevate);

  // 1) Tentative silencieuse. Si toutes les installations sont écrites, on
  //    s'arrête là : aucune invite UAC, donc aucune occasion de la rater.
  const direct = force ? [] : writeIniDirect(installs, want);
  if (!force && installs.length && direct.length === installs.length) {
    return { ok: true, installs, configured: direct, elevated: false };
  }

  // 2) Sinon, élévation — et on en profite pour poser l'ACL qui rendra les
  //    réparations suivantes silencieuses.
  const stamp = process.pid + '-' + Date.now();
  const resultFile = path.join(os.tmpdir(), 'rl-statsapi-result-' + stamp + '.txt');
  let tmpFile;
  try {
    tmpFile = path.join(os.tmpdir(), 'rl-statsapi-' + stamp + '.ps1');
    // Remplacements par FONCTION : le 2ᵉ argument de String.replace interprète
    // « $& », « $' » et « $$ ». Un chemin contenant un « $ » (D:\RL$) corrompait
    // silencieusement le script généré.
    const script = PS_LINES.join('\r\n')
      .replace('__RESULT__', () => resultFile.replace(/'/g, "''"))
      .replace('__PORT__', () => String(want))
      .replace('__USER__', () => currentUserForIcacls().replace(/'/g, "''"))
      .replace('__INSTALLS__', () => installs.map(psQuote).join(','));
    // BOM UTF-8 OBLIGATOIRE : Windows PowerShell 5.1 (celui de Windows 10)
    // lit un .ps1 sans BOM en ANSI. Le script contient des chemins qui
    // peuvent être accentués — dont $Result dans %TEMP%, qui inclut le nom
    // d'utilisateur (« C:\Users\Mathéo\… ») : sans BOM, le chemin est
    // corrompu, le résultat n'est jamais écrit et l'activation échoue en
    // silence chez les utilisateurs au nom accentué (fréquent en français).
    fs.writeFileSync(tmpFile, '\uFEFF' + script + '\r\n');
  } catch (e) {
    return { ok: false, installs, configured: null,
      reason: 'écriture du script impossible : ' + e.message };
  }

  const r = await run('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], 180000);

  // Résultat écrit par l'instance élevée (petite marge pour le flush).
  let raw = null;
  for (let i = 0; i < 10 && raw === null; i++) {
    try { raw = fs.readFileSync(resultFile, 'utf8'); } catch (e) { await sleep(300); }
  }
  try { fs.unlinkSync(resultFile); } catch (e) {}
  // Le .ps1 n'est PAS supprimé après un délai dépassé : l'invite UAC est sans
  // doute encore affichée, et le « Oui » tardif de l'utilisateur lancerait
  // alors PowerShell sur un fichier disparu — droits accordés, mais rien
  // d'écrit, sans le moindre signal. Il sera nettoyé par le ménage de %TEMP%.
  if (r.ok) { try { fs.unlinkSync(tmpFile); } catch (e) {} }

  if (raw === null) {
    return { ok: false, installs, configured: direct.length ? direct : null,
      reason: r.ok ? 'aucun résultat — fenêtre admin refusée ?' : r.reason };
  }
  const lines = raw.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines[0] === 'NONE') {
    return { ok: false, installs, configured: direct,
      reason: 'aucune installation Rocket League valide trouvée' };
  }
  return { ok: true, installs, configured: lines, elevated: true };
}

module.exports = { enableStatsApi, checkStatsApi, iniConfigured, detectInstalls,
  parseLibraryFolders, isRLInstall, iniRate, ALPHA_RATE, canonicalPath, pathKey };
