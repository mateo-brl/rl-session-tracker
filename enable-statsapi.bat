@echo off
REM Active la Stats API native de Rocket League.
REM Double-clique simplement ce fichier : le script PowerShell s'occupe du reste
REM (detection Epic/Steam + elevation administrateur).
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-statsapi.ps1"
set "RC=%ERRORLEVEL%"

REM Garde-fou : enable-statsapi.ps1 marque deja une pause (Read-Host) sur
REM chaque chemin de sortie normal. Mais si PowerShell plante avant d'y
REM arriver (script introuvable, erreur de parsing, PowerShell absent...),
REM cette fenetre se fermerait instantanement sans que l'utilisateur voie
REM quoi que ce soit : un double-clic qui "flashe" et se referme, en
REM laissant croire que tout s'est bien passe. On force donc toujours une
REM pause ici des que le code de sortie n'est pas 0.
if not "%RC%"=="0" (
  echo.
  echo   Le script a signale une erreur ^(code %RC%^). Verifie les messages ci-dessus.
  echo.
  pause
)
