#!/usr/bin/env node
/**
 * Vérifie la page d'accueil (`landing/`) dans un vrai Chromium.
 *
 * Pour chaque page : aucune violation AXE (contraste compris — c'est un navigateur, pas jsdom),
 * un bouton de téléchargement dont l'adresse et le numéro affiché concordent, des ancres qui
 * ciblent une section présente, la langue déclarée, les liens vers les autres langues, et aucune
 * ressource chargée depuis un autre domaine. Toutes les pages doivent annoncer la même version.
 *
 * ⚠️ La mesure d'audience ne se charge qu'après consentement, et le contrôle ouvre chaque page
 * sans consentement : une requête vers Google ici est une fuite, pas une exception à prévoir.
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

/** Les six langues du site, dans l'ordre où elles apparaissent dans le bundle. */
const LANGS = ['fr', 'en', 'es', 'de', 'it', 'pt'];
/** Le chemin de la page de chaque langue : `landing/index.html` pour le français, un sous-dossier pour les autres. */
const PATHS = Object.fromEntries(
  LANGS.map((lang) => [lang, lang === 'fr' ? 'landing/index.html' : `landing/${lang}/index.html`]),
);
/** La locale Playwright de chaque langue. */
const LOCALES = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE', it: 'it-IT', pt: 'pt-PT' };

/** Les pages du site, avec la langue que chacune doit déclarer et les autres à lier. */
const PAGES = LANGS.map((lang) => ({
  path: PATHS[lang],
  lang,
  others: LANGS.filter((code) => code !== lang),
  locale: LOCALES[lang],
}));

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
    const nav = [...document.querySelectorAll('nav[aria-label] a[href^="#"]')].map((a) =>
      a.getAttribute('href'),
    );
    const remote = [
      ...document.querySelectorAll(
        'script[src], link[rel="stylesheet"][href], img[src], source[srcset]',
      ),
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
      alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) =>
        l.getAttribute('hreflang'),
      ),
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
    else if (shown !== match[1])
      faults.push(`le bouton affiche « ${shown} » mais pointe la ${match[1]}`);
    else version = match[1];
  }
  if (facts.nav.length === 0) faults.push('aucune ancre dans <nav aria-label>');
  for (const href of facts.missingTargets) faults.push(`ancre sans cible : ${href}`);
  if (facts.lang !== expected.lang) faults.push(`lang="${facts.lang}", attendu "${expected.lang}"`);
  for (const code of expected.others) {
    if (!facts.alternates.includes(code))
      faults.push(`pas de <link rel="alternate" hreflang="${code}">`);
  }
  for (const url of facts.remote) faults.push(`ressource distante : ${url}`);
  return { faults, version };
}

/**
 * Ouvre chaque page dans Chromium et rend la liste des fautes, après les avoir écrites.
 *
 * ⚠️ Le contrôle « aucune ressource distante » se fait sur les requêtes réellement émises, pas
 * sur le DOM : une police appelée par un `url()` de la feuille ne porte aucun attribut à lire.
 */
async function check(pages) {
  const browser = await chromium.launch();
  const messages = [];
  const versions = new Map();
  try {
    for (const spec of pages) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        locale: spec.locale ?? 'fr-FR',
      });
      const remote = [];
      page.on('request', (r) => {
        if (!r.url().startsWith('file:')) remote.push(r.url());
      });
      await page.goto(pathToFileURL(resolve(spec.path)).href);
      const { faults, version } = await inspect(page, spec);
      await page.close();
      versions.set(spec.path, version);
      for (const url of new Set(remote)) faults.push(`ressource distante : ${url}`);
      for (const fault of faults) {
        process.stderr.write(`${spec.path} : ${fault}\n`);
        messages.push(`${spec.path} : ${fault}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (new Set(versions.values()).size > 1) {
    const message = `les pages n'annoncent pas la même version : ${[...versions.values()].join(', ')}`;
    process.stderr.write(`${message}\n`);
    messages.push(message);
  }
  return messages;
}

