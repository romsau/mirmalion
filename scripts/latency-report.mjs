/**
 * Le rapport de latence de dictée : médiane et 90ᵉ centile du total puis de chaque tronçon.
 * Il lit les lignes `latence dictée | …` émises en développement, si bien que les mesures
 * s'accumulent à l'usage, sans campagne à mener.
 *
 * @remarks
 * ⚠️ Il ne rend **aucun verdict**. Il en a rendu un, faux par construction : il comparait le
 * « relâchement → insertion » à une cible portant sur le premier texte affiché après le début
 * de la parole. Un chiffre comparé à la mauvaise référence est pire qu'un chiffre sans
 * référence — il se cite.
 * ⚠️ Médiane et 90ᵉ centile, jamais la moyenne : une dictée où le modèle a peiné dix secondes
 * déplace une moyenne de vingt mesures d'une demi-seconde, et la médiane de rien.
 * ⚠️ Lancer `--selftest` : un instrument dont la justesse n'est pas prouvée ne prouve rien.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Le préfixe des lignes de mesure. **Contrat** avec `REPORT_PREFIX` côté Rust. */
const PREFIX = 'latence dictée';

/** Les tronçons, dans l'ordre du parcours. Mêmes clés que `Leg::key` côté Rust. */
const LEGS = [
  'moteur',
  'dictionnaire',
  'nettoyage',
  'reformulation',
  'traduction',
  'collage',
  'reste',
];

/**
 * Extrait une mesure d'une ligne de journal, ou `null` si ce n'en est pas une.
 *
 * ⚠️ **On repart du préfixe et non du début de ligne** : le journal préfixe chaque message de
 * son horodatage et de son niveau, et leur format ne nous appartient pas.
 */
export function parseLine(line) {
  const start = line.indexOf(PREFIX);
  if (start === -1) {
    return null;
  }
  const entry = { legs: {} };
  for (const token of line.slice(start + PREFIX.length).split(/\s+/)) {
    const [key, raw] = token.split('=');
    if (raw === undefined) {
      continue;
    }
    if (key === 'total' || LEGS.includes(key)) {
      const millis = Number(raw);
      // ⚠️ Une valeur illisible **invalide la ligne entière** plutôt que de valoir zéro : une
      // mesure à moitié lue est pire qu'une mesure absente, parce qu'elle entre dans les
      // statistiques sans se signaler.
      // ⚠️ **`raw === ''` EST TESTÉ À PART, ET CE N'EST PAS DE LA CEINTURE-BRETELLES** :
      // `Number('')` vaut **0**, et `Number.isFinite(0)` vaut **vrai**. Une ligne coupée à
      // `total=` serait donc entrée dans les statistiques comme une dictée à zéro milliseconde
      // — la médiane s'en trouvant tirée vers le bas, sans le moindre signe. Défaut réel,
      // attrapé par `--selftest`, avant la moindre dictée.
      if (raw === '' || !Number.isFinite(millis)) {
        return null;
      }
      if (key === 'total') {
        entry.total = millis;
      } else {
        entry.legs[key] = millis;
      }
    } else {
      entry[key] = raw;
    }
  }
  return entry.total === undefined ? null : entry;
}

/**
 * Le centile d'une série, par **interpolation linéaire** entre les deux rangs encadrants.
 *
 * ⚠️ **Pas d'arrondi de rang.** Sur vingt mesures, le 90ᵉ centile tombe entre la 18ᵉ et la
 * 19ᵉ valeur : arrondir choisirait l'une des deux, et le chiffre sauterait d'un coup selon
 * qu'on ajoute une mesure ou non. C'est la définition employée par `numpy` et par R.
 */
