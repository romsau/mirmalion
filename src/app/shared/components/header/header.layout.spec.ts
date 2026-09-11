import { describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Header, type ScreenId } from './header';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — elle tourne dans un VRAI navigateur. Voir `history-panel.layout.spec`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ **NE PAS DÉPLACER CES ASSERTIONS DANS `header.spec.ts`.** Elles y passeraient sur une barre
 * cassée : jsdom ne calcule aucune géométrie, toute largeur y vaut zéro.
 *
 * Le défaut gardé : les trois destinations gardent leur libellé en fenêtre repliée, et c'est ce
 * mode-là qui protégeait la barre du débordement — voir « Incompressibles » dans
 * `header.scss`. Ce qui reste : la destination courante n'ayant pas d'entrée vers elle-même, la
 * barre repliée ne porte jamais plus de deux libellés.
 *
 * ⚠️ **La barre ne déborde jamais, et c'est pourquoi `scrollWidth` sur l'hôte ne prouve rien** :
 * quand la place manque, c'est le groupe de GAUCHE qui s'écrase — mesuré à 300 px, `.tb-left`
 * tombe de 79 px à 23 px, la réserve des pastilles de macOS et le logo passant l'un sous l'autre.
 * L'invariant est donc « rien n'est comprimé sous son contenu », posé sur les deux groupes.
 *
 * ⚠️ **Aucun pixel affirmé** : la marge mesurée dans les 450 px est de 110 à 122 px selon l'écran,
 * de quoi absorber les traductions plus longues que le français. Elle est notée ici, pas affirmée
 * — un seuil se périmerait au premier ajustement de dessin.
 */
@Component({
  imports: [Header],
  // ⚠️ La largeur de la fenêtre repliée, et les jetons dont la barre a besoin : les styles
  // globaux n'atteignent pas ce banc. La police est celle du système, comme dans l'application —
  // c'est elle qui décide de la largeur d'un libellé.
  styles: `
    .fenetre {
      width: 450px;
      font-family: -apple-system, blinkmacsystemfont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 13px;

      --btn-h: 32px;
      --header-pad-x: 16px;
    }
  `,
  template: `
    <div class="fenetre">
      <app-header [current]="current()" [compact]="true" />
    </div>
  `,
})
class Host {
  readonly current = signal<ScreenId>('dictee');
}

/** Les deux écrans qui se replient — `WindowShell.compact`. Options n'en est pas. */
const FOLDED: readonly ScreenId[] = ['dictee', 'direct'];

describe('Header — mise en page réelle', () => {
  it('tient dans la fenêtre repliée sur chaque écran qui s’y replie', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);

    /** Cet élément est-il rendu à la taille de son contenu, plutôt qu'écrasé sous lui ? */
    const entier = (element: HTMLElement) => {
      // Une boîte vraiment dessinée : sans cela l'invariant serait vrai sur du vide.
      expect(element.clientWidth).toBeGreaterThan(0);
      // Le pixel de tolérance couvre l'arrondi d'un rendu sous-pixel, jamais un contenu coupé.
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    };

    for (const screen of FOLDED) {
      fixture.componentInstance.current.set(screen);
      await fixture.whenStable();
      fixture.detectChanges();

      // La marque et la réserve des pastilles de macOS : le premier groupe à céder.
      entier(root.querySelector<HTMLElement>('.tb-left')!);

      // ⚠️ Le défaut nommé par `header.scss` : un enfant flex se rétracte sous son contenu, et
      // l'icône comme le libellé débordent du fond du bouton. Se voit ici, jamais dans jsdom.
      const nav = root.querySelector<HTMLElement>('nav')!;
      entier(nav);
      const buttons = [...nav.querySelectorAll<HTMLElement>('.button')];
      expect(buttons.length).toBe(2);
      buttons.forEach(entier);
    }

    root.remove();
  });
});
