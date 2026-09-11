#!/usr/bin/env node
/**
 * Refuse les commentaires qui racontent au lieu de documenter.
 *
 * Sept motifs, tous mécaniques : les marqueurs de journal (datation, décision, campagne), les
 * ornements (double alerte, bandeau, capitales) et les blocs hors plafond. Ce qui relève du
 * jugement — un piège qui mérite d'être gardé, une phrase de résumé juste — se tranche en
 * relecture, pas ici.
 *
 * @remarks
 * ⚠️ Aucune suite ne couvre ce script : Vitest ne voit que `src/`. D'où `--selftest`, qui soumet
 * chaque règle à un cas devant la faire tomber. Le lancer avant de croire un vert.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Les racines balayées quand aucun chemin n'est donné.
 *
 * @remarks
 * ⚠️ Le Rust ne vit pas qu'en `src/` : `build.rs` et les tests d'intégration sont du code
 * livré comme le reste, et rien d'autre ne les relit.
 */
const ROOTS = [
  'src',
  'src-tauri/src',
  'src-tauri/build.rs',
  'src-tauri/tests',
  'src-tauri/native/Sources/MirmalionNative',
  // ⚠️ Les garde-fous sont du code livré comme le reste, et ils portent leur propre convention.
  // Le script qui refuse un commentaire hors règle doit s'y soumettre le premier.
  'scripts',
  'vitest-base.config.ts',
];

/** Plafond, en lignes non vides, d'un en-tête de module. */
const HEADER_MAX = 12;

/** Plafond, en lignes non vides, de la documentation d'un item. */
const ITEM_MAX = 8;

