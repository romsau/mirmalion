# Landing page, GitHub Releases et dépôt public — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publier chaque version comme une GitHub Release, servir une page d'accueil bilingue à `https://mirmalion.web.app` avec un bouton « Télécharger Mirmalion <version> », et préparer le dépôt à devenir public, **sans toucher au mécanisme de mise à jour**.

**Architecture:** Un dossier `landing/` de HTML et CSS purs, sans construction, copié tel quel dans `dist-web/` par `scripts/release.sh`. Le script réécrit la version dans les pages, commet, crée la release GitHub avec `gh`, puis déploie sur Firebase comme aujourd'hui. Une garde `scripts/check-landing.mjs` ouvre les pages dans le Chromium de Playwright et leur fait passer AXE.

**Tech Stack:** HTML, CSS, Node 22 (scripts `.mjs`), Playwright + axe-core (déjà en devDependencies), `gh` CLI, bash.

**Spec:** `docs/superpowers/specs/2026-09-11-landing-page-github-releases-design.md`

## Global Constraints

- **Le mécanisme de mise à jour ne change pas** : `plugins.updater` de `src-tauri/tauri.conf.json`, le manifeste `updates/latest.json` et l'archive `updates/Mirmalion_<version>.app.tar.gz` sur Firebase, les en-têtes de `firebase.json`, la clé `~/.mirmalion/updater.key`. Aucune tâche ne les modifie.
- Travail sur la branche `landing`, déjà créée. Commits en français, style `type: sujet` (`feat:`, `docs:`, `build:`, `chore:`), **sans aucune attribution à un assistant**.
- Jamais de `console.*` dans le code Angular ; les scripts Node de `scripts/` écrivent sur `process.stdout`/`stderr` comme leurs voisins. Pas de `println!` côté Rust (aucune tâche Rust ici).
- Commentaires selon `.claude/convention-commentaires.md` : contrat et piège mesuré, un seul `⚠️`, jamais `⚠️⚠️`, pas de bandeau, pas de date, pas de « porteur ». `scripts/check-comments.mjs` balaie `scripts/` et les `.html` de `src` ; **il ne balaie pas `landing/`**, mais on y applique la même convention.
- Aucune couleur en dur ailleurs que dans les jetons `:root` de `landing/landing.css`, copiés des thèmes `src/styles/themes/_light.scss` et `_dark.scss`.
- La page ne charge **rien** depuis un service tiers : polices embarquées, aucun script externe, aucune mesure d'audience.
- Prérequis affichés : « macOS 26 · Apple Silicon ».
- Le dépôt reste **privé** jusqu'au geste final du porteur ; aucune tâche ne change sa visibilité.
- Le fichier `dist-web/` est ignoré par git et reconstruit à chaque publication.

---

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `LICENSE` | Texte MIT. |
| `package.json`, `src-tauri/Cargo.toml` | Déclarent `MIT` ; `package.json` gagne `verify:landing`. |
| `landing/index.html` | Page française. |
| `landing/en/index.html` | Page anglaise. |
| `landing/landing.css` | Feuille commune : jetons, polices, mise en page. |
| `landing/fonts/Montserrat-{Regular,Medium,SemiBold,Bold}.ttf` | Copies de `src/assets/fonts/`. |
| `landing/img/{logo-mark,logo-mark-magenta,app-icon}.png` | Copies de `docs/ui/logo/`. |
| `landing/img/{dictee,direct,fichiers}.png` | Captures d'écran. |
| `scripts/check-landing.mjs` | Garde : AXE, bouton, ancres, ressources locales, cohérence FR/EN. `--selftest`. |
| `scripts/landing-version.mjs` | Réécrit la version et l'adresse du `.dmg` dans les deux pages. `--selftest`. |
| `scripts/release.sh` | Vérifie `gh`, réécrit la page, commet, crée la release, assemble `landing/` dans `dist-web/`. |
| `README.md`, `.claude/CLAUDE.md` | Documentation. |
| `web/` | Supprimé. |

---

### Task 1: Licence MIT

**Files:**
- Create: `LICENSE`
- Modify: `package.json:36` (à côté de `"private": true`), `src-tauri/Cargo.toml:6`, `README.md` section `## Licence`

- [ ] **Step 1: Écrire `LICENSE`**

```text
MIT License

Copyright (c) 2026 Romain Sauvez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Déclarer la licence dans les manifestes**

Dans `package.json`, sous la ligne `"private": true,`, ajouter :

```json
  "license": "MIT",
```

Dans `src-tauri/Cargo.toml`, remplacer `license = "LicenseRef-Proprietary"` par :

```toml
license = "MIT"
```

- [ ] **Step 3: Réécrire la section Licence du README**

Remplacer :

```markdown
## Licence

Propriétaire — tous droits réservés.
```

par :

```markdown
## Licence

[MIT](LICENSE). Les poids de modèles embarqués dans `src-tauri/models/` sont des artefacts tiers
sous CC-BY-4.0 ; leur provenance et leur attribution sont dans
[`src-tauri/models/README.md`](src-tauri/models/README.md).
```

- [ ] **Step 4: Vérifier**

Run: `node -p "require('./package.json').license" && grep -n '^license' src-tauri/Cargo.toml && cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 | node -e "process.stdin.on('data',d=>{const p=JSON.parse(d).packages.find(p=>p.name==='app');console.log(p.license)})" && npx prettier --check package.json README.md`
Expected: `MIT`, `license = "MIT"`, `MIT`, puis « All matched files use Prettier code style! ».

- [ ] **Step 5: Commit**

```bash
git add LICENSE package.json src-tauri/Cargo.toml README.md
git commit -m "chore: le dépôt passe sous licence MIT"
```

---

### Task 2: La garde `check-landing.mjs`, écrite avant la page

**Files:**
- Create: `scripts/check-landing.mjs`
- Modify: `package.json` (scripts `verify:landing` et `verify`)

**Interfaces:**
- Produces: `node scripts/check-landing.mjs [--selftest]`, code de sortie 0 si les deux pages passent. Exporte rien ; tout est interne.
- Contrat sur le HTML, que la Task 4 doit respecter :
  - un seul `<a data-download href="https://github.com/romsau/mirmalion/releases/download/v<V>/Mirmalion_<V>_aarch64.dmg">` par page, dont le texte contient un `<span data-version><V></span>` ;
  - `<nav aria-label>` dont chaque `href="#id"` cible un élément d'`id` présent ;
  - `<html lang="fr">` sur `landing/index.html`, `lang="en"` sur `landing/en/index.html` ;
  - un `<link rel="alternate" hreflang>` vers l'autre langue ;
  - aucun `src` ni `href` de `<script>`, `<link rel="stylesheet">`, `<img>`, `<source>` qui commence par `http`.

- [ ] **Step 1: Écrire le script**

```js
#!/usr/bin/env node
/**
 * Vérifie la page d'accueil (`landing/`) dans un vrai Chromium.
 *
 * Pour chaque page : aucune violation AXE (contraste compris — c'est un navigateur, pas jsdom),
 * un bouton de téléchargement dont l'adresse et le numéro affiché concordent, des ancres qui
 * ciblent une section présente, la langue déclarée, le lien vers l'autre langue, et aucune
 * ressource chargée depuis un autre domaine. Les deux pages doivent annoncer la même version.
 *
 * ⚠️ Aucune suite ne couvre ce script : lancer `--selftest` avant de croire un vert.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const AXE_SOURCE = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');
const DMG_URL =
  /^https:\/\/github\.com\/romsau\/mirmalion\/releases\/download\/v(\d+\.\d+\.\d+)\/Mirmalion_(\d+\.\d+\.\d+)_aarch64\.dmg$/;

/** Les pages du site, avec la langue que chacune doit déclarer. */
const PAGES = [
  { path: 'landing/index.html', lang: 'fr', other: 'en' },
  { path: 'landing/en/index.html', lang: 'en', other: 'fr' },
];

