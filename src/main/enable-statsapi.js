// agent/enable-statsapi.js — Active la Stats API de Rocket League depuis l'agent.
//
// Au premier lancement, l'agent active lui-même la Stats API : l'utilisateur
// n'a plus rien à exécuter (fini le enable-statsapi.bat manuel).
//
// Sous Windows, on dépose un script PowerShell en %TEMP% et on le lance. Ce
// script s'élève en administrateur (le dossier d'installation de Rocket League
// est sous Program Files) puis écrit DefaultStatsAPI.ini. La détection Epic /
// Steam reprend exactement la logique du enable-statsapi.ps1 du dépôt.
//
// Hors Windows : opération sans objet (la Stats API n'existe que sur PC).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Script PowerShell embarqué (non interactif, auto-élévation). Les lignes sont
// stockées dans un tableau pour pouvoir contenir librement les backticks de
// PowerShell (`r`n) sans entrer en conflit avec la syntaxe JavaScript.
const PS_LINES = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$Port=49123',
  // 120 paquets/s : nécessaire pour la réactivité du son Alpha Boost (le
  // tracker, lui, se contenterait de 10). La diffusion d'état vers les
  // fenêtres reste limitée à 1/s côté connecteur — aucun impact ailleurs.
  '$Rate=120',
  // ── Élévation automatique : sans droits admin, on se relance élevé. ──
  '$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
  'if(-not $pr.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)){',
  "  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('\"'+$PSCommandPath+'\"'))",
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
  '$found=@()',
  // ── Epic Games : manifestes du launcher. ──
  "$em=Join-Path $env:ProgramData 'Epic\\EpicGamesLauncher\\Data\\Manifests'",
  'if(Test-Path $em){',
  '  Get-ChildItem $em -Filter *.item -ErrorAction SilentlyContinue|ForEach-Object{',
  '    try{$m=Get-Content $_.FullName -Raw|ConvertFrom-Json',
  "      if($m.DisplayName -like '*Rocket League*' -and $m.InstallLocation){$found+=$m.InstallLocation}}catch{}",
  '  }',
  '}',
  // ── Steam : registre + bibliothèques. ──
  "try{$sp=(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -Name SteamPath -ErrorAction Stop).SteamPath}catch{$sp=$null}",
  'if($sp){',
  '  $libs=@($sp)',
  "  $lv=Join-Path $sp 'steamapps\\libraryfolders.vdf'",
  '  if(Test-Path $lv){',
  "    Select-String -Path $lv -Pattern '\"path\"\\s+\"(.+?)\"' -AllMatches|ForEach-Object{$_.Matches}|ForEach-Object{$libs+=($_.Groups[1].Value -replace '\\\\\\\\','\\')}",
  '  }',
  '  foreach($l in ($libs|Select-Object -Unique)){',
  "    $cand=Join-Path $l 'steamapps\\common\\rocketleague'",
  '    if(Test-Path $cand){$found+=$cand}',
  '  }',
  '}',
  "$found+='C:\\Program Files\\Epic Games\\rocketleague'",
  "$found+='C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague'",
  // ── Écriture du .ini dans chaque installation valide trouvée. ──
  '$ini="[TAGame.MatchStatsExporter_TA]`r`nPort=$Port`r`nPacketSendRate=$Rate`r`n"',
  '$ok=0',
  'foreach($p in ($found|Select-Object -Unique)){',
  '  $c=Test-RL $p',
  '  if($c){',
  "    $ip=Join-Path $c 'TAGame\\Config\\DefaultStatsAPI.ini'",
  '    try{',
  "      if(Test-Path $ip){Copy-Item $ip ($ip+'.bak') -Force -ErrorAction SilentlyContinue}",
  '      Set-Content -Path $ip -Value $ini -Encoding ASCII -Force',
  '      $ok++',
  '    }catch{}',
  '  }',
  '}',
  'if($ok -gt 0){exit 0}else{exit 1}',
];

// Lance une commande et résout dès qu'elle se termine (ou expire).
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    try {
      const cp = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => finish({ ok: false, reason: 'délai dépassé' }), timeoutMs);
      cp.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: e.message }); });
      cp.on('exit', () => { clearTimeout(timer); finish({ ok: true }); });
    } catch (e) {
      finish({ ok: false, reason: e.message });
    }
  });
}

// Active la Stats API. Best-effort : on ne peut pas connaître le résultat du
// processus élevé (détaché), donc l'appelant ne doit pas en dépendre — le
// diagnostic « Stats API injoignable » de l'agent reste le filet de sécurité.
async function enableStatsApi() {
  if (process.platform !== 'win32') {
    return { skipped: true, reason: 'Stats API disponible uniquement sur Windows' };
  }
  let tmpFile;
  try {
    tmpFile = path.join(os.tmpdir(),
      'rl-statsapi-' + process.pid + '-' + Date.now() + '.ps1');
    // Le script est 100 % ASCII : aucun encodage particulier requis.
    fs.writeFileSync(tmpFile, PS_LINES.join('\r\n') + '\r\n');
  } catch (e) {
    return { ok: false, reason: 'écriture du script impossible : ' + e.message };
  }
  return run('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], 120000);
}

module.exports = { enableStatsApi };
