import { afterEach, describe, expect, it } from 'vitest';
import { Component, LOCALE_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PromptField, MAX_PROMPT_LENGTH } from './prompt-field';
import { expectNoAxeViolations } from '../../../../../testing/axe';

@Component({
  imports: [PromptField],
  template: `
    <app-prompt-field
      [value]="value()"
      [multiline]="multiline()"
      placeholder="Écrivez votre prompt de compte rendu…"
      ariaLabel="Prompt de compte rendu"
      (valueChange)="write($event)"
    />
  `,
})
class Host {
  readonly value = signal('');
  readonly multiline = signal(true);
  readonly typed = signal<readonly string[]>([]);

  // L'hôte est la source de la valeur, comme les trois écrans réels : le champ lui rend la
  // frappe, il la repose. Sans cet écho, le compteur resterait à zéro — et ce serait juste.
  write(prompt: string): void {
    this.typed.set([...this.typed(), prompt]);
    this.value.set(prompt);
  }
}

/** Le compteur tel que la locale de l'application l'écrit — voir `PromptField.count`. */
function counted(written: number): string {
  const numbers = new Intl.NumberFormat(TestBed.inject(LOCALE_ID));
  return `${numbers.format(written)} / ${numbers.format(MAX_PROMPT_LENGTH)}`;
}

function render() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    host: fixture.componentInstance,
    refresh: () => {
      fixture.detectChanges();
    },
    field: () => element.querySelector<HTMLTextAreaElement | HTMLInputElement>('.prompt-input'),
    counter: () => element.querySelector<HTMLElement>('.prompt-count'),
    type: (text: string) => {
      const field = element.querySelector<HTMLTextAreaElement>('.prompt-input');
      if (field === null) {
        throw new Error('le champ manque');
      }
      field.value = text;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('PromptField', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA BORNE EST CELLE DE LA BASE, ET ELLE DOIT SE VOIR AVANT D'ÊTRE ATTEINTE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Rust refuse au-delà de 2 000 caractères (`MAX_PROMPT_LENGTH`, `commands/prompts.rs`), et
   * rien ne le disait : qui collait 3 000 caractères ne voyait rien, et l'écriture était refusée
   * quatre cents millisecondes plus tard par une snackbar qui ne parlait pas de longueur.
   */
  it('borne la saisie à ce que la base accepte', () => {
    const { field } = render();

    expect(field()?.getAttribute('maxlength')).toBe(String(MAX_PROMPT_LENGTH));
  });

  /** ⚠️ Visible dès le premier caractère, et même à vide : c'est un budget, pas une alarme. */
  it('compte dès le départ, champ vide compris', () => {
    const { counter, type } = render();

    expect(counter()?.textContent?.trim()).toBe(counted(0));

    type('Décisions');
    expect(counter()?.textContent?.trim()).toBe(counted(9));
  });

  /**
   * ⚠️ **Compté en caractères, comme Rust** : `length` en JavaScript compte des unités UTF-16,
   * et un emoji en vaut deux. Rust, lui, compte des `chars`. Les deux se désaccorderaient sur un
   * texte que l'interface aurait cru court.
   */
  it('compte comme Rust compte, pas comme JavaScript compte', () => {
    const { counter, type } = render();

    type('👋');

    expect('👋'.length).toBe(2);
    expect(counter()?.textContent?.trim()).toBe(counted(1));
  });

  it('rend chaque frappe à son hôte plutôt que de la garder', () => {
    const { host, type } = render();

    type('Décisions et tâches');

    expect(host.typed()).toEqual(['Décisions et tâches']);
  });

  /**
   * ⚠️ Dictée n'a qu'une ligne, la session et les Options en ont trois. Un seul composant, deux
   * éléments : un `<textarea>` d'une ligne garderait sa poignée de redimensionnement.
   */
  it('donne une seule ligne quand on la demande', () => {
    const { element, host, refresh } = render();

    expect(element.querySelector('textarea')).not.toBeNull();

    host.multiline.set(false);
    refresh();

    expect(element.querySelector('textarea')).toBeNull();
    expect(element.querySelector('input')).not.toBeNull();
  });

  it('n’a aucune violation d’accessibilité, sur une ligne comme sur trois', async () => {
    const { element, host, refresh } = render();
    await expectNoAxeViolations(element);

    host.multiline.set(false);
    refresh();
    await expectNoAxeViolations(element);
  });

  /** ⚠️ Le compteur n'est pas un contrôle : il ne doit pas être annoncé à chaque frappe. */
  it('ne fait pas parler le compteur à chaque touche', () => {
    const { counter } = render();

    expect(counter()?.getAttribute('aria-live')).toBeNull();
    expect(counter()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('affiche la valeur que son hôte lui donne', () => {
    const { host, refresh, field } = render();

    host.value.set('Décisions, tâches, risques');
    refresh();

    expect(field()?.value).toBe('Décisions, tâches, risques');
  });
});
