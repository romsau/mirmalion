import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { LanguagesBridge } from './languages.bridge';
import type { EngineCapabilities } from './languages.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): LanguagesBridge {
  return TestBed.inject(LanguagesBridge);
}

describe('LanguagesBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('translateText() carries the outcome, whatever it is', async () => {
    vi.mocked(invoke).mockResolvedValue({ kind: 'translated', text: 'Hello' });
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().translateText('fr', 'en', 'Bonjour')).resolves.toEqual({
      kind: 'translated',
      text: 'Hello',
    });
    expect(invoke).toHaveBeenCalledWith('translate_text', {
      source: 'fr',
      target: 'en',
      text: 'Bonjour',
    });
  });

  it('getSttCapabilities() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getSttCapabilities()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getSttCapabilities() tells covered languages from usable ones', async () => {
    // ⚠️ L'écart est la règle, pas l'exception : mesuré, 2 des 9 seulement sont installées.
    // Une langue absente ne transcrit rien — le moteur démarre et reste muet.
    const capabilities: EngineCapabilities = {
      id: 'apple',
      streaming: true,
      locales: ['fr', 'en', 'it'],
      installedLocales: ['fr', 'en'],
      detail: null,
    };
    vi.mocked(invoke).mockResolvedValue(capabilities);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getSttCapabilities()).resolves.toEqual(capabilities);
    expect(invoke).toHaveBeenCalledWith('get_stt_capabilities', undefined);
  });

  it('installLanguage() does nothing outside a Tauri context', async () => {
    await expect(bridge().installLanguage('it')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('installLanguage() asks for exactly one language', async () => {
    // ⚠️ La seule opération réseau de la dictée : elle ne part que sur un geste explicite.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().installLanguage('it');
    expect(invoke).toHaveBeenCalledWith('install_language', { language: 'it' });
  });

  it('cancelLanguageInstall() does nothing outside a Tauri context', async () => {
    await expect(bridge().cancelLanguageInstall()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancelLanguageInstall() needs no argument — there is only ever one download', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().cancelLanguageInstall();
    expect(invoke).toHaveBeenCalledWith('cancel_language_install', undefined);
  });

  it('getTranslationAvailability() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getTranslationAvailability()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getTranslationAvailability() reads without asking for anything', async () => {
    // ⚠️ Lecture sans effet de bord, contrairement aux ressources de transcription : sonder une
    // paire ne consomme aucune réservation.
    vi.mocked(invoke).mockResolvedValue({ languages: ['fr'], pairs: [] });
    window.__TAURI_INTERNALS__ = {};
    await bridge().getTranslationAvailability();
    expect(invoke).toHaveBeenCalledWith('get_translation_availability', undefined);
  });

  it('prepareTranslation() does nothing outside a Tauri context', async () => {
    await expect(bridge().prepareTranslation('it', ['fr'])).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('prepareTranslation() carries a TARGET and the spoken languages, never a pair', async () => {
    // ⚠️ **Les noms d'arguments sont le contrat avec Rust, et rien d'autre ne les vérifie.**
    // Ce côté-ci a envoyé `{ target, source }` à une commande qui attendait `{ target, spoken }`
    // : l'appel aurait échoué en vrai, et aucun test ne le voyait, les écrans simulant le pont.
    // ⚠️ Le choix de la paire ordonnée appartient au backend — l'interface n'en parle jamais.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().prepareTranslation('it', ['fr', 'en']);
    expect(invoke).toHaveBeenCalledWith('prepare_translation', {
      target: 'it',
      spoken: ['fr', 'en'],
    });
  });

  it('getLocaleReservations() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getLocaleReservations()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getLocaleReservations() reads the held locales and the ceiling', async () => {
    vi.mocked(invoke).mockResolvedValue({ reserved: ['es-US'], maximum: 5 });
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getLocaleReservations()).resolves.toEqual({
      reserved: ['es-US'],
      maximum: 5,
    });
    expect(invoke).toHaveBeenCalledWith('get_locale_reservations', undefined);
  });

  it('releaseLanguage() does nothing outside a Tauri context', async () => {
    await expect(bridge().releaseLanguage('es')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('releaseLanguage() gives back the slot, and the pack with it', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().releaseLanguage('es');
    expect(invoke).toHaveBeenCalledWith('release_language', { language: 'es' });
  });

  it('getLanguageInstallInFlight() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getLanguageInstallInFlight()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getLanguageInstallInFlight() finds a download the window outlived', async () => {
    // La fenêtre peut être fermée puis rouverte pendant le téléchargement, qui lui continue.
    vi.mocked(invoke).mockResolvedValue('it');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getLanguageInstallInFlight()).resolves.toBe('it');
    expect(invoke).toHaveBeenCalledWith('get_language_install_in_flight', undefined);
  });

  it('cancelDocumentTranslation() stays silent outside a Tauri context', async () => {
    await expect(bridge().cancelDocumentTranslation('filedoc-0')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancelDocumentTranslation() names the document it stops', async () => {
    // ⚠️ Autant de traductions que de fenêtres-documents : sans l'identifiant, annuler dans l'une
    // arrêterait le travail de la voisine.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().cancelDocumentTranslation('filedoc-2');
    expect(invoke).toHaveBeenCalledWith('cancel_document_translation', { id: 'filedoc-2' });
  });
});
