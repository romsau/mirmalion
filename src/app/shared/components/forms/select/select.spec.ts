import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Select } from './select';
import type { FormOption } from '../form-option';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const LANGUAGES: readonly FormOption[] = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'Anglais' },
  { value: 'it', label: 'Italien' },
];

function render(inputs: { value?: string; disabled?: boolean; placeholder?: string } = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Select);
  fixture.componentRef.setInput('options', LANGUAGES);
  fixture.componentRef.setInput('value', inputs.value ?? 'fr');
  fixture.componentRef.setInput('ariaLabel', 'Langue parlée');
  if (inputs.disabled !== undefined) {
    fixture.componentRef.setInput('disabled', inputs.disabled);
  }
  if (inputs.placeholder !== undefined) {
    fixture.componentRef.setInput('placeholder', inputs.placeholder);
  }
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const control = element.querySelector('select');
  if (control === null) {
    throw new Error('aucun select rendu');
  }
  return { fixture, element, control };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Select', () => {
  it('is a real native select — that is what buys the keyboard and the screen reader', () => {
    const { control } = render();

    expect(control.tagName).toBe('SELECT');
    expect(control.getAttribute('aria-label')).toBe('Langue parlée');
    expect([...control.options].map((option) => option.textContent?.trim())).toEqual([
      'Français',
      'Anglais',
      'Italien',
    ]);
  });

  it('shows the value it was given, and reports a change', () => {
    const { fixture, control } = render({ value: 'en' });
    const changed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);

    expect(control.value).toBe('en');

    control.value = 'it';
    control.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(changed).toHaveBeenCalledExactlyOnceWith('it');
  });

  it('shows what the host reposes, and nothing else', () => {
    const { fixture, control } = render({ value: 'en' });

    fixture.componentRef.setInput('value', 'it');
    fixture.detectChanges();

    expect(control.value).toBe('it');
  });

  it('comes back to the host value when the host REFUSES the choice', () => {
    // ⚠️⚠️ Le navigateur change la sélection dans le dos d'Angular, et une liaison ne réécrit que
    // lorsque son expression change : un hôte qui reste sur sa valeur ne réécrirait rien. Sans la
    // restauration, le contrôle afficherait pour le reste de la session un choix que personne n'a
    // accepté — et rechoisir la même entrée n'émettrait plus rien.
    const { fixture, control } = render({ value: 'en' });
    const changed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);

    control.value = 'it';
    control.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(control.value).toBe('en');

    // Et le même choix, refait, se signale encore.
    control.value = 'it';
    control.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('carries a decorative chevron that never steals the click', () => {
    const { element } = render();
    const chevron = element.querySelector('app-icon svg');

    // Le clic appartient au `<select>` en dessous : c'est lui qui déroule la liste native.
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
  });

  it('can be disabled', () => {
    expect(render({ disabled: true }).control.disabled).toBe(true);
  });

  it('has no accessibility violation', async () => {
    await expectNoAxeViolations(render().element);
  });

  describe('en menu de commande', () => {
    it('carries a head entry that can neither be chosen nor listed', () => {
      // La maquette l'écrit `disabled hidden` : elle reste affichée entre deux actions et ne
      // prend aucune ligne dans la liste déroulée.
      const { control } = render({ value: '', placeholder: 'Exporter' });
      const head = control.options[0];

      expect(head?.textContent?.trim()).toBe('Exporter');
      expect(head?.disabled).toBe(true);
      expect(head?.hidden).toBe(true);
      expect(control.value).toBe('');
    });

    it('n’ajoute rien tant qu’aucun libellé de tête n’est donné', () => {
      expect(render().control.options).toHaveLength(3);
    });

    it('émet le choix et retombe sur son libellé, l’hôte ne reposant jamais rien', () => {
      // C'est le mode commande tout entier : aucune règle de plus que « le contrôle affiche la
      // valeur de l'hôte », et l'hôte garde la sienne.
      const { fixture, control } = render({ value: '', placeholder: 'Exporter' });
      const changed = vi.fn();
      fixture.componentInstance.valueChange.subscribe(changed);

      control.value = 'it';
      control.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(changed).toHaveBeenCalledExactlyOnceWith('it');
      expect(control.value).toBe('');
    });

    it('has no accessibility violation either', async () => {
      await expectNoAxeViolations(render({ value: '', placeholder: 'Exporter' }).element);
    });
  });
});