/**
 * Inspecte une page ouverte et rend la liste des fautes (vide si tout va bien) et la version
 * annoncée par le bouton.
 */
async function inspect(page, expected) {
  const faults = [];
  await page.addScriptTag({ content: AXE_SOURCE });
  const axe = await page.evaluate(() => globalThis.axe.run(document));
  for (const violation of axe.violations) {
    faults.push(`AXE ${violation.id} : ${violation.nodes.length} nœud(s) — ${violation.help}`);
  }

  const facts = await page.evaluate(() => {
    const downloads = [...document.querySelectorAll('a[data-download]')];
    const nav = [...document.querySelectorAll('nav[aria-label] a[href^="#"]')].map((a) => a.getAttribute('href'));
    const remote = [
      ...document.querySelectorAll('script[src], link[rel="stylesheet"][href], img[src], source[srcset]'),
    ]
      .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? el.getAttribute('srcset'))
      .filter((value) => /^https?:/.test(value));
    return {
      downloads: downloads.map((a) => ({
        href: a.getAttribute('href'),
        version: a.querySelector('[data-version]')?.textContent.trim() ?? null,
      })),
      nav,
      missingTargets: nav.filter((href) => !document.getElementById(href.slice(1))),
      lang: document.documentElement.lang,
      alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => l.getAttribute('hreflang')),
      remote,
    };
  });

  let version = null;
  if (facts.downloads.length !== 1) {
    faults.push(`${facts.downloads.length} bouton(s) [data-download], il en faut exactement un`);
  } else {
    const { href, version: shown } = facts.downloads[0];
    const match = DMG_URL.exec(href ?? '');
    if (!match) faults.push(`adresse du .dmg inattendue : ${href}`);
    else if (match[1] !== match[2]) faults.push(`adresse du .dmg incohérente : ${href}`);
    else if (shown !== match[1]) faults.push(`le bouton affiche « ${shown} » mais pointe la ${match[1]}`);
    else version = match[1];
  }
  if (facts.nav.length === 0) faults.push('aucune ancre dans <nav aria-label>');
  for (const href of facts.missingTargets) faults.push(`ancre sans cible : ${href}`);
  if (facts.lang !== expected.lang) faults.push(`lang="${facts.lang}", attendu "${expected.lang}"`);
  if (!facts.alternates.includes(expected.other)) faults.push(`pas de <link rel="alternate" hreflang="${expected.other}">`);
  for (const url of facts.remote) faults.push(`ressource distante : ${url}`);
  return { faults, version };
}

/** Ouvre chaque page dans Chromium et rend le nombre total de fautes, après les avoir écrites. */
async function check(pages) {
  const browser = await chromium.launch();
  let total = 0;
  const versions = new Map();
  try {
    for (const spec of pages) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(pathToFileURL(resolve(spec.path)).href);
      const { faults, version } = await inspect(page, spec);
      await page.close();
      versions.set(spec.path, version);
      for (const fault of faults) process.stderr.write(`${spec.path} : ${fault}\n`);
      total += faults.length;
    }
  } finally {
    await browser.close();
  }
  if (new Set(versions.values()).size > 1) {
    process.stderr.write(`les pages n'annoncent pas la même version : ${[...versions.values()].join(', ')}\n`);
    total += 1;
  }
  return total;
}

/** Une page minimale conforme, paramétrée pour fabriquer les fixtures du selftest. */
function fixture({ lang, other, version, href, span, remote }) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>t</title>
<link rel="alternate" hreflang="${other}" href="x.html">${remote ? '<script src="https://example.com/a.js"></script>' : ''}
</head><body><nav aria-label="s"><a href="#a">A</a></nav><main><h1>t</h1>
<a data-download href="${href}">Get ${span ? `<span data-version>${version}</span>` : version}</a>
<section id="a"><h2>A</h2></section></main></body></html>`;
}

async function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'landing-'));
  const good = 'https://github.com/romsau/mirmalion/releases/download/v1.2.3/Mirmalion_1.2.3_aarch64.dmg';
  const cases = [
    { name: 'conforme', expect: 0, fr: { version: '1.2.3', href: good, span: true }, en: { version: '1.2.3', href: good, span: true } },
    { name: 'sans-span', expect: 1, fr: { version: '1.2.3', href: good, span: false }, en: { version: '1.2.3', href: good, span: true } },
    { name: 'versions-differentes', expect: 1, fr: { version: '1.2.3', href: good, span: true }, en: { version: '1.2.4', href: good.replaceAll('1.2.3', '1.2.4'), span: true } },
    { name: 'ressource-distante', expect: 1, fr: { version: '1.2.3', href: good, span: true, remote: true }, en: { version: '1.2.3', href: good, span: true } },
  ];
  let failed = 0;
  try {
    for (const c of cases) {
      mkdirSync(join(dir, c.name, 'en'), { recursive: true });
      writeFileSync(join(dir, c.name, 'index.html'), fixture({ lang: 'fr', other: 'en', ...c.fr }));
      writeFileSync(join(dir, c.name, 'en', 'index.html'), fixture({ lang: 'en', other: 'fr', ...c.en }));
      const pages = [
        { path: join(dir, c.name, 'index.html'), lang: 'fr', other: 'en' },
        { path: join(dir, c.name, 'en', 'index.html'), lang: 'en', other: 'fr' },
      ];
      const faults = await check(pages);
      const ok = c.expect === 0 ? faults === 0 : faults >= c.expect;
      process.stdout.write(`${ok ? 'ok' : 'KO'}  ${c.name} (${faults} faute(s))\n`);
      if (!ok) failed += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

const failures = process.argv.includes('--selftest') ? await selftest() : await check(PAGES);
process.exitCode = failures === 0 ? 0 : 1;
```

- [ ] **Step 2: Lancer le selftest, qui doit passer même sans page**

