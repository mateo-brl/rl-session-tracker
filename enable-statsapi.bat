@echo off
REM Active la Stats API native de Rocket League.
REM Double-clique simplement ce fichier : le script PowerShell s'occupe du reste
REM (detection Epic/Steam + elevation administrateur).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-statsapi.ps1"
