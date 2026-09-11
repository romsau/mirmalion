import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OptionsHistorique } from './options-historique';
import { Settings } from '../../../../core/services/settings/settings';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../core/models/settings';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import { DictationBridge } from '../../../../core/services/bridge/dictation/dictation.bridge';

async function render(settings: Partial<AppSettings> = {}, purgeFails = false) {
  TestBed.resetTestingModule();
  const save = vi.fn().mockResolvedValue(undefined);
  const applyDictationRetention = vi.fn(() =>
    purgeFails ? Promise.reject(new Error('base indisponible')) : Promise.resolve(),
  );
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

  await TestBed.configureTestingModule({
    imports: [OptionsHistorique],
    providers: [
      { provide: DictationBridge, useValue: { applyDictationRetention } },
      { provide: Snackbar, useValue: snackbar },
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

  // C'est `App` qui relit les réglages au démarrage ; sans cet appel, le composant partirait
  // des valeurs par défaut et « part du plafond enregistré » ne prouverait rien.
  await TestBed.inject(SettingsStore).load();

  const fixture = TestBed.createComponent(OptionsHistorique);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    element,
    save,
    applyDictationRetention,
    snackbar,
    refresh: async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    },
    row: () => element.querySelector<HTMLElement>('.row'),
    select: () => element.querySelector<HTMLSelectElement>('select'),
    // ⚠️ **Deux sélecteurs depuis le 2026-08-07** : les dictées d'abord, les sessions ensuite.
    selects: () => [...element.querySelectorAll<HTMLSelectElement>('select')],
    pick: async (value: string, index = 0) => {
      const field = element.querySelectorAll<HTMLSelectElement>('select')[index];
      if (field) {
        field.value = value;
        field.dispatchEvent(new Event('change'));
      }
      await fixture.whenStable();
      fixture.detectChanges();
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('OptionsHistorique', () => {
  it('propose les quatre paliers de rétention', async () => {
    const { element, select } = await render();

    expect(element.querySelector('.label')?.textContent).toBe('Dictées conservées');
    expect([...(select()?.options ?? [])].map((option) => option.value)).toEqual([
      '50',
      '100',
      '200',
      '500',
    ]);
  });

  it('part du plafond enregistré, pas d’un défaut codé en dur', async () => {
    const { select } = await render({ dictationRetention: 500 });

    expect(select()?.value).toBe('500');
  });

  /**
   * ⚠️ **Un NOMBRE, pas la chaîne du `<select>`.** Écrire `"50"` dans les réglages passerait
   * inaperçu à l'écran, et `sanitiseSettings` le refuserait à la relecture : le choix serait
   * perdu au redémarrage suivant.
   *
   * ⚠️ Et la purge suit l'écriture — sans elle, passer de 500 à 50 laisserait 450 entrées
   * visibles jusqu'à ce que la FIFO les ait lentement chassées.
   */
  it('écrit un nombre, et applique le plafond à ce qui est déjà enregistré', async () => {
    const { pick, save, applyDictationRetention } = await render();

    await pick('50');

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ dictationRetention: 50 }));
    expect(applyDictationRetention).toHaveBeenCalled();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      applyDictationRetention.mock.invocationCallOrder[0],
    );
  });

  /**
   * ⚠️⚠️ **UNE PURGE EN ÉCHEC A UN SYMPTÔME VISIBLE, DONC ELLE SE DIT** *(P6-05, 2026-08-09)*.
   * Elle était avalée : le plafond passait de 500 à 100 et l'écran continuait d'afficher 500
   * dictées. Sans un mot, l'utilisateur conclut que le réglage est inerte — ce qui est faux, il
   * vaut pour les dictées à venir — et le rejoue en vain.
   */
  it('dit qu’une purge a échoué, sans perdre le réglage', async () => {
    const { pick, save, snackbar } = await render({}, true);

    await pick('100');

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ dictationRetention: 100 }));
    expect(snackbar.error).toHaveBeenCalledOnce();
  });

  it('ne dit rien quand la purge passe', async () => {
    const { pick, snackbar } = await render();

    await pick('100');

    expect(snackbar.error).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ Aucun navigateur n'ouvre une liste déroulante par programme : une ligne qui réagit sans
   * rien ouvrir est pire qu'une ligne inerte. La maquette ne la rend pas cliquable non plus.
   */
  it('ne réagit pas au clic sur la ligne', async () => {
    const { row, refresh, save } = await render();

    row()?.click();
    await refresh();

    expect(save).not.toHaveBeenCalled();
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const { element } = await render();
    await expectNoAxeViolations(element);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LES SESSIONS SE COMPTENT PAR DURÉE, LES DICTÉES PAR NOMBRE — L'INVERSE L'UNE DE
   * L'AUTRE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Une dictée est une phrase : on en fait vingt par jour, et ce qui compte est de ne pas en
   * garder mille. Une session est une heure de réunion : ce qu'on veut dire est « je n'ai plus
   * besoin de ce qui date de l'an dernier ». Deux objets, deux façons de les compter.
   */
  it('règle les sessions par durée, à côté des dictées par nombre', async () => {
    const { element, selects } = await render();

    expect([...element.querySelectorAll('.label')].map((label) => label.textContent)).toEqual([
      'Dictées conservées',
      'Sessions conservées',
    ]);
    expect([...(selects()[1]?.options ?? [])].map((option) => option.value)).toEqual([
      '30d',
      '3m',
      '6m',
      '1y',
      'unlimited',
    ]);
  });

  it('part de la durée enregistrée, pas d’un défaut codé en dur', async () => {
    const { selects } = await render({ liveRetention: '1y' });
    expect(selects()[1]?.value).toBe('1y');
  });

  /**
   * ⚠️ **Un seul geste, contrairement aux dictées** : il n'y a rien à purger tant que P4-10
   * n'archive pas les sessions. Appeler une purge qui ne trouverait aucune table serait une
   * erreur à traiter pour un travail que personne n'a demandé.
   */
  it('écrit la durée sans déclencher la purge des dictées', async () => {
    const { pick, save, applyDictationRetention } = await render();

    await pick('30d', 1);

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ liveRetention: '30d' }));
    expect(applyDictationRetention).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **« Illimité » est en dernier, pas en tête** : c'est une réponse valable, mais la proposer
   * d'abord ferait de l'accumulation le choix évident, sur des heures d'audio transcrit.
   */
  it('propose « Illimité » en dernier', async () => {
    const { selects } = await render();
    const labels = [...(selects()[1]?.options ?? [])].map((option) => option.textContent?.trim());

    expect(labels.at(-1)).toBe('Illimité');
    expect(labels.at(0)).toBe('30 jours');
  });

  /**
   * ⚠️ **Les deux rangées à menu déroulant n'ont pas d'action propre** : elles ne s'allument pas
   * au survol et ne prennent pas le curseur main — voir l'entrée `passive` d'`OptionRow`.
   */
  it('ne fait réagir aucune des deux rangées au survol', async () => {
    const { element } = await render();
    const rows = [...element.querySelectorAll('app-option-row')];

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.classList).toContain('is-passive');
    }
  });
});