Run: `node scripts/check-landing.mjs --selftest`
Expected: quatre lignes `ok`, code de sortie 0. Si Chromium manque : `npx playwright install chromium`.

- [ ] **Step 3: Lancer la garde sur le site, qui doit échouer**

Run: `node scripts/check-landing.mjs; echo "exit $?"`
Expected: une erreur Playwright `net::ERR_FILE_NOT_FOUND` (la page n'existe pas encore), `exit 1`.

- [ ] **Step 4: Brancher `verify:landing`**

Dans `package.json`, ajouter le script :

```json
    "verify:landing": "node scripts/check-landing.mjs --selftest && node scripts/check-landing.mjs",
```

et insérer `npm run verify:landing && ` dans la chaîne `verify`, juste après `npm run verify:styles && `.

- [ ] **Step 5: Vérifier le style et les commentaires**

Run: `npx prettier --write scripts/check-landing.mjs package.json && node scripts/check-comments.mjs`
Expected: aucune faute signalée.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-landing.mjs package.json
git commit -m "test: la garde de la page d'accueil, dans un vrai Chromium"
```

---

### Task 3: Validation graphique avec le porteur

**Files:** aucun fichier du dépôt. Une maquette jetable, publiée comme Artifact ou ouverte dans le navigateur depuis le scratchpad.

Le porteur veut **voir la page avant que son code soit écrit**. Cette tâche est une porte : la Task 4 ne commence pas tant qu'il n'a pas dit oui.

- [ ] **Step 1: Construire la maquette**

Une page HTML autonome, dans le scratchpad, qui reprend le design décrit en tête de la Task 4 (jetons de l'application, Montserrat, logo `logo-mark` bleu ou magenta selon le thème, bouton bleu Klein avec la version, sections alternées texte / capture, bandeau « rien ne sort de votre machine », pied). Les captures sont remplacées par des cadres gris de 1600 × 1000 portant le nom de l'écran. Textes français de la Task 4.

- [ ] **Step 2: La montrer**

Publier la maquette comme Artifact (favicon 🎙️) et donner le lien, ou l'ouvrir avec `open`. Montrer les deux thèmes et la largeur téléphone.

- [ ] **Step 3: Itérer jusqu'au oui**

Chaque remarque du porteur se reporte dans la maquette, puis on la remontre. Noter ce qui change par rapport au design de la Task 4 : ces changements s'appliquent ensuite au CSS et au HTML de la Task 4, qui reste la référence écrite.

- [ ] **Step 4: Consigner l'accord**

Quand le porteur valide, écrire sous cette ligne la liste des écarts retenus par rapport à la Task 4 (ou « aucun »), puis passer à la Task 4.

Écarts retenus : consignés dans `.superpowers/sdd/2026-09-11-landing-page-github-releases/task-4-ecarts.md` (accroche plein écran, marque seule, textes retenus, touches `<kbd>`, captures réelles sans barre dessinée, variante verticale). La Task 8 est déjà réalisée par cette validation : six captures FR/EN prêtes.

---

### Task 4: Les pages, la feuille et les ressources

**Files:**
- Create: `landing/index.html`, `landing/en/index.html`, `landing/landing.css`
- Create (copies): `landing/fonts/Montserrat-Regular.ttf`, `-Medium.ttf`, `-SemiBold.ttf`, `-Bold.ttf` ; `landing/img/logo-mark.png`, `landing/img/logo-mark-magenta.png`, `landing/img/app-icon.png`
- Delete: `web/index.html`

**Interfaces:**
- Consumes: le contrat HTML de la Task 2.
- Produces: les gabarits que `scripts/landing-version.mjs` (Task 5) réécrit — l'attribut `data-download` précède toujours `href` sur le bouton, et le numéro est le seul contenu de `<span data-version>`.

Le design : la page est un document calme, sur `--surface`, en Montserrat, avec le bleu Klein `--accent` pour la seule chose qui compte, le bouton. Le logo est la marque `logo-mark.png` (bleu, thème clair) ou `logo-mark-magenta.png` (thème sombre), exactement comme dans la maquette `docs/ui/ui.html`. Les sections alternent texte à gauche / capture à droite, puis l'inverse, sur une colonne à moins de 800 px.

- [ ] **Step 1: Copier les ressources et supprimer `web/`**

```bash
mkdir -p landing/fonts landing/img landing/en
cp src/assets/fonts/Montserrat-Regular.ttf src/assets/fonts/Montserrat-Medium.ttf src/assets/fonts/Montserrat-SemiBold.ttf src/assets/fonts/Montserrat-Bold.ttf landing/fonts/
cp docs/ui/logo/logo-mark.png docs/ui/logo/logo-mark-magenta.png docs/ui/logo/app-icon.png landing/img/
git rm -q -r web
```

- [ ] **Step 2: Écrire `landing/landing.css`**

```css
/*
 * Feuille de la page d'accueil. Les jetons de couleur sont ceux de l'application
 * (`src/styles/themes/_light.scss` et `_dark.scss`) : les recopier ici est le prix d'une page
 * sans outil de construction. Un jeton qui change là-bas se reporte ici à la main.
 */

@font-face {
  font-family: 'Montserrat';
  font-weight: 400;
  font-display: swap;
  src: url('fonts/Montserrat-Regular.ttf') format('truetype');
}
@font-face {
  font-family: 'Montserrat';
  font-weight: 500;
  font-display: swap;
  src: url('fonts/Montserrat-Medium.ttf') format('truetype');
}
@font-face {
  font-family: 'Montserrat';
  font-weight: 600;
  font-display: swap;
  src: url('fonts/Montserrat-SemiBold.ttf') format('truetype');
}
@font-face {
  font-family: 'Montserrat';
  font-weight: 700;
  font-display: swap;
  src: url('fonts/Montserrat-Bold.ttf') format('truetype');
}

:root {
  color-scheme: light dark;
  --accent: #002fa7;
  --accent-600: #0a3bc0;
  --accent-50: #eef1fb;
  --accent-ink: #002fa7;
  --accent-on: #fff;
  --ink: #14161c;
  --muted: #6b7080;
  --line: #e4e6ee;
  --surface: #fff;
  --surface-soft: #f6f7fb;
  --radius: 11px;
  --gutter: clamp(20px, 5vw, 48px);
  --measure: 62ch;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent: #a32fa3;
    --accent-600: #b03fb0;
    --accent-50: #2a1a2a;
    --accent-ink: #d36bd3;
    --ink: #eceef4;
    --muted: #9aa1b2;
    --line: #2a2d38;
    --surface: #1a1c22;
    --surface-soft: #23262f;
  }
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  scroll-padding-top: 76px;
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
}

body {
  margin: 0;
  background: var(--surface);
  color: var(--ink);
  font:
    400 17px/1.6 'Montserrat',
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;
  -webkit-font-smoothing: antialiased;
}

a {
  color: var(--accent-ink);
}

