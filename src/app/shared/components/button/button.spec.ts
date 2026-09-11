import { afterEach, describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Button, type ButtonSize, type ButtonVariant } from './button';
import { expectNoAxeViolations } from '../../../../testing/axe';

/**
 * Le libellé passe par `<ng-content>` : il faut donc un hôte pour le projeter. C'est aussi ce
 * qui permet de vérifier le cas « icône seule » — l'absence de contenu, pas une entrée qui la
 * déclare.
 */
@Component({
  imports: [Button],
  template: `
    <app-button
      [variant]="variant()"
      [size]="size()"
      [icon]="icon()"
      [iconSpin]="iconSpin()"
      [disabled]="disabled()"
      [selected]="selected()"
      [type]="type()"
      [ariaLabel]="ariaLabel()"
      (click)="clicks.set(clicks() + 1)"
    >
      @if (label()) {
        {{ label() }}
      }
    </app-button>
  `,
})
class Host {
  readonly variant = signal<ButtonVariant>('accent');
  readonly size = signal<ButtonSize>('default');
  readonly icon = signal<'trash' | 'spinner' | undefined>(undefined);
  readonly iconSpin = signal(false);
  readonly disabled = signal(false);
  readonly selected = signal<boolean | undefined>(undefined);
  readonly type = signal<'button' | 'submit'>('button');
  readonly ariaLabel = signal<string | undefined>(undefined);
  readonly label = signal<string>('Enregistrer');
  readonly clicks = signal(0);
}

function render() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const host = fixture.componentInstance;
  const refresh = () => fixture.detectChanges();
  const button = () => {
    const found = element.querySelector('button');
    if (found === null) {
      throw new Error('aucun <button> rendu');
    }
    return found;
  };
  return { fixture, element, host, refresh, button };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Button', () => {
  it('renders a real button that does not submit forms by accident', () => {
    const { button, host, refresh } = render();
    expect(button().getAttribute('type')).toBe('button');

    host.type.set('submit');
    refresh();
    expect(button().getAttribute('type')).toBe('submit');
  });

  it('carries the variant and the size on the host, which is where the styles hang', () => {
    const { element, host, refresh } = render();
    const appButton = element.querySelector('app-button');

    // L'ordre des classes ne se garantit pas : Angular les applique une par une.
    expect(appButton?.classList.value.split(' ').sort()).toEqual([
      'size-default',
      'variant-accent',
    ]);

    host.variant.set('neutral');
    refresh();
    expect(appButton?.className).toContain('variant-neutral');

    host.size.set('large');
    refresh();
    expect(appButton?.className).toContain('size-large');
  });

  it('draws the icon only when one is asked for, and lets the label through', () => {
    const { element, host, refresh, button } = render();

    expect(element.querySelector('app-icon')).toBeNull();
    expect(button().textContent?.trim()).toBe('Enregistrer');

    host.icon.set('trash');
    refresh();
    expect(element.querySelector('app-icon')).not.toBeNull();
  });

  // ⚠️ La rotation est un PASSE-PLAT vers `Icon` : posée sur le bouton, elle ferait tourner une
  // image déjà rastérisée. Ce test ne vérifie donc qu'une chose — que le drapeau arrive bien à
  // l'icône, qui sait quoi en faire.
  it('hands the spin down to the icon rather than animating itself', () => {
    const { element, host, refresh } = render();
    host.icon.set('spinner');
    refresh();
    expect(element.querySelector('app-icon .spin')).toBeNull();

    host.iconSpin.set(true);
    refresh();
    expect(element.querySelector('app-icon .spin')).not.toBeNull();
  });

  it('leaves the label element empty when nothing is projected — the CSS keys on it', () => {
    // Le rendu carré de l'icône seule vient de `:has(.label:empty)`. jsdom ne calcule aucune
    // mise en page : ce test vérifie la condition, la forme se vérifie à l'œil (phase 6).
    const { element, host, refresh } = render();
    const label = element.querySelector('.label');

    expect(label?.textContent?.trim()).toBe('Enregistrer');

    host.label.set('');
    host.icon.set('trash');
    refresh();
    expect(label?.textContent?.trim()).toBe('');
  });

  it('refuses to be clicked when disabled', () => {
    const { host, refresh, button } = render();

    button().click();
    expect(host.clicks()).toBe(1);

    host.disabled.set(true);
    refresh();
    expect(button().disabled).toBe(true);

    button().click();
    expect(host.clicks(), 'un bouton désactivé ne doit rien émettre').toBe(1);
  });

  it('announces a toggle only when it is one', () => {
    const { host, refresh, button } = render();

    // Un bouton ordinaire ne porte PAS `aria-pressed="false"` : il serait annoncé comme une
    // bascule relevée, ce qu'il n'est pas.
    expect(button().getAttribute('aria-pressed')).toBeNull();

    host.selected.set(false);
    refresh();
    expect(button().getAttribute('aria-pressed')).toBe('false');

    host.selected.set(true);
    refresh();
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it('names an icon-only button, and stays quiet when the label already names it', async () => {
    const { element, host, refresh, button } = render();

    expect(button().getAttribute('aria-label')).toBeNull();
    await expectNoAxeViolations(element);

    host.label.set('');
    host.icon.set('trash');
    host.ariaLabel.set('Supprimer');
    refresh();
    expect(button().getAttribute('aria-label')).toBe('Supprimer');
    await expectNoAxeViolations(element);
  });

  it('is caught by AXE when an icon-only button has no accessible name', async () => {
    // La preuve que l'exigence est réelle, et pas une consigne dans un commentaire : sans
    // `ariaLabel`, un bouton en icône seule n'a aucun nom accessible.
    const { element, host, refresh } = render();

    host.label.set('');
    host.icon.set('trash');
    refresh();

    await expect(expectNoAxeViolations(element)).rejects.toThrow(/button-name/);
  });
});