/** Les motifs bannis, cherchés dans toute ligne de commentaire. */
const BANNED = [
  { rule: 'double-alerte', re: /⚠️\s*⚠️/u, detail: 'un piège se signale une fois' },
  { rule: 'bandeau', re: /═{4,}|─{8,}/u, detail: 'bandeau décoratif' },
  { rule: 'porteur', re: /\(\s*porteur\b/iu, detail: 'datation de décision' },
  { rule: 'decision', re: /\(\s*décision\s+\d/iu, detail: 'renvoi à une décision numérotée' },
  { rule: 'campagne', re: /\bP\d+-\d{2}\b/u, detail: 'identifiant de campagne' },
  { rule: 'date', re: /\b20\d{2}-\d{2}-\d{2}\b/u, detail: 'datation' },
];

/**
 * Une ligne « hurlée » : au moins trois mots et douze lettres, toutes capitales.
 *
 * @remarks
 * ⚠️ Le test `lettres !== minuscules` écarte les écritures sans casse — sans lui, une ligne
 * qui n'en a pas serait prise pour un cri.
 */
function isShouted(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 12) return false;
  if (text.split(/\s+/u).filter((w) => /\p{L}{2,}/u.test(w)).length < 3) return false;
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * Découpe une source en blocs de commentaire contigus.
 *
 * @param source - Le contenu du fichier.
 * @param kind - `'ts'`, `'rs'`, `'swift'`, `'sql'`, `'html'` ou `'scss'`.
 * @returns Des blocs `{ start, lines, doc, header }`, `start` étant en base 1.
 *
 * @remarks
 * ⚠️ En HTML, `<!-- -->` est la **seule** forme : y laisser passer `//` prendrait une URL de
 * gabarit pour un commentaire.
 */
function spans(source, kind) {
  const lines = source.split('\n');
  const out = [];
  let current = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (current?.block) {
      const closing = current.marker === '<!--' ? '-->' : '*/';
      current.lines.push(
        trimmed
          .replace(/-->\s*$/u, '')
          .replace(/\*\/\s*$/u, '')
          .replace(/^\*\s?/u, ''),
      );
      if (trimmed.includes(closing)) flush();
      continue;
    }

    if (kind === 'html') {
      if (!trimmed.startsWith('<!--')) {
        flush();
        continue;
      }
      current = {
        block: true,
        doc: true,
        header: out.length === 0,
        marker: '<!--',
        start: i + 1,
        lines: [trimmed.replace(/^<!--/u, '').replace(/-->\s*$/u, '')],
      };
      if (trimmed.includes('-->')) flush();
      continue;
    }

    if (kind === 'scss' && trimmed.startsWith('/*')) {
      current = {
        block: true,
        doc: true,
        header: out.length === 0,
        marker: '/*',
        start: i + 1,
        lines: [trimmed.replace(/^\/\*+/u, '').replace(/\*\/\s*$/u, '')],
      };
      if (trimmed.includes('*/') && trimmed.length > 2) flush();
      continue;
    }

    if ((kind === 'ts' || kind === 'swift') && trimmed.startsWith('/**')) {
      current = {
        block: true,
        doc: true,
        header: out.length === 0,
        marker: '/**',
        start: i + 1,
        lines: [trimmed.replace(/^\/\*\*/u, '').replace(/\*\/\s*$/u, '')],
      };
      if (trimmed.includes('*/') && trimmed.length > 3) flush();
      continue;
    }

    let marker = null;
    if (kind === 'sql') marker = trimmed.startsWith('--') ? '--' : null;
    else if (kind !== 'ts' && trimmed.startsWith('//!')) marker = '//!';
    else if (kind !== 'ts' && trimmed.startsWith('///')) marker = '///';
    else if (trimmed.startsWith('//')) marker = '//';

    if (marker === null) {
      flush();
      continue;
    }

    const text = trimmed.slice(marker.length);
    if (current && current.marker === marker) {
      current.lines.push(text);
      continue;
    }
    flush();
    current = {
      block: false,
      // ⚠️ En SCSS, `//` est la forme ordinaire du commentaire : c'est là que vivent l'en-tête
      // de feuille et les pièges de rendu, donc les plafonds s'y appliquent comme ailleurs.
      doc: marker === '///' || marker === '//!' || marker === '--' || kind === 'scss',
      header: marker === '//!' || ((marker === '--' || kind === 'scss') && out.length === 0),
      marker,
      start: i + 1,
      lines: [text],
    };
  }
  flush();
  return out;
}

/**
 * Les lignes d'un bloc, privées de ses exemples entre ` ``` `.
 *
 * @remarks
 * ⚠️ Un exemple est du code, pas de la prose : le compter ferait choisir entre documenter
 * l'usage d'un composant et tenir le plafond, alors que le plafond vise le récit.
 */
function withoutFences(lines) {
  let inside = false;
  return lines.filter((line) => {
    if (line.trim().startsWith('```')) {
      inside = !inside;
      return false;
    }
    return !inside;
  });
}

/**
 * Les manquements d'une source à la convention.
 *
 * @param source - Le contenu du fichier.
 * @param kind - `'ts'`, `'rs'` ou `'swift'`.
 * @returns Des `{ line, rule, detail }`, `line` étant en base 1.
 */
export function analyse(source, kind) {
  const found = [];
  for (const span of spans(source, kind)) {
    const cap = span.header ? HEADER_MAX : ITEM_MAX;
    const body = withoutFences(span.lines).filter((l) => l.trim() !== '');
    if (span.doc && body.length > cap) {
      found.push({
        line: span.start,
        rule: 'longueur',
        detail: `${body.length} lignes de documentation pour un maximum de ${cap}`,
      });
    }
    span.lines.forEach((text, offset) => {
      for (const { rule, re, detail } of BANNED) {
        if (re.test(text)) found.push({ line: span.start + offset, rule, detail });
      }
      if (isShouted(text)) {
        found.push({ line: span.start + offset, rule: 'capitales', detail: 'ligne en capitales' });
      }
    });
  }
  return found;
}

/**
 * Le langage d'un fichier, ou `null` s'il est hors périmètre.
 *
 * @remarks
 * ⚠️ Les gabarits et les feuilles de style en sont : c'est là que vit la moitié de la prose du
 * dépôt, et une convention tenue d'un seul côté n'en est pas une.
 */
function kindOf(path) {
  if (path.endsWith('.spec.ts')) return null;
  if (path.endsWith('.ts') || path.endsWith('.mjs')) return 'ts';
  if (path.endsWith('.rs')) return 'rs';
  if (path.endsWith('.swift')) return 'swift';
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.html')) return 'html';
  if (path.endsWith('.scss')) return 'scss';
  return null;
}

/** Les fichiers du périmètre sous un chemin, qu'il désigne un fichier ou un dossier. */
function collect(target) {
  if (kindOf(target)) return [target];
  return readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => kindOf(path) !== null);
}

