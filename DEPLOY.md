# Déploiement du serveur

Comment mettre le dashboard en ligne proprement et en sécurité, par exemple
sur `rl.mateobrl.fr`.

## 1. Installation

```bash
git clone https://github.com/mateo-brl/rl-session-tracker.git
cd rl-session-tracker
npm install
npm run build:web      # pré-compile le dashboard (public/dist/app.js)
```

Prérequis : **Node.js 18+** et **Chromium** (`sudo apt install chromium`).

> `npm start` lance automatiquement `build:web` avant le serveur (script
> `prestart`). L'étape ci-dessus n'est nécessaire que si tu démarres le
> serveur autrement (ex. systemd avec `node server.js`).

## 2. Configuration

Le serveur se règle par variables d'environnement (ou un fichier `.env`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute. |
| `HOST` | `127.0.0.1` | **À laisser sur `127.0.0.1`** : seul le reverse proxy doit joindre Node. |
| `TRUST_PROXY` | `1` | Nombre de proxys de confiance devant le serveur (pour lire la vraie IP client). |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | Chemin du binaire Chromium. |
| `PLAYERS_FILE` | `./players.json` | Emplacement du registre des joueurs. |
| `SCRAPE_POOL` | `4` | Pages Chromium pour scraper tracker.gg en parallèle. |
| `SCRAPE_TIMEOUT` | `15000` | Délai max d'un scrape tracker.gg, en ms. |
| `SCRAPE_RECYCLE_MS` | `2700000` | Intervalle de recyclage des pages Chromium (anti-dérive mémoire), en ms. |

## 3. Déclarer les joueurs

Chaque PC autorisé à envoyer ses stats doit être déclaré. Cela génère un
**token** et un **fichier de config** prêt à donner au joueur.

```bash
npm run add-agent -- --id mateo --platform epic --username TonPseudoRL --name "Mateo" \
                     --server https://rl.mateobrl.fr
```

- `--id` : identifiant de la page (`/u/mateo`). Minuscules, chiffres, `-`, `_`.
- `--platform` : `epic`, `steam`, `psn` ou `xbox`.
- `--username` : le pseudo exact tel qu'il apparaît sur tracker.gg.

Le fichier `agent-config-mateo.json` est créé. **Renomme-le `config.json`** et
donne-le au joueur, avec `rl-agent.exe`.

```bash
npm run add-agent -- --list      # voir les joueurs déclarés
```

> Pour retirer un joueur : supprime son entrée dans `players.json`.
> Le serveur recharge le fichier automatiquement.

## 4. Lancer en service (systemd)

`/etc/systemd/system/rl-tracker.service` :

```ini
[Unit]
Description=RL Session Tracker
After=network.target

[Service]
Type=simple
User=rltracker
WorkingDirectory=/opt/rl-session-tracker
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=1
ExecStartPre=/usr/bin/node scripts/build-web.mjs
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now rl-tracker
```

## 5. Reverse proxy + WAF (SafeLine)

Le serveur Node écoute **uniquement sur `127.0.0.1`**. C'est **SafeLine** qui
expose le site sur internet, gère le **HTTPS** et filtre le trafic.

Dans SafeLine :

1. **Ajouter un site** : domaine `rl.mateobrl.fr`, upstream `http://127.0.0.1:3000`.
2. **Activer le HTTPS** (certificat Let's Encrypt automatique).
3. **Garder la protection WAF active** (mode interception).

### ⚠️ Important : le flux temps réel (SSE)

Le dashboard reçoit les évènements live via **SSE** (une connexion HTTP qui
reste ouverte). Un proxy qui *bufferise* les réponses casse ce flux.

Le serveur envoie déjà l'en-tête `X-Accel-Buffering: no` — SafeLine (basé sur
nginx) le respecte. Si malgré tout le live ne s'actualise pas :

- vérifie que le **buffering est désactivé** pour le chemin `/api/stats/stream/`,
- assure-toi que le **timeout** du proxy est élevé (≥ 1 h) pour ces connexions.

> Si le SSE est coupé, le navigateur se reconnecte tout seul (backoff). Le
> chargement initial du profil et le rafraîchissement en fin de match passent
> par des requêtes HTTP classiques — mais le **suivi live d'un match en cours**
> (score, bandeau) dépend du SSE : il faut donc que le proxy le laisse passer
> sans bufferisation.

## 6. Pare-feu

Seuls les ports **80** et **443** (SafeLine) doivent être ouverts vers
l'extérieur. Le port `3000` de Node **ne doit jamais** être exposé.

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

## ✅ Checklist sécurité

- [ ] Node écoute sur `127.0.0.1` uniquement (`HOST=127.0.0.1`).
- [ ] Port `3000` non exposé par le pare-feu.
- [ ] HTTPS actif via SafeLine.
- [ ] WAF SafeLine en mode interception.
- [ ] `TRUST_PROXY` réglé sur le nombre réel de proxys (1 avec SafeLine seul).
- [ ] `players.json` et les `config.json`/`agent-config-*.json` **non commités**
      (déjà dans `.gitignore`).
- [ ] Le serveur tourne sous un utilisateur dédié, non-root.

## Couches de sécurité applicatives (déjà incluses)

En plus du WAF, le serveur applique :

- **Authentification par token** sur `/api/ingest` — tokens hachés en SHA-256,
  comparaison à temps constant.
- **Limitation de débit** (`express-rate-limit`) sur l'ingestion et l'API.
- **Validation stricte** des données envoyées par les agents (taille, types,
  bornes) — un agent reste une source non fiable.
- **En-têtes de sécurité** via Helmet, `x-powered-by` désactivé.
- **Aucun scraping arbitraire** : seuls les profils des joueurs déclarés sont
  interrogés — impossible d'utiliser le serveur comme proxy.
