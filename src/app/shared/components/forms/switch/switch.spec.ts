import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Switch } from './switch';
import { expectNoAxeViolations } from '../../../../../testing/axe';

function render(
  inputs: {
    checked?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    controlled?: boolean;
  } = {},
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Switch);
  fixture.componentRef.setInput('ariaLabel', inputs.ariaLabel ?? 'Sons');
  if (inputs.checked !== undefined) {
    fixture.componentRef.setInput('checked', inputs.checked);
  }
  if (inputs.disabled !== undefined) {
    fixture.componentRef.setInput('disabled', inputs.disabled);
  }
  if (inputs.controlled !== undefined) {
    fixture.componentRef.setInput('controlled', inputs.controlled);
  }
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const control = element.querySelector('button');
  if (control === null) {
    throw new Error('aucun interrupteur rendu');
  }
  return { fixture, element, control };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Switch', () => {
  it('announces itself as a switch, named, with its state', () => {
    const { control } = render({ checked: true, ariaLabel: 'Sons' });

    // `role="switch"` dit « c'est fait », là où une case à cocher dirait « ce sera pris en
    // compte à la validation ». Il n'y a pas de bouton « Appliquer » dans les Options.
    expect(control.getAttribute('role')).toBe('switch');
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.getAttribute('aria-label')).toBe('Sons');
  });

  it('flips both ways, and tells its host', () => {
    const { fixture, control } = render({ checked: false });

    control.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.checked()).toBe(true);
    expect(control.getAttribute('aria-checked')).toBe('true');

    control.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.checked()).toBe(false);
  });

  it('cannot be flipped while disabled', () => {
    const { fixture, control } = render({ checked: false, disabled: true });

    expect(control.disabled).toBe(true);
    control.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.checked()).toBe(false);
  });

  describe('en mode contrôlé', () => {
    it('demande la bascule au lieu de l’appliquer', () => {
      // Le piège que ce mode ferme : un interrupteur qui s'allume tout seul reste allumé
      // quand l'hôte refuse, faute de réécriture de l'entrée.
      const { fixture, control } = render({ checked: false, controlled: true });
      let asked = 0;
      fixture.componentInstance.toggleRequested.subscribe(() => (asked += 1));

      control.click();
      fixture.detectChanges();

      expect(asked).toBe(1);
      expect(fixture.componentInstance.checked()).toBe(false);
      expect(control.getAttribute('aria-checked')).toBe('false');
    });

    it('ne demande rien quand il est figé', () => {
      const { fixture, control } = render({ checked: true, controlled: true, disabled: true });
      let asked = 0;
      fixture.componentInstance.toggleRequested.subscribe(() => (asked += 1));

      control.click();
      fixture.detectChanges();

      expect(asked).toBe(0);
      // ⚠️ Et il garde son état : allumé et figé reste allumé.
      expect(control.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('has no accessibility violation, in either state', async () => {
    await expectNoAxeViolations(render({ checked: false }).element);
    await expectNoAxeViolations(render({ checked: true }).element);
  });
});
