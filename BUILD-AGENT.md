# Construire l'application agent

L'agent est une **application de bureau Electron** : fenêtre native sur mesure
et icône dans la barre des tâches. Installée sur chaque PC gaming, elle lit la
Stats API locale de Rocket League et pousse les stats vers le serveur.

## Construire

```bash
npm install
npm run build:agent
```

Résultat : **`dist/rl-agent.zip`** — l'archive proposée au téléchargement sur la
page d'inscription (`/download/agent`).

Le build :

1. fige le serveur d'enrôlement dans l'application ;
2. empaquette l'app pour Windows x64 via `@electron/packager` ;
3. produit l'archive ZIP.

> Le build fonctionne **depuis Windows, Linux ou macOS** : `@electron/packager`
> télécharge l'Electron Windows. Tu peux donc lancer `build:agent` directement
> sur le serveur de déploiement. Le premier build télécharge Electron
> (~100 Mo), ensuite c'est mis en cache.

### Choisir le serveur d'enrôlement

Par défaut l'application pointe sur `https://rl.mateobrl.fr`. Pour un autre
domaine, définis `AGENT_DEFAULT_SERVER` avant le build :

```bash
AGENT_DEFAULT_SERVER=https://stats.exemple.fr npm run build:agent
```

### Icône du fichier .exe

L'icône de la **fenêtre** et de la **barre des tâches** est appliquée à
l'exécution : elle est toujours correcte. L'icône du **fichier `.exe`** (celle
vue dans l'explorateur Windows) n'est posée que si le build a lieu **sur
Windows** — hors Windows, l'outil `rcedit` exigerait Wine. Un build sur Linux
donne donc l'icône Electron par défaut sur le fichier, sans aucune conséquence
fonctionnelle.

## Distribution

L'utilisateur télécharge `rl-agent.zip`, l'**extrait**, puis lance
**`RL Session Tracker.exe`**. L'application se configure toute seule (le code
de configuration voyage dans le nom de l'archive), active la Stats API du jeu,
s'installe en démarrage automatique et reste dans la barre des tâches.

## Antivirus / SmartScreen

L'application **n'est pas signée**. Au premier lancement, Windows peut afficher
l'avertissement **SmartScreen « éditeur inconnu »** : clic sur « Informations
complémentaires » → « Exécuter quand même ». C'est le comportement attendu pour
tout exécutable non signé, quel que soit son contenu.

Les applications Electron sont très répandues : les antivirus les gèrent bien
et les faux positifs sont rares. Si l'application est tout de même signalée :

1. **Signaler le faux positif à Microsoft** (analyse sous 24-72 h) :
   <https://www.microsoft.com/en-us/wdsi/filesubmission>
2. **Exclusion Windows Defender** (pour tes propres PC) : Sécurité Windows →
   Protection contre les virus → Gérer les paramètres → Exclusions.

### La vraie solution : signer le code (Authenticode)

La signature de code est le **seul** moyen fiable de supprimer l'avertissement
SmartScreen. Options, de la moins chère à la plus classique :

- **SignPath.io** — signature **gratuite pour les projets open source** (le
  dépôt est public : éligible).
- **Azure Trusted Signing** — ~10 $/mois, accessible aux particuliers.
- **Certificat OV/EV** chez une autorité (Sectigo, DigiCert…) — 100 à 400 €/an.

Un certificat **EV** ou **Azure Trusted Signing** donne une réputation
SmartScreen immédiate ; un certificat **OV** la construit progressivement.