export function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * fraction;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** Le résumé d'une série : combien, médiane, 90ᵉ centile, et les deux extrêmes. */
export function summarise(values) {
  return {
    n: values.length,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

/** L'étiquette d'une configuration — c'est par elle que les dictées se regroupent. */
export function configuration(entry) {
  return `langue=${entry.langue} style=${entry.style} cible=${entry.cible}`;
}

function millis(value) {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

/**
 * Le tableau d'un groupe de mesures : le total d'abord, puis chaque tronçon **qui a
 * réellement eu lieu**.
 *
 * ⚠️ **Un tronçon absent de toutes les dictées du groupe ne s'affiche pas**, et un tronçon
 * présent dans certaines seulement n'est moyenné que sur celles-là. C'est l'invariant posé
 * côté Rust : une étape qui n'a pas eu lieu est absente, jamais notée zéro. L'afficher à
 * zéro laisserait croire que la reformulation est gratuite.
 */
function table(entries) {
  const lines = [];
  const totals = summarise(entries.map((entry) => entry.total));
  lines.push(
    `  total            n=${totals.n}  médiane ${millis(totals.median)}  p90 ${millis(totals.p90)}` +
      `  [${millis(totals.min)} … ${millis(totals.max)}]`,
  );
  for (const leg of LEGS) {
    const values = entries.filter((entry) => leg in entry.legs).map((entry) => entry.legs[leg]);
    if (values.length === 0) {
      continue;
    }
    const stats = summarise(values);
    lines.push(
      `  ${leg.padEnd(16)} n=${stats.n}  médiane ${millis(stats.median)}  p90 ${millis(stats.p90)}`,
    );
  }
  return lines.join('\n');
}

/** Le rapport complet, en texte. Rendu plutôt qu'imprimé, pour être éprouvable. */
export function render(entries) {
  if (entries.length === 0) {
    return (
      'Aucune mesure trouvée.\n' +
      `Le journal doit contenir des lignes « ${PREFIX} | … », émises en développement à\n` +
      "chaque dictée. Vérifier qu'on a bien capturé la sortie de `npm start`, et non celle\n" +
      "d'un build de production — `debug!` y est retiré à la compilation."
    );
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = configuration(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const sections = [`ENSEMBLE — ${entries.length} dictée(s)`, table(entries), ''];
  // ⚠️ Le protocole de demande de croiser deux langues, la reformulation et la
  // traduction : c'est le détail par configuration qui répond, pas le total.
  for (const key of [...groups.keys()].sort()) {
    sections.push(`${key} — ${groups.get(key).length} dictée(s)`, table(groups.get(key)), '');
  }

  sections.push(
    '⚠️ La mesure va du RELÂCHEMENT du raccourci au retour de l’insertion — pas de la dernière',
    "   syllabe, et pas jusqu'au repaint de l’application d’accueil, qui ne nous est pas",
    '   observable. Voir `src-tauri/src/dictation/timing.rs`.',
    '',
    "⚠️ AUCUN VERDICT N'EST RENDU ICI, ET C'EST VOULU (voir l'en-tête du fichier).",
  );
  return sections.join('\n');
}

/**
 * Le contrôle de l'instrument. **À lancer avant la campagne, pas après.**
 *
 * Les lignes d'entrée sont écrites ici à la main, dans le format exact que produit
 * `Timeline::report` — les tests Rust tiennent l'autre bout du contrat.
 */
function selftest() {
  const checks = [];
  const expect = (label, actual, wanted) => {
    checks.push({ label, ok: JSON.stringify(actual) === JSON.stringify(wanted), actual, wanted });
  };

  const line = `12:00:00 [DEBUG] ${PREFIX} | total=1500 moteur=900 nettoyage=400 collage=150 reste=50 | langue=fr style=aucun cible=aucune`;
  const parsed = parseLine(line);
  expect('le total est lu', parsed.total, 1500);
  expect('les tronçons sont lus', parsed.legs, {
    moteur: 900,
    nettoyage: 400,
    collage: 150,
    reste: 50,
  });
  expect('la configuration est lue', configuration(parsed), 'langue=fr style=aucun cible=aucune');
  expect("l'horodatage du journal n'empêche rien", parsed.langue, 'fr');

  expect('une ligne étrangère est ignorée', parseLine('12:00:00 [INFO] base prête'), null);
  expect(
    'une ligne tronquée est refusée en entier',
    parseLine(`${PREFIX} | total=  moteur=900`),
    null,
  );
  expect('une ligne sans total est refusée', parseLine(`${PREFIX} | moteur=900`), null);

  // ⚠️ Le cas qui vaut ce fichier : sur un nombre pair de mesures, la médiane est la MOYENNE
  // des deux valeurs centrales, pas l'une d'elles. Sur 4 valeurs, le p90 s'interpole.
  expect('médiane sur un nombre pair', percentile([10, 20, 30, 40], 0.5), 25);
  expect('médiane sur un nombre impair', percentile([10, 20, 30], 0.5), 20);
  expect('p90 interpolé', percentile([10, 20, 30, 40], 0.9), 37);
  expect('une série vide ne rend pas zéro', percentile([], 0.5), null);
  expect("l'ordre d'arrivée n'a aucun effet", percentile([40, 10, 30, 20], 0.5), 25);

  // Un tronçon absent d'une dictée ne doit pas y valoir zéro.
  const withoutRephrasing = parseLine(
    `${PREFIX} | total=1000 moteur=900 reste=100 | langue=fr style=aucun cible=aucune`,
  );
  const withRephrasing = parseLine(
    `${PREFIX} | total=3000 moteur=900 reformulation=2000 reste=100 | langue=fr style=concise cible=aucune`,
  );
  const rendered = render([withoutRephrasing, withRephrasing]);
  expect(
    'la reformulation est moyennée sur les seules dictées qui en ont une',
    /reformulation\s+n=1\s+médiane 2000 ms/.test(rendered),
    true,
  );
  expect(
    'les deux configurations sont séparées',
    rendered.includes('langue=fr style=aucun cible=aucune — 1 dictée(s)') &&
      rendered.includes('langue=fr style=concise cible=aucune — 1 dictée(s)'),
    true,
  );
  expect('un journal sans mesure le dit', render([]).startsWith('Aucune mesure trouvée.'), true);

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? '  ok  ' : '  ÉCHEC'} ${check.label}`);
    if (!check.ok) {
      console.log(`         attendu ${JSON.stringify(check.wanted)}`);
      console.log(`         obtenu  ${JSON.stringify(check.actual)}`);
    }
  }
  console.log(
    failed.length === 0
      ? `\n${checks.length} contrôles passés — les chiffres de cet outil sont dignes de foi.`
      : `\n${failed.length} contrôle(s) en échec sur ${checks.length}. NE PAS MESURER avec cet outil.`,
  );
  return failed.length === 0;
}

/**
 * Le journal de la variante de **développement**, où `tauri-plugin-log` l'écrit sur macOS.
 *
 * ⚠️ **L'identifiant du bundle DEV**, et pas celui de l'application finale : c'est `npm start`
 * qui produit ces mesures, et lui seul — un binaire de production n'émet rien, `debug!` y étant
 * retiré à la compilation.
 */
const DEV_LOG = join(homedir(), 'Library/Logs/com.mirmalion.desktop.dev/mirmalion.log');

const [, , argument] = process.argv;

if (argument === '--selftest') {
  process.exit(selftest() ? 0 : 1);
} else {
  const path = argument ?? DEV_LOG;
  if (!existsSync(path)) {
    console.error(
      `Journal introuvable : ${path}\n\n` +
        (argument
          ? ''
          : "Il n'apparaît qu'au premier lancement de `npm start` depuis le 2026-08-01.\n" +
            'Un autre fichier se passe en argument :  npm run latency <journal>\n'),
    );
    process.exit(2);
  }
  const entries = readFileSync(path, 'utf8').split('\n').map(parseLine).filter(Boolean);
  console.log(`Journal : ${path}\n`);
  console.log(render(entries));
}
