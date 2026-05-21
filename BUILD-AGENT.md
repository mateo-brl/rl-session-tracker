# Construire l'agent (rl-agent.exe)

L'agent est l'exécutable installé sur chaque PC gaming. Il lit la Stats API
locale de Rocket League et pousse les stats vers le serveur.

## Construire le .exe

> À faire **sur Windows** (le `.exe` produit est une copie du `node.exe` local).
> Prérequis : **Node.js 20 ou plus**.

```bash
npm install
npm run build:agent
```

Résultat : `dist/rl-agent.exe`.

La construction utilise **Node SEA** (Single Executable Application) :
1. `esbuild` regroupe `agent/agent.js` + `statsapi.js` en un seul fichier ;
2. Node génère un *blob* SEA ;
3. le `node.exe` officiel est copié ;
4. le code de l'agent y est injecté (`postject`) ;
5. des métadonnées de version sont ajoutées (`resedit`).

## Antivirus : pourquoi un faux positif, et comment l'éviter

Un exécutable qui **embarque un runtime** (Node, Python, .NET packagé…) ressemble,
pour l'**heuristique** d'un antivirus, à du code « packé » — la même technique
que certains malwares. C'est un **faux positif** classique, indépendant du
contenu réel du programme.

### Ce que ce projet fait déjà pour limiter les flags

| Mesure | Effet |
|---|---|
| **Node SEA** (et non `pkg`) | Part du `node.exe` **officiel signé Microsoft**, déjà connu des antivirus. `pkg` embarque des binaires Node modifiés, bien plus souvent signalés. |
| **Aucune compression** (pas d'UPX) | La compression d'exécutable est le déclencheur n°1 de faux positifs. |
| **Métadonnées de version** | Éditeur, description, version, nom de produit. Un `.exe` anonyme paraît suspect ; un `.exe` documenté beaucoup moins. |
| **Icône** (optionnelle) | Ajoute `assets/agent.ico` avant le build : un `.exe` avec icône paraît plus légitime. |

Ces mesures **réduisent fortement** les faux positifs mais ne les **éliminent
pas à 100 %**. Un `.exe` non signé, d'éditeur inconnu, déclenchera toujours au
minimum l'avertissement **SmartScreen « éditeur inconnu »**.

### La vraie solution : signer le code (Authenticode)

La signature de code est le **seul** moyen fiable de supprimer les
avertissements. Options, de la moins chère à la plus classique :

- **SignPath.io** — signature de code **gratuite pour les projets open source**.
  Idéal ici puisque le dépôt est public.
- **Azure Trusted Signing** — ~10 $/mois, pour particulier ou organisation,
  s'intègre à `signtool`. L'option payante la plus accessible en 2026.
- **Certificat OV/EV** chez un AC (Sectigo, DigiCert…) — 100 à 400 €/an.

Une fois un certificat obtenu, signer le `.exe` :

```bash
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 dist\rl-agent.exe
```

> Un certificat **EV** ou **Azure Trusted Signing** donne une réputation
> SmartScreen immédiate. Un certificat **OV** la construit progressivement
> au fil des téléchargements.

### Si l'agent est quand même bloqué

1. **Signaler le faux positif à Microsoft** (analyse en général sous 24-72 h) :
   <https://www.microsoft.com/en-us/wdsi/filesubmission>
2. **Exclusion Windows Defender** (efficace à 100 %, pour tes propres PC) :
   Sécurité Windows → Protection contre les virus → Gérer les paramètres →
   Exclusions → Ajouter `rl-agent.exe`.
3. **Méthode sans `.exe`** — voir ci-dessous : aucun antivirus n'est concerné.

## Alternative sans exécutable (aucun risque de faux positif)

Si un PC a (ou peut installer) **Node.js**, il n'y a pas besoin du `.exe` du
tout — donc aucun antivirus à contourner :

1. Copier le dépôt sur le PC, `npm install` (ou juste les dossiers `agent/`,
   `statsapi.js` et `node_modules`) ;
2. placer `config.json` dans le dossier `agent/` ;
3. double-cliquer **`agent/run-agent.bat`**.

C'est strictement Node.js qui exécute un script — invisible pour les antivirus.
