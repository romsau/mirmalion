# Landing page, GitHub Releases et dépôt public

Mirmalion ne sera pas vendu. Le dépôt devient public, chaque version est publiée comme une
GitHub Release, et une page d'accueil permet à quiconque de télécharger l'application.

## Ce qui ne change pas

**Le mécanisme de mise à jour des postes déjà installés n'est ni modifié, ni reconfiguré, ni
déplacé.** C'est la contrainte première du chantier.

- `plugins.updater` dans `tauri.conf.json` garde sa seule adresse, `mirmalion.web.app/updates/latest.json`,
  et sa clé publique.
- Le script de publication continue de déposer sur Firebase le manifeste et l'archive de mise à
  jour, avec les mêmes noms, aux mêmes adresses. `firebase.json` garde ses en-têtes de cache.
- La clé de signature `~/.mirmalion/updater.key`, la notarisation et l'agrafage restent tels quels.

Un poste en 0.9.16 recevra la 0.9.17 par le chemin exact qui l'a mené de la 0.9.15 à la 0.9.16.
La bascule des mises à jour vers GitHub est une décision séparée, hors de ce chantier, à prendre
après la campagne de tests.

## GitHub Releases

À chaque `npm run release`, le script crée une release sur `romsau/mirmalion` :

- tag `v<version>`, posé sur le commit courant de `main` ;
- titre `Mirmalion <version>`, notes vides, à compléter sur GitHub si on le souhaite ;
- quatre pièces jointes : `Mirmalion_<version>_aarch64.dmg`, `Mirmalion_<version>.app.tar.gz`,
  `Mirmalion_<version>.app.tar.gz.sig` et `latest.json`.

Le `.dmg` est la pièce dont la page a besoin. L'archive, sa signature et le manifeste sont des
copies de ce qui part sur Firebase, déposées pour qu'une bascule future soit possible sans
reconstruire quoi que ce soit. Personne ne les lit aujourd'hui.

L'adresse du `.dmg` est `https://github.com/romsau/mirmalion/releases/download/v<version>/Mirmalion_<version>_aarch64.dmg`.
Tant que le dépôt est privé, elle ne répond qu'à un compte autorisé.

## Dépôt public

- `LICENSE` MIT à la racine, au nom de Romain Sauvez. `package.json` et `Cargo.toml` déclarent `MIT`.
- Le README renvoie à `src-tauri/models/README.md` pour l'attribution CC-BY-4.0 des poids de modèles.
- Le passage en public est un geste manuel du porteur, une fois la branche fusionnée et la première
  release en place : `gh repo edit romsau/mirmalion --visibility public --accept-visibility-change-consequences`.

Vérifié avant l'écriture de ce document : aucun secret ni fichier de clé dans l'historique, aucun
fichier suivi de plus de 8 Mo.

## La page : `landing/`

Une page HTML unique par langue, sans outil de construction, servie par Firebase Hosting à
`https://mirmalion.web.app`. Le dossier `web/` disparaît.

```
landing/
  index.html        français
  en/index.html     anglais
  landing.css       feuille commune
  fonts/            Montserrat, copiée depuis src/assets/fonts/ (les graisses utilisées seulement)
  img/              logo et captures d'écran
```

**Structure de la page**, dans l'ordre du défilement :

1. **En-tête** : logo, une phrase, le bouton « Télécharger Mirmalion 0.9.17 », les prérequis
   (macOS 26, Apple Silicon), le lien vers l'autre langue.
2. **Sections ancrées**, une par thème, chacune avec un titre, un court texte et une capture. Une
   barre de navigation fixe porte un lien par section ; le défilement est adouci par
   `scroll-behavior: smooth`. Le contenu des sections s'écrit avec le porteur, après l'ossature.
3. **Pied** : rappel du téléchargement, lien vers le dépôt GitHub, licence.