const FIXTURES = [
  { rule: 'double-alerte', kind: 'rs', source: '//! ⚠️⚠️ attention au tampon\n' },
  { rule: 'bandeau', kind: 'rs', source: '// ═══════════════════\n' },
  { rule: 'porteur', kind: 'rs', source: '/// Retiré *(porteur, 2026-08-13)*.\npub fn a() {}\n' },
  {
    rule: 'decision',
    kind: 'rs',
    source: '/// Le plus important *(décision 6)*.\npub fn a() {}\n',
  },
  { rule: 'campagne', kind: 'rs', source: '/// Ajouté par P4-21.\npub fn a() {}\n' },
  { rule: 'date', kind: 'rs', source: '/// Mesuré le 2026-08-11.\npub fn a() {}\n' },
  {
    rule: 'capitales',
    kind: 'rs',
    source: '/// LA FENETRE DU MODELE FAIT QUATRE MILLE TOKENS\npub fn a() {}\n',
  },
  {
    rule: 'longueur',
    kind: 'rs',
    source: `${'/// une ligne de documentation\n'.repeat(9)}pub fn a() {}\n`,
  },
  { rule: 'longueur', kind: 'rs', source: "//! une ligne d'en-tête de module\n".repeat(13) },
  {
    rule: 'longueur',
    kind: 'ts',
    source: `/** L'en-tête du module. */\n\n/**\n${' * une ligne de documentation\n'.repeat(9)} */\nexport const A = 1;\n`,
  },
  {
    rule: 'longueur',
    kind: 'ts',
    source: `/**\n${" * une ligne d'en-tête de module\n".repeat(13)} */\nexport const A = 1;\n`,
  },
  {
    rule: 'longueur',
    kind: 'swift',
    source: `${'/// une ligne de documentation\n'.repeat(9)}func a() {}\n`,
  },
  {
    rule: 'double-alerte',
    kind: 'swift',
    source: '/**\n ⚠️⚠️ attention au tampon\n */\nfunc a() {}\n',
  },
  { rule: 'campagne', kind: 'sql', source: '-- Ajouté par P4-23.\nDROP TABLE voices;\n' },
  {
    rule: 'double-alerte',
    kind: 'html',
    source: '<!-- ⚠️⚠️ attention au tampon -->\n<p>Bonjour</p>\n',
  },
  {
    rule: 'porteur',
    kind: 'html',
    source: '<!--\n  Retiré *(porteur, 2026-08-13)*.\n-->\n<p>Bonjour</p>\n',
  },
  {
    rule: 'capitales',
    kind: 'html',
    source: '<!-- LA FENETRE DU MODELE FAIT QUATRE MILLE TOKENS -->\n<p>Bonjour</p>\n',
  },
  {
    rule: 'longueur',
    kind: 'html',
    source: `<!-- L'en-tête. -->\n\n<!--\n${'  une ligne de documentation\n'.repeat(9)}-->\n<p>Bonjour</p>\n`,
  },
  { rule: 'bandeau', kind: 'scss', source: '// ═══════════════════\n.a {\n  color: red;\n}\n' },
  { rule: 'date', kind: 'scss', source: '/* Mesuré le 2026-08-11. */\n.a {\n  color: red;\n}\n' },
  {
    rule: 'longueur',
    kind: 'scss',
    source: `// L'en-tête.\n\n${'// une ligne de documentation\n'.repeat(9)}.a {\n  color: red;\n}\n`,
  },
  {
    rule: 'longueur',
    kind: 'ts',
    source: `/** L'en-tête. */\n\n/**\n * Un composant.\n *\n * @example\n * \`\`\`html\n${' * <app-x />\n'.repeat(12)} * \`\`\`\n${' * une ligne de prose\n'.repeat(9)} */\nexport const A = 1;\n`,
  },
  {
    rule: 'longueur',
    kind: 'sql',
    source: `-- L'en-tête.\n\n${'-- une ligne de documentation\n'.repeat(9)}DROP TABLE voices;\n`,
  },
];

