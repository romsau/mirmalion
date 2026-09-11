# CLAUDE.md

Guidance for Claude Code working in this repository.

## Le projet

**Mirmalion** — application macOS **100 % locale / hors ligne** de transcription audio → texte.
Le « rien ne sort de la machine » est l'argument produit, pas un détail : toutes les fonctions
marchent sans réseau. Le réseau ne sert qu'à des actions **ponctuelles et explicites** (télécharger
un modèle, mettre à jour l'app). Aucune télémétrie, aucun envoi de contenu.

**Trois fonctions :**

- **Dictée** — raccourci global (⌃⌥), on parle, le texte s'insère au curseur. Traduction,
  reformulation, dictionnaire personnel. Historique configurable (défaut 200).
- **Direct** — enregistre tout le son de la machine (ou une application ciblée) et le transcrit au
  fil de l'eau. Compte rendu par LLM local, traduction, export. Rétention par durée.
- **Fichiers** — transcription de médias locaux par glisser-déposer. **Aucune URL.** Pas de compte
  rendu ici, seulement une transcription. ⚠️ **Elle n'est plus une destination de la navigation** :
  elle vit dans le rail des Options, dont le panneau porte l'écran entier. Les premiers testeurs
  n'utilisaient qu'elle et Direct ; elle reste disponible sans occuper une des trois places.

**Six langues** : français, anglais, espagnol, allemand, italien, portugais. Livré pour
**macOS 26 uniquement**, Apple Silicon.

**Vocabulaire** : la fonction est « Direct », un enregistrement est « une session ». Dans le code,
la couche visible (routes, écrans, dossiers Angular) dit `direct`, tout le reste — Rust, Swift,
base — dit `live`. Les routes sont françaises (`/dictee`), le code anglais (`src/dictation/`).

## Ne pas reproposer

Ces fonctions ont été **retirées ou écartées après mesure**. Une absence ne peut pas se commenter
dans le code — c'est la seule raison pour laquelle cette liste est ici.

- **Le chinois, le japonais et le coréen** — retirés du périmètre, et le code n'en garde rien :
  ni langue d'interface, ni langue parlée, ni cible de traduction, ni traitement des écritures
  sans blancs. Y revenir n'est pas ajouter trois lignes à une liste.
- **Le partage par Share Sheet** — retiré. Ce qui sort d'un document sort par « Exporter »
  (« Enregistrer sous ») ou par « Copier ».
- **Les locuteurs et la diarisation affichée** — retirés. Un transcript est du **texte**, sans
  étiquette. FluidAudio reste, pour écarter l'écho du micro, et rien de plus. Mesures conservées
  dans [`docs/v2/locuteurs.md`](../docs/v2/locuteurs.md).
- **Aucune donnée biométrique n'est conservée.** Si une empreinte devait être écrite un jour,
  opt-in, chiffrement, suppression réelle et revue juridique redeviennent obligatoires.
- **Un compte rendu pour les fichiers** — non : il appartient au Direct.
- **Commandes vocales, mode de ponctuation, TTS, extension navigateur** — infaisables ou sans
  objet, mesuré.
- **URL, flux distant, podcast, PDF, OCR** côté Fichiers — refusés par construction : une URL ferait
  sortir une requête de la machine.
- **Coller le texte brut puis le corriger derrière** pour gagner en latence — refusé par le porteur.

## Commands

- `npm install` — installation
- `npm start` — dev natif (variante « Mirmalion Dev »). ⚠️ Toute vérification impliquant le frontend
  passe par là : un `cargo run` seul ouvre une fenêtre vide.