a:focus-visible,
.download:focus-visible {
  outline: 3px solid var(--accent-ink);
  outline-offset: 3px;
}

img {
  max-width: 100%;
  height: auto;
}

/* ── En-tête fixe ─────────────────────────────────────────────────────────────────────── */

.top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 14px var(--gutter);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
  font-weight: 700;
  text-decoration: none;
  letter-spacing: -0.01em;
}

.brand img {
  width: 44px;
  height: 21px;
}

.top nav {
  display: flex;
  gap: 4px;
  margin-inline: auto;
}

.top nav a,
.lang {
  padding: 6px 12px;
  border-radius: 999px;
  color: var(--muted);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}

.top nav a:hover,
.lang:hover {
  background: var(--surface-soft);
  color: var(--ink);
}

@media (max-width: 640px) {
  .top nav {
    display: none;
  }
}

/* ── Accroche ─────────────────────────────────────────────────────────────────────────── */

.hero {
  display: grid;
  justify-items: center;
  gap: 18px;
  padding: clamp(56px, 12vh, 120px) var(--gutter) clamp(48px, 10vh, 96px);
  text-align: center;
}

.hero .icon {
  width: 112px;
  height: 112px;
  border-radius: 26px;
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 14%, transparent);
}

.hero h1 {
  max-width: 18ch;
  margin: 8px 0 0;
  font-size: clamp(34px, 6vw, 60px);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

.lede {
  max-width: 52ch;
  margin: 0;
  color: var(--muted);
  font-size: clamp(17px, 2.2vw, 21px);
  font-weight: 500;
  text-wrap: balance;
}

.download {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 16px 30px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-on);
  font-size: 18px;
  font-weight: 600;
  text-decoration: none;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 30%, transparent);
  transition: background 0.15s ease, transform 0.15s ease;
}

.download:hover {
  background: var(--accent-600);
  transform: translateY(-1px);
}

.download [data-version] {
  padding: 3px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent-on) 18%, transparent);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.requirements {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
  font-weight: 500;
}

/* ── Sections ─────────────────────────────────────────────────────────────────────────── */

.feature {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  align-items: center;
  gap: clamp(28px, 5vw, 72px);
  max-width: 1180px;
  margin: 0 auto;
  padding: clamp(48px, 8vh, 96px) var(--gutter);
}

.feature:nth-of-type(even) .feature__text {
  order: 2;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--accent-ink);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.feature h2 {
  margin: 0 0 14px;
  font-size: clamp(26px, 3.4vw, 36px);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.feature p {
  max-width: var(--measure);
  margin: 0 0 12px;
}

.feature__shot {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 6px);
  background: var(--surface-soft);
}

.feature__shot img {
  display: block;
  border-radius: var(--radius);
}

@media (max-width: 800px) {
  .feature {
    grid-template-columns: 1fr;
  }

  .feature:nth-of-type(even) .feature__text {
    order: 0;
  }
}

/* ── Hors ligne ───────────────────────────────────────────────────────────────────────── */

.local {
  margin: clamp(24px, 6vh, 64px) var(--gutter);
  padding: clamp(40px, 7vh, 72px) var(--gutter);
  border-radius: calc(var(--radius) + 10px);
  background: var(--accent-50);
  text-align: center;
}

.local h2 {
  max-width: 22ch;
  margin: 0 auto 12px;
  font-size: clamp(26px, 3.4vw, 36px);
  font-weight: 700;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.local p {
  max-width: var(--measure);
  margin: 0 auto;
}

.local ul {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  max-width: 760px;
  margin: 26px auto 0;
  padding: 0;
  list-style: none;
}

.local li {
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-size: 14px;
  font-weight: 600;
}

/* ── Pied ─────────────────────────────────────────────────────────────────────────────── */

.foot {
  display: grid;
  justify-items: center;
  gap: 16px;
  padding: clamp(48px, 8vh, 96px) var(--gutter) 40px;
  border-top: 1px solid var(--line);
  text-align: center;
}

.foot p {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}

.foot nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 18px;
  font-size: 14px;
  font-weight: 600;
}
```

- [ ] **Step 3: Écrire `landing/index.html`**

```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mirmalion — la parole devient texte, sans quitter votre Mac</title>
    <meta
      name="description"
      content="Dictée, transcription en direct et transcription de fichiers audio ou vidéo. Tout se passe sur votre Mac, hors ligne : aucun son, aucun texte ne quitte la machine."
    />
    <link rel="alternate" hreflang="fr" href="https://mirmalion.web.app/" />
    <link rel="alternate" hreflang="en" href="https://mirmalion.web.app/en/" />
    <link rel="icon" href="img/app-icon.png" type="image/png" />
    <link rel="stylesheet" href="landing.css" />
  </head>
  <body>
    <header class="top">
      <a class="brand" href="#top">
        <picture>
          <source srcset="img/logo-mark-magenta.png" media="(prefers-color-scheme: dark)" />
          <img src="img/logo-mark.png" alt="" width="44" height="21" />
        </picture>
        Mirmalion
      </a>
      <nav aria-label="Sections de la page">
        <a href="#dictee">Dictée</a>
        <a href="#direct">Direct</a>
        <a href="#fichiers">Fichiers</a>
        <a href="#local">Hors ligne</a>
      </nav>
      <a class="lang" href="en/" lang="en" hreflang="en">English</a>
    </header>

    <main id="top">
      <section class="hero" aria-labelledby="hero-title">
        <img class="icon" src="img/app-icon.png" alt="" width="112" height="112" />
        <h1 id="hero-title">La parole devient texte, sans quitter votre Mac.</h1>
        <p class="lede">
          Dictez, transcrivez une réunion pendant qu'elle a lieu, ou un enregistrement après coup.
          Tout se passe sur votre machine, hors ligne.
        </p>
        <a
          class="download"
          data-download
          href="https://github.com/romsau/mirmalion/releases/download/v0.9.16/Mirmalion_0.9.16_aarch64.dmg"
        >
          Télécharger Mirmalion <span data-version>0.9.16</span>
        </a>
        <p class="requirements">macOS 26 · Apple Silicon · Gratuit, code ouvert</p>
      </section>

      <section id="dictee" class="feature" aria-labelledby="dictee-title">
        <div class="feature__text">
          <p class="eyebrow">Dictée</p>
          <h2 id="dictee-title">Vous parlez, le texte s'écrit là où est votre curseur.</h2>
          <p>
            Un raccourci, ⌃⌥, et vous dictez dans n'importe quelle application. Le texte s'insère à
            l'endroit exact où vous étiez, ponctué et propre.
          </p>
          <p>
            Un second raccourci écrit directement dans la langue de votre choix. Un dictionnaire
            personnel apprend vos noms propres et vos termes de métier.
          </p>
        </div>
        <figure class="feature__shot">
          <img
            src="img/dictee.png"
            alt="La fenêtre de Mirmalion sur l'écran Dictée, avec l'historique des dernières saisies."
            width="1600"
            height="1000"
          />
        </figure>
      </section>

      <section id="direct" class="feature" aria-labelledby="direct-title">
        <div class="feature__text">
          <p class="eyebrow">Direct</p>
          <h2 id="direct-title">Une réunion transcrite pendant qu'elle a lieu.</h2>
          <p>
            Mirmalion écoute tout le son de votre Mac, ou seulement une application, et transcrit
            au fil de l'eau. Visioconférence, vidéo, appel : rien à installer ailleurs.
          </p>
          <p>
            À la fin, un compte rendu rédigé par un modèle de langage qui tourne sur votre machine,
            une traduction si besoin, et un export.
          </p>
        </div>
        <figure class="feature__shot">
          <img
            src="img/direct.png"
            alt="L'écran Direct pendant un enregistrement, le texte apparaissant au fil de l'eau."
            width="1600"
            height="1000"
            loading="lazy"
          />
        </figure>
      </section>

      <section id="fichiers" class="feature" aria-labelledby="fichiers-title">
        <div class="feature__text">
          <p class="eyebrow">Fichiers</p>
          <h2 id="fichiers-title">Un enregistrement, glissé, transcrit.</h2>
          <p>
            Déposez un fichier audio ou vidéo, et récupérez son texte. Aucune adresse à coller,
            aucun envoi : le fichier ne quitte pas votre disque.
          </p>
        </div>
        <figure class="feature__shot">
          <img
            src="img/fichiers.png"
            alt="Le panneau Fichiers, avec une zone de dépôt et une transcription terminée."
            width="1600"
            height="1000"
            loading="lazy"
          />
        </figure>
      </section>

      <section id="local" class="local" aria-labelledby="local-title">
        <h2 id="local-title">Rien ne sort de votre machine.</h2>
        <p>
          Toutes les fonctions marchent sans réseau. Aucune télémétrie, aucun compte, aucun contenu
          envoyé nulle part. Le réseau ne sert qu'à deux gestes explicites : télécharger une langue,
          mettre à jour l'application.
        </p>
        <ul aria-label="Langues gérées">
          <li>Français</li>
          <li>Anglais</li>
          <li>Espagnol</li>
          <li>Allemand</li>
          <li>Italien</li>
          <li>Portugais</li>
        </ul>
      </section>
    </main>

    <footer class="foot">
      <a class="download" href="#top">Télécharger Mirmalion</a>
      <nav aria-label="Liens">
        <a href="https://github.com/romsau/mirmalion">Code source</a>
        <a href="https://github.com/romsau/mirmalion/releases">Toutes les versions</a>
        <a href="https://github.com/romsau/mirmalion/blob/main/LICENSE">Licence MIT</a>
      </nav>
      <p>Mirmalion est un logiciel libre pour macOS 26 sur Apple Silicon.</p>
    </footer>
  </body>
