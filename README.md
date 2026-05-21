<div align="center">

# 🚀 RL Session Tracker

### Le suivi de tes sessions Rocket League, en direct.

MMR · victoires · stats de match — sur un dashboard web moderne,
alimenté **en temps réel** par plusieurs PC à la fois.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Dashboard](https://img.shields.io/badge/Dashboard-React-00e5ff?style=flat-square&logo=react&logoColor=white)
![Temps réel](https://img.shields.io/badge/Temps_réel-SSE-ff3d71?style=flat-square)
![Licence](https://img.shields.io/badge/Licence-MIT-blue?style=flat-square)

</div>

---

Les sites de stats classiques ont **plusieurs minutes de retard**. RL Session
Tracker, lui, lit les données **directement dans le jeu** via la Stats API
native de Rocket League : début de match, score, fin de match sont détectés
**à la seconde**. Plusieurs joueurs peuvent alimenter le même dashboard —
chacun a sa page.

## ✨ Fonctionnalités

| | |
|---|---|
| ⚡ **Temps réel** | Match et score détectés à la seconde via la Stats API du jeu. |
| 📊 **Stats complètes** | MMR, rang, victoires/défaites, série en cours, buts · arrêts · passes · tirs. |
| 👥 **Multi-joueurs** | Plusieurs PC envoient leurs stats ; chacun a sa page `/u/pseudo`. |
| 🟢 **Source transparente** | Un badge indique si les données viennent de l'agent (live) ou de tracker.gg (différé). |
| 🎨 **Dashboard soigné** | 3 layouts, thème clair/sombre, couleurs d'accent, bilingue FR/EN. |
| 🔥 **Tiltomètre** | Alerte sympa après 3 défaites d'affilée. |
| 🔒 **Sécurisé** | Conçu pour être exposé sur internet : tokens hachés, anti-abus, CSP stricte. |

## 🧩 Architecture

```
  🎮 PC gaming                       🌐 rl.mateobrl.fr                  👀 Spectateurs
 ┌───────────────┐                 ┌──────────────────────┐          ┌──────────────┐
 │ Rocket League │   agent ─POST─► │  serveur + dashboard  │  ─SSE─►  │  /u/pseudo   │
 │  → Stats API  │   HTTPS, token  │  + pool tracker.gg    │ temps réel│  (public)   │
 └───────────────┘                 └──────────────────────┘          └──────────────┘
```

Le projet a **deux morceaux** :

- **🖥️ Le serveur** — le dashboard. Il tourne sur une machine accessible depuis
  internet, reçoit les flux des agents, interroge tracker.gg pour le MMR, et
  diffuse tout en direct aux spectateurs.
- **🎮 L'agent** — un petit programme sur chaque PC gaming. Il lit la Stats API
  locale du jeu et la pousse au serveur. Aucune connexion entrante : c'est
  toujours l'agent qui contacte le serveur.

> 💡 **Pourquoi ce découpage ?** La Stats API du jeu est instantanée mais
> *locale*. tracker.gg est *distant* mais en retard. On combine les deux :
> l'agent donne le live, tracker.gg donne le MMR exact — rafraîchi pile à la
> fin de chaque match.

## 🚀 Démarrage rapide

### 👀 Je veux juste regarder

Ouvre le site (ex. **`https://rl.mateobrl.fr`**) et clique sur un joueur.
Rien à installer.

### 🖥️ J'héberge le serveur

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install

# Déclare un joueur — génère son token + son fichier de config
npm run add-agent -- --id mateo --platform epic --username TonPseudoRL --name "Mateo"

npm start
```

Le dashboard tourne sur `http://127.0.0.1:3000`. Pour le mettre vraiment en
ligne (HTTPS, domaine, pare-feu, WAF) → **[DEPLOY.md](DEPLOY.md)**.

### 🎮 Je veux envoyer les stats de mon PC

1. **Active la Stats API du jeu** — double-clique sur **`enable-statsapi.bat`**,
   puis redémarre Rocket League.
2. Récupère **`rl-agent.exe`** et ton **`config.json`** (fournis par
   l'hébergeur du serveur).
3. Place les deux dans un même dossier et lance **`rl-agent.exe`**.

Ta page s'affiche sur `https://rl.mateobrl.fr/u/tonpseudo` 🎉

> 🛡️ `rl-agent.exe` bloqué par l'antivirus ? C'est un faux positif courant des
> exécutables auto-portants. Solutions + méthode sans `.exe` →
> **[BUILD-AGENT.md](BUILD-AGENT.md)**.

## 🎯 Activer la Stats API de Rocket League

L'agent a besoin de la **Stats API native** du jeu (intégrée avec la mise à
jour anti-triche d'avril 2026). Une seule fois :

> Double-clique sur **`enable-statsapi.bat`** → il détecte Rocket League
> (Epic ou Steam) et configure le jeu. **Redémarre Rocket League** ensuite.

<details>
<summary>Activation manuelle</summary>

Édite `…\Rocket League\TAGame\Config\DefaultStatsAPI.ini` :

```ini
[TAGame.MatchStatsExporter_TA]
Port=49123
PacketSendRate=10
```
</details>

> ⚠️ La Stats API n'existe que sur **PC** (Epic / Steam). Sur console, le live
> n'est pas disponible.

## 🔒 Sécurité

Le serveur est pensé pour vivre sur internet :

- 🔑 **Tokens par PC** — chaque agent a un token unique, stocké **haché**
  (SHA-256). Un `players.json` volé ne donne aucun token réutilisable.
- 🚦 **Anti-abus** — limitation de débit sur l'ingestion, le scraping et le SSE
  (avec plafonds de connexions).
- 🧹 **Données validées** — tout ce qu'un agent envoie est vérifié, typé et
  borné avant d'être rediffusé.
- 🛡️ **Pas de proxy ouvert** — le serveur n'interroge tracker.gg que pour les
  joueurs déclarés.
- 🧱 **CSP stricte + WAF** — en-têtes Helmet, dashboard pré-compilé (aucun CDN),
  prévu pour tourner derrière un reverse proxy + WAF (SafeLine).

Détails et mise en place → **[DEPLOY.md](DEPLOY.md)**.

## 🧰 Stack technique

| Côté | Technologies |
|---|---|
| **Serveur** | Node.js · Express · Helmet · express-rate-limit |
| **Scraping** | Puppeteer — pool de pages Chromium headless (parallèle) |
| **Dashboard** | React 18 — pré-compilé via esbuild, CSP stricte |
| **Agent** | Node.js — packagé en `.exe` via Node SEA |
| **Temps réel** | SSE (serveur → navigateur) · socket TCP (Stats API du jeu) |

## 📚 Documentation

| Document | Contenu |
|---|---|
| **[DEPLOY.md](DEPLOY.md)** | Mise en ligne : HTTPS, reverse proxy, WAF, systemd, gestion des joueurs. |
| **[BUILD-AGENT.md](BUILD-AGENT.md)** | Construire `rl-agent.exe` et limiter les faux positifs antivirus. |

<details>
<summary>🗂️ Structure du projet</summary>

```
rl-session-tracker/
├── server.js              # Serveur Express : API, ingestion, SSE, dashboard
├── statsapi.js            # Connecteur de la Stats API du jeu (utilisé par l'agent)
├── lib/
│   ├── players.js         # Registre des joueurs + tokens (hachés)
│   └── tracker.js         # Scraping tracker.gg — pool de pages Chromium
├── agent/
│   ├── agent.js           # L'agent — tourne sur le PC gaming
│   ├── config.example.json
│   └── run-agent.bat      # Lancer l'agent sans .exe (via Node)
├── scripts/
│   ├── add-agent.js       # CLI : déclarer un nouveau PC
│   ├── build-agent.mjs    # Construire rl-agent.exe (Node SEA)
│   └── build-web.mjs      # Pré-compiler le dashboard (esbuild)
├── public/                # Dashboard web (React, pré-compilé)
├── enable-statsapi.bat    # Activer la Stats API du jeu (Windows)
└── enable-statsapi.ps1
```
</details>

<details>
<summary>⚙️ Prérequis</summary>

**Serveur** — Node.js 18+ et Chromium :
- Debian/Ubuntu : `sudo apt install chromium`
- Arch : `sudo pacman -S chromium`

**PC gaming** — Rocket League sur PC (Epic ou Steam). Rien d'autre avec
`rl-agent.exe` ; Node.js 20+ seulement si tu construis l'agent toi-même.
</details>

## 📄 Licence

MIT — fais-en ce que tu veux.
