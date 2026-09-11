import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OnboardingDownload } from './onboarding-download';
import { expectNoAxeViolations } from '../../../../../testing/axe';

function render(inputs: { label?: string; progress?: number | null } = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(OnboardingDownload);
  fixture.componentRef.setInput('label', inputs.label ?? 'Installation de la langue portugaise');
  fixture.componentRef.setInput('progress', inputs.progress ?? null);
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  let cancelled = 0;
  fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));
  return { fixture, element, cancelled: () => cancelled };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('OnboardingDownload', () => {
  it('n’affiche que le bloc de progression — ni titre d’étape, ni pied de page', () => {
    // Deux textes se disputaient le rôle de titre, et celui du composant — le seul qui dise ce
    // qui se passe — arrivait second et en plus petit.
    const { element } = render();
    expect(element.querySelector('h1')).toBeNull();
    expect(element.querySelector('.onb-footer')).toBeNull();
    expect(element.querySelector('.label')?.textContent?.trim()).toBe(
      'Installation de la langue portugaise',
    );
  });

  it('porte le nom accessible de l’écran, faute de titre', () => {
    const { element } = render();
    expect(element.getAttribute('role')).toBe('group');
    expect(element.getAttribute('aria-label')).toBe('Installation des langues parlées');
  });

  it('offre « Annuler » TOUT DE SUITE — c’est la seule sortie', () => {
    // Ailleurs un délai évite un bouton qui clignote sur les traitements brefs ; ici, faire
    // attendre devant la seule issue de l'écran n'aurait aucun sens.
    const { element } = render();
    const cancel = element.querySelector<HTMLButtonElement>('app-progress-bar button');
    expect(cancel).not.toBeNull();
  });

  it('demande l’interruption', () => {
    const { fixture, element, cancelled } = render();
    element.querySelector<HTMLButtonElement>('app-progress-bar button')?.click();
    fixture.detectChanges();
    expect(cancelled()).toBe(1);
  });

  it('n’a aucune violation d’accessibilité, déterminée ou non', async () => {
    await expectNoAxeViolations(render({ progress: null }).element);
    await expectNoAxeViolations(render({ progress: 47 }).element);
  });
});
