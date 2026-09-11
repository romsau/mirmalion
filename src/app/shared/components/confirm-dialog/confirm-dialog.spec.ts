import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ConfirmDialog, type ConfirmChoice, type ConfirmData } from './confirm-dialog';
import { MODAL_DATA, ModalRef } from '../../../core/services/modal/modal-ref';
import { expectNoAxeViolations } from '../../../../testing/axe';

const DATA: ConfirmData = {
  heading: 'Supprimer la dictée ?',
  message: 'Cette dictée sera définitivement retirée de l’historique.',
  confirmLabel: 'Supprimer',
  cancelLabel: 'Annuler',
};

function render(data: Partial<ConfirmData> = {}) {
  const closes: (ConfirmChoice | undefined)[] = [];
  const ref = new ModalRef<ConfirmChoice>(() => undefined);
  const original = ref.close.bind(ref);
  ref.close = (result?: ConfirmChoice) => {
    closes.push(result);
    original(result);
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MODAL_DATA, useValue: { ...DATA, ...data } },
      { provide: ModalRef, useValue: ref },
    ],
  });
  const fixture = TestBed.createComponent(ConfirmDialog);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const buttons = () => [...element.querySelectorAll<HTMLButtonElement>('button')];
  return { fixture, element, closes, buttons };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('ConfirmDialog', () => {
  it('shows nothing it was not given — every text comes from the caller', () => {
    const { element, buttons } = render();

    expect(element.querySelector('.message')?.textContent).toBe(DATA.message);
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['Annuler', 'Supprimer']);
  });

  it('names the button that was pressed, and nothing else', () => {
    const confirmed = render();
    confirmed.buttons()[1]?.click();
    expect(confirmed.closes).toEqual(['confirm']);

    const cancelled = render();
    cancelled.buttons()[0]?.click();
    expect(cancelled.closes).toEqual(['cancel']);
  });

  it('offers exactly two ways out, and no more', () => {
    // ⚠️ Une **troisième** issue a vécu ici jusqu'au 2026-08-03 — « Fermer sans exporter »,
    // pour la modale de fermeture d'une fenêtre-document, elle-même retirée ce jour-là. Elle
    // n'avait plus d'appelant : voir `ConfirmChoice`. Ce test garde la boîte à deux boutons.
    expect(render().buttons()).toHaveLength(2);
  });

  it('puts the cancel button first — DOM order is what decides the initial focus', () => {
    // L'action la moins destructive est ciblée à l'ouverture : une confirmation dont le bouton
    // dangereux a déjà le focus s'exécute sur une frappe d'Entrée distraite. Le piège de focus
    // vise le premier élément tabulable, donc l'ordre du DOM suffit — et il porte aussi
    // l'ordre de tabulation, qui doit être le même.
    const { element } = render();

    expect(element.querySelector('app-button')?.textContent?.trim()).toBe('Annuler');
  });

  it('never paints its buttons in an alert colour, however destructive the action', () => {
    // ⚠️ Ce test garde une porte qui a déjà été forcée deux fois : le bouton de confirmation a
    // été rouge (2026-07-30 au matin), puis orange (le jour même), avant d'être bleu
    // (2026-07-31). Ce qui protège d'un geste destructeur est CETTE BOÎTE — poser la question
    // et exiger un second clic —, pas la teinte du bouton qu'elle porte.
    const [cancel, confirm] = render().element.querySelectorAll('app-button');

    expect(confirm?.className).toContain('variant-accent');
    expect(cancel?.className).toContain('variant-neutral');
  });

  it('has no accessibility violation', async () => {
    await expectNoAxeViolations(render().element);
  });
});