</html>
```

⚠️ Le bouton du pied n'a **pas** `data-download` : la garde exige un seul bouton par page, et c'est celui de l'accroche que le script de version réécrit. Le pied renvoie vers le haut.

- [ ] **Step 4: Écrire `landing/en/index.html`**

Mêmes structure, classes et attributs ; chemins relatifs préfixés `../` ; textes anglais :

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mirmalion — speech becomes text, and never leaves your Mac</title>
    <meta
      name="description"
      content="Dictation, live transcription and transcription of audio or video files. Everything runs on your Mac, offline: no sound and no text ever leaves the machine."
    />
    <link rel="alternate" hreflang="en" href="https://mirmalion.web.app/en/" />
    <link rel="alternate" hreflang="fr" href="https://mirmalion.web.app/" />
    <link rel="icon" href="../img/app-icon.png" type="image/png" />
    <link rel="stylesheet" href="../landing.css" />
  </head>
  <body>
    <header class="top">
      <a class="brand" href="#top">
        <picture>
          <source srcset="../img/logo-mark-magenta.png" media="(prefers-color-scheme: dark)" />
          <img src="../img/logo-mark.png" alt="" width="44" height="21" />
        </picture>
        Mirmalion
      </a>
      <nav aria-label="Page sections">
        <a href="#dictation">Dictation</a>
        <a href="#live">Live</a>
        <a href="#files">Files</a>
        <a href="#local">Offline</a>
      </nav>
      <a class="lang" href="../" lang="fr" hreflang="fr">Français</a>
    </header>

    <main id="top">
      <section class="hero" aria-labelledby="hero-title">
        <img class="icon" src="../img/app-icon.png" alt="" width="112" height="112" />
        <h1 id="hero-title">Speech becomes text, and never leaves your Mac.</h1>
        <p class="lede">
          Dictate, transcribe a meeting while it happens, or a recording afterwards. Everything
          runs on your machine, offline.
        </p>
        <a
          class="download"
          data-download
          href="https://github.com/romsau/mirmalion/releases/download/v0.9.16/Mirmalion_0.9.16_aarch64.dmg"
        >
          Download Mirmalion <span data-version>0.9.16</span>
        </a>
        <p class="requirements">macOS 26 · Apple Silicon · Free, open source</p>
      </section>

      <section id="dictation" class="feature" aria-labelledby="dictation-title">
        <div class="feature__text">
          <p class="eyebrow">Dictation</p>
          <h2 id="dictation-title">You speak, the text lands right where your cursor is.</h2>
          <p>
            One shortcut, ⌃⌥, and you dictate into any application. The text is inserted exactly
            where you were, punctuated and clean.
          </p>
          <p>
            A second shortcut writes straight into the language of your choice. A personal
            dictionary learns your names and your trade's vocabulary.
          </p>
        </div>
        <figure class="feature__shot">
          <img
            src="../img/dictee.png"
            alt="The Mirmalion window on the Dictation screen, with the history of recent entries."
            width="1600"
            height="1000"
          />
        </figure>
      </section>

      <section id="live" class="feature" aria-labelledby="live-title">
        <div class="feature__text">
          <p class="eyebrow">Live</p>
          <h2 id="live-title">A meeting transcribed while it happens.</h2>
          <p>
            Mirmalion listens to all the sound on your Mac, or to a single application, and
            transcribes as it goes. Video call, video, phone call: nothing to install elsewhere.
          </p>
          <p>
            At the end, a summary written by a language model running on your machine, a
            translation if you need one, and an export.
          </p>
        </div>
        <figure class="feature__shot">
          <img
            src="../img/direct.png"
            alt="The Live screen during a recording, text appearing as it goes."
            width="1600"
            height="1000"
            loading="lazy"
          />
        </figure>
      </section>

      <section id="files" class="feature" aria-labelledby="files-title">
        <div class="feature__text">
          <p class="eyebrow">Files</p>
          <h2 id="files-title">A recording, dropped, transcribed.</h2>
          <p>
            Drop an audio or video file and get its text back. No link to paste, no upload: the
            file never leaves your disk.
          </p>
        </div>
        <figure class="feature__shot">
          <img
            src="../img/fichiers.png"
            alt="The Files panel, with a drop zone and a finished transcription."
            width="1600"
            height="1000"
            loading="lazy"
          />
        </figure>
      </section>

      <section id="local" class="local" aria-labelledby="local-title">
        <h2 id="local-title">Nothing leaves your machine.</h2>
        <p>
          Every feature works without a network. No telemetry, no account, no content sent
          anywhere. The network is only used for two explicit actions: downloading a language, and
          updating the app.
        </p>
        <ul aria-label="Supported languages">
          <li>French</li>
          <li>English</li>
          <li>Spanish</li>
          <li>German</li>
          <li>Italian</li>
          <li>Portuguese</li>
        </ul>
      </section>
    </main>

    <footer class="foot">
      <a class="download" href="#top">Download Mirmalion</a>
      <nav aria-label="Links">
        <a href="https://github.com/romsau/mirmalion">Source code</a>
        <a href="https://github.com/romsau/mirmalion/releases">All releases</a>
        <a href="https://github.com/romsau/mirmalion/blob/main/LICENSE">MIT license</a>
      </nav>
      <p>Mirmalion is free software for macOS 26 on Apple Silicon.</p>
    </footer>
  </body>
</html>
```