/** Une page minimale conforme, paramétrée pour fabriquer les fixtures du selftest. */
function fixture({
  lang,
  others,
  version,
  href,
  span,
  remote,
  font,
  buttons = 1,
  brokenAnchor,
  noAlternate,
  noAlt,
}) {
  const download = `<a data-download href="${href}">Get ${span ? `<span data-version>${version}</span>` : version}</a>`;
  const alternate = noAlternate
    ? ''
    : others.map((code) => `<link rel="alternate" hreflang="${code}" href="x.html">`).join('');
  // ⚠️ Chromium ne télécharge une police que si un texte s'en sert : le `<p>` fait partie du cas.
  const face = font
    ? '<style>@font-face{font-family:x;src:url(https://example.com/x.woff2)}</style>'
    : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>t</title>
${alternate}${remote ? '<script src="https://example.com/a.js"></script>' : ''}${face}
</head><body><nav aria-label="s"><a href="#a">A</a></nav><main><h1>t</h1>
${download.repeat(buttons)}
${noAlt ? '<img src="x.png">' : ''}
${font ? '<p style="font-family:x">t</p>' : ''}
<section id="${brokenAnchor ? 'z' : 'a'}"><h2>A</h2></section></main></body></html>`;
}

async function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'landing-'));
  const good =
    'https://github.com/romsau/mirmalion/releases/download/v1.2.3/Mirmalion_1.2.3_aarch64.dmg';
  const cases = [
    {
      name: 'conforme',
      expect: 0,
      fr: { version: '1.2.3', href: good, span: true },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'sans-span',
      expect: 1,
      reason: 'le bouton affiche',
      fr: { version: '1.2.3', href: good, span: false },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'versions-differentes',
      expect: 1,
      reason: 'même version',
      fr: { version: '1.2.3', href: good, span: true },
      en: { version: '1.2.4', href: good.replaceAll('1.2.3', '1.2.4'), span: true },
    },
    {
      name: 'ressource-distante',
      expect: 1,
      reason: 'ressource distante',
      fr: { version: '1.2.3', href: good, span: true, remote: true },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'police-distante',
      expect: 1,
      reason: 'ressource distante',
      fr: { version: '1.2.3', href: good, span: true, font: true },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'sans-bouton',
      expect: 1,
      reason: 'bouton(s) [data-download]',
      fr: { version: '1.2.3', href: good, span: true, buttons: 0 },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'deux-boutons',
      expect: 1,
      reason: 'bouton(s) [data-download]',
      fr: { version: '1.2.3', href: good, span: true, buttons: 2 },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'ancre-sans-cible',
      expect: 1,
      reason: 'ancre sans cible',
      fr: { version: '1.2.3', href: good, span: true, brokenAnchor: true },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'mauvaise-langue',
      expect: 1,
      reason: 'lang="en"',
      fr: { version: '1.2.3', href: good, span: true, lang: 'en' },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'sans-alternate',
      expect: 1,
      reason: 'hreflang',
      fr: { version: '1.2.3', href: good, span: true, noAlternate: true },
      en: { version: '1.2.3', href: good, span: true },
    },
    {
      name: 'image-sans-alt',
      expect: 1,
      reason: 'AXE image-alt',
      fr: { version: '1.2.3', href: good, span: true, noAlt: true },
      en: { version: '1.2.3', href: good, span: true },
    },
  ];
  let failed = 0;
  try {
    for (const c of cases) {
      mkdirSync(join(dir, c.name, 'en'), { recursive: true });
      writeFileSync(
        join(dir, c.name, 'index.html'),
        fixture({ lang: 'fr', others: ['en'], ...c.fr }),
      );
      writeFileSync(
        join(dir, c.name, 'en', 'index.html'),
        fixture({ lang: 'en', others: ['fr'], ...c.en }),
      );
      const pages = [
        { path: join(dir, c.name, 'index.html'), lang: 'fr', others: ['en'] },
        { path: join(dir, c.name, 'en', 'index.html'), lang: 'en', others: ['fr'] },
      ];
      const faults = await check(pages);
      const ok =
        c.expect === 0
          ? faults.length === 0
          : faults.length >= c.expect && faults.some((f) => f.includes(c.reason));
      process.stdout.write(`${ok ? 'ok' : 'KO'}  ${c.name} (${faults.length} faute(s))\n`);
      if (!ok) failed += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

const failures = process.argv.includes('--selftest')
  ? await selftest()
  : (await check(PAGES)).length;
process.exitCode = failures === 0 ? 0 : 1;
