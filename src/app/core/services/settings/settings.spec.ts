import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { load } from '@tauri-apps/plugin-store';
import { Settings, SETTINGS_FILE } from './settings';
import { DEFAULT_SETTINGS } from '../../models/settings';
import { Invoke } from '../bridge/invoke/invoke';
import { SystemBridge } from '../bridge/system/system.bridge';

vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn() }));

/** Le double du store du plugin : des entrées en mémoire. */
function fakeStore(entries: [string, unknown][] = []) {
  return {
    entries: vi.fn().mockResolvedValue(entries),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function service(isTauri: boolean, interfaceLocale: string | null = 'fr'): Settings {
  TestBed.resetTestingModule();
  const bridge = {
    isTauri: () => isTauri,
    getInterfaceLocale: vi.fn().mockResolvedValue(isTauri ? interfaceLocale : null),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: Invoke, useValue: bridge },
      { provide: SystemBridge, useValue: bridge },
    ],
  });
  return TestBed.inject(Settings);
}

describe('Settings', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('outside a Tauri context', () => {
    it('load() gives the defaults without touching the disk', async () => {
      await expect(service(false).load()).resolves.toEqual({
        settings: DEFAULT_SETTINGS,
        isFirstLaunch: true,
      });
      expect(load).not.toHaveBeenCalled();
    });

    it('save() is a no-op rather than an error', async () => {
      await expect(service(false).save({ theme: 'dark' })).resolves.toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    });
  });

  describe('inside a Tauri context', () => {
    it('reads the settings file and sanitises what it finds', async () => {
      vi.mocked(load).mockResolvedValue(
        fakeStore([
          ['theme', 'dark'],
          ['dictationRetention', 999],
        ]) as never,
      );

      const { settings, isFirstLaunch } = await service(true).load();

      expect(load).toHaveBeenCalledWith(SETTINGS_FILE, { autoSave: false });
      expect(settings.theme).toBe('dark');
      expect(settings.dictationRetention).toBe(DEFAULT_SETTINGS.dictationRetention);
      expect(isFirstLaunch).toBe(false);
    });

    it('reports a first launch when the file holds nothing at all', async () => {
      vi.mocked(load).mockResolvedValue(fakeStore() as never);
      await expect(service(true).load()).resolves.toEqual({
        settings: DEFAULT_SETTINGS,
        isFirstLaunch: true,
      });
    });

    it('rejects with a typed AppError when the file cannot be read', async () => {
      vi.mocked(load).mockRejectedValue('fichier illisible');
      await expect(service(true).load()).rejects.toEqual({
        kind: 'native',
        message: 'fichier illisible',
      });
    });

    it('writes only the keys it was given, then flushes', async () => {
      const store = fakeStore();
      vi.mocked(load).mockResolvedValue(store as never);

      await service(true).save({ theme: 'dark', soundsEnabled: false });

      expect(store.set).toHaveBeenCalledTimes(2);
      expect(store.set).toHaveBeenCalledWith('theme', 'dark');
      expect(store.set).toHaveBeenCalledWith('soundsEnabled', false);
      expect(store.save).toHaveBeenCalledOnce();
    });

    it('rejects with a typed AppError when the write fails', async () => {
      vi.mocked(load).mockRejectedValue(new Error('disque plein'));
      await expect(service(true).save({ theme: 'dark' })).rejects.toEqual({
        kind: 'native',
        message: 'disque plein',
      });
    });
  });

  describe('detectInitialSettings', () => {
    function setDarkMode(matches: boolean | undefined) {
      Object.defineProperty(window, 'matchMedia', {
        value: matches === undefined ? undefined : () => ({ matches }),
        configurable: true,
      });
    }

    beforeEach(() => {
      setDarkMode(false);
    });

    it('takes the system theme — the only moment it is ever consulted', async () => {
      setDarkMode(true);
      await expect(service(true).detectInitialSettings()).resolves.toMatchObject({
        theme: 'dark',
      });

      setDarkMode(false);
      await expect(service(true).detectInitialSettings()).resolves.toMatchObject({
        theme: 'light',
      });
    });

    it('stays on the light theme when the platform cannot answer', async () => {
      setDarkMode(undefined);
      await expect(service(true).detectInitialSettings()).resolves.toMatchObject({
        theme: 'light',
      });
    });

    it('takes the language from the backend, not from the WebView', async () => {
      // C'est Rust qui a choisi le bundle localisé de la fenêtre : une seconde détection ici
      // finirait par en désigner un autre.
      await expect(service(true, 'it').detectInitialSettings()).resolves.toEqual({
        theme: 'light',
        interfaceLanguage: 'it',
        dictationLanguage: 'it',
      });
    });

    it('keeps only the primary subtag', async () => {
      await expect(service(true, 'pt-BR').detectInitialSettings()).resolves.toMatchObject({
        interfaceLanguage: 'pt',
      });
    });

    it('falls back to English for a language the app does not handle', async () => {
      // Le néerlandais a été retiré du périmètre.
      await expect(service(true, 'nl').detectInitialSettings()).resolves.toMatchObject({
        interfaceLanguage: 'en',
      });
    });

    it('falls back to English outside a Tauri context', async () => {
      await expect(service(false).detectInitialSettings()).resolves.toMatchObject({
        interfaceLanguage: 'en',
        dictationLanguage: 'en',
      });
    });
  });
});
