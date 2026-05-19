# RL Session Tracker

Dashboard web pour tracker tes sessions Rocket League en direct. Entre ton pseudo, et le tracker suit ta progression MMR, tes victoires/defaites, et tes stats en temps reel.

## Fonctionnalites

**Live tracking**
- Detecte automatiquement les matchs en cours via [tracker.network](https://rocketleague.tracker.network)
- Polling toutes les 15 secondes pour capter les changements de MMR
- Notifications animees (banner Win/Loss) a chaque match detecte
- Alerte tilt apres 3 defaites d'affilee

**Dashboard**
- 3 layouts au choix : **Command Center** (paysage), **Sidekick** (portrait), **Focus** (minimaliste)
- Rang actuel avec icone officielle + barre de progression vers le rang suivant
- Graphique MMR session et saison (donnees reelles)
- Tiltometre avec jauge animee
- Stats de la session vs moyenne globale (buts, arrets, passes, tirs)
- Repartition par mode (2v2, 3v3, 1v1, etc.)
- Ticker bar live en bas de l'ecran

**Personnalisation**
- 5 couleurs d'accent (cyan, lime, pink, amber, violet)
- Mode sombre / clair
- 3 niveaux de densite (compact, regular, spacious)
- 4 polices au choix
- Modules activables/desactivables
- Bilingue FR / EN

## Installation

```bash
git clone https://github.com/ton-user/rl-session-tracker.git
cd rl-session-tracker
npm install
```

## Utilisation

```bash
npm start
```

Puis ouvre **http://localhost:3000** dans ton navigateur.

1. Entre ton pseudo Rocket League (Epic, Steam, PSN ou Xbox)
2. Le dashboard se charge avec tes stats
3. Lance Rocket League et joue — le tracker detecte tes matchs automatiquement
4. Clique sur l'engrenage en haut a droite pour personnaliser

## Comment ca marche

Le serveur utilise un navigateur headless (Chromium via Puppeteer) pour acceder a tracker.network. Ca permet de passer la protection Cloudflare sans avoir besoin d'une cle API.

```
Navigateur  -->  localhost:3000  -->  Chromium headless  -->  tracker.network
   (toi)          (Express)           (Puppeteer)             (donnees RL)
```

Le polling compare le MMR entre chaque requete. Quand il detecte un changement, il ajoute le match a la session et declenche l'animation.

## Prerequis

- **Node.js** 18+
- **Chromium** installe sur le systeme (`/usr/bin/chromium`)
  - Debian/Ubuntu : `sudo apt install chromium-browser`
  - Arch : `sudo pacman -S chromium`
  - macOS : `brew install chromium`

## Structure du projet

```
rl-session-tracker/
├── server.js              # Serveur Express + scraping headless
├── package.json
├── .env                   # Cle API TRN (optionnel)
├── .gitignore
└── public/
    ├── index.html          # App React + panneau options
    ├── styles.css          # Design broadcast/editorial
    ├── data.js             # Couche donnees + polling live
    ├── i18n.js             # Traductions FR/EN
    ├── modules.jsx         # Composants UI du dashboard
    ├── variants.jsx        # 3 layouts (Command/Sidekick/Focus)
    └── tweaks-panel.jsx    # Panel de configuration
```

## Configuration avancee

**Port personnalise**
```bash
PORT=8080 npm start
```

**Cle API TRN (optionnel)**
Si tu as une cle API tracker.gg approuvee, cree un fichier `.env` :
```
TRN_API_KEY=ta-cle-ici
```

## Licence

MIT
