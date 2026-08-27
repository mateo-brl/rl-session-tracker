# enable-statsapi.ps1
# Active la Stats API native de Rocket League (mise à jour Easy Anti-Cheat,
# avril 2026). Écrit le fichier DefaultStatsAPI.ini dans le dossier
# d'installation du jeu — Epic Games et Steam sont détectés automatiquement.
#
# Lance plutôt enable-statsapi.bat (double-clic) ; ce script s'élève tout
# seul en administrateur car le dossier d'installation est sous Program
# Files.
#
# ARCHITECTURE — leçon apprise sur un PC Steam (le même bug a été corrigé
# côté application en v3.9.1 ; voir le commentaire d'en-tête de
# src/main/enable-statsapi.js, plus détaillé) : la détection Epic/Steam se
# fait ICI, AVANT l'élévation, dans la session du VRAI utilisateur, puis la
# liste déjà validée est transmise à l'instance élevée via -Installs.
# Pourquoi : quand UAC élève vers un AUTRE compte (utilisateur
# non-administrateur — cas familial très courant), le
# HKCU:\Software\Valve\Steam lu par l'instance élevée est la ruche de
# l'ADMINISTRATEUR, où la clé SteamPath n'existe pas. libraryfolders.vdf
# n'est alors jamais lu et Rocket League installé sur D:\SteamLibrary (ou
# tout disque autre que C:) devient introuvable — seuls les chemins par
# défaut sous C: survivaient à ce bug.

param(
  # Liste de dossiers d'installation déjà détectés et validés côté
  # utilisateur (session non élevée), séparés par ';'. Transmis
  # automatiquement par ce script à sa propre instance élevée — un
  # utilisateur ne doit normalement jamais renseigner ce paramètre à la main.
  [string]$Installs = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# ───────── Paramètres ─────────
$Port = 49123   # port d'écoute du socket local
# 120 maj/s : nécessaire pour la réactivité du son Alpha Boost (voir
# src/main/enable-statsapi.js). La vérification côté application n'exige
# qu'un rate "> 0" : une valeur plus basse écrite ici serait donc toujours
# jugée valide et ne serait jamais corrigée automatiquement par l'app.
$Rate = 120

# ───────── Validation d'un dossier d'installation Rocket League ─────────
# Les chemins viennent de sources non fiables (manifestes Epic,
# libraryfolders.vdf, registre) : on n'écrit le .ini, en admin, que dans un
# dossier qui ressemble vraiment à une install Rocket League. On
# canonicalise le chemin et on exige la présence de l'exécutable du jeu ET
# du dossier de config.
#
# AVERTISSEMENT TOCTOU : il subsiste une fenêtre entre cette validation et
# l'écriture du fichier — un tiers pourrait remplacer/déplacer le dossier
# entre les deux. Ce script n'est pas signé et n'élimine pas ce risque ; il
# ne fait que réduire la surface aux chemins plausibles. Une protection
# complète exigerait un installeur signé et des ACL strictes sur le dossier
# cible.
function Test-RLInstall {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  # Canonicalisation : résout . / .. / liens et normalise la casse/séparateurs.
  $canon = $null
  try {
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $canon = [System.IO.Path]::GetFullPath($resolved.Path)
  } catch { return $null }
  if (-not (Test-Path -LiteralPath $canon -PathType Container)) { return $null }
  # Exécutable du jeu : signe le plus fiable d'une vraie install RL.
  $exe = Join-Path $canon 'Binaries\Win64\RocketLeague.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
  # Dossier de config où l'on écrira le .ini.
  $cfg = Join-Path $canon 'TAGame\Config'
  if (-not (Test-Path -LiteralPath $cfg -PathType Container)) { return $null }
  return $canon
}

# ───────── Détection : Epic (ProgramData) + chemins par défaut ─────────
# Indépendante du compte utilisateur (ProgramData est partagé sur la
# machine, lisible sans élévation) : sert à la détection normale ET de filet
# de sécurité, rejouable sans risque dans l'instance élevée (contrairement à
# la lecture du registre Steam via HKCU — voir l'en-tête).
function Find-EpicAndDefaults {
  $found = @()

  $epicManifests = Join-Path $env:ProgramData 'Epic\EpicGamesLauncher\Data\Manifests'
  if (Test-Path $epicManifests) {
    Get-ChildItem $epicManifests -Filter *.item -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $m = Get-Content $_.FullName -Raw | ConvertFrom-Json
        if ($m.DisplayName -like '*Rocket League*' -and $m.InstallLocation) {
          $found += $m.InstallLocation
        }
      } catch {}
    }
  }

  $found += 'C:\Program Files\Epic Games\rocketleague'
  $found += 'C:\Program Files (x86)\Steam\steamapps\common\rocketleague'
  $found
}

