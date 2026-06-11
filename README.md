<div align="center">

<img src="docs/logo.png" width="96" alt="RL Session Tracker" />

# RL Session Tracker

**BakkesMod est banni. Pas tes stats.**
**BakkesMod is banned. Your stats aren't.**

Le tracker de session Rocket League nouvelle génération — temps réel, 100 % local, compatible anti-triche.
The next-generation Rocket League session tracker — real-time, 100% local, anti-cheat safe.

[![Release](https://img.shields.io/github/v/release/mateo-brl/rl-session-tracker?style=flat-square&label=version&color=2f9bff)](https://github.com/mateo-brl/rl-session-tracker/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mateo-brl/rl-session-tracker/total?style=flat-square&color=ff8a1e)](https://github.com/mateo-brl/rl-session-tracker/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/mateo-brl/rl-session-tracker/ci.yml?style=flat-square&label=tests)](https://github.com/mateo-brl/rl-session-tracker/actions)
[![License](https://img.shields.io/badge/licence-MIT-blue?style=flat-square)](LICENSE)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078d4?style=flat-square&logo=windows&logoColor=white)

[![Stars](https://img.shields.io/github/stars/mateo-brl/rl-session-tracker?style=social)](https://github.com/mateo-brl/rl-session-tracker/stargazers)

**[🇫🇷 Français](#-français) · [🇬🇧 English](#-english)**

<br/>

![Dashboard — vue session avec match en direct](docs/dashboard.png)

</div>

---

## 🇫🇷 Français

> **Avril 2026.** L'anti-triche de Rocket League débarque et emporte BakkesMod
> avec lui. Plus d'overlays, plus de trackers de session, plus d'Alpha Boost.
>
> **Sauf que.** Le jeu expose désormais une **Stats API native** — un flux
> local, officiel, compatible anti-triche. RL Session Tracker s'en sert pour
> tout reconstruire, en mieux : un vrai dashboard de session sur ton 2ᵉ écran,
> qui s'ouvre tout seul quand tu lances le jeu, et qui n'envoie **rien** sur
> internet.

Victoires · défaites · série · stats par mode · MMR · bilan contre tes rivaux
· son Alpha Boost — détectés à la seconde, directement depuis le jeu. Aucune
inscription, aucun site externe, aucun risque de ban.

⭐ **L'app te sert ? Une étoile sur le dépôt aide d'autres joueurs à la
trouver — et c'est le seul « merci » qu'elle demandera jamais.**

### 📸 Aperçu

![Écran de victoire — animation Broadcast](docs/victory.png)

<p align="center">
  <img src="docs/control.png" width="38%" alt="Fenêtre de réglages" />
  &nbsp;&nbsp;
  <img src="docs/overlay.png" width="32%" alt="Mini-overlay" />
</p>

### ✨ Ce que ça fait

| | |
|---|---|
| 🖥️ **Dashboard auto** | Tu lances Rocket League → le tracker s'ouvre en plein écran sur ton 2ᵉ écran. Tu quittes le jeu → il se ferme. |
| ⚡ **Temps réel** | Score, temps, overtime, stats des joueurs — à la seconde, pendant le match. |
| 📊 **Ta session** | Victoires/défaites, % de victoires, série en cours, meilleure série, par mode (1v1 · 2v2 · 3v3). La liste des matchs récents repart à zéro à chaque lancement (ou d'un clic). |
| 📈 **Évolution MMR** | Recopie une fois ton MMR affiché en jeu (saison 22+) : courbe d'évolution match après match, bilan des 7 derniers jours, records de tous les temps. |
| 🤝 **Déjà croisé** | Un adversaire que tu as déjà affronté ? Ton bilan contre lui (2V – 1D) s'affiche à côté de son nom pendant le match — savoureux en 1v1. |
| 🔉 **Son Alpha Boost** | Le boost légendaire de l'alpha, rejoué quand tu boostes — la sonorité suit ta vitesse en direct. 100 % externe via la Stats API : **aucun fichier du jeu n'est touché, rien d'injecté**. Marche aussi à la manette. |
| ⚖️ **Comptage honnête** | Un forfait en classé compte comme une défaite (comme dans le jeu). Un commutateur Classé/Casual sur chaque match en direct évite que le casual pollue ton MMR. |
| 🥅 **Tes stats** | Buts, passes, arrêts, tirs, MVP — cumulés sur la session et détaillés match par match. |
| 🪄 **Zéro config** | Pas de compte, pas de code. L'appli détecte même ton pseudo toute seule après 2-3 matchs. |
| 🎯 **Mini-overlay** | Petit bandeau toujours au premier plan (W–L, série, score live) pour jouer sur un seul écran. |
| 🎮 **Statut Discord** | Rich Presence optionnelle : tes amis voient « Classé 2v2 · 3 – 2 » et ta série en cours, en direct. |
| 🔄 **Mises à jour auto** | Une nouvelle version sort → un bouton « Mettre à jour » apparaît → un clic et c'est fait. |
| 🔊 **Jingles** | Un son de victoire, un son de défaite (désactivables) — et un tiltomètre après 3 défaites d'affilée. |
| 🎨 **Personnalisable** | Chaque bloc du dashboard se déplace, se redimensionne et se masque — avec 3 profils de disposition et des widgets bonus (horloge, objectif de MMR). Thèmes de couleurs prédéfinis ou libres, 3 styles d'animations testables, overlay réglable. |
| 🌍 **FR / EN** | Interface bilingue : langue du système détectée automatiquement, modifiable dans les réglages. |

### 🆚 Pourquoi celui-là ?

| | RL Session Tracker | Sites de tracking | Mods d'avant (BakkesMod…) |
|---|:---:|:---:|:---:|
| Temps réel pendant le match | ✅ | ❌ (après coup) | ✅ |
| Compatible anti-triche (EAC) | ✅ | ✅ | ❌ banni en ligne |
| 100 % local, zéro compte | ✅ | ❌ | ✅ |
| Dashboard 2ᵉ écran automatique | ✅ | ❌ | ❌ |
| Risque pour ton compte | **Aucun** | Aucun | Réel |

### 🚀 Installation (2 minutes, aucune connaissance requise)

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
>
> ⚠️ **Matchs de placement** (début de saison) : les gains y sont bien plus
> gros (souvent ±15 et dégressifs), l'estimation dérive forcément pendant
> cette période. Recopie ton MMR en jeu une fois tes placements terminés —
> l'application te signale d'ailleurs les gros écarts quand tu recalibres.

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
<summary><b>Le mini-overlay n'apparaît pas par-dessus le jeu</b></summary>

Rocket League est en mode « Plein écran » exclusif : Windows ne laisse alors
**aucune** fenêtre passer devant le jeu (c'est pareil pour tous les overlays).
Mets l'affichage en **« Fenêtré sans bordure »** (Paramètres → Vidéo) —
visuellement identique, et l'overlay passera devant.
</details>

<details>
<summary><b>Le dashboard s'ouvre sur le mauvais écran</b></summary>

Il choisit l'écran **secondaire** automatiquement. Si tu préfères le placer
toi-même, décoche « plein écran » dans les réglages : il s'ouvrira en fenêtre
normale que tu peux déplacer.
</details>

<details>
<summary><b>Le son Alpha Boost a du retard</b></summary>

Clique **« Réactiver la Stats API du jeu »** dans les réglages puis redémarre
Rocket League : ça passe le flux du jeu à 120 paquets/seconde, et le son
devient instantané.
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

**Et le son Alpha Boost, c'est risqué ?** Non — et c'est tout l'intérêt de
cette approche. Les mods qui remplacent les fichiers audio du jeu vivent dans
une zone grise depuis Easy Anti-Cheat ; ici le son est joué **par
l'application, à côté du jeu**, à partir des champs `Speed` / `Boost` /
`bBoosting` que la Stats API diffuse déjà. Aucun fichier modifié, aucune
injection, aucun hook clavier/souris. L'idée et les samples viennent du
projet communautaire
[trznx/Rocket_League-Alpha_Boost](https://github.com/trznx/Rocket_League-Alpha_Boost)
(MIT) — merci à lui. Notre version y ajoute le support manette (détection
100 % Stats API) et un fondu enchaîné entre les paliers de vitesse.

### 🧰 Pour les développeurs

| Côté | Technologies |
|---|---|
| **Application** | Electron — un seul processus principal, fenêtres HTML/CSS/JS sans framework ni étape de build |
| **Données** | Stats API native du jeu (socket TCP `127.0.0.1:49123`, JSON concaténé) |
| **Empaquetage** | electron-builder — installeur NSIS un-clic |
| **Mises à jour** | electron-updater + GitHub Releases (`latest.yml`) |
| **Qualité** | 38 tests unitaires et d'intégration (`node --test`), CI à chaque push |

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install
npm start          # lance l'application en mode développement
node --test        # lance les tests
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
│   │   ├── discord-rpc.js     # Statut Discord (pipe IPC local, sans dépendance)
│   │   └── enable-statsapi.js # Active la Stats API du jeu (PowerShell élevé)
│   ├── preload.js             # Pont IPC sécurisé (contextIsolation)
│   └── renderer/
│       ├── control.html       # Fenêtre de contrôle / réglages
│       ├── dashboard.html     # Le tracker plein écran
│       ├── overlay.html       # Mini-overlay toujours au premier plan
│       ├── alphaboost.html    # Moteur audio Alpha Boost (fenêtre invisible)
│       ├── sounds/alpha/      # Samples Alpha Boost (projet trznx, MIT)
│       └── fonts/             # Barlow Condensed (licence OFL-1.1)
├── build/icon.ico             # Icône de l'application
├── electron-builder.yml       # Empaquetage NSIS + publication GitHub
├── .github/workflows/         # CI (tests) + release (build Windows)
└── enable-statsapi.bat / .ps1 # Activation manuelle de secours
```
</details>

### 📄 Licence

MIT — fais-en ce que tu veux. Les samples du son Alpha Boost proviennent du
projet [trznx/Rocket_League-Alpha_Boost](https://github.com/trznx/Rocket_League-Alpha_Boost)
(MIT) et la police Barlow Condensed est sous licence OFL-1.1.

<div align="center">

**Si ce projet t'a été utile, [laisse une étoile ⭐](https://github.com/mateo-brl/rl-session-tracker/stargazers) — ça prend deux secondes et ça aide énormément.**

</div>

---

## 🇬🇧 English

> **April 2026.** Rocket League's anti-cheat arrives and takes BakkesMod down
> with it. No more overlays, no more session trackers, no more Alpha Boost.
>
> **Except.** The game now exposes a **native Stats API** — a local, official,
> anti-cheat-friendly feed. RL Session Tracker uses it to rebuild everything,
> better: a real session dashboard on your second screen that opens by itself
> when you launch the game, and sends **nothing** to the internet.

Wins · losses · streak · per-mode stats · MMR · record against your rivals ·
Alpha Boost sound — detected the second they happen, straight from the game.
No sign-up, no third-party website, no ban risk.

⭐ **Found it useful? A star on the repo helps other players discover it —
and it's the only "thank you" this app will ever ask for.**

### 📸 Preview

![Victory screen — Broadcast animation](docs/victory.png)

<p align="center">
  <img src="docs/control.png" width="38%" alt="Settings window" />
  &nbsp;&nbsp;
  <img src="docs/overlay.png" width="32%" alt="Mini-overlay" />
</p>

### ✨ Features

| | |
|---|---|
| 🖥️ **Auto dashboard** | Launch Rocket League → the tracker opens fullscreen on your second screen. Quit the game → it closes. |
| ⚡ **Real time** | Score, clock, overtime, player stats — to the second, during the match. |
| 📊 **Your session** | Wins/losses, win rate, current streak, best streak, per mode (1v1 · 2v2 · 3v3). The recent-matches list starts fresh on every launch (or with one click). |
| 📈 **MMR tracking** | Copy your in-game MMR once (Season 22+): match-by-match evolution chart, last-7-days summary, all-time records. |
| 🤝 **Seen before** | Facing an opponent you've already played? Your record against them (2W – 1L) shows next to their name during the match — delicious in 1v1. |
| 🔉 **Alpha Boost sound** | The legendary alpha boost sound, replayed while you boost — the tone follows your live speed. 100% external through the Stats API: **no game file is touched, nothing is injected**. Works on controller too. |
| ⚖️ **Honest counting** | Forfeiting a ranked match counts as a loss (just like in the game). A Ranked/Casual switch on each live match keeps casual games from polluting your MMR. |
| 🥅 **Your stats** | Goals, assists, saves, shots, MVP — session totals and per-match detail. |
| 🪄 **Zero config** | No account, no code. The app even detects your in-game name by itself after 2-3 matches. |
| 🎯 **Mini-overlay** | Small always-on-top strip (W–L, streak, live score) for single-screen setups. |
| 🎮 **Discord status** | Optional Rich Presence: your friends see "Ranked 2v2 · 3 – 2" and your current streak, live. |
| 🔄 **Auto updates** | A new version ships → an "Update" button appears → one click and you're done. |
| 🔊 **Jingles** | A win sound, a loss sound (can be turned off) — and a tilt-o-meter after 3 losses in a row. |
| 🎨 **Customizable** | Every dashboard block can be moved, resized and hidden — with 3 layout profiles and bonus widgets (clock, MMR goal). Built-in or fully custom color themes, 3 testable animation styles, adjustable overlay. |
| 🌍 **FR / EN** | Bilingual interface: system language auto-detected, changeable in the settings. |

### 🆚 Why this one?

| | RL Session Tracker | Tracking websites | Old-school mods (BakkesMod…) |
|---|:---:|:---:|:---:|
| Real-time during the match | ✅ | ❌ (after the fact) | ✅ |
| Anti-cheat (EAC) compatible | ✅ | ✅ | ❌ banned online |
| 100% local, no account | ✅ | ❌ | ✅ |
| Automatic second-screen dashboard | ✅ | ❌ | ❌ |
| Risk for your account | **None** | None | Real |

### 🚀 Install (2 minutes, no technical knowledge needed)

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
>
> ⚠️ **Placement matches** (start of season): gains are much bigger there
> (often ±15 and decreasing), so the estimate inevitably drifts during that
> period. Copy your in-game MMR again once placements are done — the app
> also flags big gaps when you recalibrate.

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
<summary><b>The mini-overlay doesn't show above the game</b></summary>

Rocket League is in exclusive "Fullscreen" mode: Windows then lets **no**
window appear above the game (the same goes for every overlay). Set the
display mode to **"Borderless Windowed"** (Settings → Video) — visually
identical, and the overlay will show on top.
</details>

<details>
<summary><b>The dashboard opens on the wrong screen</b></summary>

It picks the **secondary** display automatically. If you'd rather place it
yourself, untick "fullscreen" in the settings: it opens as a normal window
you can move around.
</details>

<details>
<summary><b>The Alpha Boost sound lags behind</b></summary>

Click **"Re-enable the game's Stats API"** in the settings, then restart
Rocket League: it bumps the game's feed to 120 packets per second and the
sound becomes instant.
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

**Is the Alpha Boost sound risky?** No — that's the whole point of this
approach. Mods that replace the game's audio files live in a gray zone since
Easy Anti-Cheat; here the sound is played **by the app, next to the game**,
from the `Speed` / `Boost` / `bBoosting` fields the Stats API already
broadcasts. No modified file, no injection, no keyboard/mouse hook. The idea
and the samples come from the community project
[trznx/Rocket_League-Alpha_Boost](https://github.com/trznx/Rocket_League-Alpha_Boost)
(MIT) — kudos to them. Our version adds controller support (100% Stats API
detection) and crossfading between speed tiers.

### 🧰 For developers

| Side | Technologies |
|---|---|
| **App** | Electron — a single main process, framework-free HTML/CSS/JS windows, no build step |
| **Data** | The game's native Stats API (TCP socket `127.0.0.1:49123`, concatenated JSON) |
| **Packaging** | electron-builder — one-click NSIS installer |
| **Updates** | electron-updater + GitHub Releases (`latest.yml`) |
| **Quality** | 38 unit & integration tests (`node --test`), CI on every push |

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install
npm start          # run the app in development mode
node --test        # run the tests
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
│   │   ├── discord-rpc.js     # Discord status (local IPC pipe, no dependency)
│   │   └── enable-statsapi.js # Enables the game's Stats API (elevated PS)
│   ├── preload.js             # Secure IPC bridge (contextIsolation)
│   └── renderer/
│       ├── control.html       # Control / settings window
│       ├── dashboard.html     # The fullscreen tracker
│       ├── overlay.html       # Always-on-top mini-overlay
│       ├── alphaboost.html    # Alpha Boost audio engine (hidden window)
│       ├── sounds/alpha/      # Alpha Boost samples (trznx project, MIT)
│       └── fonts/             # Barlow Condensed (OFL-1.1 license)
├── build/icon.ico             # App icon
├── electron-builder.yml       # NSIS packaging + GitHub publishing
├── .github/workflows/         # CI (tests) + release (Windows build)
└── enable-statsapi.bat / .ps1 # Manual fallback activation
```
</details>

### 📄 License

MIT — do whatever you want with it. The Alpha Boost samples come from the
[trznx/Rocket_League-Alpha_Boost](https://github.com/trznx/Rocket_League-Alpha_Boost)
project (MIT), and the Barlow Condensed font is licensed under OFL-1.1.

<div align="center">

**If this project helped you, [drop a star ⭐](https://github.com/mateo-brl/rl-session-tracker/stargazers) — it takes two seconds and it means a lot.**

<br/>

*Fait par un joueur, pour les joueurs · Made by a player, for players*

</div>
