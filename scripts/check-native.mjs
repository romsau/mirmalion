#!/usr/bin/env node
/**
 * Garde les interdits du paquet Swift — ceux dont la violation ne casse **rien** et se voit
 * seulement chez l'utilisateur.
 *
 * **Aucune requête réseau** (l'application est hors-ligne, et FluidAudio télécharge ses modèles
 * par défaut) ; **le tap clavier ne voit que les modificateurs** (élargir son masque ferait de
 * Mirmalion un enregistreur de frappe) ; **le tap reste en queue de chaîne** (en tête, il décale
 * les modificateurs pour toute la machine) ; **le presse-papiers ne se lit pas hors de son
 * module** (l'emprunt est sérialisé par un verrou).
 *
 * @remarks
 * ⚠️ Une recherche textuelle attrape la récidive distraite, pas l'intention : on ferme la porte
 * qu'on a déjà vue s'ouvrir toute seule.
 * ⚠️ Aucune suite ne couvre ce script : lancer `--selftest` avant de croire un vert.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = 'src-tauri/native/Sources/MirmalionNative';
const MANIFEST = 'src-tauri/native/Package.swift';

/**
 * Les motifs refusés, et **pourquoi** — le message est ce que lira celui qui les déclenche, et
 * une règle sans sa raison se contourne au lieu de se comprendre.
 *
 * `only` restreint la règle aux fichiers nommés : le presse-papiers se lit légitimement dans son
 * propre module, et nulle part ailleurs.
 */
const FORBIDDEN = [
  {
    pattern: /\bURLSession\b|\bURLRequest\b|https?:\/\//,
    why: "aucune requête réseau dans le paquet natif : « rien ne sort de la machine » est l'argument produit, pas un détail. Le réseau ne part que d'un geste explicite, et il part de Rust.",
  },
  {
    pattern: /\bdownloadIfNeeded\b/,
    why: 'FluidAudio télécharge ses modèles depuis HuggingFace au premier usage, en silence. On passe exclusivement par `load(localSegmentationModel:localEmbeddingModel:)` — voir Diarization.swift.',
  },
  {
    pattern: /DiarizerModels\s*\.\s*load\s*\(\s*\)/,
    why: '`DiarizerModels.load()` sans paramètres ouvre le réseau. Charger depuis les modèles embarqués — voir `modelLocations()`.',
  },
  {
    pattern: /\.headInsertEventTap\b/,
    why: 'en tête de chaîne, le tap fait transiter chaque changement de modificateur de la session par notre processus : le ⌘V casse dans les applications tierces du seul fait que Mirmalion tourne. `.tailAppendEventTap`, toujours.',
  },
  {
    pattern: /CGEventMask\(1\s*<<\s*CGEventType\.(?!flagsChanged\b)\w+/,
    why: 'le tap clavier ne voit que `flagsChanged`. Élargir son masque ferait entrer les touches de caractère dans le processus — ce qui ressemblerait à un enregistreur de frappe, dans une application qui promet le contraire.',
  },
  {
    pattern: /NSPasteboard\s*\.\s*general/,
    only: ['Pasteboard.swift'],
    why: "le presse-papiers ne s'atteint que par `borrowingPasteboard`, qui sérialise l'emprunt. Deux emprunts entrelacés remplacent définitivement ce que l'utilisateur avait copié — et NSPasteboard n'étant pas thread-safe, ils font tomber le processus.",
  },
];

/**
 * Ce que le manifeste doit **porter**, par opposition à ce que les sources ne doivent pas.
 *
 * ⚠️ Un durcissement du compilateur se retire en une ligne, sans que rien ne casse : les
 * avertissements redeviennent muets, et les prochains dorment à leur tour. C'est le seul endroit
 * d'où ce retrait se voit.
 */
const REQUIRED_PER_TARGET = [
  {
    target: 'MirmalionNative',
    pattern: /treatAllWarnings\(as:\s*\.error\)/,
    why: 'la cible `MirmalionNative` doit traiter ses avertissements en erreurs — le pendant du `-D warnings` de clippy. Les dix avertissements dormants qui existaient avant lui ont été traités un à un ; sans le drapeau, les suivants dormiront aussi.',
  },
  {
    target: 'MirmalionNativeTests',
    pattern: /treatAllWarnings\(as:\s*\.error\)/,
    why: "la cible de test aussi : un durcissement qui ne vaudrait que pour les sources laisserait les épreuves diverger de ce qu'elles éprouvent.",
  },
];

// ---------------------------------------------------------------------------------------------

function say(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Retire ce qui n'est pas du code : les motifs interdits sont **cités** dans les commentaires qui
 * les expliquent, et une règle qui se déclencherait sur sa propre justification serait ingérable.
 *
 * ⚠️ Grossier à dessein : on efface les lignes de commentaire entières plutôt que d'analyser le
 * Swift. Un motif interdit posé sur la même ligne qu'un `//` qui le suit passerait — cas qu'on
 * accepte, parce que l'alternative est un analyseur syntaxique pour quatre expressions.
 */
export function withoutComments(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n');
}

/** Les infractions d'un fichier, ligne par ligne. */
export function violations(name, source, rules = FORBIDDEN) {
  const lines = withoutComments(source).split('\n');
  const found = [];
  for (const rule of rules) {
    if (rule.only?.includes(name)) {
      continue;
    }
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        found.push({ name, line: index + 1, text: line.trim(), why: rule.why });
      }
    });
  }
  return found;
}

