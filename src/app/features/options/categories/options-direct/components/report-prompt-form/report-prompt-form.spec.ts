import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  MAX_PROMPT_TITLE_LENGTH,
  ReportPromptForm,
  type ReportPromptFormData,
  type ReportPromptFormResult,
} from './report-prompt-form';
import { MODAL_DATA, ModalRef } from '../../../../../../core/services/modal/modal-ref';
import type { ReportPrompt } from '../../../../../../core/services/bridge/live/live.bridge';
import { expectNoAxeViolations } from '../../../../../../../testing/axe';

const CLIENT: ReportPrompt = { id: 3, title: 'Client', prompt: 'Décisions.' };

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Harness {
  readonly fixture: ComponentFixture<ReportPromptForm>;
  readonly element: HTMLElement;
  /** Ce que la modale a rendu, dans l'ordre. `undefined` y est une annulation. */
  readonly closes: readonly (ReportPromptFormResult | undefined)[];
  readonly title: () => HTMLInputElement;
  readonly prompt: () => HTMLTextAreaElement;
  readonly cancel: () => HTMLButtonElement;
  readonly save: () => HTMLButtonElement;
  readonly type: (field: Field, text: string) => void;
}

function required<T>(node: T | null, what: string): T {
  if (node === null) {
    throw new Error(`${what} manque`);
  }
  return node;
}

async function render(
  data: { prompt: ReportPrompt | null; taken?: (title: string) => boolean } = { prompt: null },
): Promise<Harness> {
  const closes: (ReportPromptFormResult | undefined)[] = [];
  const ref = new ModalRef<ReportPromptFormResult>(() => {});
  // La poignée réelle, dont on n'intercepte que la fermeture : c'est elle qu'on éprouve, et la
  // promesse de `ModalRef` ne se lit pas dans le même tour de boucle que le clic.
  vi.spyOn(ref, 'close').mockImplementation((result?: ReportPromptFormResult) => {
    closes.push(result);
  });
  const modalData: ReportPromptFormData = {
    prompt: data.prompt,
    taken: data.taken ?? (() => false),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MODAL_DATA, useValue: modalData },
      { provide: ModalRef, useValue: ref },
    ],
  });
  const fixture = TestBed.createComponent(ReportPromptForm);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;

  const buttons = (): HTMLButtonElement[] => [
    ...element.querySelectorAll<HTMLButtonElement>('button'),
  ];

  return {
    fixture,
    element,
    closes,
    title: () => required(element.querySelector<HTMLInputElement>('.field-input'), 'le titre'),
    prompt: () => required(element.querySelector<HTMLTextAreaElement>('.prompt-input'), 'le texte'),
    cancel: () => required(buttons()[0] ?? null, '« Annuler »'),
    save: () => required(buttons()[1] ?? null, '« Enregistrer »'),
    type: (field, text) => {
      field.value = text;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    },
  };
}