- [ ] **Step 5: Mettre en forme et lancer la garde**

Run: `npx prettier --write landing && node scripts/check-landing.mjs; echo "exit $?"`
Expected: `exit 0`, aucune faute. Les captures manquent encore : une image absente n'est pas une violation AXE, et ce n'est pas un défaut de la page, la Task 8 les fournit. Si AXE remonte `color-contrast`, corriger la couleur en cause avec un jeton, jamais en désactivant la règle.

- [ ] **Step 6: Regarder la page**

Run: `open landing/index.html && open landing/en/index.html`
Vérifier à l'œil : le logo bleu en thème clair, magenta en thème sombre (Réglages Système ▸ Apparence) ; le bouton bleu Klein ; les ancres de l'en-tête qui défilent en douceur ; le lien de langue qui mène à l'autre page ; la mise en page sur une colonne en réduisant la fenêtre sous 800 px.

- [ ] **Step 7: Commit**

```bash
git add landing
git commit -m "feat: la page d'accueil, en français et en anglais"
```

---

### Task 5: `landing-version.mjs`, la réécriture de la version

**Files:**
- Create: `scripts/landing-version.mjs`

**Interfaces:**
- Consumes: les gabarits de la Task 4 (`data-download` avant `href`, `<span data-version>` au contenu nu).
- Produces: `node scripts/landing-version.mjs <version>` réécrit `landing/index.html` et `landing/en/index.html` sur place ; code 1 si un motif manque ou si la version est mal formée. `--selftest`.

- [ ] **Step 1: Écrire le script**

```js
#!/usr/bin/env node
/**
 * Écrit la version publiée dans la page d'accueil : l'adresse du `.dmg` sur le bouton
 * `[data-download]` et le numéro dans `[data-version]`, dans les deux langues.
 *
 *   node scripts/landing-version.mjs 0.9.17
 *
 * ⚠️ Le script cherche `data-download` AVANT `href` sur le bouton, et un `<span data-version>`
 * dont le numéro est le seul contenu. Un gabarit réordonné laisse la page sur l'ancienne version,
 * mais le script le dit : il refuse toute page où l'un des deux motifs ne se trouve pas
 * exactement une fois.
 *
 * ⚠️ Aucune suite ne couvre ce script : lancer `--selftest` avant de croire un vert.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PAGES = ['landing/index.html', 'landing/en/index.html'];
const VERSION = /^\d+\.\d+\.\d+$/;
const HREF = /(<a\b[^>]*\bdata-download\b[^>]*\bhref=")[^"]*(")/g;
const SPAN = /(<span data-version>)[^<]*(<\/span>)/g;

/** L'adresse du programme d'installation d'une version, sur sa GitHub Release. */
export function dmgUrl(version) {
  return `https://github.com/romsau/mirmalion/releases/download/v${version}/Mirmalion_${version}_aarch64.dmg`;
}

/**
 * Rend la page réécrite pour `version`.
 *
 * @throws {Error} si le bouton ou le numéro ne se trouve pas exactement une fois.
 */
export function rewrite(source, version) {
  let hrefs = 0;
  let spans = 0;
  const out = source
    .replace(HREF, (_, open, close) => {
      hrefs += 1;
      return `${open}${dmgUrl(version)}${close}`;
    })
    .replace(SPAN, (_, open, close) => {
      spans += 1;
      return `${open}${version}${close}`;
    });
  if (hrefs !== 1) throw new Error(`${hrefs} bouton(s) [data-download], il en faut exactement un`);
  if (spans !== 1) throw new Error(`${spans} <span data-version>, il en faut exactement un`);
  return out;
}