const CLEAN = [
  {
    kind: 'rs',
    source:
      '//! Le découpage du transcript en tranches.\n//!\n//! Module pur : ni modèle, ni pont.\n\n/// Découpe en tranches respectant les frontières de sens.\n///\n/// # Errors\n///\n/// Rend [`SliceError::Empty`] si le transcript ne porte aucun tour de parole.\n///\n/// # Pièges\n///\n/// - ⚠️ La fenêtre du modèle fait 4 096 tokens ; au-delà, il refuse la requête.\npub fn slice() {}\n',
  },
  {
    kind: 'ts',
    source:
      "import { Service } from '@angular/core';\n\n/**\n * Une ligne du transcript en direct.\n *\n * @remarks\n * ⚠️ La clé de rendu n'est ni l'index ni le texte : l'index rejouerait tout le DOM.\n */\nexport interface LiveLine {\n  readonly id: number;\n}\n",
  },
  {
    kind: 'swift',
    source:
      '/// Capture le son du système.\n///\n/// - Parameters:\n///   - source: la source retenue.\n/// - Returns: le flux ouvert.\n/// - Warning: le tap Core Audio se ferme si le périphérique change.\nfunc capture() {}\n',
  },
  {
    kind: 'ts',
    source: `/** L'en-tête. */\n\n/**\n * Un composant, dont l'exemple ne compte pas dans le plafond.\n *\n * @example\n * \`\`\`html\n${' * <app-x />\n'.repeat(12)} * \`\`\`\n */\nexport const A = 1;\n`,
  },
  {
    kind: 'sql',
    source:
      "-- Le répertoire de voix sort du produit.\n--\n-- Pièges\n--\n-- ⚠️ L'ordre compte : la table qui référence part avant la table référencée.\n\nDROP TABLE live_session_participants;\nDROP TABLE voices;\n",
  },
  {
    kind: 'html',
    source:
      '<!-- La liste des dictées, du plus récent au plus ancien. -->\n<div class="hist">\n  <!--\n    ⚠️ Le filtrage se fait à la source : masquer des lignes en CSS les laisserait dans l\'ordre\n    de tabulation et dans le compte annoncé.\n  -->\n  @for (entry of entries(); track entry.id) {\n    <p>{{ entry.text }}</p>\n  }\n</div>\n',
  },
  {
    kind: 'scss',
    source:
      '// Le panneau d’historique : une colonne, et rien de plus.\n\n// ⚠️ La hauteur descend du gabarit par `--hist-item-h` : l’écrire ici la ferait diverger.\n.hist {\n  height: var(--hist-total-h);\n}\n\n/* Le filet de séparation, en jeton et jamais en dur. */\n.hist-sep {\n  border-top: 1px solid var(--line);\n}\n',
  },
];

function selftest() {
  let failures = 0;
  for (const { rule, kind, source } of FIXTURES) {
    const hits = analyse(source, kind);
    if (!hits.some((h) => h.rule === rule)) {
      failures += 1;
      console.log(`✗ selftest — la règle « ${rule} » n'a pas vu son propre cas (${kind})`);
    }
  }
  for (const { kind, source } of CLEAN) {
    const hits = analyse(source, kind);
    if (hits.length > 0) {
      failures += 1;
      console.log(
        `✗ selftest — un fichier propre (${kind}) est refusé : ${hits.map((h) => h.rule).join(', ')}`,
      );
    }
  }
  if (failures > 0) {
    console.log(`\n${failures} contrôle(s) inutilisable(s).`);
    process.exit(1);
  }
  console.log(`selftest : ${FIXTURES.length} pièges vus, ${CLEAN.length} fichiers propres admis.`);
}

function main(targets) {
  const files = (targets.length > 0 ? targets : ROOTS).flatMap(collect);

  let total = 0;
  for (const file of files) {
    for (const hit of analyse(readFileSync(file, 'utf8'), kindOf(file))) {
      total += 1;
      console.log(`✗ ${file}:${hit.line} — ${hit.rule} : ${hit.detail}`);
    }
  }

  if (total > 0) {
    console.log(`\n${total} commentaire(s) hors convention.`);
    process.exit(1);
  }
  console.log(`commentaires : ${files.length} fichiers conformes.`);
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) selftest();
else main(args.filter((a) => !a.startsWith('--')));
