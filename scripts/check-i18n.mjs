#!/usr/bin/env node
/**
 * Vérifie que les six langues d'interface disent la même chose. L'interface est localisée **au
 * build** : une unité oubliée se voit chez l'utilisateur allemand, pas en développement.
 *
 * Cinq motifs — **un identifiant, deux textes** (les deux emplois lisent la même traduction, et
 * l'un est faux) ; **le fichier source périmé** (un texte non extrait ne sera jamais traduit) ;
 * **une unité manquante ou orpheline** ; **une cible identique à sa source** (légitime pour
 * « Options », un oubli pour « Arrêter ») ; **deux identifiants, un texte** (mesuré :
 * « Traduction » couvrait un nom et un état, et l'anglais disait « Translation » puis
 * « Translating »). Les partages légitimes des deux derniers se listent à la main.
 *
 * @remarks
 * ⚠️ Les deux premiers motifs ne se lisent pas dans les fichiers — l'extracteur replie les
 * doublons avant d'écrire —, d'où l'extraction relancée à part et la lecture de ce qu'elle dit.
 * ⚠️ Aucune suite ne couvre ce script : lancer `--selftest` avant de croire un vert.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Les cinq locales cibles, dans l'ordre de `SUPPORTED_LOCALES` (`src-tauri/src/i18n.rs`), dont
 * elles sont la queue : le français y est en tête, c'est la locale **source**, et il n'a pas de
 * fichier de traduction — les textes du code sont déjà les siens.
 */
const TARGET_LOCALES = ['en', 'es', 'de', 'it', 'pt'];

const LOCALE_DIR = 'src/locale';

/**
 * Les unités qui ont le **droit** d'être identiques à leur source, langue par langue.
 *
 * @remarks
 * ⚠️ Elle s'écrit à la main, unité par unité : une règle automatique laisserait passer
 * exactement ce qu'on cherche, un texte qu'on a oublié de traduire.
 * ⚠️ Quatre familles seulement y ont droit — noms de format avec leur extension, noms propres,
 * noms de couleur de la palette, et mots que les deux langues écrivent à l'identique. Le doute
 * se tranche en se demandant si un anglophone verrait là un mot français.
 */
const SAME_AS_SOURCE_ALLOWED = {
  en: [
    'screen.options',
    'options.section.audio',
    'dictee.rephrasing.standard',
    'direct.transcript.roleOriginal',
    'onboarding.permissions.microphone.title',
    'direct.prompt.promptLabel',
    'export.csv',
    'export.json',
    'export.markdown',
    'export.pdf',
    'export.word',
    'options.accent.orange',
    'options.accent.olive',
    'options.accent.cyan',
    'options.accent.indigo',
    'options.accent.violet',
    'options.accent.magenta',
    'options.accent.fuchsia',
    'options.accent.rose',
  ],
  es: [
    'options.section.audio',
    'direct.transcript.roleOriginal',
    'direct.prompt.promptLabel',
    'export.csv',
    'export.json',
    'export.markdown',
    'export.pdf',
    'export.word',
    'options.accent.magenta',
  ],
  de: [
    'options.section.audio',
    'dictee.rephrasing.standard',
    'direct.prompt.promptLabel',
    'export.csv',
    'export.json',
    'export.markdown',
    'export.pdf',
    'export.word',
    'options.accent.orange',
    'options.accent.cyan',
    'options.accent.indigo',
    'options.accent.magenta',
    'options.accent.fuchsia',
  ],
  it: [
    'options.section.audio',
    'dictee.rephrasing.standard',
    'direct.report.brainstorm',
    'direct.prompt.promptLabel',
    'export.csv',
    'export.json',
    'export.markdown',
    'export.pdf',
    'export.word',
    'options.accent.magenta',
  ],
  pt: [
    'direct.transcript.roleOriginal',
    'direct.prompt.promptLabel',
    'export.csv',
    'export.json',
    'export.markdown',
    'export.pdf',
    'export.word',
    'options.accent.magenta',
  ],
};

