import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DictationHistoryStore, displayedText } from './dictation-history.store';
import { Dictation } from '../../services/dictation/dictation';
import type { DictationRecord } from '../../services/bridge/dictation/dictation.bridge';
import { SettingsStore } from '../settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../models/settings';

function record(id: number, overrides: Partial<DictationRecord> = {}): DictationRecord {
  return {
    id,
    language: 'fr',
    rawText: `brut ${id}`,
    cleanedText: null,
    rephrasedText: null,
    translatedText: null,
    translatedLanguage: null,
    ...overrides,
  };
}

function harness(
  overrides: { dictation?: Record<string, unknown>; settings?: Partial<AppSettings> } = {},
) {
  const dictation = {
    dictations: vi.fn().mockResolvedValue([record(1), record(2)]),
    deleteDictation: vi.fn().mockResolvedValue(undefined),
    clearDictations: vi.fn().mockResolvedValue(undefined),
    ...overrides.dictation,
  };
  const settings = { settings: () => ({ ...DEFAULT_SETTINGS, ...overrides.settings }) };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Dictation, useValue: dictation },
      { provide: SettingsStore, useValue: settings },
    ],
  });
  return { dictation, store: TestBed.inject(DictationHistoryStore) };
}

describe('displayedText', () => {
  /**
   * ⚠️ **LE POINT DE CETTE FONCTION.** L'historique montre ce qui a été inséré au curseur —
   * afficher le brut montrerait un texte que l'utilisateur n'a jamais vu, celui d'avant le
   * nettoyage, la reformulation et la traduction.
   */
  it('shows the last text obtained, which is the one that was inserted', () => {
    expect(
      displayedText(
        record(1, {
          cleanedText: 'nettoyé',
          rephrasedText: 'reformulé',
          translatedText: 'traduit',
        }),
      ),
    ).toBe('traduit');
  });

  it('falls back step by step when an optional stage gave up', () => {
    // Une variante absente signifie « cette étape n'a pas eu lieu » : on prend la précédente.
    expect(displayedText(record(1, { cleanedText: 'nettoyé', rephrasedText: 'reformulé' }))).toBe(
      'reformulé',
    );
    expect(displayedText(record(1, { cleanedText: 'nettoyé' }))).toBe('nettoyé');
    expect(displayedText(record(1))).toBe('brut 1');
  });
});

describe('DictationHistoryStore', () => {
  it('reads the history, most recent first', async () => {
    const { store } = harness();
    await store.load();
    expect(store.entries()).toHaveLength(2);
  });

  it('survives a backend that says nothing', async () => {
    // ⚠️ Le magasin n'a plus à distinguer « historique vide » de « pas de backend » : le service
    // de domaine absorbe le `null` du pont, et son propre spec l'éprouve. Ce qui se joue ici est
    // ce qu'en fait le magasin — l'état vide, et non l'état « pas encore lu ».
    const { store } = harness({ dictation: { dictations: vi.fn().mockResolvedValue([]) } });
    await store.load();
    expect(store.entries()).toEqual([]);
    expect(store.empty()).toBe(true);
  });

  it('turns a failure into an error to say once', async () => {
    const { store } = harness({
      dictation: { dictations: vi.fn().mockRejectedValue(new Error('base fermée')) },
    });
    await store.load();
    expect(store.error()?.message).toContain('base fermée');

    store.clearError();
    expect(store.error()).toBeNull();
  });

  it('is not empty before it has been read', async () => {
    // ⚠️ Sinon l'invitation à dicter clignoterait à chaque ouverture du panneau.
    const { store } = harness();
    expect(store.empty()).toBe(false);
    await store.load();
  });

  /**
   * ⚠️ **La recherche ignore les accents ET la casse** — c'est la raison pour laquelle elle
   * n'est pas en SQL : SQLite ne sait pas rapprocher « résumé » et « resume ».
   */
  it('finds a word however it is accented or cased', async () => {
    const { store } = harness({
      dictation: {
        dictations: vi
          .fn()
          .mockResolvedValue([
            record(1, { cleanedText: 'Compte rendu détaillé' }),
            record(2, { cleanedText: 'Autre chose' }),
          ]),
      },
    });
    await store.load();

    // ⚠️ **Le mot cherché DOIT porter un accent** : c'est tout l'objet du test. Un mot sans
    // accent le ferait passer quoi que fasse la normalisation.
    for (const needle of ['détaillé', 'detaille', 'DÉTAILLÉ', 'Detaille', '  détaillé  ']) {
      store.setSearch(needle);
      expect(store.filtered().map((entry) => entry.id)).toEqual([1]);
    }
  });

  it('searches the text that is shown, not the raw one', async () => {
    // Chercher dans le brut ferait trouver des mots absents de l'écran, et manquer ceux qui
    // s'y trouvent.
    const { store } = harness({
      dictation: {
        dictations: vi.fn().mockResolvedValue([record(1, { translatedText: 'the report' })]),
      },
    });
    await store.load();

    store.setSearch('report');
    expect(store.filtered()).toHaveLength(1);
    store.setSearch('brut');
    expect(store.filtered()).toHaveLength(0);
  });

  it('shows everything when the search is empty', async () => {
    const { store } = harness();
    await store.load();
    store.setSearch('   ');
    expect(store.filtered()).toHaveLength(2);
  });

  it('removes an entry before the round trip, and puts it back on failure', async () => {
    // Le panneau doit répondre au clic, pas au disque.
    const { store, dictation } = harness({
      dictation: { deleteDictation: vi.fn().mockRejectedValue(new Error('disque plein')) },
    });
    await store.load();

    const pending = store.remove(1);
    expect(store.entries().map((entry) => entry.id)).toEqual([2]);
    await pending;

    expect(store.entries().map((entry) => entry.id)).toEqual([1, 2]);
    expect(store.error()?.message).toContain('disque plein');
    expect(dictation.deleteDictation).toHaveBeenCalledWith(1);
  });

  it('removes an entry for good when the backend agrees', async () => {
    const { store } = harness();
    await store.load();
    await store.remove(1);
    expect(store.entries().map((entry) => entry.id)).toEqual([2]);
    expect(store.error()).toBeNull();
  });

  it('empties the history, and restores it on failure', async () => {
    const { store } = harness({
      dictation: { clearDictations: vi.fn().mockRejectedValue(new Error('base fermée')) },
    });
    await store.load();
    await store.clear();
    expect(store.entries()).toHaveLength(2); // un effacement raté ne perd rien
    expect(store.error()?.message).toContain('base fermée');
  });

  it('empties the history when the backend agrees', async () => {
    const { store } = harness();
    await store.load();
    await store.clear();
    expect(store.entries()).toEqual([]);
  });
});
