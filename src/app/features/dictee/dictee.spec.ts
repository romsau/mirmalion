import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Dictee } from './dictee';
import { DicteeControls } from './components/dictee-controls/dictee-controls';
import { DicteeStore } from '../../core/store/dictee/dictee.store';
import { DictationHistoryStore } from '../../core/store/dictation-history/dictation-history.store';
import { PanelStore } from '../../core/store/panel/panel.store';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { Dictation } from '../../core/services/dictation/dictation';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { DEFAULT_SETTINGS, type AppSettings } from '../../core/models/settings';
import type { AppError } from '../../core/models/app-error';
import { expectNoAxeViolations } from '../../../testing/axe';

/**
 * Le harnais monte l'écran sur des doublures : ni pont, ni overlay CDK. Ce qui est éprouvé ici
 * est **l'orchestration** — ce qui est écrit dans les réglages, et où mène la ligne qui sort
 * vers les options de langues.
 */
function harness(
  overrides: {
    settings?: Partial<AppSettings>;
    storedPrompt?: Promise<string>;
    savePrompt?: () => Promise<void>;
    historyEmpty?: boolean;
  } = {},
) {
  const error = signal<AppError | null>(null);
  const settingsValue = signal<AppSettings>({ ...DEFAULT_SETTINGS, ...overrides.settings });

  const store = {
    microphones: signal([]),
    error,
    loaded: signal(true),
    load: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(() => {
      error.set(null);
    }),
  };

  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    settingsValue.update((current) => ({ ...current, ...patch }));
  });
  const settings = { settings: settingsValue, update };

  const router = { navigateByUrl: vi.fn().mockResolvedValue(true) };
  const snackbar = { error: vi.fn() };

  const unlistenRecorded = vi.fn();
  /** Le dernier abonné à l'archivage — c'est lui qu'on déclenche pour simuler une dictée. */
  let onRecorded: (() => void) | null = null;
  const dictation = {
    rephrasingPrompt: vi.fn(() => overrides.storedPrompt ?? Promise.resolve('')),
    saveRephrasingPrompt: vi.fn(overrides.savePrompt ?? (() => Promise.resolve())),
    observeRecorded: vi.fn((handler: () => void) => {
      onRecorded = handler;
      return Promise.resolve(unlistenRecorded);
    }),
  };

  const historyEmpty = signal(overrides.historyEmpty ?? true);
  // La doublure porte tout ce que le PANNEAU lit, et pas seulement ce que l'écran lit : déplié,
  // il est monté pour de bon, et un membre manquant échoue au rendu et non à l'assertion.
  const history = {
    empty: historyEmpty,
    entries: signal([]),
    filtered: signal([]),
    search: signal(''),
    count: signal(0),
    cap: signal(200),
    error: signal(null),
    load: vi.fn().mockResolvedValue(undefined),
    setSearch: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    clearError: vi.fn(),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DicteeStore, useValue: store },
      { provide: SettingsStore, useValue: settings },
      { provide: Dictation, useValue: dictation },
      { provide: DictationHistoryStore, useValue: history },
      { provide: Router, useValue: router },
      { provide: Snackbar, useValue: snackbar },
    ],
  });

  return {
    store,
    settings,
    update,
    snackbar,
    router,
    dictation,
    history,
    historyEmpty,
    unlistenRecorded,
    recorded: () => onRecorded?.(),
    error,
    settingsValue,
  };
}

async function mount(doubles: ReturnType<typeof harness>) {
  const fixture = TestBed.createComponent(Dictee);
  await fixture.whenStable();
  return { fixture, ...doubles };
}

/**
 * Le composant de contrôles, pour lui faire émettre ce que l'utilisateur choisirait.
 *
 * ⚠️ Retrouvé par sa **directive**, et non par un chemin dans l'arbre : un index de position
 * se décale au premier élément ajouté au gabarit, et le test se met alors à éprouver autre
 * chose sans échouer.
 */