- `npm run start:web` — navigateur seul, appels natifs à `null`
- `npm run build` — build Angular
- `npm run tauri:build` — bundle final ; `tauri:build:dev` pour la variante de dev
- `npm run release` — construit, signe, notarise, agrafe et publie une version
- `npm run latency` — relit les mesures de latence de dictée (`latency:selftest` d'abord)

⚠️ **Publier ne s'improvise pas, et un `git push` ne publie rien** — il n'y a aucune CI. La
procédure est dans [`README.md`](../README.md), section « Publier une version » ; **la lire avant
de lancer `release`**. Le piège qui coûte une version : incrémenter le numéro d'abord, dans les
quatre fichiers, faute de quoi la mise à jour n'atteint personne. Elle crée aussi la GitHub
Release et écrit la version dans `landing/` ; le mécanisme de mise à jour, lui, reste sur
Firebase.

**`npm run verify` — la commande qui vaut relecture.** Elle enchaîne, en s'arrêtant à la première
faute : `prettier --check` · `verify:landing` (la page d'accueil dans un vrai Chromium) · tests
Angular avec couverture et seuils · `verify:layout` (épreuves de mise en page dans un vrai
Chromium) · `cargo fmt --check` · `cargo clippy -- -D warnings` · `cargo test` ·
`cargo test --release`.

Tests Angular ciblés : `npx ng test --include "<glob de fichiers>"` · `npx ng test --coverage`.
Pas d'ESLint ; Prettier via `npx prettier --write .`.

⚠️ **`--filter` ne prend PAS un chemin** : il filtre les **noms d'épreuve**, et il est sensible à la
casse. Lui donner un nom de fichier ne lance rien **et sort en succès** — une suite qu'on croit
verte n'a pas tourné. Cibler des fichiers, c'est `--include`.

## Architecture

Application de bureau à deux processus. Frontend **Angular 22** (`src/`) dans une coquille
**Tauri 2** adossée à un crate **Rust** (`src-tauri/`), lui-même relié aux briques Apple par un
paquet **SwiftPM** (`src-tauri/native/`).

- **Frontend** : composants autonomes + signaux, `src/main.ts` → `app.config.ts`, `app.routes.ts`.
  Services globaux dans `src/app/core/services/<nom>/`, modèles dans `core/models/`.
  État : **NgRx Signal Store**, un dossier par magasin, `providedIn: 'root'`. **Un magasin
  n'injecte jamais `Tauri`** — le service de domaine parle au backend, le magasin porte l'état.
- **Backend** : `src-tauri/src/lib.rs` construit l'app dans `run()` ; `main.rs` est un point
  d'entrée mince. Permissions dans `capabilities/`, configuration dans `tauri.conf.json`.
- **Pont IPC** : Rust expose des `#[tauri::command]` rendant des structs
  `#[serde(rename_all = "camelCase")]` ; Angular les appelle via le service `Tauri`, qui garde avec
  `isTauri()` et rend `null` hors Tauri. Toute capacité native suit ces trois pièces.
- **Pont Rust → Swift** : `src-tauri/native/` (bibliothèque dynamique), exports `@_cdecl` dans
  `Bridge.swift` — **lire son en-tête avant d'en ajouter un**. `src-tauri/src/native/mod.rs`
  concentre l'`unsafe` ; une fonction qui prend un pointeur brut est **`unsafe fn`**, et son
  appelant l'enveloppe avec un `// SAFETY:`. `build.rs` compile le Swift avant le crate.
- **Persistance** : **SQLite chiffré (SQLCipher)**, clé dans le **Keychain**, migrations
  embarquées dans `db/schema.rs` — **ne jamais modifier une migration livrée**. Réglages non
  sensibles dans `tauri-plugin-store` (`core/models/settings.ts`) ; **rien de sensible n'y entre**.
- **Pas de Python** : la chaîne Swift/Rust couvre STT, LLM, écho et traduction.

## Références

- **`docs/ui/ui.html`** — la maquette. Référence UI **au pixel près** ; toute question de rendu s'y
  tranche. `src/styles/` en porte les tokens.
- **`docs/v2/`** — ce qui a été retiré ou reporté, avec les mesures.
- **`.claude/convention-commentaires.md`** — la convention de commentaire, résumée plus bas.
- **`dev/save/mirmalion/`** (hors dépôt) — l'ancienne app Electron, en service. Avant de
  reconstruire une brique native, aller voir si elle y est déjà.

## TypeScript

- Typage strict ; préférer l'inférence quand le type est évident.
- Éviter `any` ; utiliser `unknown` quand le type est incertain.

## Angular

**Avant de créer un fichier Angular** (composant, service, directive, pipe, garde, interface…),
**demander confirmation du nom ET de l'emplacement**. Puis générer avec le CLI
(`ng generate <schematic>`), jamais à la main.

⚠️ **Aucun suffixe de type**, ni dans le fichier ni dans la classe : `snackbar.ts` → `Snackbar`,
jamais `snackbar.component.ts` → `SnackbarComponent`. **Ne jamais passer `--type=component`** — c'est
ce drapeau qui réintroduit le suffixe. Seuls les `*.spec.ts` gardent leur suffixe, et les magasins
NgRx leur `<nom>.store.ts` / `<Nom>Store`. En cas de collision, **c'est le modèle qui se précise**
(`DictationRecord`), pas l'élément Angular qui reprend un suffixe.

**Placement des services** : partagé par ≥ 2 éléments → `shared/services` ; unique et global →
`core/services` ; lié à un seul composant → dans son dossier. Un dossier par service, avec son spec.

- Composants autonomes, jamais de NgModules. Ne pas écrire `standalone: true` ni
  `changeDetection: OnPush` — ce sont les défauts.
- `input()` / `output()` plutôt que les décorateurs ; `computed()` pour l'état dérivé.
- Pas de `@HostBinding` / `@HostListener` : utiliser l'objet `host` du décorateur.
- Flux de contrôle natif (`@if`, `@for`, `@switch`), jamais `*ngIf` / `*ngFor`.
- Liaisons `class` / `style`, jamais `ngClass` / `ngStyle`.
- Formulaires : **Signal Forms** (`@angular/forms/signals`) pour les nouveaux ; sinon réactifs.
- `NgOptimizedImage` pour les images statiques.
- Ne pas supposer les globales (`new Date()`) disponibles dans un template.
- `inject()` plutôt que l'injection par constructeur ; `@Service` pour un nouveau singleton.
- **Demander l'avis du porteur avant de rendre un composant inline.**

**Quatre composants génériques imposés**, un seul de chaque : `Button` (tous les boutons), le
service de modales/overlays (`open(component, { data })`), `SnackbarItem` (toutes les notifications
transitoires, **erreurs comprises — pas de page d'erreur dédiée**), `HistoryPanel` (les deux
historiques) et `ProgressBar`.

**CSS — zéro duplication.** Le style vit dans `src/styles/` ; un composant n'écrit que ce qui lui
est propre. Un motif qui apparaît une **deuxième** fois remonte en mixin. **Aucune couleur ni
dimension en dur** : uniquement des jetons (`var(--accent)`, `var(--btn-h)`). ⚠️ Copier une classe
d'un autre composant **ne copie pas son style** — l'encapsulation émulée l'enferme.

## Rust / Tauri

- Les commandes rendent `Result<T, E>` avec une erreur **sérialisable** (`thiserror` + `Serialize`).
  **Jamais `unwrap()` / `expect()` / panique** dans un `#[tauri::command]`.
- **Async par défaut pour l'I/O** ; le travail lourd part en `spawn` / `spawn_blocking`. Ne jamais
  bloquer dans une commande. Motif de référence pour la base : `src-tauri/src/commands/db.rs`.
- État partagé par `.manage(T)` + `State<'_, T>`, sous `Mutex`/`RwLock`. Pas de `static mut`.
- **Moindre privilège** : `capabilities/*.json` minimal, jamais de joker. Le webview est **non
  fiable** : valider chaque argument. Garder la CSP restrictive.
- **Aucune commande n'expose de SQL générique**, ni la clé de chiffrement, ni le chemin de la base.
  Les accès arrivent **par domaine** (`save_dictation`, `list_live_sessions`…).
- Ajouter un plugin avec `tauri add <plugin>` (dépendance **et** permissions).
- Garder `lib.rs` mince : les commandes vont dans `src-tauri/src/commands/`.
- `cargo fmt` et `cargo clippy` avant tout commit Rust.

## Journalisation

Façade `log` uniquement, configurée dans `src-tauri/src/logging.rs`. **Jamais** `println!`,
`eprintln!`, `dbg!` côté Rust, `print(` côté Swift, ni `console.*` côté Angular — deux tests le
refusent.

⚠️ **Aucun contenu utilisateur dans un message de log** — pas de texte dicté, pas de transcript, pas
de nom de fichier, pas de clé. Un message dit **ce qui** a échoué, jamais **sur quoi**.

## Documentation

Un commentaire documente ou prévient ; il ne raconte pas. **Contrat** (ce que fait le symbole) et
**piège mesuré** (ce qui casse si on l'ignore) restent ; le **journal** — alternatives écartées,
justification d'approche, datation, décision numérotée, nom de campagne — n'entre pas. En cas de
doute, garder le piège et raccourcir la prose.

Formats standard : **TSDoc** (`@remarks` pour un piège), **rustdoc** (`# Errors`, `# Pièges`),
**DocC** (`- Warning:`). Plafonds : en-tête ≤ 12 lignes, doc d'item ≤ 8 **pièges compris**, piège
≤ 4. Bannis : `⚠️⚠️`, bandeaux, capitales, dates, `*(porteur…)*`, `P4-…` — le `⚠️` simple marque
un piège.
`npm run docs` assemble la doc dans `docs/api/` (ignoré) ; `scripts/check-comments.mjs` refuse le
reste. Détail : `.claude/convention-commentaires.md`.

⚠️ **Les pièges vivent à leur point d'usage**, jamais ici. Avant de toucher à une brique sensible
(tap Core Audio, prompts LLM, collage au curseur, clé de chiffrement, overlay), **lire l'en-tête de
son module**.

## Internationalisation

- Interface localisée dans les 6 langues par **`$localize`**, au build. Un composant est traduit
  **dès sa naissance** ; `scripts/check-i18n.mjs` garde la porte.
- Dates, heures et nombres par **`Intl`**, y compris dans les noms de fichiers exportés.
- Les noms de langues s'affichent **dans la langue de l'interface** (« Allemand », pas
  « Deutsch »).
  Seule exception : le sélecteur de langue d'interface, qui double chaque nom de son équivalent
  anglais.
- Chaque langue est un dossier du bundle, et ce dossier est le `<base href>` : **toute URL écrite à
  la main passe par `underBaseHref`** (`app.routes.ts`), jamais un chemin absolu.

## Tests

- **100 % de couverture imposée par l'outillage** (statements, branches, functions, lines), seuils
  **par fichier** dans `angular.json`. Couvrir chaque branche, chemins d'erreur compris.
- **Accessibilité** : `expectNoAxeViolations(fixture.nativeElement)` dans le spec de **chaque**
  composant. WCAG 2.2 AA. Le rendu doit passer AXE.
  ⚠️ jsdom ne calcule aucune mise en page : contrastes, focus visible et repères de page échappent
  à ce test. D'où `*.layout.spec.ts`, qui tourne dans un vrai Chromium (`npm run verify:layout`).
  ⚠️ **AXE a deux angles morts, mesurés** : sa règle de contraste n'évalue **aucun pseudo-élément**
  (donc jamais un `::placeholder`) et **saute les nœuds `aria-disabled`**. Une couleur posée là
  n'est gardée par rien — un texte d'attente à 2,43:1 et une ligne peinte en blanc sur blanc ont
  toutes deux laissé la suite verte. Ces couples-là se mesurent à la main.
- **Une épreuve qu'on n'a jamais vue échouer ne prouve rien** : vérifier qu'un test tombe sans son
  correctif avant de s'y fier.

## Git / Commits

**Aucune attribution à Claude ou à un assistant** : pas de `Co-Authored-By`, pas de « Generated
with », aucun nom d'assistant dans un message de commit ou un corps de PR.
