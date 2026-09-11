import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from './settings.store';
import { Settings } from '../../services/settings/settings';
import { DEFAULT_SETTINGS, type AppSettings } from '../../models/settings';

const DETECTED = {
  theme: 'dark',
  interfaceLanguage: 'it',
  dictationLanguage: 'it',
} as const;

function store(service: Partial<Settings>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: Settings,
        useValue: {
          load: vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, isFirstLaunch: true }),
          save: vi.fn().mockResolvedValue(undefined),
          detectInitialSettings: vi.fn().mockReturnValue(DETECTED),
          ...service,
        },
      },
    ],
  });
  return TestBed.inject(SettingsStore);
}

describe('SettingsStore', () => {
  it('serves the defaults before anything has been read from disk', () => {
    const instance = store({});

    expect(instance.settings()).toEqual(DEFAULT_SETTINGS);
    expect(instance.theme()).toBe(DEFAULT_SETTINGS.theme);
    expect(instance.loaded()).toBe(false);
    expect(instance.isDegraded()).toBe(false);
  });

  it('detects theme and language on the very first launch, and persists them', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const instance = store({ save });
    await instance.load();

    expect(instance.theme()).toBe('dark');
    expect(instance.interfaceLanguage()).toBe('it');
    expect(instance.loaded()).toBe(true);
    // L'écriture est ce qui rend le choix explicite : sans elle, on redétecterait au
    // prochain démarrage et on écraserait le choix de l'utilisateur.
    expect(save).toHaveBeenCalledWith(DETECTED);
  });

  it('never redetects once the file exists', async () => {
    const stored: AppSettings = { ...DEFAULT_SETTINGS, theme: 'light', interfaceLanguage: 'es' };
    const detectInitialSettings = vi.fn().mockReturnValue(DETECTED);
    const save = vi.fn().mockResolvedValue(undefined);
    const instance = store({
      load: vi.fn().mockResolvedValue({ settings: stored, isFirstLaunch: false }),
      detectInitialSettings,
      save,
    });

    await instance.load();

    expect(instance.theme()).toBe('light');
    expect(instance.interfaceLanguage()).toBe('es');
    expect(detectInitialSettings).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('signals a first launch whose detected values could not be written', async () => {
    const instance = store({ save: vi.fn().mockRejectedValue(new Error('disque plein')) });
    await instance.load();

    expect(instance.theme()).toBe('dark');
    expect(instance.isDegraded()).toBe(true);
  });

  it('keeps the defaults and says so when the disk cannot be read', async () => {
    const instance = store({ load: vi.fn().mockRejectedValue('fichier illisible') });
    await instance.load();

    expect(instance.settings()).toEqual(DEFAULT_SETTINGS);
    expect(instance.loaded()).toBe(true);
    expect(instance.isDegraded()).toBe(true);
    expect(instance.error()).toEqual({ kind: 'native', message: 'fichier illisible' });
  });

  it('applies a change in memory before writing it', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const instance = store({ save });

    await instance.update({ theme: 'dark', soundsEnabled: false });

    expect(instance.theme()).toBe('dark');
    expect(instance.settings().soundsEnabled).toBe(false);
    // Les autres réglages sont intacts.
    expect(instance.settings().dictationRetention).toBe(DEFAULT_SETTINGS.dictationRetention);
    expect(save).toHaveBeenCalledWith({ theme: 'dark', soundsEnabled: false });
  });

  it('keeps the change visible even if the write fails, and signals it', async () => {
    const instance = store({ save: vi.fn().mockRejectedValue(new Error('disque plein')) });

    await instance.update({ theme: 'dark' });

    expect(instance.theme()).toBe('dark');
    expect(instance.isDegraded()).toBe(true);
    expect(instance.error()).toEqual({ kind: 'native', message: 'disque plein' });
  });

  it('clears a previous failure once a write succeeds', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('disque plein'))
      .mockResolvedValueOnce(undefined);
    const instance = store({ save });

    await instance.update({ theme: 'dark' });
    expect(instance.isDegraded()).toBe(true);

    await instance.update({ soundsEnabled: false });
    expect(instance.isDegraded()).toBe(false);
  });
});
