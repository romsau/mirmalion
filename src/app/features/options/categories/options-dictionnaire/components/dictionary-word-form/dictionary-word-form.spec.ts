import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  DictionaryWordForm,
  MAX_DICTIONARY_WORD_LENGTH,
  type DictionaryWordFormResult,
} from './dictionary-word-form';
import { ModalRef } from '../../../../../../core/services/modal/modal-ref';
import { expectNoAxeViolations } from '../../../../../../../testing/axe';

interface Harness {
  readonly fixture: ComponentFixture<DictionaryWordForm>;
  readonly element: HTMLElement;
  /** Ce que la modale a rendu, dans l'ordre. `undefined` y est une annulation. */
  readonly closes: readonly (DictionaryWordFormResult | undefined)[];
  readonly fields: () => HTMLInputElement[];
  readonly cancel: () => HTMLButtonElement;
  readonly submit: () => HTMLButtonElement;
  readonly type: (field: HTMLInputElement, text: string) => void;
}

function required<T>(node: T | null | undefined, what: string): T {
  if (node === null || node === undefined) {
    throw new Error(`${what} manque`);
  }
  return node;
}

async function render(): Promise<Harness> {
  const closes: (DictionaryWordFormResult | undefined)[] = [];
  // La poignée réelle, dont on n'intercepte que la fermeture : la promesse de `ModalRef` ne se
  // lit pas dans le même tour de boucle que le clic.
  const ref = new ModalRef<DictionaryWordFormResult>(() => {});
  vi.spyOn(ref, 'close').mockImplementation((result?: DictionaryWordFormResult) => {
    closes.push(result);
  });

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: ModalRef, useValue: ref }] });
  const fixture = TestBed.createComponent(DictionaryWordForm);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;

  const buttons = (): HTMLButtonElement[] => [
    ...element.querySelectorAll<HTMLButtonElement>('button'),
  ];

  return {
    fixture,
    element,
    closes,
    fields: () => [...element.querySelectorAll<HTMLInputElement>('.field-input')],
    cancel: () => required(buttons()[0], '« Annuler »'),
    submit: () => required(buttons()[1], '« Ajouter »'),
    type: (field, text) => {
      field.value = text;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    },
  };
}

describe('DictionaryWordForm', () => {
  it('demande les deux champs d’un coup, et s’ouvre vide', async () => {
    // ⚠️ Un mot sans son écriture fautive ne corrige rien : les deux sont demandés ensemble,
    // là où l'ajout se faisait en deux temps dont le second n'était que possible.
    const { fields } = await render();
    expect(fields()).toHaveLength(2);
    expect(fields().map((field) => field.value)).toEqual(['', '']);
  });

  it('nomme ses champs sans libellé visible', async () => {
    // ⚠️ Le texte d'attente DISPARAÎT à la première frappe : sans `aria-label`, un champ rempli
    // n'aurait plus aucun nom accessible, et AXE refuserait l'écran.
    const { fields } = await render();
    expect(fields()[0].getAttribute('aria-label')).toBe(fields()[0].getAttribute('placeholder'));
    expect(fields()[1].getAttribute('aria-label')).toBe(fields()[1].getAttribute('placeholder'));
  });

  it('montre un exemple que tout le monde connaît', async () => {
    // Un mot déjà vu, dont on sait ce que la dictée en fait : l'exemple explique le couple sans
    // une ligne de plus.
    const { fields } = await render();
    expect(fields()[0].getAttribute('placeholder')).toContain('WhatsApp');
    expect(fields()[1].getAttribute('placeholder')).toContain("what's up");
  });

  it('borne les deux champs sur ce que la base accepte', async () => {
    const { fields } = await render();
    for (const field of fields()) {
      expect(field.getAttribute('maxlength')).toBe(String(MAX_DICTIONARY_WORD_LENGTH));
    }
  });

  it('garde « Ajouter » éteint tant qu’un des deux champs manque', async () => {
    const harness = await render();
    expect(harness.submit().disabled).toBe(true);

    harness.type(harness.fields()[0], 'WhatsApp');
    expect(harness.submit().disabled).toBe(true);

    harness.type(harness.fields()[1], "what's up");
    expect(harness.submit().disabled).toBe(false);
  });

  it('ne prend pas des espaces pour une saisie', async () => {
    const harness = await render();
    harness.type(harness.fields()[0], '   ');
    harness.type(harness.fields()[1], "what's up");
    expect(harness.submit().disabled).toBe(true);
  });

  it('rend le couple saisi, taillé', async () => {
    const harness = await render();
    harness.type(harness.fields()[0], '  WhatsApp  ');
    harness.type(harness.fields()[1], "  what's up  ");
    harness.submit().click();

    expect(harness.closes).toEqual([{ term: 'WhatsApp', said: "what's up" }]);
  });

  it('ferme sans rien rendre sur « Annuler »', async () => {
    const harness = await render();
    harness.type(harness.fields()[0], 'WhatsApp');
    harness.cancel().click();
    // ⚠️ `undefined` veut dire annulé — ne pas le confondre avec un enregistrement vide.
    expect(harness.closes).toEqual([undefined]);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render()).element);
  });
});
