import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { DictationBridge } from './dictation.bridge';
import type { InputDevice } from './dictation.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): DictationBridge {
  return TestBed.inject(DictationBridge);
}

describe('DictationBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('listInputDevices() resolves to null outside a Tauri context', async () => {
    await expect(bridge().listInputDevices()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('listInputDevices() names the machine inputs and which one is the system default', async () => {
    const devices: readonly InputDevice[] = [
      { id: '42', name: 'Micro du MacBook Pro', isDefault: true },
    ];
    vi.mocked(invoke).mockResolvedValue(devices);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().listInputDevices()).resolves.toEqual(devices);
    expect(invoke).toHaveBeenCalledWith('list_input_devices', undefined);
  });

  it('getRephrasingPrompt() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getRephrasingPrompt()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getRephrasingPrompt() reads the prompt from the encrypted database', async () => {
    // ⚠️ Pas du fichier de réglages, qui est en clair.
    vi.mocked(invoke).mockResolvedValue('Ton professionnel, sans jargon.');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getRephrasingPrompt()).resolves.toBe('Ton professionnel, sans jargon.');
    expect(invoke).toHaveBeenCalledWith('get_rephrasing_prompt', undefined);
  });

  it('setRephrasingPrompt() does nothing outside a Tauri context', async () => {
    await expect(bridge().setRephrasingPrompt('x')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('setRephrasingPrompt() sends the prompt as written, empty string included', async () => {
    // Une chaîne vide n'est pas un cas dégénéré : c'est le geste d'effacement.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().setRephrasingPrompt('');
    expect(invoke).toHaveBeenCalledWith('set_rephrasing_prompt', { prompt: '' });
  });

  it('listDictations() resolves to null outside a Tauri context', async () => {
    await expect(bridge().listDictations()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('listDictations() carries the four text variants, and no timestamp', async () => {
    // ⚠️ Une variante absente dit que l'étape n'a pas eu lieu — elle ne se remplace pas par la
    // précédente. Et la règle : « pas d'horodatage » jusqu'au panneau.
    const entry = {
      id: 7,
      language: 'fr',
      rawText: 'alors euh le rapport est prêt',
      cleanedText: 'Alors, le rapport est prêt.',
      rephrasedText: null,
      translatedText: null,
      translatedLanguage: null,
    };
    vi.mocked(invoke).mockResolvedValue([entry]);
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().listDictations()).resolves.toEqual([entry]);
    expect(invoke).toHaveBeenCalledWith('list_dictations', undefined);
  });

  it('deleteDictation() does nothing outside a Tauri context', async () => {
    await expect(bridge().deleteDictation(3)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('deleteDictation() names the entry to remove', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().deleteDictation(3);
    expect(invoke).toHaveBeenCalledWith('delete_dictation', { id: 3 });
  });

  it('clearDictations() does nothing outside a Tauri context', async () => {
    await expect(bridge().clearDictations()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('clearDictations() empties the whole history', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().clearDictations();
    expect(invoke).toHaveBeenCalledWith('clear_dictations', undefined);
  });

  it('listDictionaryTerms() renders null outside a Tauri context', async () => {
    await expect(bridge().listDictionaryTerms()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('listDictionaryTerms() asks for the whole dictionary', async () => {
    const entry = { id: 1, term: 'GitLab', variants: [{ id: 7, value: 'git lab' }] };
    vi.mocked(invoke).mockResolvedValue([entry]);
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().listDictionaryTerms()).resolves.toEqual([entry]);
    expect(invoke).toHaveBeenCalledWith('list_dictionary_terms', undefined);
  });

  it('addDictionaryTerm() does nothing outside a Tauri context', async () => {
    await expect(bridge().addDictionaryTerm('GitLab')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('addDictionaryTerm() names its argument as the backend expects it', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 1, term: 'GitLab', variants: [] });
    window.__TAURI_INTERNALS__ = {};
    await bridge().addDictionaryTerm('GitLab');
    expect(invoke).toHaveBeenCalledWith('add_dictionary_term', { term: 'GitLab' });
  });

  it('deleteDictionaryTerm() does nothing outside a Tauri context', async () => {
    await expect(bridge().deleteDictionaryTerm(4)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('deleteDictionaryTerm() names the term to remove', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().deleteDictionaryTerm(4);
    expect(invoke).toHaveBeenCalledWith('delete_dictionary_term', { id: 4 });
  });

  it('addDictionaryVariant() does nothing outside a Tauri context', async () => {
    await expect(bridge().addDictionaryVariant(1, 'git lab')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('addDictionaryVariant() names both arguments in camelCase', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 7, value: 'git lab' });
    window.__TAURI_INTERNALS__ = {};
    await bridge().addDictionaryVariant(1, 'git lab');
    expect(invoke).toHaveBeenCalledWith('add_dictionary_variant', {
      termId: 1,
      variant: 'git lab',
    });
  });

  it('deleteDictionaryVariant() does nothing outside a Tauri context', async () => {
    await expect(bridge().deleteDictionaryVariant(7)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('deleteDictionaryVariant() removes one spelling by its identifier', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().deleteDictionaryVariant(7);
    expect(invoke).toHaveBeenCalledWith('delete_dictionary_variant', { id: 7 });
  });

  it('applyDictationRetention() does nothing outside a Tauri context', async () => {
    await expect(bridge().applyDictationRetention()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('applyDictationRetention() re-applies the cap to what is already stored', async () => {
    // Abaisser le plafond vaut tout de suite, pas seulement pour les dictées à venir.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().applyDictationRetention();
    expect(invoke).toHaveBeenCalledWith('apply_dictation_retention', undefined);
  });
});
