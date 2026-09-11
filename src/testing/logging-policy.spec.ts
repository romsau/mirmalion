import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La politique de journalisation du frontend, transformée en test.
 *
 * Le WebView n'a **aucun** journal : `tauri-plugin-log` vit côté Rust, avec ses niveaux et
 * ses règles (`src-tauri/src/logging.rs`). Un `console.log` oublié échappe à tout cela — il
 * survit en production, s'affiche dans les outils de développement de n'importe qui, et rien
 * n'empêche qu'il emporte un transcript au passage.
 *
 * Ce qu'un composant a à dire à l'utilisateur passe par la snackbar ; ce qu'il a à dire au
 * développeur passe par un test qui échoue.
 *
 * Le motif interdit est **assemblé à l'exécution** : écrit en toutes lettres, il ferait
 * échouer ce fichier sur lui-même.
 */

const SOURCE_ROOT = join(process.cwd(), 'src/app');
const EXTENSIONS = ['.ts', '.html'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

describe('politique de journalisation du frontend', () => {
  it('no source file logs to the console', () => {
    const forbidden = `${'con'}sole.`;
    const files = sourceFiles(SOURCE_ROOT);

    expect(files.length, 'aucune source trouvée — le test ne prouverait rien').toBeGreaterThan(0);

    const offenders = files.filter((path) => readFileSync(path, 'utf8').includes(forbidden));

    expect(
      offenders,
      'la journalisation vit côté Rust ; côté frontend, rien ne doit écrire dans la console',
    ).toEqual([]);
  });
});
