import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OnboardingWelcome } from './onboarding-welcome';
import { expectNoAxeViolations } from '../../../../../testing/axe';

async function render(): Promise<ComponentFixture<OnboardingWelcome>> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(OnboardingWelcome);
  await fixture.whenStable();
  return fixture;
}

/** `fixture.nativeElement` est `any` : on le type une fois, ici, plutôt qu'à chaque appel. */
function rootOf(fixture: ComponentFixture<OnboardingWelcome>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function texts(fixture: ComponentFixture<OnboardingWelcome>, selector: string): string[] {
  return Array.from(rootOf(fixture).querySelectorAll(selector)).map(
    (node) => node.textContent?.trim() ?? '',
  );
}

describe('OnboardingWelcome', () => {
  it('states the hook, the promise and the three uses — each once', async () => {
    const fixture = await render();
    const root = rootOf(fixture);

    // Les trois niveaux ont des rôles distincts : accroche, promesse, usages.
    expect(root.querySelector('.onb-h')?.textContent?.trim()).toBe('Écrivez à voix haute.');
    expect(root.querySelector('.onb-sub')?.textContent?.trim()).toBe(
      'Tout reste sur votre Mac — rien ne part dans le cloud.',
    );
    expect(texts(fixture, '.onb-it-title')).toEqual(['Dictée', 'Direct', 'Fichiers']);
  });

  it('shows three blocks, not four', async () => {
    // La règle le dit explicitement, et la raison est la vitesse de lecture. Un test le
    // garde, sans quoi le quatrième bloc s'ajoute tout seul un jour.
    const fixture = await render();
    expect(rootOf(fixture).querySelectorAll('.onb-item')).toHaveLength(3);
  });

  it('describes each use in one sentence', async () => {
    const fixture = await render();
    expect(texts(fixture, '.onb-it-desc')).toEqual([
      "Un raccourci, vous parlez, le texte s'insère au curseur.",
      'Enregistrez le son de votre Mac, obtenez un transcript et un compte rendu.',
      'Importez un audio ou une vidéo, récupérez le texte.',
    ]);
  });

  it('never proposes voice recognition here', async () => {
    // ⚠️ Acté : le consentement biométrique se demande **en contexte**, au premier
    // nommage d'un locuteur, jamais avant d'avoir vu un transcript.
    //
    // Le test vise la **fonction**, pas le mot : « voix » apparaît légitimement dans
    // l'accroche « Écrivez à voix haute ». Une première version l'interdisait tel quel et
    // échouait sur le titre lui-même — un test qui refuse ce que la règle exige.
    //
    // ⚠️⚠️ **« INTERVENANT » ET « LOCUTEUR » ONT ÉTÉ AJOUTÉS LE 2026-08-10, ET ILS ONT
    // ATTRAPÉ UN VRAI DÉFAUT** : la ligne du Direct promettait encore « identifiez les
    // intervenants » — la fonctionnalité retirée du produit le 2026-08-06. Le garde-fou
    // d'origine ne visait que le vocabulaire **biométrique**, si bien qu'une promesse de
    // séparation par locuteur passait au travers. Elle a survécu à la refonte de P4-23
    // parce que ce texte-ci est un écran d'accueil, que P4-23 ne rouvrait pas. Trouvée en
    // traduisant (P6-10), à l'instant où la phrase allait partir dans cinq langues.
    const fixture = await render();
    const wording = rootOf(fixture).textContent?.toLowerCase() ?? '';
    for (const forbidden of [
      'empreinte',
      'biométr',
      'reconnaissance des voix',
      'répertoire de voix',
      'intervenant',
      'locuteur',
    ]) {
      expect(wording).not.toContain(forbidden);
    }
  });

  it('emits start when the call to action is pressed', async () => {
    const fixture = await render();
    const started = vi.fn();
    fixture.componentInstance.start.subscribe(started);

    rootOf(fixture).querySelector<HTMLButtonElement>('.onb-footer button')?.click();
    expect(started).toHaveBeenCalledOnce();
  });

  it('carries an accessible heading and one reachable control', async () => {
    const fixture = await render();
    const root = rootOf(fixture);

    // Un `<h1>` : c'est la première chose qu'un lecteur d'écran annonce en arrivant.
    expect(root.querySelector('h1')).not.toBeNull();
    // Les icônes des trois blocs sont décoratives — le titre du bloc dit déjà tout.
    expect(root.querySelectorAll('app-icon svg[aria-hidden="true"]')).toHaveLength(3);
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });

  it('has no accessibility violations', async () => {
    const fixture = await render();
    await expectNoAxeViolations(rootOf(fixture));
  });
});
