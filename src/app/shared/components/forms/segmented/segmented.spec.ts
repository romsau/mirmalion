import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Segmented } from './segmented';
import type { FormOption } from '../form-option';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const THEMES: readonly FormOption<'light' | 'dark'>[] = [
  { value: 'light', label: 'Clair', icon: 'sun' },
  { value: 'dark', label: 'Sombre', icon: 'moon' },
];

function render(value: 'light' | 'dark' = 'light') {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent<Segmented<'light' | 'dark'>>(Segmented);
  fixture.componentRef.setInput('options', THEMES);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('ariaLabel', 'Thème');
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    buttons: () => [...element.querySelectorAll<HTMLButtonElement>('.seg-btn')],
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Segmented', () => {
  it('renders one button per option, inside a named group', () => {
    const { element, buttons } = render();

    expect(element.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Thème');
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['Clair', 'Sombre']);
    expect(element.querySelectorAll('app-icon')).toHaveLength(2);
  });

  it('marks exactly one option as pressed, and moves it on click', () => {
    const { fixture, buttons } = render('light');

    expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ]);

    buttons()[1]?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('dark');
    expect(buttons().map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('is not the button component in selected state — the maquette draws two patterns', () => {
    // `.seg-btn.is-active` pose une pastille claire sur un rail creusé ; `.mode-btn.is-active`
    // remplit d'accent plein. Deux contrôles, deux motifs — cf. l'en-tête du composant.
    const { buttons } = render('light');

    expect(buttons()[0]?.className).toContain('is-active');
    expect(buttons()[0]?.querySelector('app-button')).toBeNull();
  });

  it('has no accessibility violation', async () => {
    await expectNoAxeViolations(render().element);
  });
});
