import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { OptionsLangues } from './options-langues';
import { Settings } from '../../../../core/services/settings/settings';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../core/models/settings';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import { SystemBridge } from '../../../../core/services/bridge/system/system.bridge';

async function render(settings: Partial<AppSettings> = {}, displayedLocale = 'fr') {
  TestBed.resetTestingModule();
  const save = vi.fn().mockResolvedValue(undefined);
  await TestBed.configureTestingModule({
    imports: [OptionsLangues],
    providers: [
      provideRouter([]),
      // ⚠️ La langue AFFICHÉE, pas le réglage : c'est elle qui décide de la parenthèse
      // anglaise, et les deux divergent jusqu'au redémarrage.
      { provide: LOCALE_ID, useValue: displayedLocale },
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

  // C'est `App` qui relit les réglages au démarrage ; monté seul, le composant partirait des
  // valeurs par défaut et les tests de résumé ne prouveraient rien.
  await TestBed.inject(SettingsStore).load();

  const fixture = TestBed.createComponent(OptionsLangues);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;

  return {
    fixture,
    element,
    save,
    // Le vrai service : hors contexte Tauri il ne fait rien, ce qui suffit à presque tous les
    // cas. Les deux qui vérifient la bascule l'espionnent.
    tauri: TestBed.inject(SystemBridge),
    rows: () => [...element.querySelectorAll<HTMLElement>('.row')],
    select: () => {
      const control = element.querySelector('select');
      if (control === null) {
        throw new Error('aucun sélecteur de langue d’interface');
      }
      return control;
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  // La route retenue survit délibérément à la fenêtre : il faut donc la balayer entre deux cas.
  sessionStorage.clear();
});

describe('OptionsLangues', () => {
  it('porte les trois lignes de la famille', async () => {
    const { rows } = await render();
    expect(rows()).toHaveLength(3);
  });

  describe('la langue de l’interface', () => {
    it('double chaque nom de son équivalent anglais', async () => {
      // Le seul contrôle de l'application qui le fasse : un mauvais choix ici rend l'interface
      // illisible, et l'anglais est le point d'appui qui permet d'en revenir.
      const { select } = await render({}, 'fr');
      const labels = [...select().options].map((option) => option.textContent?.trim());
      expect(labels).toContain('Allemand (German)');
      expect(labels).toContain('Anglais (English)');
    });

    it('ne double rien quand l’interface est déjà en anglais', async () => {
      const { select } = await render({}, 'en');
      for (const option of [...select().options]) {
        expect(option.textContent).not.toContain('(');
      }
    });

    it('enregistre le choix', async () => {
      const { fixture, select, save } = await render({ interfaceLanguage: 'fr' });
      const control = select();
      control.value = 'it';
      control.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ interfaceLanguage: 'it' }));
    });

    // ⚠️⚠️ **L'ORDRE EST TOUT** : la bascule fait charger un autre bundle, donc une autre
    // instance d'Angular, qui relit le fichier de réglages. Demander la bascule avant d'avoir
    // écrit perdrait le choix qu'on vient de faire — et le défaut serait intermittent, puisque
    // les deux courses se joueraient à quelques millisecondes près.
    it('écrit le réglage AVANT de demander la bascule de bundle', async () => {
      const order: string[] = [];
      const { fixture, select, save, tauri } = await render({ interfaceLanguage: 'fr' });
      save.mockImplementation(async () => void order.push('save'));
      vi.spyOn(tauri, 'setInterfaceLanguage').mockImplementation(async () => {
        order.push('switch');
      });

      const control = select();
      control.value = 'it';
      control.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(order).toEqual(['save', 'switch']);
      expect(tauri.setInterfaceLanguage).toHaveBeenCalledWith('it');
    });

    // La route est retenue **avant** les deux appels : ce webview n'existera plus pour la poser
    // après. Sans elle, changer de langue renverrait à l'écran d'accueil.
    it('retient la route avant de partir', async () => {
      const { fixture, select } = await render({ interfaceLanguage: 'fr' });
      const control = select();
      control.value = 'it';
      control.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(sessionStorage.getItem('mirmalion.route')).toBe(TestBed.inject(Router).url);
    });
  });

  describe('les deux lignes « drill-in »', () => {
    it('résument les langues activées, et rien d’autre', async () => {
      // « · proposées dans tous les écrans » y a figuré : la ligne porte déjà son compte à
      // droite, et la phrase redisait ce que le sous-écran explique.
      const { rows } = await render({
        spokenLanguages: ['fr', 'en', 'es'],
        translationLanguages: ['en', 'it'],
      });
      expect(rows()[1]?.textContent).toContain('Français, Anglais, Espagnol');
      expect(rows()[1]?.textContent).not.toContain('proposées');
      expect(rows()[2]?.textContent).toContain('Anglais, Italien');
    });

    it('affichent le compte en bout de ligne', async () => {
      const { rows } = await render({
        spokenLanguages: ['fr', 'en', 'es'],
        translationLanguages: ['en', 'it'],
      });
      expect(rows()[1]?.textContent).toContain('3 langues');
      expect(rows()[2]?.textContent).toContain('2 langues');
    });

    it('mènent chacune à son sous-écran', async () => {
      const { fixture, rows } = await render();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      rows()[1]?.querySelector('button')?.click();
      rows()[2]?.querySelector('button')?.click();
      fixture.detectChanges();

      expect(navigate).toHaveBeenNthCalledWith(1, ['/options', 'langues', 'parlees']);
      expect(navigate).toHaveBeenNthCalledWith(2, ['/options', 'langues', 'traduction']);
    });
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render()).element);
  });

  /**
   * ⚠️ **La rangée de la langue d'interface n'a pas d'action propre** : elle porte un menu
   * déroulant, qu'aucun navigateur n'ouvre par programme — voir l'entrée `passive` d'`OptionRow`.
   */
  it('ne fait pas réagir au survol la rangée de la langue d’interface', async () => {
    const { element } = await render();
    const row = element.querySelector('app-option-row');

    expect(row?.classList).toContain('is-passive');
  });
});