function controls(fixture: ComponentFixture<Dictee>): DicteeControls {
  const found = fixture.debugElement.query(By.directive(DicteeControls));
  if (found === null) {
    throw new Error('la colonne de contrôles n’est pas montée');
  }
  return found.componentInstance as DicteeControls;
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Dictee', () => {
  it('reads what the machine offers as soon as it opens', async () => {
    const { store } = await mount(harness());
    expect(store.load).toHaveBeenCalledOnce();
  });

  it('writes the chosen language straight to the settings', async () => {
    // ⚠️ **Plus rien entre le choix et l'écriture** : le menu ne propose que des langues
    // activées, il n'y a donc ni vérification ni installation à intercaler.
    const { fixture, update } = await mount(
      harness({ settings: { spokenLanguages: ['en', 'fr'] } }),
    );
    controls(fixture).language.set('fr');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ dictationLanguage: 'fr' });
  });

  /**
   * ⚠️ **Une seule écriture, pas deux** : la cible tombe dans le même patch que la langue. Deux
   * `update` successifs feraient passer l'écran par un état où il traduit le français en
   * français — celui que le menu ne propose plus.
   */
  it('drops the translation target when the spoken language becomes it', async () => {
    const { fixture, update } = await mount(
      harness({
        settings: {
          spokenLanguages: ['en', 'fr'],
          translationLanguages: ['fr'],
          translationTarget: 'fr',
        },
      }),
    );
    controls(fixture).language.set('fr');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ dictationLanguage: 'fr', translationTarget: 'none' });
  });

  /** Une cible qui n'est pas la langue choisie survit intacte. */
  it('keeps a translation target that is not the chosen language', async () => {
    const { fixture, update } = await mount(
      harness({
        settings: {
          spokenLanguages: ['en', 'fr'],
          translationLanguages: ['en'],
          translationTarget: 'en',
        },
      }),
    );
    controls(fixture).language.set('fr');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ dictationLanguage: 'fr' });
  });

  it('hands the controls the enabled lists, and nothing about what is installed', async () => {
    const { fixture } = await mount(
      harness({ settings: { spokenLanguages: ['fr', 'it'], translationLanguages: ['en'] } }),
    );

    expect(controls(fixture).spokenLanguages()).toEqual(['fr', 'it']);
    expect(controls(fixture).translationLanguages()).toEqual(['en']);
  });

  describe('la sortie vers les options de langues', () => {
    /**
     * ⚠️⚠️ **CHACUN VERS SA LISTE.** Les deux menaient à `/options/langues` — la page qui ne fait
     * qu'annoncer les deux listes —, si bien qu'on quittait « Langue parlée » pour arriver
     * devant une porte qui redemandait laquelle. Le test vérifie les DEUX destinations : une
     * seule aurait laissé passer un branchement qui les confond.
     */
    it('opens the list that asked, not the page that lists them', async () => {
      for (const [list, url] of [
        ['spoken', '/options/langues/parlees'],
        ['translation', '/options/langues/traduction'],
      ] as const) {
        const { fixture, router } = await mount(harness());
        controls(fixture).languageOptionsRequested.emit(list);
        await fixture.whenStable();

        expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith(url);
      }
    });

    /**
     * ⚠️ **Le cœur de la décision du 2026-07-31** : cette ligne est une commande, pas une
     * valeur. Si elle écrivait quoi que ce soit, le champ afficherait le nom d'une commande à
     * la place d'une langue.
     */
    it('changes no setting on the way out', async () => {
      const { fixture, update } = await mount(harness());
      controls(fixture).languageOptionsRequested.emit('spoken');
      await fixture.whenStable();

      expect(update).not.toHaveBeenCalled();
    });
  });

  it('pushes a mode change through the store, never straight to the settings', async () => {
    // ⚠️ Écrire le réglage seul laisserait ⌃⌥ se comporter comme avant jusqu'au redémarrage.
    const { fixture, store, update } = await mount(harness());
    controls(fixture).mode.set('toggle');
    await fixture.whenStable();

    expect(store.setMode).toHaveBeenCalledExactlyOnceWith('toggle');
    expect(update).not.toHaveBeenCalledWith({ dictationMode: 'toggle' });
  });

  it('persists the plain settings the controls emit', async () => {
    // Ces deux-là n'ont aucun effet de bord : ils s'écrivent et c'est tout. Ce qui les
    // distingue du mode et de la langue, qui en ont un chacun.
    const { fixture, update } = await mount(harness());
    const panel = controls(fixture);

    panel.translationTarget.set('en');
    panel.rephrasingMode.set('concise');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ translationTarget: 'en' });
    expect(update).toHaveBeenCalledWith({ rephrasingMode: 'concise' });
  });

  it('drops a subscription that arrives after the screen is gone', async () => {
    // L'écran peut être quitté pendant l'attente : le laisser sans propriétaire fuirait à
    // chaque passage sur la Dictée.
    const doubles = harness();
    let settle: ((unlisten: () => void) => void) | undefined;
    doubles.dictation.observeRecorded = vi.fn(
      (_handler: () => void) =>
        new Promise<() => void>((resolve) => {
          settle = resolve;
        }) as ReturnType<typeof doubles.dictation.observeRecorded>,
    );

    const fixture = TestBed.createComponent(Dictee);
    await Promise.resolve();
    fixture.destroy();
    settle?.(doubles.unlistenRecorded);
    await Promise.resolve();

    expect(doubles.unlistenRecorded).toHaveBeenCalledOnce();
  });

  it('says an error once, then forgets it', async () => {
    // La garder la ferait ressurgir au prochain rendu, longtemps après ce qui l'a causée.
    const doubles = harness();
    const { fixture, snackbar, error, store } = await mount(doubles);

    error.set({ kind: 'native', message: 'réseau indisponible' });
    await fixture.whenStable();

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('réseau indisponible');
    expect(store.clearError).toHaveBeenCalledOnce();
  });

  it('shows no history panel yet — it arrives later', async () => {
    const { fixture } = await mount(harness());
    expect(controls(fixture)).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).querySelector('.col-right')).toBeNull();
  });

  it('has no AXE violation', async () => {
    const { fixture } = await mount(harness());
    await expectNoAxeViolations(fixture.nativeElement);
  });

  describe('le prompt de reformulation personnalisé', () => {
    it('reads the stored prompt when the screen opens', async () => {
      const { fixture } = await mount(
        harness({ storedPrompt: Promise.resolve('Ton administratif.') }),
      );
      expect(controls(fixture).customPrompt()).toBe('Ton administratif.');
    });

    /**
     * ⚠️ **Le cas qui casse en silence** : la base est lue de façon asynchrone, et
     * l'utilisateur peut avoir commencé à taper avant que la réponse arrive. Remettre
     * l'ancien texte par-dessus sa frappe serait pire que de ne rien lire.
     */
    it('does not overwrite what the user is already typing', async () => {
      let resolveStored: (value: string) => void = () => undefined;
      const stored = new Promise<string>((resolve) => {
        resolveStored = resolve;
      });
      const { fixture } = await mount(harness({ storedPrompt: stored }));

      controls(fixture).customPrompt.set('ce que je tape');
      resolveStored('ce qui dormait en base');
      await fixture.whenStable();

      expect(controls(fixture).customPrompt()).toBe('ce que je tape');
    });

    it('surfaces a failed read without losing the screen', async () => {
      const { fixture, snackbar } = await mount(
        harness({ storedPrompt: Promise.reject(new Error('base verrouillée')) }),
      );
      await fixture.whenStable();
      expect(snackbar.error).toHaveBeenCalledWith('base verrouillée');
    });

    /**
     * ⚠️ **Une frappe n'écrit pas tout de suite.** Sans différé, une phrase de cinquante
     * signes ferait cinquante transactions SQLCipher.
     */
    it('waits before writing, then writes once', async () => {
      const { fixture, dictation } = await mount(harness());
      vi.useFakeTimers();
      try {
        controls(fixture).customPrompt.set('Ton');
        controls(fixture).customPrompt.set('Ton pro');
        controls(fixture).customPrompt.set('Ton professionnel.');
        expect(dictation.saveRephrasingPrompt).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);
        expect(dictation.saveRephrasingPrompt).toHaveBeenCalledExactlyOnceWith(
          'Ton professionnel.',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('pushes a pending write when the screen goes away', async () => {
      const { fixture, dictation } = await mount(harness());
      vi.useFakeTimers();
      try {
        controls(fixture).customPrompt.set('écrit juste avant de fermer');
        fixture.destroy();
        await vi.advanceTimersByTimeAsync(0);

        expect(dictation.saveRephrasingPrompt).toHaveBeenCalledExactlyOnceWith(
          'écrit juste avant de fermer',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('writes nothing when nothing was typed', async () => {
      const { fixture, dictation } = await mount(harness());
      fixture.destroy();
      expect(dictation.saveRephrasingPrompt).not.toHaveBeenCalled();
    });

    it('surfaces a failed write', async () => {
      const { fixture, snackbar } = await mount(
        harness({ savePrompt: () => Promise.reject(new Error('écriture refusée')) }),
      );
      vi.useFakeTimers();
      try {
        controls(fixture).customPrompt.set('quelque chose');
        await vi.advanceTimersByTimeAsync(1000);
        expect(snackbar.error).toHaveBeenCalledWith('écriture refusée');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('le bouton de dépli de l’historique', () => {
    const button = (fixture: ComponentFixture<Dictee>) =>
      (fixture.nativeElement as HTMLElement).querySelector('.panel-collapse');

    it('reads the history itself — the panel is not mounted when collapsed', async () => {
      // ⚠️ Sans cette lecture, replié, l'écran ne saurait pas s'il a quelque chose à proposer.
      const { history } = await mount(harness());
      expect(history.load).toHaveBeenCalled();
    });

    it('disappears when there is nothing to open', async () => {
      const { fixture } = await mount(harness({ historyEmpty: true }));
      expect(button(fixture)).toBeNull();
    });

    it('is there as soon as the history holds something', async () => {
      const { fixture } = await mount(harness({ historyEmpty: false }));
      expect(button(fixture)).not.toBeNull();
    });

    it('stays while the panel is open, however empty the history is', async () => {
      // Sinon on ne pourrait plus le replier : le bouton est sa seule commande.
      const { fixture } = await mount(harness({ historyEmpty: true }));
      TestBed.inject(PanelStore).toggle();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(button(fixture)).not.toBeNull();
    });

    it('comes back when a dictation is archived while the window is open', async () => {
      // ⚠️ La dictée aboutit fenêtre cachée, et la fenêtre n'est jamais détruite : sans
      // l'évènement, elle montrerait indéfiniment l'historique qu'elle avait au chargement.
      const { fixture, history, historyEmpty, recorded } = await mount(
        harness({ historyEmpty: true }),
      );
      expect(button(fixture)).toBeNull();

      history.load.mockImplementation(async () => {
        historyEmpty.set(false);
      });
      recorded();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(button(fixture)).not.toBeNull();
    });

    it('unsubscribes from the archiving when it goes away', async () => {
      const { fixture, unlistenRecorded } = await mount(harness());
      fixture.destroy();
      expect(unlistenRecorded).toHaveBeenCalled();
    });
  });
});