/**
 * Le bloc d'une cible du manifeste, borné à la déclaration de cible suivante.
 *
 * ⚠️ Deux bornes, et chacune a déjà manqué : sans découper sur `.target(` / `.testTarget(`, la
 * recherche part du `name:` de la **bibliothèque** déclarée en `products` ; et sans arrêter au
 * bloc suivant, un contrôle « la cible X porte Y » se satisfait du Y d'une autre cible.
 */
export function targetBlock(manifest, target) {
  return (
    manifest
      .split(/\.(?:test)?[Tt]arget\(/)
      .slice(1)
      .find((block) => new RegExp(`name:\\s*"${target}"`).test(block)) ?? null
  );
}

/** Ce qui manque au manifeste, avec de quoi le nommer. */
export function missing(manifest, rules = REQUIRED_PER_TARGET) {
  return rules.filter((rule) => {
    const block = targetBlock(manifest, rule.target);
    return block === null || !rule.pattern.test(block);
  });
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

  expect(
    'un commentaire qui cite un interdit ne le déclenche pas',
    violations('X.swift', '// on n’emploie jamais URLSession ici\nlet a = 1').length === 0,
  );
  expect(
    'un commentaire de fin de ligne est retiré lui aussi',
    violations('X.swift', 'let a = 1  // jamais de .headInsertEventTap').length === 0,
  );
  expect(
    'une vraie requête réseau est refusée',
    violations('X.swift', 'let s = URLSession.shared').length === 1,
  );
  expect(
    'une URL littérale est refusée',
    violations('X.swift', 'let u = "https://exemple.test/modele"').length === 1,
  );
  expect(
    'le tap en tête de chaîne est refusé',
    violations('X.swift', 'place: .headInsertEventTap,').length === 1,
  );
  expect(
    'le tap en queue de chaîne passe',
    violations('X.swift', 'place: .tailAppendEventTap,').length === 0,
  );
  expect(
    'un masque sur flagsChanged passe',
    violations('X.swift', 'let m = CGEventMask(1 << CGEventType.flagsChanged.rawValue)').length ===
      0,
  );
  expect(
    'un masque élargi aux frappes est refusé',
    violations('X.swift', 'let m = CGEventMask(1 << CGEventType.keyDown.rawValue)').length === 1,
  );
  expect(
    'le chargement sans paramètres de FluidAudio est refusé',
    violations('X.swift', 'let m = try await DiarizerModels.load()').length === 1,
  );
  expect(
    'le chargement local de FluidAudio passe',
    violations('X.swift', 'try await DiarizerModels.load(localSegmentationModel: a)').length === 0,
  );
  expect(
    'le presse-papiers général est refusé hors de son module',
    violations('TextInjection.swift', 'let p = NSPasteboard.general').length === 1,
  );
  expect(
    'le presse-papiers général passe dans son propre module',
    violations('Pasteboard.swift', 'let p = NSPasteboard.general').length === 0,
  );

  const hardened = `.target(
      name: "MirmalionNative",
      swiftSettings: [.treatAllWarnings(as: .error)]
    ),
    .testTarget(
      name: "MirmalionNativeTests",
      swiftSettings: [.treatAllWarnings(as: .error)]
    )`;
  const mainUnhardened = `.target(
      name: "MirmalionNative"
    ),
    .testTarget(
      name: "MirmalionNativeTests",
      swiftSettings: [.treatAllWarnings(as: .error)]
    )`;
  expect('un manifeste durci ne remonte rien', missing(hardened).length === 0);
  // ⚠️ Le contrôle qui prouve la borne : sans elle, le drapeau de la cible de test suffit à
  // faire passer la cible principale qui n'en a plus.
  expect(
    'le drapeau retiré de la cible principale remonte, malgré celui de la cible de test',
    missing(mainUnhardened).length === 1,
  );
  expect('un manifeste sans le drapeau remonte les deux cibles', missing('').length === 2);
  expect('une cible absente du manifeste remonte', targetBlock('', 'MirmalionNative') === null);

  if (failures.length > 0) {
    say(`✗ autotest : ${failures.length} contrôle(s) en échec sur ${checked}`);
    failures.forEach((what) => say(`  · ${what}`));
    process.exit(1);
  }
  say(`✓ autotest : ${checked} contrôles`);
}

function main() {
  const files = readdirSync(SOURCES).filter((name) => name.endsWith('.swift'));
  const found = files.flatMap((name) =>
    violations(name, readFileSync(join(SOURCES, name), 'utf8')),
  );

  if (found.length > 0) {
    say(`✗ ${found.length} interdit(s) du paquet natif`);
    for (const hit of found) {
      say(`\n  ${hit.name}:${hit.line}`);
      say(`    ${hit.text}`);
      say(`    ⚠️ ${hit.why}`);
    }
    process.exit(1);
  }
  const absent = missing(readFileSync(MANIFEST, 'utf8'));
  if (absent.length > 0) {
    say(`✗ ${absent.length} durcissement(s) absent(s) de ${MANIFEST}`);
    absent.forEach((rule) => say(`    ⚠️ ${rule.why}`));
    process.exit(1);
  }

  say(`✓ ${files.length} fichiers Swift, aucun interdit ; manifeste durci`);
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main();
}
