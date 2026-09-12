// Les captures d'écran de la page d'accueil, prises dans la maquette.
//
// `node scripts/landing-shots.mjs` — les six langues ; `… fr de` pour n'en reprendre que deux.
//
// ⚠️ **La maquette et non l'application construite.** Elle seule porte la fenêtre telle que
// macOS la dessine — pastilles rouge et jaune comprises —, que le navigateur ne peut pas rendre.
// Son cadre mesure exactement 450 × 635, la taille des captures existantes.
// ⚠️ **La maquette est écrite en français en dur.** Les cinq autres langues sont obtenues en y
// injectant les traductions des catalogues avant la capture : c'est la seule raison d'être de la
// table ci-dessous, qui apparie un texte visible de la maquette à son unité de traduction. Un
// texte qui bouge dans la maquette sans bouger ici cesse d'être traduit, en silence.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

/** La maquette, référence de rendu de toute l'application. */
const MAQUETTE = 'docs/ui/ui.html';

/** Où les captures atterrissent, sous les noms que la page d'accueil référence. */
const DESTINATION = 'landing/img';

/**
 * Le format des captures : le cadre de la maquette, rendu en 2×.
 *
 * ⚠️ La taille n'est pas choisie ici, elle est **mesurée** sur `main.window`. Ce qui est écrit
 * est la densité, et elle doit rester à 2 : les images de la page d'accueil s'affichent à moitié
 * de leur taille, et un rendu à 1× serait flou sur tout écran moderne.
 */
const DENSITE = 2;

/**
 * Ce que chaque langue montre : on dicte dans la langue de l'interface, on traduit vers l'anglais.
 *
 * ⚠️ **Les deux exceptions ne sont pas des oublis.** L'anglais vise le français, faute de quoi il
 * se traduirait vers lui-même ; le français ne vise rien, et c'est lui qui montre l'écran tel
 * qu'il s'ouvre — « Pas de traduction », l'indice ⌃⌥⌘ annonçant l'anglais par défaut.
 */
const PLAN = {
  fr: { parlee: 'fr', cible: null },
  en: { parlee: 'en', cible: 'fr' },
  es: { parlee: 'es', cible: 'en' },
  de: { parlee: 'de', cible: 'en' },
  it: { parlee: 'it', cible: 'en' },
  pt: { parlee: 'pt', cible: 'en' },
};

/** Les catalogues, le français étant la source et non une traduction. */
const CATALOGUES = {
  fr: 'src/locale/messages.xlf',
  en: 'src/locale/messages.en.xlf',
  es: 'src/locale/messages.es.xlf',
  de: 'src/locale/messages.de.xlf',
  it: 'src/locale/messages.it.xlf',
  pt: 'src/locale/messages.pt.xlf',
};

/**
 * Le texte visible de la maquette, et l'unité de traduction qui le porte dans l'application.
 *
 * ⚠️ **Deux écarts assumés, et ils vont dans le même sens** : c'est l'application que la page
 * d'accueil montre, pas la maquette. « Démarrer la session » devient donc ce que le bouton dit
 * vraiment, et « Voir les options de langues » suit le libellé livré.
 */
const TEXTES = {
  Dictée: 'screen.dictee',
  Direct: 'screen.direct',
  Options: 'screen.options',
  Historique: 'screen.historique',
  'Mode de dictée': 'dictee.mode',
  Maintenir: 'dictee.mode.hold',
  'Mains libres': 'dictee.mode.toggle',
  'Maintenez pour dicter.': 'dictee.mode.hint.hold',
  'Langue parlée': 'dictee.language',
  Traduction: 'dictee.translation',
  'Pas de traduction': 'dictee.translation.none',
  Nettoyage: 'dictee.cleanup',
  Reformulation: 'dictee.rephrasing',
  Standard: 'dictee.rephrasing.standard',
  'Source audio': 'direct.source',
  'Choisir une source (obligatoire)': 'direct.source.placeholder',
  'Inclure mon micro': 'direct.mic.include',
  'Démarrer la session': 'direct.start',
  'Voir les options de langues': 'dictee.language.seeOptions',
};

/**
 * Lit une unité de traduction dans un catalogue, cible d'abord, source à défaut.
 *
 * @remarks
 * ⚠️ **`bouchon` est rempli AVANT le nettoyage des balises.** Une interpolation est un
 * `<x id="INTERPOLATION"/>`, donc une balise : la retirer avec les autres laissait
 * « Übersetzung: » sans la langue, et le défaut ne se voyait que sur l'image.
 */
