import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DicteeStore } from './dictee.store';
import { Dictation } from '../../services/dictation/dictation';
import { SettingsStore } from '../settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../models/settings';
import type { InputDevice } from '../../services/bridge/dictation/dictation.bridge';

const DEVICES: readonly InputDevice[] = [{ id: '42', name: 'Micro système', isDefault: true }];

/**
 * Monte le store sur des doublures. `settings` remplace le store de réglages : le store de
 * dictée lui écrit le mode.
 */
function harness(
  overrides: {
    dictation?: Record<string, unknown>;
    settings?: Partial<AppSettings>;
  } = {},
) {
  const dictation = {
    inputDevices: vi.fn().mockResolvedValue(DEVICES),
    applyMode: vi.fn().mockResolvedValue(undefined),
    ...overrides.dictation,
  };
  const update = vi.fn().mockResolvedValue(undefined);
  const settings = {
    settings: () => ({ ...DEFAULT_SETTINGS, ...overrides.settings }),
    update,
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Dictation, useValue: dictation },
      { provide: SettingsStore, useValue: settings },
    ],
  });
  return { dictation, update, store: TestBed.inject(DicteeStore) };
}

describe('DicteeStore', () => {
  it('starts empty rather than optimistic', () => {
    // `loaded` distingue « pas encore lu » de « rien à proposer », que la liste seule
    // confondrait.
    const { store } = harness();

    expect(store.microphones()).toEqual([]);
    expect(store.loaded()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('reads what the machine offers', async () => {
    const { store } = harness();
    await store.load();

    expect(store.microphones()).toEqual(DEVICES);
    expect(store.loaded()).toBe(true);
  });

  it('stays usable when the backend says nothing at all', async () => {
    const { store } = harness({
      dictation: { inputDevices: vi.fn().mockRejectedValue(new Error('pont muet')) },
    });
    await store.load();

    expect(store.loaded()).toBe(true);
    expect(store.error()).not.toBeNull();
  });

  /**
   * ⚠️ **Ce store ne connaît plus rien à l'installation des langues** (2026-07-31). Elle a été
   * retirée avec la refonte de l'écran de dictée, et appartient à Options ▸ Langues.
   * Ce contrôle existe pour qu'un retour en arrière se voie : la remettre ici la ramènerait sur
   * un écran d'où le produit l'a délibérément sortie.
   */
  it('carries nothing about installing languages any more', () => {
    const { store } = harness();

    for (const gone of [
      'installedLanguages',
      'install',
      'installing',
      'installLanguage',
      'cancelInstall',
      'applyInstallEvent',
      'spokenLanguageMissing',
    ]) {
      expect(gone in store).toBe(false);
    }
  });

  it('does both halves of a mode change, in one call', async () => {
    // ⚠️ C'est la raison d'être de cette méthode : écrire le réglage ne suffit pas, le
    // backend ne le relit qu'au démarrage. Les deux appels sont ici pour qu'aucun appelant
    // ne puisse n'en faire que la moitié.
    const { store, dictation, update } = harness();
    await store.setMode('toggle');

    expect(update).toHaveBeenCalledExactlyOnceWith({ dictationMode: 'toggle' });
    expect(dictation.applyMode).toHaveBeenCalledExactlyOnceWith('toggle');
  });

  it('keeps the persisted choice even when the shortcut refuses it', async () => {
    // Le réglage est déjà écrit : l'annuler ferait perdre le choix au redémarrage aussi.
    const { store, update } = harness({
      dictation: { applyMode: vi.fn().mockRejectedValue(new Error('tap absent')) },
    });
    await store.setMode('toggle');

    expect(update).toHaveBeenCalledOnce();
    expect(store.error()).not.toBeNull();
  });

  it('forgets an error once it has been said', async () => {
    const { store } = harness({
      dictation: { inputDevices: vi.fn().mockRejectedValue(new Error('pont muet')) },
    });
    await store.load();
    store.clearError();

    expect(store.error()).toBeNull();
  });
});
