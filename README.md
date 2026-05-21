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
| 🪄 **Inscription self-service** | Un code d'invitation suffit : le joueur s'inscrit en ligne, l'agent se configure seul. Aucun fichier à transférer. |
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
> l'agent fournit **tout le détail des matchs** (résultats, stats, série) en
> direct, tracker.gg ne fournit plus que le **MMR et le rang** — rafraîchis
> pile à la fin de chaque match.

## 🚀 Démarrage rapide

### 👀 Je veux juste regarder

Ouvre le site (ex. **`https://rl.mateobrl.fr`**) et clique sur un joueur.
Rien à installer.

### 🖥️ J'héberge le serveur

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install

# Génère un code d'invitation à donner à un joueur
npm run add-invite -- --label "Mes amis" --uses 5

npm start
```

Le dashboard tourne sur `http://127.0.0.1:3000`. Pour le mettre vraiment en
ligne (HTTPS, domaine, pare-feu, WAF) → **[DEPLOY.md](DEPLOY.md)**.

### 🎮 Je veux envoyer les stats de mon PC

Tu as reçu un **code d'invitation** ? Tout se passe en ligne :

1. Va sur **`https://rl.mateobrl.fr/enroll`** et remplis le formulaire
   (code d'invitation, pseudo Rocket League, plateforme…).
2. **Télécharge l'application**, décompresse l'archive et lance
   **`RL Session Tracker`**.
3. Clique **« Oui »** à la fenêtre d'autorisation Windows.
4. **Redémarre Rocket League.**

L'agent est une **vraie application de bureau** : il se configure seul (le code
voyage dans le nom de l'archive — aucune saisie), **active la Stats API** du
jeu, **s'installe en démarrage automatique** et reste dans la **barre des
tâches**. Ta page s'affiche sur `https://rl.mateobrl.fr/u/tonpseudo` 🎉

> 🛡️ Avertissement Windows « éditeur inconnu » ? L'application n'est pas signée :
> clique « Informations complémentaires » → « Exécuter quand même ». Détails et
> solutions → **[BUILD-AGENT.md](BUILD-AGENT.md)**.

## 🎯 Activer la Stats API de Rocket League

L'agent a besoin de la **Stats API native** du jeu (intégrée avec la mise à
jour anti-triche d'avril 2026). **Bonne nouvelle : l'agent l'active tout seul**
à son premier lancement — une fenêtre d'autorisation Windows s'ouvre, clique
« Oui ». Tu n'as rien d'autre à faire que de redémarrer Rocket League.

<details>
<summary>Activation manuelle (secours)</summary>

Si l'activation automatique échoue, double-clique sur
**`enable-statsapi.bat`** → il détecte Rocket League (Epic ou Steam) et
configure le jeu. Ou édite à la main
`…\Rocket League\TAGame\Config\DefaultStatsAPI.ini` :

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
- 🎟️ **Inscription gardée** — l'inscription self-service exige un code
  d'invitation émis par l'admin. Codes d'invitation et de configuration sont
  eux aussi stockés **hachés**, jamais en clair.
- 🚦 **Anti-abus** — limitation de débit sur l'ingestion, le scraping, le SSE
  et l'enrôlement (avec plafonds de connexions).
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
| **Agent** | Application **Electron** — fenêtre native, barre des tâches |
| **Temps réel** | SSE (serveur → navigateur) · socket TCP (Stats API du jeu) |

## 📚 Documentation

| Document | Contenu |
|---|---|
| **[DEPLOY.md](DEPLOY.md)** | Mise en ligne : HTTPS, reverse proxy, WAF, systemd, gestion des joueurs. |
| **[BUILD-AGENT.md](BUILD-AGENT.md)** | Construire l'application agent (Electron) et gérer la signature de code. |

<details>
<summary>🗂️ Structure du projet</summary>

```
rl-session-tracker/
├── server.js              # Serveur Express : API, ingestion, SSE, enrôlement
├── lib/
│   ├── players.js         # Registre des joueurs + tokens (hachés)
│   ├── invites.js         # Registre des codes d'invitation (hachés)
│   ├── codes.js           # Génération et hachage des codes lisibles
│   ├── validate.js        # Validations partagées (id, pseudo, plateforme)
│   ├── matchlog.js        # Journal des matchs — détail venu de l'agent
│   └── tracker.js         # Scraping tracker.gg — MMR et rang uniquement
├── agent/                 # Application agent (Electron)
│   ├── main.js            # Processus principal : enrôlement + envoi des stats
│   ├── preload.js         # Pont IPC sécurisé interface ↔ agent
│   ├── renderer.html      # Interface de la fenêtre
│   ├── statsapi.js        # Connecteur de la Stats API du jeu
│   ├── enable-statsapi.js # Active la Stats API automatiquement
│   └── assets/            # Icône de l'application
├── scripts/
│   ├── add-agent.js       # CLI : déclarer un joueur manuellement
│   ├── add-invite.js      # CLI : générer un code d'invitation
│   ├── build-agent.mjs    # Construire l'application agent (Electron)
│   └── build-web.mjs      # Pré-compiler le dashboard (esbuild)
├── public/                # Dashboard web (React) + page d'inscription /enroll
├── enable-statsapi.bat    # Activer la Stats API à la main (secours)
└── enable-statsapi.ps1
```
</details>

<details>
<summary>⚙️ Prérequis</summary>

**Serveur** — Node.js 18+ et Chromium :
- Debian/Ubuntu : `sudo apt install chromium`
- Arch : `sudo pacman -S chromium`

**PC gaming** — Rocket League sur PC (Epic ou Steam) et Windows. L'application
agent ne demande rien d'autre ; Node.js 18+ uniquement si tu la construis
toi-même.
</details>

## 📄 Licence

MIT — fais-en ce que tu veux.
