<div align="center">

# 🚀 RL Session Tracker

### Ton tracker de session Rocket League, en direct sur ton 2ᵉ écran.
### Your live Rocket League session tracker, on your second screen.

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078d4?style=flat-square&logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/App-Electron-47848f?style=flat-square&logo=electron&logoColor=white)
![Updates](https://img.shields.io/badge/Updates-automatic-2ee6a6?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

**[🇫🇷 Français](#-français) · [🇬🇧 English](#-english)**

</div>

---

## 🇫🇷 Français

Victoires · défaites · série · stats par mode · MMR — détectés à la seconde,
directement depuis le jeu. Aucune inscription, aucun site externe, 100 % local.

Depuis que l'anti-triche de Rocket League a banni BakkesMod, la **Stats API
native du jeu** est la seule source temps réel autorisée. RL Session Tracker
s'en sert pour faire ce que faisaient les overlays d'avant — en mieux : un
vrai dashboard de session sur ton double écran, qui s'ouvre tout seul quand
tu lances le jeu.

### ✨ Ce que ça fait

| | |
|---|---|
| 🖥️ **Dashboard auto** | Tu lances Rocket League → le tracker s'ouvre en plein écran sur ton 2ᵉ écran. Tu quittes le jeu → il se ferme. |
| ⚡ **Temps réel** | Score, temps, overtime, stats des joueurs — à la seconde, pendant le match. |
| 📊 **Ta session** | Victoires/défaites, % de victoires, série en cours, meilleure série, par mode (1v1 · 2v2 · 3v3). La liste des matchs récents repart à zéro à chaque lancement (ou d'un clic). |
| 📈 **Évolution MMR** | Recopie une fois ton MMR affiché en jeu (saison 22+) : courbe d'évolution match après match, bilan des 7 derniers jours, records de tous les temps. |
| ⚖️ **Comptage honnête** | Un forfait en classé compte comme une défaite (comme dans le jeu). Un commutateur Classé/Casual sur chaque match en direct évite que le casual pollue ton MMR. |
| 🥅 **Tes stats** | Buts, passes, arrêts, tirs, MVP — cumulés sur la session et détaillés match par match. |
| 🪄 **Zéro config** | Pas de compte, pas de code. L'appli détecte même ton pseudo toute seule après 2-3 matchs. |
| 🎯 **Mini-overlay** | Petit bandeau toujours au premier plan (W–L, série, score live) pour jouer sur un seul écran. |
| 🔄 **Mises à jour auto** | Une nouvelle version sort → un bouton « Mettre à jour » apparaît → un clic et c'est fait. |
| 🔊 **Jingles** | Un son de victoire, un son de défaite (désactivables) — et un tiltomètre après 3 défaites d'affilée. |

### 🎮 Installation (2 minutes, aucune connaissance requise)

1. **Télécharge** le fichier `RL-Session-Tracker-Setup-X.Y.Z.exe` depuis la
   [dernière release](https://github.com/mateo-brl/rl-session-tracker/releases/latest).
2. **Double-clique** dessus. Si Windows affiche « Éditeur inconnu », clique
   *Informations complémentaires* → *Exécuter quand même* (l'application
   n'est pas signée, c'est normal pour un projet gratuit).
3. Au premier lancement, **clique « Oui »** à la fenêtre d'autorisation
   Windows : elle active la Stats API du jeu (un fichier de configuration de
   Rocket League).
4. **Lance Rocket League et joue.** C'est tout. 🎉

L'application :
- s'installe en **démarrage automatique** avec Windows (elle vit discrètement
  dans la barre des tâches) ;
- **détecte ton pseudo toute seule** après quelques matchs (c'est le seul
  joueur présent dans toutes tes parties) ;
- ouvre le **dashboard sur ton 2ᵉ écran** dès que le jeu démarre.

> 💡 **Optionnel — le MMR :** active « Afficher le MMR » dans les paramètres
> de Rocket League (Interface), recopie les valeurs dans la fenêtre de
> l'application, et le dashboard suivra ton MMR estimé (≈ ±9 par match
> classé). Tu peux le corriger quand tu veux.

#### ❓ Petits soucis courants

<details>
<summary><b>Le dashboard ne montre rien pendant mes matchs</b></summary>

La Stats API du jeu n'est probablement pas active. Ouvre la fenêtre de
l'application (icône dans la barre des tâches) → clique **« Réactiver la
Stats API du jeu »** → accepte la fenêtre Windows → **redémarre Rocket
League**. En dernier recours, double-clique sur `enable-statsapi.bat`
(inclus dans ce dépôt).
</details>

<details>
<summary><b>Mes victoires/défaites ne sont pas comptées</b></summary>

L'application ne sait pas encore qui tu es. Joue 2-3 matchs (elle détecte ton
pseudo automatiquement), ou ouvre la fenêtre de l'application et choisis ton
pseudo dans les suggestions.
</details>

<details>
<summary><b>Le dashboard s'ouvre sur le mauvais écran</b></summary>

Il choisit l'écran **secondaire** automatiquement. Si tu préfères le placer
toi-même, décoche « plein écran » dans les réglages : il s'ouvrira en fenêtre
normale que tu peux déplacer.
</details>

> ⚠️ La Stats API n'existe que sur **PC** (Epic / Steam). L'application est
> Windows uniquement.

### 🧩 Comment ça marche

```
 ┌──────────────────────────── ton PC ────────────────────────────┐
 │                                                                │
 │  🎮 Rocket League ──Stats API──►  🛰️ RL Session Tracker        │
 │     (socket local 49123)            │   barre des tâches       │
 │                                     ├─► 🖥️ dashboard 2ᵉ écran  │
 │                                     └─► 💾 matchs (en local)   │
 │                                                                │
 └────────────────────────────────────────────────────────────────┘
                          ▲
            GitHub Releases (mises à jour auto)
```

Tout est local : tes matchs sont enregistrés dans un fichier JSON sur ton PC
(`%APPDATA%/RL Session Tracker`), rien n'est envoyé nulle part. La seule
connexion sortante est la vérification de mise à jour sur GitHub.

**Pourquoi pas le vrai MMR ?** La Stats API du jeu ne le diffuse pas, les
sites comme tracker.gg n'ont pas d'API publique (et leur scraping casse sans
arrêt), et les API tierces exigent des clés privées. Depuis la saison 22 le
MMR est visible **dans le jeu** : on le recopie une fois, l'appli fait le
reste. Fiable, hors-ligne, et ça ne peut pas casser.

### 🧰 Pour les développeurs

| Côté | Technologies |
|---|---|
| **Application** | Electron — un seul processus principal, fenêtres HTML/CSS/JS sans framework ni étape de build |
| **Données** | Stats API native du jeu (socket TCP `127.0.0.1:49123`, JSON concaténé) |
| **Empaquetage** | electron-builder — installeur NSIS un-clic |
| **Mises à jour** | electron-updater + GitHub Releases (`latest.yml`) |

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install
npm start          # lance l'application en mode développement
npm run dist       # construit l'installeur Windows dans dist/
```

#### Publier une nouvelle version

```bash
npm version minor          # bump package.json + tag vX.Y.Z
git push --follow-tags
```

Le workflow GitHub Actions ([release.yml](.github/workflows/release.yml))
construit l'installeur sur Windows et publie la release (déclenchable aussi
par un commit `main` contenant `[release]`, ou à la main depuis l'onglet
Actions). Toutes les applications installées la verront et proposeront le
bouton « Mettre à jour ».

<details>
<summary>🗂️ Structure du projet</summary>

```
rl-session-tracker/
├── src/
│   ├── main/                  # Processus principal Electron
│   │   ├── index.js           # Cycle de vie, tray, IPC, câblage général
│   │   ├── statsapi.js        # Connecteur Stats API (TCP, parseur de flux)
│   │   ├── game-watcher.js    # Détection du processus RocketLeague.exe
│   │   ├── session.js         # Journal des matchs + stats + MMR + records
│   │   ├── config.js          # Préférences (pseudo, MMR, options)
│   │   ├── windows.js         # Fenêtres : contrôle, dashboard, overlay
│   │   ├── updater.js         # Mises à jour automatiques (GitHub Releases)
│   │   └── enable-statsapi.js # Active la Stats API du jeu (PowerShell élevé)
│   ├── preload.js             # Pont IPC sécurisé (contextIsolation)
│   └── renderer/
│       ├── control.html       # Fenêtre de contrôle / réglages
│       ├── dashboard.html     # Le tracker plein écran
│       ├── overlay.html       # Mini-overlay toujours au premier plan
│       └── fonts/             # Barlow Condensed (licence OFL-1.1)
├── build/icon.ico             # Icône de l'application
├── electron-builder.yml       # Empaquetage NSIS + publication GitHub
├── .github/workflows/release.yml
└── enable-statsapi.bat / .ps1 # Activation manuelle de secours
```
</details>

### 📄 Licence

MIT — fais-en ce que tu veux.

---

## 🇬🇧 English

Wins · losses · streak · per-mode stats · MMR — detected the second they
happen, straight from the game. No sign-up, no third-party website, 100% local.

Since Rocket League's anti-cheat banned BakkesMod, the game's **native Stats
API** is the only allowed real-time source. RL Session Tracker uses it to do
what the old overlays did — better: a real session dashboard on your second
screen that opens by itself when you launch the game.

### ✨ Features

| | |
|---|---|
| 🖥️ **Auto dashboard** | Launch Rocket League → the tracker opens fullscreen on your second screen. Quit the game → it closes. |
| ⚡ **Real time** | Score, clock, overtime, player stats — to the second, during the match. |
| 📊 **Your session** | Wins/losses, win rate, current streak, best streak, per mode (1v1 · 2v2 · 3v3). The recent-matches list starts fresh on every launch (or with one click). |
| 📈 **MMR tracking** | Copy your in-game MMR once (Season 22+): match-by-match evolution chart, last-7-days summary, all-time records. |
| ⚖️ **Honest counting** | Forfeiting a ranked match counts as a loss (just like in the game). A Ranked/Casual switch on each live match keeps casual games from polluting your MMR. |
| 🥅 **Your stats** | Goals, assists, saves, shots, MVP — session totals and per-match detail. |
| 🪄 **Zero config** | No account, no code. The app even detects your in-game name by itself after 2-3 matches. |
| 🎯 **Mini-overlay** | Small always-on-top strip (W–L, streak, live score) for single-screen setups. |
| 🔄 **Auto updates** | A new version ships → an "Update" button appears → one click and you're done. |
| 🔊 **Jingles** | A win sound, a loss sound (can be turned off) — and a tilt-o-meter after 3 losses in a row. |

### 🎮 Install (2 minutes, no technical knowledge needed)

1. **Download** `RL-Session-Tracker-Setup-X.Y.Z.exe` from the
   [latest release](https://github.com/mateo-brl/rl-session-tracker/releases/latest).
2. **Double-click** it. If Windows shows "Unknown publisher", click
   *More info* → *Run anyway* (the app isn't code-signed, which is normal
   for a free project).
3. On first launch, **click "Yes"** on the Windows permission prompt: it
   enables the game's Stats API (a Rocket League config file).
4. **Launch Rocket League and play.** That's it. 🎉

The app:
- installs itself to **start with Windows** (it lives quietly in the system
  tray);
- **detects your in-game name by itself** after a few matches (you're the
  only player present in all of them);
- opens the **dashboard on your second screen** as soon as the game starts.

> 💡 **Optional — MMR:** enable "Show MMR" in Rocket League's settings
> (Interface), copy the values into the app window, and the dashboard will
> track your estimated MMR (≈ ±9 per ranked match). You can correct it
> anytime.

#### ❓ Troubleshooting

<details>
<summary><b>The dashboard shows nothing during my matches</b></summary>

The game's Stats API is probably not enabled. Open the app window (tray
icon) → click **"Re-enable the game's Stats API"** → accept the Windows
prompt → **restart Rocket League**. As a last resort, double-click
`enable-statsapi.bat` (included in this repo).
</details>

<details>
<summary><b>My wins/losses aren't counted</b></summary>

The app doesn't know who you are yet. Play 2-3 matches (it detects your name
automatically), or open the app window and pick your name from the
suggestions.
</details>

<details>
<summary><b>The dashboard opens on the wrong screen</b></summary>

It picks the **secondary** display automatically. If you'd rather place it
yourself, untick "fullscreen" in the settings: it opens as a normal window
you can move around.
</details>

> ⚠️ The Stats API only exists on **PC** (Epic / Steam). The app is
> Windows-only.

### 🧩 How it works

```
 ┌──────────────────────────── your PC ───────────────────────────┐
 │                                                                │
 │  🎮 Rocket League ──Stats API──►  🛰️ RL Session Tracker        │
 │     (local socket 49123)            │   system tray            │
 │                                     ├─► 🖥️ 2nd-screen dashboard│
 │                                     └─► 💾 matches (local file)│
 │                                                                │
 └────────────────────────────────────────────────────────────────┘
                          ▲
              GitHub Releases (auto updates)
```

Everything is local: your matches are stored in a JSON file on your PC
(`%APPDATA%/RL Session Tracker`); nothing is sent anywhere. The only
outbound connection is the update check on GitHub.

**Why not the real MMR?** The game's Stats API doesn't broadcast it, sites
like tracker.gg have no public API (and scraping them breaks constantly),
and third-party APIs require private keys. Since Season 22 the MMR is
visible **in the game**: copy it once, the app does the rest. Reliable,
offline, and it can never break.

### 🧰 For developers

| Side | Technologies |
|---|---|
| **App** | Electron — a single main process, framework-free HTML/CSS/JS windows, no build step |
| **Data** | The game's native Stats API (TCP socket `127.0.0.1:49123`, concatenated JSON) |
| **Packaging** | electron-builder — one-click NSIS installer |
| **Updates** | electron-updater + GitHub Releases (`latest.yml`) |

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install
npm start          # run the app in development mode
npm run dist       # build the Windows installer into dist/
```

#### Shipping a new version

```bash
npm version minor          # bump package.json + tag vX.Y.Z
git push --follow-tags
```

The GitHub Actions workflow ([release.yml](.github/workflows/release.yml))
builds the installer on Windows and publishes the release (also triggered by
a `main` commit containing `[release]`, or manually from the Actions tab).
Every installed app will see it and offer the "Update" button.

<details>
<summary>🗂️ Project layout</summary>

```
rl-session-tracker/
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.js           # Lifecycle, tray, IPC, general wiring
│   │   ├── statsapi.js        # Stats API connector (TCP, stream parser)
│   │   ├── game-watcher.js    # RocketLeague.exe process detection
│   │   ├── session.js         # Match log + stats + MMR + records
│   │   ├── config.js          # Preferences (name, MMR, options)
│   │   ├── windows.js         # Windows: control, dashboard, overlay
│   │   ├── updater.js         # Automatic updates (GitHub Releases)
│   │   └── enable-statsapi.js # Enables the game's Stats API (elevated PS)
│   ├── preload.js             # Secure IPC bridge (contextIsolation)
│   └── renderer/
│       ├── control.html       # Control / settings window
│       ├── dashboard.html     # The fullscreen tracker
│       ├── overlay.html       # Always-on-top mini-overlay
│       └── fonts/             # Barlow Condensed (OFL-1.1 license)
├── build/icon.ico             # App icon
├── electron-builder.yml       # NSIS packaging + GitHub publishing
├── .github/workflows/release.yml
└── enable-statsapi.bat / .ps1 # Manual fallback activation
```
</details>

### 📄 License

MIT — do whatever you want with it.