# ───────── Détection complète : Epic + Steam (registre) + défauts ─────────
# À N'APPELER QUE DANS LA SESSION DU VRAI UTILISATEUR (avant élévation), ou
# quand on sait que le compte n'a pas changé (ex. déjà administrateur dès le
# départ) — voir l'avertissement UAC en tête de fichier.
function Find-RLInstalls {
  $found = @(Find-EpicAndDefaults)

  # Steam : HKCU (compte courant) + repli HKLM (WOW6432Node, indépendant du
  # compte — utile si HKCU est absent, ou quand on tourne déjà en admin sans
  # avoir changé de compte).
  $steamPaths = @()
  try {
    $p = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -Name SteamPath `
      -ErrorAction Stop).SteamPath
    if ($p) { $steamPaths += $p }
  } catch {}
  try {
    $p = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -Name InstallPath `
      -ErrorAction Stop).InstallPath
    if ($p) { $steamPaths += $p }
  } catch {}

  foreach ($steamPath in ($steamPaths | Select-Object -Unique)) {
    $libs = @($steamPath)
    $libVdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
    if (Test-Path $libVdf) {
      Select-String -Path $libVdf -Pattern '"path"\s+"(.+?)"' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object {
          $libs += ($_.Groups[1].Value -replace '\\\\', '\')
        }
    }
    foreach ($lib in ($libs | Select-Object -Unique)) {
      $found += (Join-Path $lib 'steamapps\common\rocketleague')
    }
  }

  # Validation stricte : on canonicalise chaque chemin et on ne garde que
  # ceux qui ressemblent vraiment à une install RL (exécutable du jeu +
  # TAGame\Config). Test-RLInstall renvoie le chemin canonique, ce qui
  # dédoublonne aussi les variantes d'un même dossier (casse, séparateurs, '..').
  $valid = @()
  foreach ($p in ($found | Select-Object -Unique)) {
    $ok = Test-RLInstall -Path $p
    if ($ok) { $valid += $ok }
  }
  $valid | Select-Object -Unique
}

# ───────── Élévation automatique en administrateur ─────────
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

