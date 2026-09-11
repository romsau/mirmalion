import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OnboardingSpoken } from './onboarding-spoken';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import type { Language } from '../../../../core/models/settings';

function render(inputs: { selected?: readonly Language[]; installed?: readonly Language[] } = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(OnboardingSpoken);
  fixture.componentRef.setInput('selected', inputs.selected ?? ['fr']);
  fixture.componentRef.setInput('installed', inputs.installed ?? ['fr']);
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  const asked: Language[] = [];
  let acted = 0;
  fixture.componentInstance.toggled.subscribe((language) => asked.push(language));
  fixture.componentInstance.act.subscribe(() => (acted += 1));

  return {
    fixture,
    element,
    asked,
    acted: () => acted,
    action: () => {
      const button = element.querySelector<HTMLButtonElement>('.onb-footer button');
      if (button === null) {
        throw new Error('aucun bouton de pied');
      }
      return button;
    },
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

describe('OnboardingSpoken', () => {
  it('dit « Continuer » quand rien de neuf n’est coché', () => {
    const { action } = render({ selected: ['fr'], installed: ['fr', 'it'] });
    expect(action().textContent?.trim()).toBe('Continuer');
  });

  it('dit « Télécharger (n) », et n compte ce qui manque', () => {
    // Le bouton annonce ce qu'il va obtenir, et combien : c'est ce qui remplace la clé d'icône
    // et le compteur retirés du bas de l'écran.
    const { action } = render({ selected: ['fr', 'it', 'pt'], installed: ['fr'] });
    expect(action().textContent?.trim()).toBe('Télécharger (2)');
  });

  it('ne compte pas une langue absente qui n’est pas cochée', () => {
    const { action } = render({ selected: ['fr'], installed: ['fr'] });
    expect(action().textContent?.trim()).toBe('Continuer');
  });

  it('cocher est GRATUIT — le clic ne fait que signaler', () => {
    // Contrairement aux Options, rien ne s'installe ici : c'est le bouton du pied qui engage.
    const { fixture, rowFor, asked, acted } = render({ selected: ['fr'], installed: ['fr'] });
    rowFor('Italien').click();
    fixture.detectChanges();
    expect(asked).toEqual(['it']);
    expect(acted()).toBe(0);
  });

  it('fige la dernière langue allumée, et dit pourquoi', () => {
    const { rowFor } = render({ selected: ['fr'], installed: ['fr'] });
    const row = rowFor('Français');
    expect(row.querySelector('button')?.disabled).toBe(true);
    expect(row.getAttribute('data-hint')).toBe('Au moins une langue parlée est nécessaire.');
  });

  it('n’affiche RIEN sous la liste', () => {
    // Clé de l'icône, note sur le plafond, compteur « 2 / 5 » : retirés l'un après l'autre.
    const { element } = render();
    expect(element.querySelector('.lang-legend')).toBeNull();
    expect(element.querySelector('.lang-note')).toBeNull();
    expect(element.querySelectorAll('.lang-row svg')).toHaveLength(0);
  });

  it('demande l’action du pied', () => {
    const { fixture, action, acted } = render();
    action().click();
    fixture.detectChanges();
    expect(acted()).toBe(1);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations(render({ selected: ['fr', 'it'], installed: ['fr'] }).element);
  });
});
