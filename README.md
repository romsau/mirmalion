# Mirmalion

Application desktop macOS (Apple Silicon) de **transcription audio → texte**, **100 % locale et hors ligne**, construite avec **Tauri 2** (coquille native + backend Rust) et **Angular 22** (interface).

Rien ne sort de la machine : toutes les fonctions marchent sans réseau, aucune télémétrie n'est émise, aucun contenu n'est envoyé nulle part. Le réseau ne sert qu'à des gestes ponctuels et explicites — télécharger les ressources d'une langue, mettre à jour l'application.

## Fonctionnalités

- **Dictée** — un raccourci global (⌃⌥), on parle, le texte s'insère à l'emplacement du curseur. Traduction, reformulation et dictionnaire personnel. Historique configurable, 200 saisies par défaut.
- **Direct** — enregistre tout le son de la machine, ou celui d'une application ciblée (Teams, Google Meet, une vidéo…), et le transcrit au fil de l'eau. Compte rendu généré par un **LLM local**, traduction, export. Historique à rétention par durée.
- **Fichiers** — transcription de médias locaux par glisser-déposer. Aucune URL, aucun flux distant.

### Langues gérées

Français, anglais, espagnol, allemand, italien, portugais — pour l'interface comme pour la transcription et la traduction.

## Stack technique

- **Frontend** : Angular 22 (composants standalone, signals, contrôle de flux natif, NgRx Signal Store).
- **Desktop / backend** : Tauri 2 + Rust (crate dans `src-tauri/`).
- **Natif** : un paquet SwiftPM (`src-tauri/native/`) relie le crate aux briques Apple — transcription, LLM, traduction, capture audio.
- **Persistance** : SQLite chiffré (SQLCipher), clé dans le Keychain.

## Prérequis

- macOS 26 sur Apple Silicon (cible `aarch64-apple-darwin`).
- Node.js + npm.
- Toolchain Rust (`rustup`) avec la cible `aarch64-apple-darwin`.

## Démarrage

```bash
npm install          # installer les dépendances
npm start            # app desktop en dev (fenêtre native "Mirmalion Dev")
```

`npm start` lance `tauri dev`, qui démarre automatiquement le serveur Angular (`http://localhost:4200`) puis ouvre la fenêtre native. ⚠️ Toute vérification qui touche au frontend passe par là : un `cargo run` seul ouvre une fenêtre vide.

### Autres commandes utiles

```bash
npm run verify            # la commande qui vaut relecture (voir ci-dessous)
npm run start:web         # dev navigateur uniquement (appels natifs à null)
npm run build             # build Angular seul → dist/mirmalion/browser
npm run tauri:build       # bundle desktop final "Mirmalion" (.app + .dmg)
npm run tauri:build:dev   # bundle de la variante dev "Mirmalion Dev"
npm run release           # construit, signe, notarise, agrafe et publie une version
npx ng test --coverage    # tests Angular + rapport de couverture
```

`npm run verify` enchaîne, en s'arrêtant à la première faute : `prettier --check`, la page d'accueil dans un vrai Chromium (`verify:landing`), les tests Angular avec leurs seuils de couverture, les épreuves de mise en page dans un vrai Chromium, puis `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` et `cargo test --release`.

Les bundles sont produits dans `src-tauri/target/release/bundle/` (`.app` et `.dmg`).

## Publier une version

**`npm run release` est le seul geste qui publie.** Il n'y a aucune intégration continue : un
`git push` dépose des commits sur GitHub et rien de plus — aucun utilisateur ne voit quoi que ce
soit. Le script fait trois choses visibles de l'extérieur, dans cet ordre : il écrit la version
dans la page d'accueil (`landing/`) et la commet ; il crée la **GitHub Release** `v<version>`,
avec le `.dmg` que la page fait télécharger ; il met en ligne sur Firebase Hosting la page et
`https://mirmalion.web.app/updates/latest.json`, le manifeste qu'interroge chaque application
installée pour se mettre à jour. Il se lance depuis `main`, sur un arbre propre.

**Avant de lancer la commande, monter le numéro de version.** L'outil de mise à jour compare des
numéros : republier sous le même laisse tous les postes déjà installés sur l'ancienne version,
sans un message et sans recours. Quatre fichiers, un seul commit `build:` :

```bash
# package.json, src-tauri/tauri.conf.json et src-tauri/Cargo.toml à la main, puis :
cargo update --manifest-path src-tauri/Cargo.toml -p app --offline   # src-tauri/Cargo.lock
```

Puis :

```bash
npm run release                    # tout : construction, notarisation, agrafage, mise en ligne
npm run release -- --no-deploy     # assemble le site dans ./dist-web sans rien publier
npm run release -- --skip-build    # repart des artefacts déjà construits
```

Le script demande deux soumissions à Apple — le `.app` d'abord, le `.dmg` ensuite, son contenu
ayant changé — et prend donc plusieurs minutes. Il s'appuie sur un profil de trousseau
`mirmalion` pour la notarisation, et sur la clé de signature des mises à jour rangée dans
`~/.mirmalion/updater.key`, hors du dépôt.

⚠️ **Cette clé est irremplaçable.** Chaque application installée ne fait confiance qu'à la clé
publique inscrite dans son propre binaire : la perdre obligerait à publier sous une autre clé,
que personne n'accepterait, et tous les postes cesseraient de se mettre à jour en silence. À
sauvegarder ailleurs que sur la machine de développement.

Le détail de la notarisation, de l'agrafage et de ce qui n'est délibérément pas agrafé est
documenté en tête de [`scripts/release.sh`](scripts/release.sh). La page d'accueil se vérifie
avec `npm run verify:landing`, dans un vrai Chromium ; ses textes vivent dans
`landing/index.html` et `landing/en/index.html`, et seul le script de publication y écrit le
numéro de version.

## Structure du projet

```
src/            Frontend Angular (composants, services dans core/services, routes, locales)
landing/        Page d'accueil (mirmalion.web.app), HTML et CSS purs, en français et en anglais
src-tauri/      Crate Rust Tauri (lib.rs, commandes IPC, tauri.conf.json, capabilities, icons)
src-tauri/native/  Paquet SwiftPM : pont vers les briques Apple
docs/           Maquette UI de référence, cadrage, mesures
```

Le pont IPC suit un pattern constant : une commande Rust `#[tauri::command]` (payload sérialisé en camelCase) est exposée côté Angular par le service `Tauri` (`src/app/core/services/tauri/`), qui garde avec `isTauri()` et rend `null` hors contexte Tauri.

## Variante « dev » et cohabitation

`npm start` et `npm run tauri:build:dev` produisent la variante **« Mirmalion Dev »** (identifiant `com.mirmalion.desktop.dev`), distincte de la version finale **« Mirmalion »** (`com.mirmalion.desktop`). Les deux coexistent sans conflit de données ni de fichier.

## Conventions de développement

Les standards du projet (Angular, Rust/Tauri, tests, sécurité, i18n, workflow de création de fichiers) sont décrits dans [`.claude/CLAUDE.md`](.claude/CLAUDE.md). La convention de commentaire a sa page : [`.claude/convention-commentaires.md`](.claude/convention-commentaires.md).

## Licence

[MIT](LICENSE). Les poids de modèles embarqués dans `src-tauri/models/` sont des artefacts tiers
sous CC-BY-4.0 ; leur provenance et leur attribution sont dans
[`src-tauri/models/README.md`](src-tauri/models/README.md).