/**
 * Les groupes d'identifiants qui ont le **droit** de partager un même texte source.
 *
 * ⚠️ Un seul groupe, et il est là pour une raison mesurée : « Traduction » désigne en français
 * aussi bien le nom que l'état en cours, quand l'anglais dit « Translation » et « Translating »,
 * l'espagnol « Traducción » et « Traduciendo ». Les fondre écrirait un nom là où il faut un état.
 * Tout le reste a été ramené à une seule unité — voir `common.*` et `screen.*`.
 */
const DUPLICATE_SOURCE_ALLOWED = [
  ['dictee.translation', 'onboarding.translation.title', 'overlay.state.translating'],
];

/**
 * Les groupes d'identifiants qui portent le même texte sans y avoir droit.
 *
 * @param units - Les unités de la locale source.
 * @param allowed - Les groupes autorisés à se partager une source.
 * @returns Des `{ source, ids }`, un par texte partagé hors liste.
 */
export function sharedSources(units, allowed) {
  const byText = new Map();
  for (const [id, unit] of units) {
    const seen = byText.get(unit.source);
    if (seen === undefined) {
      byText.set(unit.source, [id]);
    } else {
      seen.push(id);
    }
  }
  const shared = [];
  for (const [source, ids] of byText) {
    if (ids.length < 2) {
      continue;
    }
    // ⚠️ Tous les identifiants du groupe doivent figurer dans une même entrée autorisée : une
    // liste qui n'en couvrirait qu'une partie laisserait passer le doublon qu'on cherche.
    if (allowed.some((group) => ids.every((id) => group.includes(id)))) {
      continue;
    }
    shared.push({ source, ids });
  }
  return shared;
}

/**
 * Les unités d'un fichier XLIFF, par identifiant.
 *
 * ⚠️ Il ne sait lire qu'une forme précise — un `<trans-unit id="…">` portant un `<source>` et au
 * plus un `<target>`. C'est exactement ce que produit `ng extract-i18n`, et c'est une raison de
 * plus de ne jamais réécrire ces fichiers à la main autrement que par leurs `<target>`.
 */
export function parseUnits(xml) {
  const units = new Map();
  for (const [, id, body] of xml.matchAll(
    /<trans-unit id="([^"]*)"[^>]*>([\s\S]*?)<\/trans-unit>/g,
  )) {
    const source = body.match(/<source>([\s\S]*?)<\/source>/);
    const target = body.match(/<target[^>]*>([\s\S]*?)<\/target>/);
    units.set(id, {
      source: source ? source[1].trim() : '',
      // ⚠️ **`null` et chaîne vide ne veulent pas dire la même chose** : pas de balise du tout,
      // c'est « personne n'y a touché » ; une balise vide, c'est « quelqu'un est passé et n'a
      // rien écrit ». Le second est le plus dangereux — il ressemble à du travail fait.
      target: target ? target[1].trim() : null,
    });
  }
  return units;
}

/**
 * Les identifiants que l'extracteur signale comme portant **deux textes différents**.
 *
 * ⚠️ **On lit ce qu'il DIT, parce que ce qu'il écrit ne le porte plus** : il replie les doublons
 * dans le fichier produit, en ne gardant qu'une source. Le seul témoin est son avertissement.
 */
export function duplicateIds(extractorOutput) {
  return [...extractorOutput.matchAll(/Duplicate messages with id "([^"]*)"/g)].map(([, id]) => id);
}

/**
 * Ce qui manque, ce qui traîne et ce qui n'a pas bougé, pour une langue.
 *
 * `missing` est rendu à part des trois autres : pendant la phase de traduction, c'est un
 * **compte annoncé**, pas une faute. Les trois autres sont des fautes dès la première.
 */
export function auditLocale(sourceUnits, targetUnits, allowed) {
  const audit = { missing: [], orphans: [], empty: [], drifted: [], untranslated: [] };
  for (const [id, unit] of sourceUnits) {
    const translated = targetUnits.get(id);
    if (translated === undefined || translated.target === null) {
      audit.missing.push(id);
      continue;
    }
    if (translated.target === '') {
      audit.empty.push(id);
      continue;
    }
    // La source recopiée dans le fichier cible sert de témoin : si elle ne correspond plus, la
    // traduction répond à une phrase que le code n'écrit plus.
    if (translated.source !== unit.source) {
      audit.drifted.push(id);
      continue;
    }
    if (translated.target === unit.source && !allowed.includes(id)) {
      audit.untranslated.push(id);
    }
  }
  for (const id of targetUnits.keys()) {
    if (!sourceUnits.has(id)) {
      audit.orphans.push(id);
    }
  }
  return audit;
}

