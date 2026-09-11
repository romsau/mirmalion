import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideRouter, Router } from '@angular/router';
import { categoryFromUrl } from './options';
import { routes } from '../../app.routes';
import { expectNoAxeViolations } from '../../../testing/axe';
import { Invoke } from '../../core/services/bridge/invoke/invoke';
import { DictationBridge } from '../../core/services/bridge/dictation/dictation.bridge';
import { LanguagesBridge } from '../../core/services/bridge/languages/languages.bridge';
import { SystemBridge } from '../../core/services/bridge/system/system.bridge';

/**
 * Le vrai routeur et les vraies routes : ce qu'on éprouve ici est justement le lien entre une
 * URL et l'état du rail. Un routeur simulé ne prouverait que ma propre arithmétique.
 */
async function render() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DictationBridge, useExisting: Invoke },
      { provide: LanguagesBridge, useExisting: Invoke },
      { provide: SystemBridge, useExisting: Invoke },
      provideRouter(routes),
      // `setWindowTheme` : `Theme` l'appelle à chaque peinture, dans toute fenêtre.
      // Les trois suivantes sont celles que `LanguageAssets` emprunte : le sous-écran des
      // langues parlées lit ce qui est installé et s'abonne à la progression dès son montage.
      {
        provide: Invoke,
        useValue: {
          setWindowCompact: () => Promise.resolve(),
          setWindowTheme: () => Promise.resolve(),
          getSttCapabilities: () => Promise.resolve(null),
          getLanguageInstallInFlight: () => Promise.resolve(null),
          // La famille Dictionnaire liste les termes à son montage : sans cette méthode, la
          // navigation testée ici lève.
          listDictionaryTerms: () => Promise.resolve([]),
          // La catégorie Général lit l'état RÉEL de l'ouverture à la session : il ne vient pas
          // des réglages, mais de macOS. Voir `commands/autostart.rs`.
          getLaunchAtLogin: () => Promise.resolve(false),
          listen: () => Promise.resolve(() => undefined),
          // Le panneau Fichiers s'abonne au glisser-déposer dès son montage ; le pont s'arrête là
          // hors contexte Tauri, comme dans `npm run start:web`.
          isTauri: () => false,
        },
      },
    ],
  });
  const harness = await RouterTestingHarness.create('/options');
  const element = harness.fixture.nativeElement as HTMLElement;
  return {
    harness,
    element,
    goto: async (url: string) => {
      await harness.navigateByUrl(url);
      harness.detectChanges();
    },
    current: () =>
      element.querySelector('app-options-rail [aria-current="page"]')?.textContent?.trim(),
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('categoryFromUrl', () => {
  it('lit le segment qui suit /options', () => {
    expect(categoryFromUrl('/options/general')).toBe('general');
    expect(categoryFromUrl('/options/moteurs')).toBe('moteurs');
    expect(categoryFromUrl('/options/historique')).toBe('historique');
  });

  /**
   * ⚠️ Le cœur du motif de sous-écran : il **appartient** à sa catégorie, il ne la quitte pas.
   * Sans cette règle, ouvrir les langues parlées éteindrait « Langues » dans le rail.
   */
  it('reste sur la catégorie quand on descend dans un sous-écran', () => {
    expect(categoryFromUrl('/options/langues/parlees')).toBe('langues');
    expect(categoryFromUrl('/options/langues/traduction')).toBe('langues');
  });

  /** Le dictionnaire est une famille : son URL désigne la SIENNE, pas celle de Dictée. */
  it('reconnaît le dictionnaire comme une famille à part entière', () => {
    expect(categoryFromUrl('/options/dictionnaire')).toBe('dictionnaire');
  });

  /**
   * ⚠️ **Une famille masquée du rail reste une famille RECONNUE.** La faire retomber sur
   * « Général » l'aurait rendue inatteignable, alors qu'elle est seulement invisible.
   */
  it('reconnaît les familles que le rail ne montre pas', () => {
    expect(categoryFromUrl('/options/fichiers')).toBe('fichiers');
    expect(categoryFromUrl('/options/moteurs')).toBe('moteurs');
  });

  it('retombe sur Général pour tout ce qu’elle ne reconnaît pas', () => {
    expect(categoryFromUrl('/options')).toBe('general');
    expect(categoryFromUrl('/options/inconnue')).toBe('general');
    // ⚠️ `dictee` n'est plus une famille : l'URL doit retomber sur Général, pas afficher un
    // panneau vide. C'est ce que la suppression du 2026-08-06 doit garantir.
    expect(categoryFromUrl('/options/dictee')).toBe('general');
    // ⚠️ **`direct` EST REVENUE le 2026-08-06 (porteur)** : elle porte deux réglages qui n'ont de
    // sens que pour le Direct. Seule `dictee` reste supprimée.
    expect(categoryFromUrl('/options/direct')).toBe('direct');
    expect(categoryFromUrl('/options/langues?x=1')).toBe('langues');
    expect(categoryFromUrl('/options/langues#ancre')).toBe('langues');
  });
});

describe('Options', () => {
  it('ouvre sur Général : le chemin nu y redirige', async () => {
    const { element, current } = await render();

    expect(TestBed.inject(Router).url).toBe('/options/general');
    expect(element.querySelector('app-options-general')).not.toBeNull();
    expect(current()).toBe('Général');
  });

  it('navigue quand le rail le demande, et le panneau suit', async () => {
    const { element, harness, current } = await render();

    // ⚠️ Retrouvé par son **libellé**, et non par sa position dans le rail : un
    // `:nth-of-type` se décale à la première famille insérée avant — ce qu'a fait « Langues »
    // le 2026-07-31, et le test s'était mis à éprouver la mauvaise entrée.
    const historique = [
      ...element.querySelectorAll<HTMLButtonElement>('app-options-rail .nav'),
    ].find((entry) => entry.textContent?.includes('Historique'));
    historique?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe('/options/historique');
    expect(element.querySelector('app-options-historique')).not.toBeNull();
    expect(current()).toBe('Historique');
  });

  /**
   * ⚠️ **Masquée du rail, mais bel et bien vivante.** Le composant se monte, la route répond ;
   * seule l'entrée du rail manque, donc rien ne s'y allume. `moteurs` est la seule famille dans
   * ce cas depuis que `fichiers` a rejoint le rail.
   */
  it('ouvre quand même la famille masquée, par son URL', async () => {
    const { element, goto, current } = await render();

    await goto('/options/moteurs');
    expect(element.querySelector('app-options-moteurs')).not.toBeNull();
    expect(current()).toBeUndefined();
  });

  /**
   * ⚠️ **Le seul titre de la page est celui du rail.** En ajouter un dans le panneau serait un
   * écart au patron « Réglages Système », pas une amélioration — et il redirait mot pour mot
   * l'entrée déjà allumée à gauche.
   *
   * ⚠️ **On cherche un TITRE, pas du vide** : ce test a longtemps exigé un panneau sans un
   * caractère, ce qui ne tenait que tant que la famille visée était vide. Il éprouvait alors
   * l'absence de contenu, pas l'absence de titre.
   */
  it('n’affiche aucun titre de catégorie dans le panneau — le rail suffit', async () => {
    const { element, goto } = await render();

    for (const family of ['general', 'direct', 'historique']) {
      await goto(`/options/${family}`);
      const panel = element.querySelector('.content');
      expect(panel?.querySelector('h1, h2')).toBeNull();
    }
  });

  /**
   * ⚠️ **Le dictionnaire s'ouvre depuis le RAIL, et il montre sa liste sans détour.** Il fut un
   * sous-écran de Dictée ; il n'en reste rien — ni ligne de départ dans « Dictée », ni
   * titre-bouton retour, qu'une catégorie n'a pas.
   */
  it('ouvre le dictionnaire par le rail, sur sa liste', async () => {
    const { element, harness, goto, current } = await render();
    await goto('/options/general');
    expect(element.querySelector('app-options-general')?.textContent).not.toContain('Dictionnaire');

    const entry = [...element.querySelectorAll<HTMLButtonElement>('app-options-rail .nav')].find(
      (candidate) => candidate.textContent?.includes('Dictionnaire'),
    );
    entry?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe('/options/dictionnaire');
    expect(element.querySelector('app-options-dictee')).toBeNull();
    expect(element.querySelector('app-dictionary-toolbar')).not.toBeNull();
    expect(element.querySelector('app-subscreen-header')).toBeNull();
    expect(current()).toBe('Dictionnaire');
  });

  /**
   * Les deux listes de langues sont les derniers sous-écrans — et c'est le rail qui le prouve :
   * il reste sur « Langues », parce qu'un sous-écran appartient à sa catégorie.
   */
  it('descend dans les deux sous-écrans de langues sans quitter la famille', async () => {
    const { element, goto, current } = await render();

    await goto('/options/langues/parlees');
    expect(element.querySelector('app-options-langues-parlees')).not.toBeNull();
    expect(element.querySelector('app-options-langues')).toBeNull();
    expect(current()).toBe('Langues');

    await goto('/options/langues/traduction');
    expect(element.querySelector('app-options-langues-traduction')).not.toBeNull();
    expect(current()).toBe('Langues');
  });

  // Les huit familles — celles que le rail masque comprises — et les deux sous-écrans.
  it('n’a aucune violation d’accessibilité, sur les huit catégories et les deux sous-écrans', async () => {
    const { element, goto } = await render();

    for (const url of [
      '/options/general',
      '/options/dictee',
      '/options/direct',
      '/options/fichiers',
      '/options/langues',
      '/options/dictionnaire',
      '/options/moteurs',
      '/options/historique',
      '/options/langues/parlees',
      '/options/langues/traduction',
    ]) {
      await goto(url);
      await expectNoAxeViolations(element);
    }
  });
});
