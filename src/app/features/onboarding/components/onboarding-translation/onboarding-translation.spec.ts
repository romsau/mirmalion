import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OnboardingTranslation } from './onboarding-translation';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import type { Language } from '../../../../core/models/settings';

function render(selected: readonly Language[] = []) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(OnboardingTranslation);
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  const asked: Language[] = [];
  let finished = 0;
  fixture.componentInstance.toggled.subscribe((language) => asked.push(language));
  fixture.componentInstance.finish.subscribe(() => (finished += 1));

  return {
    fixture,
    element,
    asked,
    finished: () => finished,
    action: () => element.querySelector<HTMLButtonElement>('.onb-footer button'),
    rowFor: (name: string) => {
      const row = [...element.querySelectorAll<HTMLElement>('.lang-row')].find(
        (candidate) => candidate.textContent?.trim() === name,
      );
      if (row === undefined) {
        throw new Error(`aucune rangée « ${name} »`);
      }
      return row;
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('OnboardingTranslation', () => {
  it('ne parle jamais de paires, ni de téléchargement, ni d’installation', () => {
    const { element } = render();
    const texte = element.textContent ?? '';
    expect(texte).not.toContain('paire');
    expect(texte).not.toContain('élécharg');
    expect(texte).not.toContain('nstallation');
  });

  it('ne dit RIEN de l’état d’installation sur ses rangées', () => {
    // L'icône mentait sur la granularité : Apple installe des paires ordonnées, pas des langues.
    const { rowFor } = render();
    expect(rowFor('Italien').querySelector('button')?.getAttribute('aria-label')).toBe(
      'Traduire en Italien',
    );
    expect(rowFor('Italien').querySelector('svg')).toBeNull();
  });

  it('dit « Terminer », toujours — rien n’oblige à traduire', () => {
    expect(render().action()?.textContent?.trim()).toBe('Terminer');
    expect(render(['it']).action()?.textContent?.trim()).toBe('Terminer');
  });

  it('se traverse sans rien cocher', () => {
    const { fixture, action, finished } = render();
    action()?.click();
    fixture.detectChanges();
    expect(finished()).toBe(1);
  });

  it('signale une bascule sans rien décider', () => {
    const { fixture, rowFor, asked } = render();
    rowFor('Italien').click();
    fixture.detectChanges();
    expect(asked).toEqual(['it']);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations(render(['it']).element);
  });
});