function selftest() {
  const page = '<a class="download" data-download href="OLD">Get <span data-version>0.0.0</span></a>';
  const cases = [
    {
      name: 'réécrit les deux motifs',
      run: () => rewrite(page, '1.2.3') === `<a class="download" data-download href="${dmgUrl('1.2.3')}">Get <span data-version>1.2.3</span></a>`,
    },
    { name: 'refuse un bouton absent', run: () => throws(() => rewrite('<span data-version>0</span>', '1.2.3')) },
    { name: 'refuse un numéro absent', run: () => throws(() => rewrite('<a data-download href="x">y</a>', '1.2.3')) },
    { name: 'refuse deux boutons', run: () => throws(() => rewrite(page + page, '1.2.3')) },
    { name: 'laisse le reste intact', run: () => rewrite(`<p>avant</p>${page}<p>après</p>`, '1.2.3').startsWith('<p>avant</p>') },
  ];
  let failed = 0;
  for (const c of cases) {
    const ok = c.run();
    process.stdout.write(`${ok ? 'ok' : 'KO'}  ${c.name}\n`);
    if (!ok) failed += 1;
  }
  return failed;
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

if (process.argv.includes('--selftest')) {
  process.exitCode = selftest() === 0 ? 0 : 1;
} else {
  const version = process.argv[2] ?? '';
  if (!VERSION.test(version)) {
    process.stderr.write(`version attendue sous la forme 1.2.3, reçu « ${version} »\n`);
    process.exitCode = 1;
  } else {
    for (const path of PAGES) {
      writeFileSync(path, rewrite(readFileSync(path, 'utf8'), version));
      process.stdout.write(`${path} annonce la ${version}\n`);
    }
  }
}
```

- [ ] **Step 2: Lancer le selftest**

Run: `node scripts/landing-version.mjs --selftest`
Expected: cinq `ok`, code 0.

- [ ] **Step 3: Vérifier sur les vraies pages, puis remettre**

Run: `node scripts/landing-version.mjs 9.9.9 && grep -c "9.9.9" landing/index.html landing/en/index.html && node scripts/check-landing.mjs && git checkout -- landing`
Expected: chaque page compte `2` occurrences (l'adresse et le numéro), la garde passe, puis `git status` propre.

- [ ] **Step 4: Style et commentaires, puis commit**

Run: `npx prettier --write scripts/landing-version.mjs && node scripts/check-comments.mjs`

```bash
git add scripts/landing-version.mjs
git commit -m "feat: le script qui écrit la version publiée dans la page"
```

---

### Task 6: Le script de publication

**Files:**
- Modify: `scripts/release.sh` — étape 0 (l. 88-100), composition du manifeste (l. 233-246), mise en ligne (l. 268-281)

**Interfaces:**
- Consumes: `node scripts/landing-version.mjs <version>` (Task 5), `landing/` (Task 4).
- Produces: la release `v<version>` sur GitHub avec quatre pièces jointes ; `dist-web/` = `landing/` + `updates/`.

⚠️ Ne pas toucher aux étapes de notarisation, d'agrafage, de verdict, ni à ce qui est écrit sous `updates/`. Relire l'en-tête du script avant de commencer.

- [ ] **Step 1: Étape 0, les nouvelles gardes**

Après la ligne `xcrun notarytool history … || fail "profil de notarisation …"`, ajouter :

```bash
# ⚠️ Une release GitHub ne se recrée pas sous le même tag, et le script commet la page avant de
# la créer : la branche et l'arbre se vérifient AVANT les dix minutes de compilation.
gh auth status > /dev/null 2>&1 || fail 'gh n’est pas connecté — « gh auth login »'
[[ "$(git branch --show-current)" == main ]] || fail 'une version se publie depuis main'
[[ -z "$(git status --porcelain)" ]] || fail 'l’arbre de travail n’est pas propre — commettre ou remiser avant de publier'
```

Et après `readonly version` (la version est lue juste en dessous du bloc précédent), ajouter :

```bash
if gh release view "v${version}" > /dev/null 2>&1; then
  fail "la release v${version} existe déjà — monter le numéro de version d'abord"
fi
```

- [ ] **Step 2: Composer le site à partir de `landing/`**

Remplacer :

```bash
rm -rf "$STAGING"
mkdir -p "${STAGING}/updates"
cp "$archive" "${STAGING}/updates/Mirmalion_${version}.app.tar.gz"
cp web/index.html "${STAGING}/index.html"
```

par :

```bash
step 'La page annonce la version'
node scripts/landing-version.mjs "$version" || fail 'la page ne se laisse pas réécrire'

rm -rf "$STAGING"
mkdir -p "${STAGING}/updates"
cp -R landing/. "$STAGING/"
cp "$archive" "${STAGING}/updates/Mirmalion_${version}.app.tar.gz"
```

- [ ] **Step 3: Commit, release GitHub, puis mise en ligne**

Remplacer le bloc final, depuis `step 'Mise en ligne sur Firebase'` jusqu'à la fin du fichier, par :

```bash
# ── 7. Commettre la page, créer la release, mettre en ligne ────────────────────────────────────
#
# Dans cet ordre : le tag de la release se pose sur le commit qui porte la version dans la page,
# et Firebase n'annonce le bouton qu'une fois le `.dmg` réellement téléchargeable.
step 'La page est commise et poussée'
git add landing
git commit -q -m "release: la page annonce la ${version}"
git push -q origin main

step 'GitHub Release'
# ⚠️ `gh` nomme chaque pièce jointe d'après son fichier : l'archive et sa signature sont copiées
# sous leur nom versionné avant l'envoi, sans quoi deux versions porteraient le même nom.
readonly RELEASE_DIR="${BUNDLE}/release"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cp "$dmg" "$RELEASE_DIR/"
cp "$archive" "${RELEASE_DIR}/Mirmalion_${version}.app.tar.gz"
cp "${archive}.sig" "${RELEASE_DIR}/Mirmalion_${version}.app.tar.gz.sig"
cp "${STAGING}/updates/latest.json" "${RELEASE_DIR}/latest.json"
gh release create "v${version}" --title "Mirmalion ${version}" --notes '' "$RELEASE_DIR"/* \
  || fail 'la release GitHub ne se crée pas'
curl -sfIL -o /dev/null "https://github.com/romsau/mirmalion/releases/download/v${version}/Mirmalion_${version}_aarch64.dmg" \
  || printf '  ⚠️ le .dmg ne répond pas encore sans authentification — normal tant que le dépôt est privé\n'

step 'Mise en ligne sur Firebase'
npx -y firebase-tools deploy --only hosting

step "Publié — ${SITE}"
printf '  Les postes déjà installés verront la %s à leur prochaine ouverture.\n' "$version"
printf '  Release : https://github.com/romsau/mirmalion/releases/tag/v%s\n' "$version"
printf '  Le programme d’installation, si on doit le remettre à la main :\n'
printf '    %s\n' "$dmg"
```

⚠️ Le bloc `if [[ "$deploy" == false ]]` existant reste **avant** ce nouveau bloc, tel quel : `--no-deploy` réécrit la page et assemble `dist-web/`, sans commettre, sans release, sans déploiement — c'est ce que la spécification demande.

- [ ] **Step 4: Mettre à jour l'usage en tête du script**

Dans l'en-tête, remplacer :

```bash
# Publie une version de Mirmalion : construction, notarisation, agrafage, mise en ligne.
```

par :

```bash
# Publie une version de Mirmalion : construction, notarisation, agrafage, GitHub Release, mise
# en ligne de la page et du manifeste de mise à jour.
```

- [ ] **Step 5: Vérifier la syntaxe et relire le chemin `--no-deploy`**

Run: `bash -n scripts/release.sh && grep -n -E "deploy\" == false|landing-version|gh release create|cp -R landing" scripts/release.sh`
Expected: pas d'erreur de syntaxe ; les quatre lignes apparaissent dans cet ordre : `landing-version` puis `cp -R landing`, puis `deploy" == false`, puis `gh release create`. Cet ordre est ce qui garantit que `--no-deploy` réécrit et assemble sans commettre ni publier.

- [ ] **Step 6: Commit**

```bash
git add scripts/release.sh
git commit -m "build: la publication crée la GitHub Release et sert la page d'accueil"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (sections « Publier une version » et « Structure du projet »), `.claude/CLAUDE.md` (section « Commands »)

- [ ] **Step 1: README, « Publier une version »**

Remplacer le premier paragraphe :

```markdown
**`npm run release` est le seul geste qui publie.** Il n'y a aucune intégration continue : un
`git push` dépose des commits sur GitHub et rien de plus — aucun utilisateur ne voit quoi que ce
soit. L'application installée interroge `https://mirmalion.web.app/updates/latest.json`, un
manifeste que seul ce script réécrit avant de le mettre en ligne sur Firebase Hosting.
```

par :

```markdown
**`npm run release` est le seul geste qui publie.** Il n'y a aucune intégration continue : un
`git push` dépose des commits sur GitHub et rien de plus — aucun utilisateur ne voit quoi que ce
soit. Le script fait trois choses visibles de l'extérieur, dans cet ordre : il écrit la version
dans la page d'accueil (`landing/`) et la commet ; il crée la **GitHub Release** `v<version>`,
avec le `.dmg` que la page fait télécharger ; il met en ligne sur Firebase Hosting la page et
`https://mirmalion.web.app/updates/latest.json`, le manifeste qu'interroge chaque application
installée pour se mettre à jour. Il se lance depuis `main`, sur un arbre propre.
```

Et remplacer, plus bas :

```markdown
Le détail de la notarisation, de l'agrafage et de ce qui n'est délibérément pas agrafé est
documenté en tête de [`scripts/release.sh`](scripts/release.sh).
```

par :

```markdown
Le détail de la notarisation, de l'agrafage et de ce qui n'est délibérément pas agrafé est
documenté en tête de [`scripts/release.sh`](scripts/release.sh). La page d'accueil se vérifie
avec `npm run verify:landing`, dans un vrai Chromium ; ses textes vivent dans
`landing/index.html` et `landing/en/index.html`, et seul le script de publication y écrit le
numéro de version.
```

- [ ] **Step 2: README, « Structure du projet »**

Dans le bloc de l'arborescence, ajouter une ligne après `src/` :

```text
landing/        Page d'accueil (mirmalion.web.app), HTML et CSS purs, en français et en anglais
```

- [ ] **Step 3: CLAUDE.md, « Commands »**

Dans la liste des étapes de `npm run verify`, insérer `verify:landing` (la page d'accueil dans un vrai Chromium) après `verify:layout`. Dans le paragraphe sur `npm run release`, ajouter une phrase : « Elle crée aussi la GitHub Release et écrit la version dans `landing/` ; le mécanisme de mise à jour, lui, reste sur Firebase. »

- [ ] **Step 4: Vérifier et commettre**

Run: `npx prettier --check README.md`

```bash
git add README.md .claude/CLAUDE.md
git commit -m "docs: la page d'accueil et la GitHub Release dans la procédure de publication"
```

---

### Task 8: Les captures d'écran

**Files:**
- Create: `landing/img/dictee.png`, `landing/img/direct.png`, `landing/img/fichiers.png`
- Modify: les attributs `height` des trois `<img>` dans les deux pages, si le ratio diffère de 1600 × 1000

Cette tâche se fait **avec le porteur** : c'est lui qui met l'application dans un état présentable (une dictée dans l'historique, une session Direct en cours, une transcription de fichier terminée), l'assistant capture. Aucun contenu personnel ne doit apparaître dans les captures.

- [ ] **Step 1: Lancer l'application de dev**

Run: `npm start` (en arrière-plan). Attendre la fenêtre « Mirmalion Dev ».

- [ ] **Step 2: Capturer un écran**

Pour chaque écran, une fois mis en place, capturer la fenêtre par ses coordonnées :

```bash
bounds=$(osascript -e 'tell application "System Events" to tell process "Mirmalion Dev" to get {position, size} of window 1' | tr -d ' ')
IFS=, read -r x y w h <<< "$bounds"
screencapture -x -R "${x},${y},${w},${h}" landing/img/dictee.png
```

Si `osascript` est refusé (Accessibilité), le porteur capture à la main avec ⌘⇧4 puis espace, et dépose le fichier sous le même nom.

- [ ] **Step 3: Ramener chaque capture à 1600 px de large et relever sa hauteur**

```bash
for f in landing/img/dictee.png landing/img/direct.png landing/img/fichiers.png; do
  sips --resampleWidth 1600 "$f" > /dev/null
  printf '%s : ' "$f"; sips -g pixelHeight "$f" | tail -1
done
```

Reporter chaque hauteur dans l'attribut `height` de l'`<img>` correspondante, dans **les deux** pages.

- [ ] **Step 4: Vérifier**

Run: `npx prettier --check landing && node scripts/check-landing.mjs && open landing/index.html`
Expected: la garde passe ; les trois captures s'affichent, nettes, sans déformation.

- [ ] **Step 5: Commit**

```bash
git add landing
git commit -m "feat: les captures d'écran de la page d'accueil"
```

---

### Task 9: Vérification complète et répétition à blanc

**Files:** aucun nouveau.

- [ ] **Step 1: La suite complète**

Run: `npm run verify`
Expected: vert de bout en bout, `verify:landing` compris. Une faute de Prettier sur `landing/` ou `scripts/` se corrige avec `npx prettier --write <fichier>`.

- [ ] **Step 2: Répétition à blanc de la publication**

Run: `npm run release -- --skip-build --no-deploy`
Expected : le script échoue sur la garde « une version se publie depuis main », puisque nous sommes sur `landing`. C'est le comportement attendu, et la preuve que la garde tient. Pour aller jusqu'au bout de l'assemblage sans changer de branche, lancer la partie « site » à la main :

```bash
node scripts/landing-version.mjs 0.9.16 && rm -rf dist-web && mkdir -p dist-web/updates && cp -R landing/. dist-web/ && ls -R dist-web | head -20 && git checkout -- landing
```

Expected : `dist-web/` contient `index.html`, `en/index.html`, `landing.css`, `fonts/`, `img/`, `updates/`. Le manifeste et l'archive y seront ajoutés par le script à la vraie publication.

- [ ] **Step 3: Relire le diff complet de la branche**

Run: `git diff main...landing --stat && git diff main...landing -- src-tauri/tauri.conf.json firebase.json`
Expected : la seconde commande **n'imprime rien** : ni la configuration du plugin de mise à jour ni celle de Firebase n'ont bougé.

- [ ] **Step 4: Remettre le zip temporaire à sa place**

`dist-web/Mirmalion_0.9.16.zip`, déposé à la main pour un testeur, disparaîtra de Firebase à la prochaine publication, puisque `dist-web/` est reconstruit. Le dire au porteur, qui l'attend.

---

## Après la fusion, hors de ce plan

1. Fusionner `landing` dans `main`.
1b. À la demande du porteur : réécrire l'historique en **un seul commit initial** avant le passage en public. Irréversible : sauvegarde (`git bundle` + branche `archive/historique`), confirmation explicite, puis `push --force` et re-création du tag de la release.
2. Monter la version en 0.9.17 dans les quatre fichiers (procédure du README), un commit `build:`.
3. `npm run release`.
4. Épreuve grandeur nature : le Mac du porteur, en 0.9.16, propose et installe la 0.9.17.
5. Le porteur rend le dépôt public : `gh repo edit romsau/mirmalion --visibility public --accept-visibility-change-consequences`. Le bouton de la page fonctionne alors pour tout le monde.
