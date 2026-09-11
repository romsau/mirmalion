import { describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DirectDocument } from './direct-document';
import { reportTypeOptions } from '../../../../core/services/live/live';

/**
 * ÉPREUVE DE MISE EN PAGE — dans un VRAI navigateur. Voir `direct-recording.layout.spec.ts`.
 *
 * Le défaut gardé : la bascule de la tête et le sélecteur d'export sont les deux commandes de
 * droite, et la maquette les veut sur une seule verticale. C'est un `space-between` d'un côté et
 * un `flex: 1` de l'autre qui les y mettent — jsdom ne calcule rien, lui seul ne peut pas le voir.
 */
async function render(): Promise<ComponentFixture<DirectDocument>> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(DirectDocument);
  fixture.componentRef.setInput('title', 'Session produit hebdo');
  fixture.componentRef.setInput('meta', '20 juil. 2026 · Microsoft Teams');
  fixture.componentRef.setInput('sections', [
    { heading: 'Résumé', lines: ['Point hebdomadaire produit.'], bullets: false },
  ]);
  fixture.componentRef.setInput('lines', [{ text: 'On commence par la roadmap ?' }]);
  fixture.componentRef.setInput('kind', 'team');
  fixture.componentRef.setInput('kinds', reportTypeOptions([]));
  fixture.componentRef.setInput('transcriptTarget', 'none');
  fixture.componentRef.setInput('reportTarget', 'none');

  // ⚠️ **La vraie fenêtre, et non celle du navigateur d'épreuve.** Le panneau est en
  // `display: contents` : posé nu dans le `<body>`, il s'étalait sur 1 280 px et tout y tenait
  // sur une ligne — l'épreuve passait quelle que soit la feuille. 980 px est la largeur d'une
  // fenêtre-document (`DOCUMENT_WIDTH`), 40 le rembourrage du panneau.
  const frame = document.createElement('div');
  frame.style.cssText = 'width: 940px; display: flex; flex-direction: column;';
  frame.appendChild(fixture.nativeElement as HTMLElement);
  document.body.appendChild(frame);

  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

/** Retire le cadre d'épreuve du document. */
function clear(): void {
  document.body.replaceChildren();
}

describe('DirectDocument — mise en page réelle', () => {
  /**
   * ⚠️ **L'invariant compare deux mesures**, il n'attend pas une abscisse : les deux commandes
   * tombent sur le même bord quelle que soit la place que la fenêtre leur donne. Il ne se périme
   * donc pas le jour où la fenêtre change de taille.
   */
  it('aligne la bascule et « Exporter » sur le même bord droit', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;

    const toggle = root.querySelector<HTMLElement>('.tr-toggle');
    const exporter = root.querySelector<HTMLElement>('.export');
    expect(toggle).not.toBeNull();
    expect(exporter).not.toBeNull();

    const toggleBox = toggle!.getBoundingClientRect();
    const exportBox = exporter!.getBoundingClientRect();

    expect(exportBox.width).toBeGreaterThan(0);
    expect(Math.abs(exportBox.right - toggleBox.right)).toBeLessThan(1);

    clear();
  });

  /**
   * ⚠️ **Les deux sélecteurs restent sur UNE rangée**, à gauche de l'export : ce sont eux qui
   * disent ce que le document *est*, quand « Exporter » dit ce qu'on en *fait*. Le champ de
   * prompt les faisait passer à la ligne ; il n'y en a plus.
   */
  it('garde les deux sélecteurs sur la rangée, à gauche de « Exporter »', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;

    const kind = root.querySelector<HTMLElement>('.cr-kind')!.getBoundingClientRect();
    const translate = root.querySelector<HTMLElement>('.cr-translate')!.getBoundingClientRect();
    const exporter = root.querySelector<HTMLElement>('.export')!.getBoundingClientRect();

    expect(Math.abs(kind.top - translate.top)).toBeLessThan(1);
    expect(Math.abs(kind.top - exporter.top)).toBeLessThan(1);
    expect(translate.right).toBeLessThan(exporter.left);

    clear();
  });
});
