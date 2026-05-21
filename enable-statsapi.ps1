# enable-statsapi.ps1
# Active la Stats API native de Rocket League (mise à jour Easy Anti-Cheat,
# avril 2026). Écrit le fichier DefaultStatsAPI.ini dans le dossier
# d'installation du jeu — Epic Games et Steam sont détectés automatiquement.
#
# Lance plutôt enable-statsapi.bat (double-clic) ; ce script s'élève tout seul
# en administrateur car le dossier d'installation est sous Program Files.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# ───────── Paramètres ─────────
$Port = 49123   # port d'écoute du socket local
$Rate = 10      # mises à jour par seconde (1-120 ; 0 = désactivé)

# ───────── Élévation automatique en administrateur ─────────
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Élévation des privilèges (administrateur requis)..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}

# ───────── Validation d'un dossier d'installation Rocket League ─────────
# Les chemins viennent de sources non fiables (manifestes Epic,
# libraryfolders.vdf) : on n'écrit le .ini, en admin, que dans un dossier qui
# ressemble vraiment à une install Rocket League. On canonicalise le chemin et
# on exige la présence de l'exécutable du jeu ET du dossier de config.
#
# AVERTISSEMENT TOCTOU : il subsiste une fenêtre entre cette validation et
# l'écriture du fichier — un tiers pourrait remplacer/déplacer le dossier
# entre les deux. Ce script n'est pas signé et n'élimine pas ce risque ; il ne
# fait que réduire la surface aux chemins plausibles. Une protection complète
# exigerait un installeur signé et des ACL strictes sur le dossier cible.
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

# ───────── Détection des installations de Rocket League ─────────
function Find-RLInstalls {
  $found = @()

  # --- Epic Games : manifestes du launcher ---
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

  # --- Steam : Rocket League = appid 252950 ---
  $steamPath = $null
  try {
    $steamPath = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -Name SteamPath `
      -ErrorAction Stop).SteamPath
  } catch {}
  if ($steamPath) {
    $libs = @($steamPath)
    $libVdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
    if (Test-Path $libVdf) {
      Select-String -Path $libVdf -Pattern '"path"\s+"(.+?)"' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object {
          $libs += ($_.Groups[1].Value -replace '\\\\', '\')
        }
    }
    foreach ($lib in ($libs | Select-Object -Unique)) {
      $cand = Join-Path $lib 'steamapps\common\rocketleague'
      if (Test-Path $cand) { $found += $cand }
    }
  }

  # --- Chemins courants, en dernier recours ---
  $found += 'C:\Program Files\Epic Games\rocketleague'
  $found += 'C:\Program Files (x86)\Steam\steamapps\common\rocketleague'

  # Validation stricte : on canonicalise chaque chemin et on ne garde que ceux
  # qui ressemblent vraiment à une install RL (exécutable du jeu + TAGame\Config).
  # Test-RLInstall renvoie le chemin canonique, ce qui dédoublonne aussi les
  # variantes d'un même dossier (casse, séparateurs, '..').
  $valid = @()
  foreach ($p in ($found | Select-Object -Unique)) {
    $ok = Test-RLInstall -Path $p
    if ($ok) { $valid += $ok }
  }
  $valid | Select-Object -Unique
}

Write-Host ''
Write-Host '  Rocket League · activation de la Stats API' -ForegroundColor Cyan
Write-Host '  ------------------------------------------'

$installs = @(Find-RLInstalls)
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

foreach ($dir in $installs) {
  $iniPath = Join-Path $dir 'TAGame\Config\DefaultStatsAPI.ini'
  try {
    if (Test-Path $iniPath) {
      Copy-Item $iniPath "$iniPath.bak" -Force -ErrorAction SilentlyContinue
    }
    Set-Content -Path $iniPath -Value $ini -Encoding ASCII -Force
    Write-Host "  [OK]    $iniPath" -ForegroundColor Green
  } catch {
    Write-Host "  [ÉCHEC] $iniPath" -ForegroundColor Red
    Write-Host "          $($_.Exception.Message)" -ForegroundColor DarkGray
  }
}

Write-Host ''
Write-Host "  Stats API activée sur le port $Port ($Rate maj/s)." -ForegroundColor Green
Write-Host '  >> Redémarre Rocket League pour appliquer le changement.' -ForegroundColor Yellow
Write-Host ''
Read-Host '  Appuie sur Entrée pour quitter'
