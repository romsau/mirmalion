import { afterEach, describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UpdateModal, type UpdateModalData, type UpdateState } from './update-modal';
import { MODAL_DATA } from '../../../core/services/modal/modal-ref';
import { expectNoContrastViolations } from '../../../../testing/axe';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — dans un VRAI navigateur. Voir `history-panel.layout.spec.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce qui se garde ici : l'empilement vertical qui remplace la rangée de l'ancienne barre, le
 * centrage, et le fait que ce composant ne peigne NI carte NI ombre — la boîte appartient au
 * service `Modal`, et deux cartes l'une dans l'autre se voient immédiatement.
 *
 * ⚠️ **Ces assertions ne peuvent pas vivre dans `update-modal.spec.ts`** : jsdom ne calcule
 * aucune mise en page, tout y mesure zéro, et un empilement qui ne se produit pas y passerait
 * vert.
 */
const état = signal<UpdateState>('ready');

const DONNÉES: UpdateModalData = {
  state: état,
  version: signal('1.1.0'),
  percent: signal(0.45),
  action: () => undefined,
};

@Component({
  imports: [UpdateModal],
  // La boîte de la modale, réduite à ce qui contraint le contenu : la largeur demandée à
  // l'ouverture, la marge intérieure du corps générique, et la surface qu'AXE remonte pour
  // mesurer un contraste.
  //
  // ⚠️ 460 px, comme `UPDATE_MODAL_WIDTH` dans `window-shell.ts`. Une largeur qui dériverait de
  // celle du produit ferait mesurer le repli d'une phrase dans une boîte qui n'existe pas.
  styles: `
    .boite {
      width: 460px;
      padding: 20px 24px 30px;
      background: var(--surface);
    }
  `,
  template: `
    <div class="boite">
      <app-update-modal />
    </div>
  `,
})
class Host {}

/**
 * Monte l'hôte dans le document — sans cela, rien n'a de géométrie.
 *
 * ⚠️ Le thème se pose sur la racine du document, pas sur l'hôte : les jetons vivent sous
 * `:root[data-theme='…']`, et un attribut posé plus bas ne les atteindrait pas.
 */
async function monter(state: UpdateState, theme: 'light' | 'dark' = 'light') {
  document.documentElement.setAttribute('data-theme', theme);
  état.set(state);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: MODAL_DATA, useValue: DONNÉES }] });
  const fixture = TestBed.createComponent(Host);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  await fixture.whenStable();
  fixture.detectChanges();

  const boite = root.querySelector<HTMLElement>('.boite')!;
  const contenu = root.querySelector<HTMLElement>('app-update-modal')!;
  const rect = (sélecteur: string) => root.querySelector(sélecteur)?.getBoundingClientRect();

  return {
    root,
    contenu,
    boite: boite.getBoundingClientRect(),
    icone: rect('.up-ico'),
    message: root.querySelector<HTMLElement>('.up-msg')!,
    barre: rect('.up-prog'),
    actions: rect('.up-actions')!,
  };
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('UpdateModal — mise en page réelle', () => {
  // ⚠️ Trois étages, pas quatre : la phrase, la barre, les boutons. C'est ce qu'un oubli de
  // `:host { display: grid }` casserait sans bruit.
  it('empile son contenu de haut en bas', async () => {
    const { root, message, barre, actions } = await monter('downloading');
    const phrase = message.getBoundingClientRect();

    expect(phrase.bottom).toBeLessThanOrEqual(barre!.top);
    expect(barre!.bottom).toBeLessThanOrEqual(actions.top);

    root.remove();
  });

  /**
   * ⚠️ **L'icône OUVRE la phrase, elle ne la surplombe pas.** Posée au-dessus, elle faisait un
   * étage de plus dans une boîte qui n'en veut que trois — relevé à l'écran, capture à l'appui.
   * Ce test tient les deux moitiés de la règle : même ligne, et à gauche du texte.
   */
  it('pose l’icône au début de la phrase, pas au-dessus', async () => {
    const { root, icone, message } = await monter('downloading');
    const phrase = message.getBoundingClientRect();

    expect(icone!.right).toBeLessThanOrEqual(phrase.left);
    const ecart = Math.abs((icone!.top + icone!.bottom) / 2 - (phrase.top + phrase.bottom) / 2);
    expect(ecart).toBeLessThan(2);

    root.remove();
  });

  it('centre son message et ses boutons dans la boîte', async () => {
    const { root, boite, message, actions } = await monter('ready');
    const phrase = message.getBoundingClientRect();
    const centre = (boite.left + boite.right) / 2;

    expect(Math.abs((phrase.left + phrase.right) / 2 - centre)).toBeLessThan(2);
    expect(Math.abs((actions.left + actions.right) / 2 - centre)).toBeLessThan(2);

    root.remove();
  });

  // ⚠️ La barre n'a plus à se glisser entre un message et des boutons : elle a sa ligne, donc
  // toute la largeur. Une base prise sur le contenu la réduirait à un trait.
  it('donne à la barre de progression toute la largeur du contenu', async () => {
    const { root, contenu, barre } = await monter('downloading');

    expect(barre!.width).toBeCloseTo(contenu.getBoundingClientRect().width, 0);

    root.remove();
  });

  // ⚠️ Le défaut visé : une carte dans une carte. La boîte, son fond et son ombre appartiennent
  // à `ModalContainer` ; si ce composant en repeignait, le liseré doublé se verrait sur le bord.
  it('ne peint ni carte ni ombre — la modale les porte déjà', async () => {
    const { root, contenu } = await monter('ready');
    const style = getComputedStyle(contenu);

    expect(style.boxShadow).toBe('none');
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');

    root.remove();
  });

  // ⚠️ La phrase la plus longue de l'application tient dans la boîte parce qu'elle se replie, et
  // non parce qu'elle est courte : un `white-space: nowrap` hérité la ferait déborder du cadre
  // sans rien couper, et le texte sortirait de la modale.
  it('ne déborde jamais de la largeur de la boîte', async () => {
    for (const state of ['available', 'downloading', 'ready'] as const) {
      const { root, contenu } = await monter(state);

      expect(contenu.scrollWidth).toBeLessThanOrEqual(contenu.clientWidth);

      root.remove();
    }
  });

  // ⚠️ C'est le filet qui garde le piège de l'encre. Une propriété invalide — un `var(--jeton)`
  // qui n'existe pas — est ignorée en silence : le message resterait pâle sur la surface de la
  // modale, sans erreur et sans test rouge. Seul un contraste mesuré sur le rendu le voit.
  it('reste lisible dans les deux thèmes, dans les trois états', async () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const state of ['available', 'downloading', 'ready'] as const) {
        const { root } = await monter(state, theme);

        await expectNoContrastViolations(root);

        root.remove();
      }
    }
  });
});
