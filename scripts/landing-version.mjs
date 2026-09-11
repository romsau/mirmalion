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

/**
 * Réécrit les deux pages pour `version`.
 *
 * ⚠️ Les deux pages sont relues et réécrites en mémoire avant le moindre écrit sur le disque :
 * une page hors gabarit laisse sinon l'autre déjà réécrite, arbre sale au milieu d'une publication.
 *
 * @throws {Error} si l'une des deux pages ne correspond pas au gabarit.
 */
function writePages(version) {
  const rewritten = PAGES.map((path) => [path, rewrite(readFileSync(path, 'utf8'), version)]);
  for (const [path, source] of rewritten) {
    writeFileSync(path, source);
    process.stdout.write(`${path} annonce la ${version}\n`);
  }
}

function selftest() {
  const page =
    '<a class="download" data-download href="OLD">Get <span data-version>0.0.0</span></a>';
  const cases = [
    {
      name: 'réécrit les deux motifs',
      run: () =>
        rewrite(page, '1.2.3') ===
        `<a class="download" data-download href="${dmgUrl('1.2.3')}">Get <span data-version>1.2.3</span></a>`,
    },
    {
      name: 'refuse un bouton absent',
      run: () => throws(() => rewrite('<span data-version>0</span>', '1.2.3')),
    },
    {
      name: 'refuse un numéro absent',
      run: () => throws(() => rewrite('<a data-download href="x">y</a>', '1.2.3')),
    },
    { name: 'refuse deux boutons', run: () => throws(() => rewrite(page + page, '1.2.3')) },
    {
      name: 'laisse le reste intact',
      run: () => rewrite(`<p>avant</p>${page}<p>après</p>`, '1.2.3').startsWith('<p>avant</p>'),
    },
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
    writePages(version);
  }
}