**Apparence** : couleurs, rayons et espacements repris des jetons de `src/styles/themes/`, en
thème clair et sombre par `prefers-color-scheme`. Montserrat embarquée par `@font-face` ; la page
ne charge rien depuis un service tiers, ni police, ni script, ni mesure d'audience. Les captures
portent un `alt` et sont chargées en `loading="lazy"` à partir de la deuxième.

**La version dans la page.** Le numéro et l'adresse du `.dmg` sont écrits en dur dans les deux
pages, sur un même élément :

```html
<a class="download" data-download href="https://github.com/romsau/mirmalion/releases/download/v0.9.17/Mirmalion_0.9.17_aarch64.dmg">
  Télécharger Mirmalion <span data-version>0.9.17</span>
</a>
```

Le script de publication réécrit l'attribut `href` et le contenu de `[data-version]` dans les deux
pages, par un script Node qui échoue si l'un des deux éléments manque. Il n'existe aucun autre
endroit où la version est écrite.

**Captures** : prises par l'assistant dans l'app de dev, PNG, largeur 1600 px, déposées dans
`landing/img/`, remplaçables sans toucher au HTML.

**Vérification** :

- Prettier couvre `landing/` comme il couvrait `web/`.
- Un script `scripts/check-landing.mjs` (Playwright + axe-core, avec `--selftest`) s'ajoute à
  `npm run verify` sous `verify:landing` : il charge chaque page dans un vrai Chromium, vérifie
  qu'AXE ne remonte rien, que `[data-download]` et `[data-version]` existent et concordent, que
  chaque ancre de la navigation cible une section présente et qu'aucune requête ne sort de la
  machine. Un script plutôt qu'une épreuve `*.layout.spec.ts` : le lanceur d'épreuves Angular
  ignore les fichiers hors de `src/`.
- Les contrastes des couleurs propres à la page se mesurent à la main, AXE ne voyant pas les
  pseudo-éléments.

## Le script de publication

`scripts/release.sh` garde toute sa chaîne. Les changements :

- **Étape 0** vérifie en plus que `gh auth status` réussit, que la branche courante est `main` et que
  l'arbre de travail est propre, pour échouer avant la compilation.
- **Après le verdict de Gatekeeper**, une étape « Page » réécrit les deux pages, les commet
  (`release: la page annonce la <version>`) et pousse `main`.
- Une étape « GitHub Release » crée la release avec ses quatre pièces jointes, par
  `gh release create v<version> --title … --notes ""`. Une release déjà existante pour ce tag fait
  échouer le script : on ne republie pas sous le même numéro, pour la même raison que le manifeste.
- L'assemblage du site copie `landing/` dans `dist-web/` puis y ajoute `updates/latest.json` et
  l'archive, comme aujourd'hui.
- Le déploiement Firebase reste le dernier geste. Le message final donne l'adresse de la page et
  celle de la release.

`--no-deploy` réécrit les pages sur le disque et assemble le site dans `dist-web/`, pour relecture,
mais ne commet rien, ne crée pas la release et ne déploie pas : rien de visible de l'extérieur n'est
fait. `--skip-build` ne change pas de sens.

## Épreuve grandeur nature

La première publication après ce chantier est la 0.9.17. Le Mac du porteur, en 0.9.16, doit la
recevoir et l'installer par la mécanique actuelle. Tant que cette épreuve n'a pas été vue passer,
la chaîne n'est pas considérée comme validée.

## Ordre des opérations

1. Branche `landing` : licence, `landing/` avec en-tête et ossature, épreuve de mise en page,
   script de publication, suppression de `web/`, README.
2. Sections de la page écrites avec le porteur, captures prises.
3. `npm run verify` vert, puis `npm run release -- --no-deploy` pour relire le site assemblé.
4. Fusion dans `main`, montée de version en 0.9.17, `npm run release`.
5. Épreuve grandeur nature sur le poste en 0.9.16.
6. Passage du dépôt en public par le porteur. La page devient utilisable par tous.

## Hors périmètre

- Basculer les mises à jour vers GitHub.
- GitHub Pages, ou l'abandon de Firebase.
- Notes de release générées.
- Une version Intel, ou un macOS antérieur à 26.
