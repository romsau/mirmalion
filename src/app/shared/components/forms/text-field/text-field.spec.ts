import { describe, expect, it } from 'vitest';
import { Component, LOCALE_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TextField } from './text-field';
import { expectNoAxeViolations } from '../../../../../testing/axe';

@Component({
  imports: [TextField],
  template: `
    <app-text-field
      [value]="value()"
      [maxLength]="maxLength()"
      [showCounter]="showCounter()"
      placeholder="Titre du prompt"
      ariaLabel="Titre"
      [invalid]="invalid()"
      [describedBy]="describedBy()"
      (valueChange)="write($event)"
    />
  `,
})
class Host {
  readonly value = signal('');
  readonly maxLength = signal(40);
  readonly showCounter = signal(true);
  readonly invalid = signal(false);
  readonly describedBy = signal<string | null>(null);
  readonly typed = signal<readonly string[]>([]);

  // L'hôte est la source de la valeur : le champ lui rend la frappe, il la repose. Sans cet
  // écho, le compteur resterait à zéro — et ce serait juste.
  write(text: string): void {
    this.typed.set([...this.typed(), text]);
    this.value.set(text);
  }
}

/** Le compteur tel que la locale de l'application l'écrit — voir `TextField.count`. */
function counted(written: number, max: number): string {
  const numbers = new Intl.NumberFormat(TestBed.inject(LOCALE_ID));
  return `${numbers.format(written)} / ${numbers.format(max)}`;
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
    field: () => element.querySelector<HTMLInputElement>('.field-input'),
    counter: () => element.querySelector<HTMLElement>('.field-count'),
    type: (text: string) => {
      const field = element.querySelector<HTMLInputElement>('.field-input');
      if (field === null) {
        throw new Error('le champ manque');
      }
      field.value = text;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    },
  };
}

describe('TextField', () => {
  it('compte comme Rust compte, pas comme JavaScript compte', () => {
    // ⚠️ En points de code : `String.length` donne 2 pour un emoji, Rust en voit 1.
    const { counter, type } = render();
    type('👋');
    expect('👋'.length).toBe(2);
    expect(counter()?.textContent?.trim()).toBe(counted(1, 40));
  });

  it('borne la saisie à ce que la base accepte', () => {
    expect(render().field()?.getAttribute('maxlength')).toBe('40');
  });

  it('compte dès le départ, champ vide compris', () => {
    // Le compteur est un budget annoncé, pas une alarme.
    expect(render().counter()?.textContent?.trim()).toBe(counted(0, 40));
  });

  it('rend chaque frappe à son hôte plutôt que de la garder', () => {
    const { host, type } = render();
    type('Bilan');
    expect(host.typed()).toEqual(['Bilan']);
  });

  it('ne fait pas parler le compteur à chaque touche', () => {
    // ⚠️ `aria-hidden` : annoncé, il couvrirait la frappe. La borne est déjà portée par
    // `maxlength`, que les lecteurs d'écran annoncent à la prise de focus.
    expect(render().counter()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('se passe de compteur quand on le lui demande', () => {
    const { element, host, refresh } = render();
    host.showCounter.set(false);
    refresh();
    expect(element.querySelector('.field-count')).toBeNull();
  });

  it('affiche la valeur que son hôte lui donne', () => {
    const { host, refresh, field } = render();

    host.value.set('Compte rendu');
    refresh();

    expect(field()?.value).toBe('Compte rendu');
  });

  it('reflète le texte d’attente, le nom accessible et l’état désactivé', () => {
    const { field } = render();

    expect(field()?.getAttribute('placeholder')).toBe('Titre du prompt');
    expect(field()?.getAttribute('aria-label')).toBe('Titre');
    expect(field()?.disabled).toBe(false);
  });

  /**
   * ⚠️ **Un champ en faute le DIT** : sans `aria-invalid` ni `aria-describedby`, un lecteur
   * d'écran laisse chercher pourquoi « Enregistrer » s'est éteint.
   */
  it('ne porte les marques de faute que lorsqu’on l’en charge', () => {
    const { host, refresh, field } = render();

    expect(field()?.getAttribute('aria-invalid')).toBeNull();
    expect(field()?.getAttribute('aria-describedby')).toBeNull();

    host.invalid.set(true);
    host.describedBy.set('erreur-1');
    refresh();

    expect(field()?.getAttribute('aria-invalid')).toBe('true');
    expect(field()?.getAttribute('aria-describedby')).toBe('erreur-1');
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations(render().element);
  });
});
