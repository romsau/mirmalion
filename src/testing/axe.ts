import axe, { type AxeResults, type Result } from 'axe-core';

/**
 * Le harnais d'accessibilité partagé par tous les tests de composants, exigeant zéro
 * violation AXE en WCAG 2.2 AA.
 *
 * @remarks
 * ⚠️ `axe-core` tourne ici dans jsdom, qui ne calcule aucune mise en page : contrastes,
 * focus visible, ordre de tabulation, cibles tactiles et débordements lui échappent. Ce
 * harnais attrape la structure — rôles, noms accessibles, étiquettes, hiérarchie de titres,
 * ARIA invalide —, pas le rendu. Voir `*.layout.spec.ts` pour ce qui demande un vrai
 * navigateur.
 */

/** Les tags AXE correspondant à WCAG 2.2 niveau AA, plus les bonnes pratiques. */
const WCAG_22_AA = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
] as const;

/**
 * Analyse un élément et échoue si AXE relève la moindre violation.
 *
 * @param element typiquement `fixture.nativeElement` — il doit être attaché au document,
 *   sinon AXE n'a rien à analyser.
 */
export async function expectNoAxeViolations(element: Element): Promise<void> {
  const results: AxeResults = await axe.run(element, {
    runOnly: { type: 'tag', values: [...WCAG_22_AA] },
    rules: {
      // Indécidable sans mise en page : jsdom ne calcule aucune couleur. Vérifié à l'œil
      // en phase 6, pas ici — mieux vaut une lacune connue qu'un faux négatif rassurant.
      'color-contrast': { enabled: false },
    },
  });

  if (results.violations.length > 0) {
    throw new Error(
      `${results.violations.length} violation(s) AXE :\n${report(results.violations)}`,
    );
  }
}

/**
 * Analyse un élément **rendu** et échoue si un texte n'a pas le contraste exigé.
 *
 * @param element il doit être attaché au document et réellement peint.
 *
 * @remarks
 * - ⚠️ N'a de sens que dans un `*.layout.spec.ts` : dans jsdom aucune couleur n'est calculée, et
 *   AXE rendrait « indéterminé » sur chaque nœud sans rien affirmer.
 * - ⚠️ L'absence de mesure est un échec, au même titre qu'une violation : un élément invisible ou
 *   sans texte ferait passer l'épreuve en n'ayant rien regardé.
 */
export async function expectNoContrastViolations(element: Element): Promise<void> {
  const results: AxeResults = await axe.run(element, {
    runOnly: { type: 'rule', values: ['color-contrast'] },
  });

  if (results.violations.length > 0) {
    throw new Error(
      `${results.violations.length} contraste(s) insuffisant(s) :\n${report(results.violations)}`,
    );
  }

  const measured = results.passes.reduce((total, pass) => total + pass.nodes.length, 0);
  if (measured === 0) {
    throw new Error("AXE n'a mesuré aucun contraste : le rendu était-il bien peint ?");
  }
}

/**
 * Attend que les animations de `element` et de ses descendants soient **finies**.
 *
 * @remarks
 * - ⚠️ À poser avant toute mesure sur un élément qui entre en fondu — contraste, position,
 *   taille. Mesuré à mi-fondu, un texte encore translucide ne rend qu'un « indéterminé », et
 *   {@link expectNoContrastViolations} échoue sur « n'a mesuré aucun contraste ».
 * - ⚠️ Une vraie attente, jamais un délai : un `setTimeout` calé sur la durée annoncée est un
 *   pari, et il se perd sur une machine chargée, où l'animation démarre en retard.
 * - ⚠️ Elle n'a de sens que dans un `*.layout.spec.ts` : jsdom n'anime rien.
 */
export async function waitForAnimations(element: Element): Promise<void> {
  // Réglées et non résolues : une animation interrompue rejette sa promesse, et l'interruption
  // n'est pas une faute — l'élément a simplement pu être retiré entre-temps.
  await Promise.allSettled(
    element.getAnimations({ subtree: true }).map((animation) => animation.finished),
  );
}

/** Un message qui dit quoi corriger, et où — pas seulement qu'il y a un problème. */
function report(violations: readonly Result[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => `      ${node.target.join(' ')}`).join('\n');
      // `String(...)` plutôt qu'un repli `??` : AXE renseigne toujours `impact`, et une
      // branche qu'aucun test ne peut atteindre est une branche qu'on ne saurait pas relire.
      return `  • [${String(violation.impact)}] ${violation.id} — ${violation.help}\n${targets}\n      ${violation.helpUrl}`;
    })
    .join('\n');
}
