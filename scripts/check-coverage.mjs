#!/usr/bin/env node
/**
 * Tient deux planchers de couverture sur le crate Rust, et **pas un seul**.
 *
 * Le backend a deux populations que rien ne rapproche. Le domaine s'éprouve entièrement hors
 * application, et il est à 90 %. La couche `commands/` demande un `AppHandle` que Tauri ne laisse
 * pas construire hors d'une application vivante, et elle plafonne à 45 % pour cette seule raison.
 *
 * @remarks
 * ⚠️ Un plancher unique serait décoratif : posé à la moyenne, il laisserait cinq cents lignes non
 * couvertes entrer dans le domaine sans que rien ne bouge. Chaque population porte le sien.
 * ⚠️ Les chiffres viennent d'une mesure, pas d'un objectif. Les relever demande de mesurer
 * d'abord — un plancher qu'on n'atteint pas fait échouer la vérification de tout le monde.
 * ⚠️ Aucune suite ne couvre ce script : lancer `--selftest` avant de croire un vert.
 * ⚠️ La mesure demande `cargo-llvm-cov`, absent d'une machine neuve :
 * `rustup component add llvm-tools-preview && cargo install cargo-llvm-cov --locked`.
 */

import { readFileSync } from 'node:fs';

/**
 * Les planchers, par population, en pourcentage de lignes.
 *
 * Mesure au moment où ils sont posés : domaine 90,5 %, commandes 45,6 %, ensemble 76,3 %.
 * L'écart au plancher est la marge qu'on se donne, pas une réserve à consommer.
 */
const FLOORS = { domain: 90, commands: 45, total: 76 };

/**
 * De quelle population relève un fichier.
 *
 * `lib.rs` et `main.rs` rejoignent les commandes : ils assemblent l'application, et s'éprouvent
 * aussi mal qu'elles.
 */
export function layerOf(filename) {
  const relative = filename.split('src-tauri/').pop();
  return relative.startsWith('src/commands/') || /^src\/(lib|main)\.rs$/.test(relative)
    ? 'commands'
    : 'domain';
}

/** Les lignes couvertes et totales, par population et pour l'ensemble. */
export function aggregate(files) {
  const totals = {
    domain: { covered: 0, count: 0 },
    commands: { covered: 0, count: 0 },
    total: { covered: 0, count: 0 },
  };
  for (const file of files) {
    const lines = file.summary.lines;
    const layer = totals[layerOf(file.filename)];
    layer.covered += lines.covered;
    layer.count += lines.count;
    totals.total.covered += lines.covered;
    totals.total.count += lines.count;
  }
  return totals;
}

/** Le pourcentage d'une population ; `100` quand elle est vide, faute de quoi diviser par zéro. */
export function percent({ covered, count }) {
  return count === 0 ? 100 : (100 * covered) / count;
}

/** Les populations sous leur plancher, avec de quoi les nommer. */
export function shortfalls(totals, floors = FLOORS) {
  return Object.entries(floors)
    .map(([name, floor]) => ({ name, floor, reached: percent(totals[name]) }))
    .filter((entry) => entry.reached < entry.floor);
}

// ---------------------------------------------------------------------------------------------

function say(line) {
  process.stdout.write(`${line}\n`);
}

const LABELS = {
  domain: 'domaine',
  commands: 'commandes + assemblage',
  total: 'ensemble',
};

function selftest() {
  const failures = [];
  let checked = 0;
  const expect = (what, condition) => {
    checked += 1;
    if (!condition) {
      failures.push(what);
    }
  };

  expect(
    'un fichier de commandes est reconnu',
    layerOf('/x/src-tauri/src/commands/live/capture.rs') === 'commands',
  );
  expect(
    "l'assemblage compte avec les commandes",
    layerOf('/x/src-tauri/src/lib.rs') === 'commands',
  );
  expect(
    'un module de domaine est reconnu',
    layerOf('/x/src-tauri/src/live/finalise.rs') === 'domain',
  );
  expect(
    'un chemin sans le préfixe du crate se classe quand même',
    layerOf('src/db/mod.rs') === 'domain',
  );

  const files = [
    { filename: 'src/live/a.rs', summary: { lines: { covered: 90, count: 100 } } },
    { filename: 'src/commands/b.rs', summary: { lines: { covered: 10, count: 100 } } },
  ];
  const totals = aggregate(files);
  expect('le domaine est agrégé seul', percent(totals.domain) === 90);
  expect('les commandes sont agrégées seules', percent(totals.commands) === 10);
  expect("l'ensemble additionne les deux", percent(totals.total) === 50);

  expect('une population vide ne divise pas par zéro', percent({ covered: 0, count: 0 }) === 100);
  expect(
    'un plancher franchi ne remonte rien',
    shortfalls(totals, { domain: 90, commands: 10, total: 50 }).length === 0,
  );
  expect(
    'un plancher manqué remonte, et se nomme',
    shortfalls(totals, { domain: 91 })[0]?.name === 'domain',
  );
  expect(
    "un plancher manqué d'un cheveu remonte aussi",
    shortfalls({ domain: { covered: 8999, count: 10000 } }, { domain: 90 }).length === 1,
  );

  if (failures.length > 0) {
    say(`✗ autotest : ${failures.length} contrôle(s) en échec sur ${checked}`);
    failures.forEach((what) => say(`  · ${what}`));
    process.exit(1);
  }
  say(`✓ autotest : ${checked} contrôles`);
}

function main() {
  const path = process.argv[2];
  if (!path) {
    say('✗ usage : check-coverage.mjs <rapport json de cargo llvm-cov>');
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const files = report.data?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    say('✗ le rapport ne contient aucun fichier — la mesure a-t-elle tourné ?');
    process.exit(1);
  }

  const totals = aggregate(files);
  for (const name of ['domain', 'commands', 'total']) {
    const reached = percent(totals[name]);
    const mark = reached < FLOORS[name] ? '✗' : '·';
    say(
      `  ${mark} ${LABELS[name].padEnd(24)} ${reached.toFixed(1)} % ` +
        `(plancher ${FLOORS[name]} %, ${totals[name].covered}/${totals[name].count} lignes)`,
    );
  }

  const missed = shortfalls(totals);
  if (missed.length > 0) {
    say(`\n✗ ${missed.length} population(s) sous leur plancher de couverture`);
    process.exit(1);
  }
  say(`\n✓ couverture : ${files.length} fichiers Rust, trois planchers tenus`);
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main();
}
