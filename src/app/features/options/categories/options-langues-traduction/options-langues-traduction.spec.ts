import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { OptionsLanguesTraduction } from './options-langues-traduction';
import { Settings } from '../../../../core/services/settings/settings';
import { Translation } from '../../../../core/services/translation/translation';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../core/models/settings';
import { expectNoAxeViolations } from '../../../../../testing/axe';

async function render(settings: Partial<AppSettings> = {}) {
  TestBed.resetTestingModule();
  const save = vi.fn().mockResolvedValue(undefined);
  const offerDownload = vi.fn().mockResolvedValue(false);
  await TestBed.configureTestingModule({
    imports: [OptionsLanguesTraduction],
    providers: [
      provideRouter([]),
      { provide: Translation, useValue: { offerDownload } },
      {
        provide: Settings,
        useValue: {
          load: vi.fn().mockResolvedValue({
            settings: { ...DEFAULT_SETTINGS, ...settings },
            isFirstLaunch: false,
          }),
          save,
          detectInitialSettings: vi.fn().mockReturnValue({}),
        },
      },
    ],
  }).compileComponents();

  await TestBed.inject(SettingsStore).load();

  const fixture = TestBed.createComponent(OptionsLanguesTraduction);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;

  const rowFor = (name: string): HTMLElement => {
    const row = [...element.querySelectorAll<HTMLElement>('.lang-row')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (row === undefined) {
      throw new Error(`aucune rangée « ${name} »`);
    }
    return row;
  };

  return { fixture, element, save, rowFor, offerDownload };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('OptionsLanguesTraduction', () => {
  it('tient en une phrase, et ne parle jamais de paires', async () => {
    const { element } = await render();
    const description = element.querySelector('.fam-desc');
    expect(description?.textContent?.trim()).toBe(
      'Les langues proposées comme cible de traduction.',
    );
    expect(element.textContent).not.toContain('paire');
  });

  it('ne dit RIEN de l’installation sur ses rangées', async () => {
    // La traduction s'installe par paires ordonnées : une icône ou un suffixe par LANGUE
    // mentirait sur la granularité.
    const { rowFor } = await render();
    expect(rowFor('Italien').querySelector('button')?.getAttribute('aria-label')).toBe(
      'Traduire en Italien',
    );
    expect(rowFor('Italien').querySelector('svg')).toBeNull();
  });

  it('active une cible', async () => {
    const { fixture, rowFor, save } = await render({ translationLanguages: [] });
    rowFor('Italien').click();
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ translationLanguages: ['it'] }));
  });

  it('désactive une cible', async () => {
    const { fixture, rowFor, save } = await render({ translationLanguages: ['en', 'it'] });
    rowFor('Anglais').click();
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ translationLanguages: ['it'] }));
  });

  it('laisse tout éteindre — ne rien traduire est un choix valable', async () => {
    // Contrairement aux langues parlées, il n'y a AUCUN minimum ici : c'est même le défaut.
    const { fixture, rowFor, save } = await render({ translationLanguages: ['it'] });
    rowFor('Italien').click();
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ translationLanguages: [] }));
  });

  describe('la préparation chez Apple', () => {
    it('ne demande RIEN à l’ouverture de l’écran', async () => {
      // Une feuille système qui surgit sans qu'on ait cliqué serait exactement ce que la règle
      // du consentement explicite interdit.
      const { offerDownload } = await render({ translationLanguages: ['it'] });
      expect(offerDownload).not.toHaveBeenCalled();
    });

    it('la demande à l’activation, avec les langues parlées', async () => {
      const { fixture, rowFor, offerDownload } = await render({
        translationLanguages: [],
        spokenLanguages: ['fr', 'en'],
      });
      rowFor('Italien').click();
      await fixture.whenStable();
      expect(offerDownload).toHaveBeenCalledWith('it', ['fr', 'en']);
    });

    it('ne demande rien à l’EXTINCTION — et rien ne se désinstalle', async () => {
      const { fixture, rowFor, offerDownload } = await render({ translationLanguages: ['it'] });
      rowFor('Italien').click();
      await fixture.whenStable();
      expect(offerDownload).not.toHaveBeenCalled();
    });
  });

  it('revient à la famille', async () => {
    const { fixture, element } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    element.querySelector<HTMLButtonElement>('button')?.click();
    fixture.detectChanges();
    expect(navigate).toHaveBeenCalledWith(['/options', 'langues']);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render({ translationLanguages: ['it'] })).element);
  });
});