if (-not $isAdmin) {
  # Session du vrai utilisateur : c'est ICI, et seulement ici, que la
  # lecture du registre Steam (HKCU) est garantie fiable (voir l'en-tête).
  Write-Host "  Détection de l'installation (session utilisateur)..." -ForegroundColor Yellow
  $detected = @(Find-RLInstalls)

  Write-Host '  Élévation des privilèges (administrateur requis)...' -ForegroundColor Yellow
  $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($detected.Count -gt 0) {
    $psArgs += '-Installs'
    $psArgs += "`"$($detected -join ';')`""
  }

  try {
    Start-Process powershell -Verb RunAs -ArgumentList $psArgs -ErrorAction Stop
  } catch {
    # Refus de l'UAC (ou échec du lancement élevé) : Start-Process lève ici
    # une erreur TERMINANTE (« L'opération a été annulée par l'utilisateur »).
    # Sans ce try/catch, le script mourait instantanément, sans aucun
    # message — la fenêtre se fermait (ou, lancée depuis le .bat, semblait
    # juste "flasher") et l'utilisateur croyait l'activation réussie alors
    # que RIEN n'avait été écrit.
    Write-Host ''
    Write-Host "  /!\ Élévation refusée : la Stats API n'a PAS été activée." -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray
    Write-Host ''
    Read-Host '  Appuie sur Entrée pour quitter'
    exit 1
  }
  # L'instance élevée (nouvelle fenêtre) prend le relais : c'est elle qui
  # détecte le résultat final et affiche le message de succès/échec.
  exit 0
}

# ───────── À partir d'ici, le processus est forcément administrateur ─────────
Write-Host ''
Write-Host '  Rocket League · activation de la Stats API' -ForegroundColor Cyan
Write-Host '  ------------------------------------------'

if ($Installs) {
  # Liste déjà détectée et validée dans la session utilisateur (voir
  # l'en-tête). On la revalide quand même (canonicalisation + présence de
  # l'exécutable) par défense en profondeur — ces chemins ont transité par
  # la ligne de commande.
  $installs = @()
  foreach ($p in ($Installs -split ';')) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    $c = Test-RLInstall -Path $p
    if ($c) { $installs += $c }
  }
  # Filet de sécurité : Epic (ProgramData) + chemins par défaut, comme le
  # fait l'application. PAS de nouvelle lecture du registre Steam ici :
  # c'est justement cette lecture, dans la mauvaise ruche HKCU après
  # élévation vers un autre compte, qui causait le bug (voir l'en-tête).
  foreach ($p in (Find-EpicAndDefaults)) {
    $c = Test-RLInstall -Path $p
    if ($c) { $installs += $c }
  }
  $installs = @($installs | Select-Object -Unique)
} else {
  # Aucune liste reçue : ce script a été lancé directement en administrateur
  # (ex. clic droit > Exécuter en tant qu'administrateur), sans passer par
  # la détection préalable côté utilisateur. Le compte n'a pas changé ici,
  # donc relire le registre (HKCU compris) reste fiable.
  $installs = @(Find-RLInstalls)
}

if ($installs.Count -eq 0) {
  Write-Host '  /!\ Installation de Rocket League introuvable.' -ForegroundColor Red
  Write-Host ''
  Write-Host "  Édite ce fichier à la main, puis relance le jeu :"
  Write-Host '    <dossier Rocket League>\TAGame\Config\DefaultStatsAPI.ini'
  Write-Host ''
  Write-Host '    [TAGame.MatchStatsExporter_TA]'
  Write-Host "    Port=$Port"
  Write-Host "    PacketSendRate=$Rate"
  Write-Host ''
  Read-Host '  Appuie sur Entrée pour quitter'
  exit 1
}

# ───────── Écriture du fichier de configuration ─────────
$ini = @"
[TAGame.MatchStatsExporter_TA]
Port=$Port
PacketSendRate=$Rate
"@

$configured = @()
foreach ($dir in $installs) {
  $iniPath = Join-Path $dir 'TAGame\Config\DefaultStatsAPI.ini'
  try {
    if (Test-Path $iniPath) {
      Copy-Item $iniPath "$iniPath.bak" -Force -ErrorAction SilentlyContinue
    }
    Set-Content -Path $iniPath -Value $ini -Encoding ASCII -Force
    Write-Host "  [OK]    $iniPath" -ForegroundColor Green
    $configured += $dir
  } catch {
    Write-Host "  [ÉCHEC] $iniPath" -ForegroundColor Red
    Write-Host "          $($_.Exception.Message)" -ForegroundColor DarkGray
  }
}

Write-Host ''
if ($configured.Count -eq 0) {
  # Aucune écriture n'a abouti : ne JAMAIS conclure en vert ici. Avant ce
  # correctif, le message de succès s'affichait de façon INCONDITIONNELLE,
  # même quand chaque écriture ci-dessus avait échoué — l'utilisateur
  # redémarrait le jeu pour rien, sans que la Stats API soit réellement
  # activée.
  Write-Host "  /!\ Aucune installation n'a pu être configurée." -ForegroundColor Red
  Write-Host "      La Stats API n'a PAS été activée (voir les échecs ci-dessus)." -ForegroundColor Red
  Write-Host ''
  Read-Host '  Appuie sur Entrée pour quitter'
  exit 1
}

Write-Host "  Stats API activée sur le port $Port ($Rate maj/s)." -ForegroundColor Green
if ($configured.Count -lt $installs.Count) {
  Write-Host "  ($($configured.Count)/$($installs.Count) installations configurées — voir les échecs ci-dessus)" -ForegroundColor Yellow
}
foreach ($c in $configured) { Write-Host "    - $c" -ForegroundColor DarkGray }
Write-Host '  >> Redémarre Rocket League pour appliquer le changement.' -ForegroundColor Yellow
Write-Host ''
Read-Host '  Appuie sur Entrée pour quitter'
exit 0
