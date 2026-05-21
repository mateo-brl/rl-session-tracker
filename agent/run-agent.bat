@echo off
REM ───────────────────────────────────────────────────────────────
REM  Lance l'agent RL Session Tracker SANS executable (.exe).
REM
REM  Cette methode ne declenche AUCUN faux positif antivirus : c'est
REM  juste Node.js qui execute un script. A privilegier si rl-agent.exe
REM  est bloque par Windows Defender.
REM
REM  Prerequis : Node.js 20+  ->  https://nodejs.org
REM  Au premier lancement, l'agent demande ton code de configuration
REM  (obtenu apres l'inscription en ligne) et se configure tout seul.
REM ───────────────────────────────────────────────────────────────
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js est introuvable. Installe-le depuis https://nodejs.org
  echo   puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

node agent.js
pause