describe('ReportPromptForm', () => {
  it('s’ouvre vide à l’ajout', async () => {
    const { title, prompt } = await render({ prompt: null });
    expect(title().value).toBe('');
    expect(prompt().value).toBe('');
  });

  it('s’ouvre rempli à la modification', async () => {
    const { title, prompt } = await render({ prompt: CLIENT });
    expect(title().value).toBe('Client');
    expect(prompt().value).toBe('Décisions.');
  });

  it('garde « Enregistrer » éteint tant qu’un des deux champs manque', async () => {
    // ⚠️ Un prompt sans titre ne se retrouve pas dans un menu, un titre sans prompt ne produit
    // rien : les deux sont exigés.
    const harness = await render({ prompt: null });
    expect(harness.save().disabled).toBe(true);

    harness.type(harness.title(), 'Bilan');
    expect(harness.save().disabled).toBe(true);

    harness.type(harness.prompt(), 'Ce qui a avancé.');
    expect(harness.save().disabled).toBe(false);
  });

  it('ne prend pas des espaces pour un titre', async () => {
    const harness = await render({ prompt: null });
    harness.type(harness.title(), '   ');
    harness.type(harness.prompt(), 'Ce qui a avancé.');
    expect(harness.save().disabled).toBe(true);
    expect(harness.element.querySelector('.field-error')).toBeNull();
  });

  it('refuse un titre déjà pris, sans se fermer', async () => {
    const harness = await render({
      prompt: null,
      taken: (title) => title.trim() === 'Client',
    });
    harness.type(harness.title(), 'Client');
    harness.type(harness.prompt(), 'Décisions.');

    expect(harness.save().disabled).toBe(true);
    expect(harness.element.querySelector('.field-error')?.textContent).toContain('déjà');
    expect(harness.closes).toEqual([]);
  });

  /**
   * ⚠️ **Le champ dit lui-même sa faute**, et pas seulement l'alerte à côté : `role="alert"` ne
   * se dit qu'une fois, à l'apparition du message, et rien ne rattacherait ensuite l'un à
   * l'autre pour qui revient sur le champ. Même règle que la ligne du dictionnaire.
   */
  it('marque le champ en faute et le rattache au message', async () => {
    const harness = await render({ prompt: null, taken: (title) => title.trim() === 'Client' });
    const field = harness.title();

    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBeNull();

    harness.type(field, 'Client');

    const message = harness.element.querySelector('.field-error');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(message?.id);
    expect(message?.id).not.toBe('');
  });

  /**
   * ⚠️ Un identifiant en dur serait dupliqué si deux instances étaient montées, et
   * l'`aria-describedby` du champ désignerait alors deux éléments — ce qu'AXE ne relève pas.
   */
  it('donne à son message un identifiant qui lui est propre', async () => {
    const taken = (title: string) => title.trim() === 'Client';
    const first = await render({ prompt: null, taken });
    first.type(first.title(), 'Client');
    const one = first.element.querySelector('.field-error')?.id;

    const second = await render({ prompt: null, taken });
    second.type(second.title(), 'Client');

    expect(second.element.querySelector('.field-error')?.id).not.toBe(one);
  });

  it('n’accuse pas un titre que l’appelant ne dit pas pris', async () => {
    // L'exclusion du prompt en cours de modification appartient à `taken`, donc à l'appelant :
    // la modale ne fait qu'obéir à sa réponse, y compris sur un titre qu'elle a affiché.
    const harness = await render({ prompt: CLIENT, taken: () => false });
    harness.type(harness.prompt(), 'Décisions et suites.');

    expect(harness.element.querySelector('.field-error')).toBeNull();
    expect(harness.save().disabled).toBe(false);
  });

  it('rend le titre et le texte taillés', async () => {
    const harness = await render({ prompt: null });
    harness.type(harness.title(), '  Bilan  ');
    harness.type(harness.prompt(), '  Ce qui a avancé.  ');
    harness.save().click();

    expect(harness.closes).toEqual([{ title: 'Bilan', prompt: 'Ce qui a avancé.' }]);
  });

  it('taille le champ du titre sur la borne, sans la réécrire', async () => {
    // ⚠️ Le nombre est posé une seule fois, et la feuille en déduit la largeur : deux endroits,
    // et la boîte promettrait une longueur que le champ n'accepte pas.
    const harness = await render({ prompt: null });
    const field = harness.element.querySelector<HTMLElement>('.rp-field--sized');

    expect(field?.style.getPropertyValue('--chars')).toBe(String(MAX_PROMPT_TITLE_LENGTH));
    expect(harness.title().getAttribute('maxlength')).toBe(String(MAX_PROMPT_TITLE_LENGTH));
  });

  it('ferme sans rien rendre sur « Annuler »', async () => {
    const harness = await render({ prompt: CLIENT });
    harness.cancel().click();
    // ⚠️ `undefined` veut dire annulé — ne pas le confondre avec un enregistrement vide.
    expect(harness.closes).toEqual([undefined]);
  });

  /**
   * ⚠️ **Corriger le texte d'un prompt sans toucher à son titre reste possible.** Le `taken`
   * de l'appelant écarte le prompt ouvert ; un bouchon qui rendrait toujours faux ne prouverait
   * rien, celui-ci reconnaît bien « Client » — mais porté par un AUTRE prompt.
   */
  it('ne refuse pas son propre titre à la modification', async () => {
    const others: readonly ReportPrompt[] = [{ id: 9, title: 'Veille', prompt: 'Les annonces.' }];
    const harness = await render({
      prompt: CLIENT,
      taken: (title) =>
        others.some((entry) => entry.title.toLocaleLowerCase() === title.toLocaleLowerCase()),
    });

    harness.type(harness.prompt(), 'Décisions, tâches et risques.');

    expect(harness.element.querySelector('.field-error')).toBeNull();
    expect(harness.save().disabled).toBe(false);

    harness.save().click();
    expect(harness.closes).toEqual([{ title: 'Client', prompt: 'Décisions, tâches et risques.' }]);
  });

  it('refuse le titre d’un AUTRE prompt, à la modification aussi', async () => {
    const harness = await render({
      prompt: CLIENT,
      taken: (title) => title.trim().toLocaleLowerCase() === 'veille',
    });

    harness.type(harness.title(), 'Veille');

    expect(harness.element.querySelector('.field-error')).not.toBeNull();
    expect(harness.save().disabled).toBe(true);
  });

  it('n’a aucune violation d’accessibilité, à l’ajout comme à la modification', async () => {
    await expectNoAxeViolations((await render({ prompt: null })).element);
    await expectNoAxeViolations((await render({ prompt: CLIENT })).element);
  });
});