/** Les identifiants d'un côté qui n'ont pas le même texte de l'autre. */
export function staleAgainst(fresh, committed) {
  const stale = [];
  for (const [id, unit] of fresh) {
    const known = committed.get(id);
    if (known === undefined || known.source !== unit.source) {
      stale.push(id);
    }
  }
  for (const id of committed.keys()) {
    if (!fresh.has(id)) {
      stale.push(id);
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------------------------

function say(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Extrait dans un dossier temporaire et rend ce qui a été écrit **et** ce qui a été dit.
 *
 * ⚠️ Le dossier temporaire, jamais `src/locale` : une extraction qui échoue à mi-course
 * laisserait le fichier source à moitié écrit, et le prochain `verify` mesurerait un dégât
 * causé par la mesure précédente.
 */
function extract() {
  const directory = mkdtempSync(join(tmpdir(), 'mirmalion-i18n-'));
  try {
    const output = execFileSync('npx', ['ng', 'extract-i18n', '--output-path', directory], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { units: parseUnits(readFileSync(join(directory, 'messages.xlf'), 'utf8')), output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function selftest() {
  const failures = [];
  let checked = 0;
  // ⚠️ Le nombre s'annonce en comptant, jamais en dur : un total écrit à la main survit à
  // l'ajout d'un contrôle et annonce alors une couverture qu'il n'a plus.
  const expect = (what, condition) => {
    checked += 1;
    if (!condition) {
      failures.push(what);
    }
  };

  const source = parseUnits(
    `<trans-unit id="a"><source>Arrêter</source></trans-unit>
     <trans-unit id="b"><source>Options</source></trans-unit>
     <trans-unit id="c"><source>Démarrer</source></trans-unit>`,
  );
  expect('parseUnits lit les trois unités', source.size === 3);
  expect('parseUnits ne rend pas de cible quand il n’y en a pas', source.get('a').target === null);

  expect(
    'un doublon signalé par l’extracteur est vu',
    duplicateIds('WARNINGS:\n - Duplicate messages with id "direct.source":\n').length === 1,
  );
  expect('une sortie sans avertissement ne signale rien', duplicateIds('ok').length === 0);

  const audit = auditLocale(
    source,
    parseUnits(
      `<trans-unit id="a"><source>Arrêter</source><target>Arrêter</target></trans-unit>
       <trans-unit id="b"><source>Options</source><target>Options</target></trans-unit>
       <trans-unit id="d"><source>Parti</source><target>Gone</target></trans-unit>`,
    ),
    ['b'],
  );
  expect('une unité absente est vue', audit.missing.join() === 'c');
  expect('une cible identique à sa source est vue', audit.untranslated.join() === 'a');
  expect('une unité autorisée à ne pas bouger passe', !audit.untranslated.includes('b'));
  expect('une orpheline est vue', audit.orphans.join() === 'd');

  const vide = auditLocale(
    parseUnits('<trans-unit id="a"><source>Arrêter</source></trans-unit>'),
    parseUnits('<trans-unit id="a"><source>Arrêter</source><target></target></trans-unit>'),
    [],
  );
  expect('une cible vide est vue, et n’est pas comptée comme manquante', vide.empty.join() === 'a');

  const derive = auditLocale(
    parseUnits('<trans-unit id="a"><source>Arrêter la session</source></trans-unit>'),
    parseUnits('<trans-unit id="a"><source>Arrêter</source><target>Stop</target></trans-unit>'),
    [],
  );
  expect('une source qui a bougé sous la traduction est vue', derive.drifted.join() === 'a');

  const fresh = parseUnits('<trans-unit id="a"><source>Neuf</source></trans-unit>');
  expect(
    'un fichier source périmé est vu',
    staleAgainst(
      fresh,
      parseUnits('<trans-unit id="a"><source>Vieux</source></trans-unit>'),
    ).join() === 'a',
  );
  expect('un fichier source à jour ne l’est pas', staleAgainst(fresh, fresh).length === 0);

  const partage = parseUnits(
    `<trans-unit id="a"><source>Traduction</source></trans-unit>
     <trans-unit id="b"><source>Traduction</source></trans-unit>
     <trans-unit id="c"><source>Démarrer</source></trans-unit>`,
  );
  expect('deux identifiants pour un même texte sont vus', sharedSources(partage, []).length === 1);
  expect(
    'le groupe signalé porte les deux identifiants',
    sharedSources(partage, [])[0].ids.join() === 'a,b',
  );
  expect(
    'un partage explicitement autorisé passe',
    sharedSources(partage, [['a', 'b']]).length === 0,
  );
  expect(
    'une liste qui ne couvre qu’une partie du groupe ne l’autorise pas',
    sharedSources(partage, [['a']]).length === 1,
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      say(`  ✗ ${failure}`);
    }
    say(`\nAutotest : ${failures.length} contrôle(s) ne détectent pas ce qu'ils annoncent.`);
    process.exit(1);
  }
  say(`Autotest i18n : les ${checked} contrôles tombent bien sur ce qu’ils sont censés attraper.`);
}

function main() {
  const { units: fresh, output } = extract();
  const committed = parseUnits(readFileSync(join(LOCALE_DIR, 'messages.xlf'), 'utf8'));

  let fatal = 0;
  let pending = 0;

  const duplicates = duplicateIds(output);
  if (duplicates.length > 0) {
    fatal += duplicates.length;
    say(`✗ ${duplicates.length} identifiant(s) portant deux textes : ${duplicates.join(', ')}`);
    say('  Un `@@id` ne porte qu’une source — les deux emplois liraient la même traduction.');
  }

  const shared = sharedSources(fresh, DUPLICATE_SOURCE_ALLOWED);
  if (shared.length > 0) {
    fatal += shared.length;
    say(`✗ ${shared.length} texte(s) portés par plusieurs identifiants :`);
    for (const { source, ids } of shared) {
      say(`    « ${source.slice(0, 48)} » — ${ids.join(', ')}`);
    }
    say('  Le traducteur reçoit la même phrase deux fois et peut la rendre de deux façons.');
  }

  const stale = staleAgainst(fresh, committed);
  if (stale.length > 0) {
    fatal += stale.length;
    say(
      `✗ ${LOCALE_DIR}/messages.xlf est périmé sur ${stale.length} unité(s) : ${stale.join(', ')}`,
    );
    say('  Régénérer avec `npm run i18n:extract`, sinon personne ne traduira ces textes.');
  }

  for (const locale of TARGET_LOCALES) {
    const path = join(LOCALE_DIR, `messages.${locale}.xlf`);
    const audit = auditLocale(fresh, parseUnits(readFileSync(path, 'utf8')), [
      ...SAME_AS_SOURCE_ALLOWED[locale],
    ]);
    for (const [motif, ids] of [
      ['orpheline(s)', audit.orphans],
      ['cible(s) vide(s)', audit.empty],
      ['source(s) ayant bougé sous leur traduction', audit.drifted],
      ['cible(s) identiques à leur source', audit.untranslated],
    ]) {
      if (ids.length > 0) {
        fatal += ids.length;
        say(`✗ ${locale} — ${ids.length} ${motif} : ${ids.slice(0, 8).join(', ')}`);
      }
    }
    if (audit.missing.length > 0) {
      fatal += audit.missing.length;
      say(`✗ ${locale} — ${audit.missing.length} unité(s) non traduite(s)`);
    }
  }

  if (fatal > 0) {
    say(`\n${fatal} problème(s). Les six langues ne disent pas la même chose.`);
    process.exit(1);
  }

  // ⚠️ **Une unité manquante est bloquante.** Elle a été **tolérée** tant que les langues se remplissaient — un compte
  // annoncé, pas une faute —, et un drapeau `--strict` permettait alors de basculer. Le drapeau
  // est parti avec la tolérance : un interrupteur qu'on peut oublier de mettre est un contrôle
  // qu'on peut oublier de faire. **Ajouter un texte au code sans le traduire échoue désormais
  // `npm run verify`**, ce qui est exactement le moment où on peut encore le faire à peu de frais.
  say(`i18n : ${fresh.size} unités, ${TARGET_LOCALES.length} langues, aucun doublon ni orpheline.`);
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main();
}
