<div align="center">

# 🚀 RL Session Tracker

### Ton tracker de session Rocket League, en direct sur ton 2ᵉ écran.

Victoires · défaites · série · stats par mode · MMR — détectés à la seconde,
directement depuis le jeu. Aucune inscription, aucun site externe, 100 % local.

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078d4?style=flat-square&logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/App-Electron-47848f?style=flat-square&logo=electron&logoColor=white)
![Mises à jour](https://img.shields.io/badge/Mises_à_jour-automatiques-2ee6a6?style=flat-square)
![Licence](https://img.shields.io/badge/Licence-MIT-blue?style=flat-square)

</div>

---

Depuis que l'anti-triche de Rocket League a banni BakkesMod, la **Stats API
native du jeu** est la seule source temps réel autorisée. RL Session Tracker
s'en sert pour faire ce que faisaient les overlays d'avant — en mieux : un
vrai dashboard de session sur ton double écran, qui s'ouvre tout seul quand
tu lances le jeu.

## ✨ Ce que ça fait

| | |
|---|---|
| 🖥️ **Dashboard auto** | Tu lances Rocket League → le tracker s'ouvre en plein écran sur ton 2ᵉ écran. Tu quittes le jeu → il se ferme. |
| ⚡ **Temps réel** | Score, temps, overtime, stats des joueurs — à la seconde, pendant le match. |
| 📊 **Ta session** | Victoires/défaites, % de victoires, série en cours 🔥, meilleure série, par mode (1v1 · 2v2 · 3v3). |
| 🥅 **Tes stats** | Buts, passes, arrêts, tirs, MVP — cumulés sur la session et détaillés match par match. |
| 📈 **MMR estimé** | Recopie une fois ton MMR affiché en jeu (visible depuis la saison 22), l'appli le suit ensuite toute seule. |
| 🪄 **Zéro config** | Pas de compte, pas de code. L'appli détecte même ton pseudo toute seule après 2-3 matchs. |
| 🔄 **Mises à jour auto** | Une nouvelle version sort → un bouton « Mettre à jour » apparaît → un clic et c'est fait. |
| 🧊 **Tiltomètre** | 3 défaites d'affilée ? L'appli te suggère gentiment une pause. |

## 🎮 Installation (2 minutes, aucune connaissance requise)

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

### ❓ Petits soucis courants

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

## 🧩 Comment ça marche

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

## 🧰 Pour les développeurs

| Côté | Technologies |
|---|---|
| **Application** | Electron — un seul processus principal, deux fenêtres HTML/CSS/JS sans framework ni étape de build |
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

### Publier une nouvelle version

```bash
npm version minor          # bump package.json + tag vX.Y.Z
git push --follow-tags
```

Le workflow GitHub Actions ([release.yml](.github/workflows/release.yml))
construit l'installeur sur Windows et publie la release. Toutes les
applications installées la verront et proposeront le bouton « Mettre à jour ».

<details>
<summary>🗂️ Structure du projet</summary>

```
rl-session-tracker/
├── src/
│   ├── main/                  # Processus principal Electron
│   │   ├── index.js           # Cycle de vie, tray, IPC, câblage général
│   │   ├── statsapi.js        # Connecteur Stats API (TCP, parseur de flux)
│   │   ├── game-watcher.js    # Détection du processus RocketLeague.exe
│   │   ├── session.js         # Journal des matchs + stats de session + MMR
│   │   ├── config.js          # Préférences (pseudo, MMR, options)
│   │   ├── windows.js         # Fenêtre de contrôle + dashboard 2ᵉ écran
│   │   ├── updater.js         # Mises à jour automatiques (GitHub Releases)
│   │   └── enable-statsapi.js # Active la Stats API du jeu (PowerShell élevé)
│   ├── preload.js             # Pont IPC sécurisé (contextIsolation)
│   └── renderer/
│       ├── control.html       # Fenêtre de contrôle / réglages
│       └── dashboard.html     # Le tracker plein écran
├── build/icon.ico             # Icône de l'application
├── electron-builder.yml       # Empaquetage NSIS + publication GitHub
├── .github/workflows/release.yml
└── enable-statsapi.bat / .ps1 # Activation manuelle de secours
```
</details>

## 📄 Licence

MIT — fais-en ce que tu veux.
