import { afterEach, describe, expect, it, vi } from 'vitest';
import axe, { type AxeResults } from 'axe-core';
import { expectNoAxeViolations, expectNoContrastViolations, waitForAnimations } from './axe';

/**
 * Le harnais d'accessibilité se teste lui-même.
 *
 * Un contrôle qu'on n'a jamais vu échouer ne prouve rien : si `axe.run` était mal configuré,
 * ou si la comparaison était inversée, tous les tests de composants passeraient au vert sans
 * rien vérifier. Ces deux cas sont la preuve permanente que le harnais mord.
 */

let mounted: HTMLElement | null = null;

/** AXE n'analyse que ce qui est réellement dans le document. */
function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  mounted = host;
  return host;
}

afterEach(() => {
  mounted?.remove();
  mounted = null;
});

describe('expectNoAxeViolations', () => {
  it('passes on accessible markup', async () => {
    const host = mount(`
      <main>
        <h1>Mirmalion</h1>
        <img src="logo.png" alt="Logo de Mirmalion" />
        <label for="nom">Nom</label>
        <input id="nom" type="text" />
        <button type="button">Enregistrer</button>
      </main>
    `);

    await expect(expectNoAxeViolations(host)).resolves.toBeUndefined();
  });

  it('fails on an image without a text alternative', async () => {
    const host = mount('<main><img src="logo.png" /></main>');

    await expect(expectNoAxeViolations(host)).rejects.toThrow(/image-alt/);
  });

  it('fails on a control with no accessible name', async () => {
    const host = mount('<main><button type="button"></button></main>');

    await expect(expectNoAxeViolations(host)).rejects.toThrow(/button-name/);
  });

  it('says what to fix and where, not merely that something is wrong', async () => {
    const host = mount('<main><input id="sans-etiquette" type="text" /></main>');

    const failure = await expectNoAxeViolations(host).catch((error: Error) => error.message);

    expect(failure).toContain('violation(s) AXE');
    // La règle, la cible dans le DOM, et un lien pour comprendre.
    expect(failure).toContain('sans-etiquette');
    expect(failure).toContain('https://');
  });
});

/**
 * Fait rendre à AXE le verdict voulu — `measured` étant le nombre de contrastes réellement
 * mesurés. Les surcharges de `axe.run` obligent au transtypage : c'est celle qui rend une
 * promesse qui nous intéresse.
 */
function verdict(violations: unknown[], measured: number): void {
  const results = {
    violations,
    passes: measured === 0 ? [] : [{ nodes: Array.from({ length: measured }, () => ({})) }],
  } as unknown as AxeResults;
  vi.spyOn(axe, 'run').mockImplementation((() => Promise.resolve(results)) as typeof axe.run);
}

describe('expectNoContrastViolations', () => {
  /**
   * ⚠️ **C'est l'échec attendu sous jsdom, et c'est le point du garde-fou.** Sans mesure, AXE ne
   * rend ni violation ni succès : une épreuve qui se contenterait de compter les violations
   * passerait au vert en n'ayant rien regardé.
   */
  it('fails when nothing could be measured', async () => {
    const host = mount('<main><p>Du texte sur un fond</p></main>');

    await expect(expectNoContrastViolations(host)).rejects.toThrow(/aucun contraste/);
  });

  /**
   * ⚠️ Le verdict est simulé : jsdom ne calcule aucune couleur, et c'est
   * `contrast.layout.spec.ts` qui éprouve la vraie mesure dans un navigateur. Ce qui se vérifie
   * ici est le compte rendu du harnais.
   */
  it('says which contrasts fall short, and where', async () => {
    verdict(
      [
        {
          id: 'color-contrast',
          impact: 'serious',
          help: 'Elements must meet minimum color contrast ratio thresholds',
          helpUrl: 'https://dequeuniversity.com/rules/axe/4.12/color-contrast',
          nodes: [{ target: ['.temoin'] }],
        },
      ],
      3,
    );
    const host = mount('<main><p>Du texte</p></main>');

    const failure = await expectNoContrastViolations(host).catch((error: Error) => error.message);

    expect(failure).toContain('contraste(s) insuffisant(s)');
    expect(failure).toContain('.temoin');
    vi.restoreAllMocks();
  });

  it('passes when axe measured contrasts and found none wanting', async () => {
    verdict([], 12);
    const host = mount('<main><p>Du texte</p></main>');

    await expect(expectNoContrastViolations(host)).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});

/**
 * ⚠️ jsdom n'a pas de `getAnimations` : c'est un faux élément qui prouve le contrat — on attend
 * bien la fin de chaque animation, et une animation interrompue ne fait pas échouer l'attente.
 */
describe('waitForAnimations', () => {
  it('attend chaque animation, et ne trébuche pas sur une interrompue', async () => {
    let fini = false;
    const element = {
      getAnimations: () => [
        {
          finished: Promise.resolve().then(() => {
            fini = true;
          }),
        },
        { finished: Promise.reject(new Error('interrompue')) },
      ],
    } as unknown as Element;

    await waitForAnimations(element);

    expect(fini).toBe(true);
  });
});