function unite(source, identifiant, bouchon = '') {
  const bloc = source.match(
    new RegExp(
      `<trans-unit id="${identifiant.replaceAll('.', '\\.')}"[^>]*>([\\s\\S]*?)</trans-unit>`,
    ),
  );
  if (!bloc) return null;
  const texte =
    bloc[1].match(/<target[^>]*>([\s\S]*?)<\/target>/) ??
    bloc[1].match(/<source>([\s\S]*?)<\/source>/);
  return texte[1]
    .replace(/<x\b[^>]*\/?>/g, bouchon)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Tout ce qu'une langue doit savoir dire : les textes fixes, les noms de langues, et la phrase
 * de l'indice ⌃⌥⌘.
 *
 * @remarks
 * ⚠️ Un identifiant absent du catalogue **arrête le script** plutôt que de laisser passer une
 * capture à moitié française. C'est le seul garde-fou de la table ci-dessus.
 */
function lexique(locale) {
  const source = fs.readFileSync(CATALOGUES[locale], 'utf8');
  const mots = {};
  for (const [francais, identifiant] of Object.entries(TEXTES)) {
    const traduit = unite(source, identifiant);
    if (traduit === null) throw new Error(`${locale} : l'unité « ${identifiant} » manque`);
    mots[francais] = traduit;
  }
  const langues = {};
  for (const code of Object.keys(CATALOGUES)) {
    langues[code] = unite(source, `language.${code}`);
    if (langues[code] === null) throw new Error(`${locale} : le nom de « ${code} » manque`);
  }
  return { mots, langues, source };
}

/** Le nom du fichier attendu par la page d'accueil : le français n'a pas de suffixe. */
const fichierDe = (ecran, locale) =>
  path.join(DESTINATION, `${ecran}${locale === 'fr' ? '' : `-${locale}`}.png`);

/**
 * Réécrit la maquette dans une langue, puis rend le cadre de l'écran demandé.
 *
 * @remarks
 * ⚠️ **Le remplacement porte sur les nœuds de texte, comparés entiers.** Une recherche dans le
 * HTML abîmerait les attributs et les commentaires ; une comparaison partielle réécrirait
 * « Direct » à l'intérieur de « Traduction en direct ».
 */
async function capturer(page, locale, ecran) {
  const { parlee, cible } = PLAN[locale];
  const { mots, langues, source } = lexique(locale);
  // La phrase de l'indice ⌃⌥⌘ se compose : elle nomme la langue réellement écrite.
  const phrase = unite(source, 'dictee.translation.hint', langues[cible ?? 'en']);

  await page.goto(`file://${process.cwd()}/${MAQUETTE}`);
  await page.waitForTimeout(400);
  await page.evaluate((nom) => {
    document.querySelector(`.mq-btn[data-screen="${nom}"]`)?.click();
  }, ecran);
  await page.waitForTimeout(500);

  await page.evaluate(
    ({ mots, parlee, cible, phrase }) => {
      const table = { ...mots, ...parlee, ...cible };
      const noeuds = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const aFaire = [];
      while (noeuds.nextNode()) aFaire.push(noeuds.currentNode);
      for (const noeud of aFaire) {
        const brut = noeud.textContent.trim();
        if (table[brut] !== undefined) {
          noeud.textContent = noeud.textContent.replace(brut, table[brut]);
        }
      }
      // L'indice ⌃⌥⌘ porte une phrase à trou : elle se compose, elle ne se remplace pas.
      const indice = document.querySelector('.hint.is-secondary .hint-txt');
      if (indice && phrase) indice.textContent = phrase;
    },
    {
      mots,
      // La langue parlée affichée, et la cible quand il y en a une.
      parlee: { Français: langues[parlee] },
      cible: cible ? { 'Pas de traduction': langues[cible] } : {},
      phrase,
    },
  );
  // ⚠️ **L'ombre portée part avant la capture**, et ce n'est pas une coquetterie : Playwright
  // cadre sur la boîte de l'élément, l'ombre déborde, et ce qui en tient dans le cadre laisse un
  // halo gris le long des bords. Retirée ici plutôt que dans la maquette, où elle a sa place.
  await page.evaluate(() => {
    for (const fenetre of document.querySelectorAll('main.window')) {
      fenetre.style.boxShadow = 'none';
      fenetre.style.filter = 'none';
    }
  });
  await page.waitForTimeout(300);

  const cadre = page.locator('main.window:visible').first();
  await cadre.screenshot({ path: fichierDe(ecran, locale) });
}

const demandees = process.argv.slice(2);
const langues = demandees.length > 0 ? demandees : Object.keys(PLAN);
for (const locale of langues) {
  if (!PLAN[locale]) throw new Error(`langue inconnue : ${locale}`);
}

const navigateur = await chromium.launch();
const page = await navigateur.newPage({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: DENSITE,
});
try {
  for (const locale of langues) {
    for (const ecran of ['dictee', 'direct']) {
      await capturer(page, locale, ecran);
    }
    console.log(`${locale} : ${fichierDe('dictee', locale)} et ${fichierDe('direct', locale)}`);
  }
} finally {
  await navigateur.close();
}
console.log(`captures : ${langues.length} langue(s) reprise(s).`);
