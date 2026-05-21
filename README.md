<div align="center">

# 🚀 RL Session Tracker

**Suis tes sessions Rocket League en direct — MMR, victoires, stats de match — sur un dashboard web moderne.**

Plusieurs PC envoient leurs stats. Chaque joueur a sa page. Le tout en **temps réel**, sans le délai habituel des sites de stats.

</div>

---

## ✨ Ce que ça fait

| | |
|---|---|
| ⚡ **Temps réel** | Début/fin de match et score détectés **à la seconde**, via la Stats API native de Rocket League. |
| 📊 **Stats complètes** | MMR, rang, victoires/défaites, série en cours, buts · arrêts · passes · tirs. |
| 👥 **Multi-joueurs** | Plusieurs PC envoient leurs stats ; chacun a sa page `/u/pseudo`. |
| 🎨 **Dashboard soigné** | 3 layouts, thème clair/sombre, couleurs d'accent, bilingue FR/EN. |
| 🔥 **Tiltomètre** | Alerte sympa après 3 défaites d'affilée. |
| 🔒 **Sécurisé** | Conçu pour être exposé sur internet (tokens, anti-abus, validation). |

## 🧩 Comment ça marche

Le projet a **deux morceaux** :

```
   🎮 PC gaming                          🌐 Serveur (rl.mateobrl.fr)
  ┌──────────────┐                      ┌────────────────────────────┐
  │ Rocket League│                      │  Dashboard web             │
  │   Stats API  │   ── HTTPS ──>       │  reçoit · agrège · affiche │
  │      ↓       │   (token sécurisé)   │                            │
  │  rl-agent    │ ───────────────────> │  /u/pseudo  ←── 👀 public  │
  └──────────────┘                      └────────────────────────────┘
```

- **Le serveur** — c'est le dashboard. Il tourne sur une machine accessible depuis internet.
- **L'agent** — un petit programme sur chaque PC. Il lit les stats *dans le jeu* et les envoie au serveur.

> 💡 Pourquoi un agent ? Les sites de stats classiques (tracker.gg…) ont plusieurs minutes de retard. La Stats API intégrée à Rocket League, elle, est instantanée — mais uniquement en local. L'agent fait le pont.

---

## 🚀 Démarrage rapide

### 👀 Je veux juste regarder

Ouvre le site (ex. **`https://rl.mateobrl.fr`**) et clique sur un joueur. Rien à installer.

### 🖥️ J'héberge le serveur

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install

# Déclare un joueur (génère son token + son fichier config)
npm run add-agent -- --id mateo --platform epic --username TonPseudoRL --name "Mateo"

npm start
```

Le dashboard tourne sur `http://127.0.0.1:3000`. Pour le mettre en ligne proprement (HTTPS, nom de domaine, pare-feu) → **[DEPLOY.md](DEPLOY.md)**.

### 🎮 Je veux envoyer les stats de mon PC

1. **Active la Stats API du jeu** — double-clique sur **`enable-statsapi.bat`**, puis redémarre Rocket League.
2. Récupère **`rl-agent.exe`** et ton **`config.json`** (fournis par l'hébergeur du serveur).
3. Mets les deux fichiers dans un même dossier et lance **`rl-agent.exe`**.

Ta page s'affiche alors sur `https://rl.mateobrl.fr/u/tonpseudo` 🎉

> 🛡️ `rl-agent.exe` bloqué par l'antivirus ? C'est un faux positif courant des exécutables auto-portants. Solutions et méthode sans `.exe` → **[BUILD-AGENT.md](BUILD-AGENT.md)**.

---

## 🎯 Activer la Stats API de Rocket League

L'agent a besoin de la **Stats API native** du jeu (intégrée depuis la mise à jour
anti-triche d'avril 2026). Pour l'activer, une seule fois :

> Double-clique sur **`enable-statsapi.bat`** → il détecte Rocket League (Epic ou
> Steam) et configure le jeu. **Redémarre Rocket League** ensuite.

<details>
<summary>Activation manuelle</summary>

Édite `…\Rocket League\TAGame\Config\DefaultStatsAPI.ini` :

```ini
[TAGame.MatchStatsExporter_TA]
Port=49123
PacketSendRate=10
```
</details>

> ⚠️ La Stats API n'existe que sur **PC** (Epic / Steam). Sur console, ce tracker ne peut pas remonter les données en direct.

## 🔒 Sécurité

Le serveur est pensé pour vivre sur internet :

- 🔑 **Tokens par PC** — chaque agent a un token unique, stocké **haché** (un fichier volé ne donne aucun token utilisable).
- 🚦 **Anti-abus** — limitation de débit sur toutes les routes sensibles.
- 🧹 **Données validées** — tout ce qui entre est vérifié, typé et borné.
- 🛡️ **Pas de proxy ouvert** — le serveur n'interroge les sites de stats que pour les joueurs déclarés.
- 🧱 **Derrière un WAF** — prévu pour tourner derrière un reverse proxy + pare-feu applicatif (SafeLine).

Détails et mise en place → **[DEPLOY.md](DEPLOY.md)**.

## 📚 Documentation

| Document | Pour quoi |
|---|---|
| **[DEPLOY.md](DEPLOY.md)** | Mettre le serveur en ligne : HTTPS, reverse proxy, WAF, gestion des joueurs. |
| **[BUILD-AGENT.md](BUILD-AGENT.md)** | Construire `rl-agent.exe` et éviter les faux positifs antivirus. |

<details>
<summary>🗂️ Structure du projet</summary>

```
rl-session-tracker/
├── server.js            # Serveur : API, dashboard, ingestion
├── statsapi.js          # Connecteur Stats API de Rocket League
├── lib/players.js       # Registre des joueurs / tokens
├── scripts/
│   ├── add-agent.js     # Déclarer un nouveau PC
│   └── build-agent.mjs  # Construire rl-agent.exe
├── agent/
│   ├── agent.js         # L'agent (tourne sur le PC gaming)
│   └── run-agent.bat    # Lancer l'agent sans .exe (via Node)
├── enable-statsapi.bat  # Activer la Stats API du jeu
└── public/              # Dashboard web (interface)
```
</details>

<details>
<summary>⚙️ Prérequis</summary>

**Serveur** — Node.js 18+, et Chromium installé (`/usr/bin/chromium`) :
- Debian/Ubuntu : `sudo apt install chromium`
- Arch : `sudo pacman -S chromium`

**PC gaming** — Rocket League sur PC (Epic ou Steam). Rien d'autre avec `rl-agent.exe`.
</details>

## 📄 Licence

MIT — fais-en ce que tu veux.
