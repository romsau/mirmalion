import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RecordingSound } from './recording-sound';
import { MAIN_WINDOW } from '../bridge/invoke/invoke';
import type { ShortcutAction } from '../bridge/shortcut/shortcut.bridge';
import { SettingsStore } from '../../store/settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../models/settings';
import { Invoke } from '../bridge/invoke/invoke';

/** Ce que chaque `new Audio(src)` a produit, dans l'ordre de construction. */
interface FakeAudio {
  src: string;
  preload: string;
  currentTime: number;
  play: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
}

const built: FakeAudio[] = [];

beforeEach(() => {
  built.length = 0;
  vi.stubGlobal(
    'Audio',
    class {
      preload = '';
      currentTime = 0;
      readonly play = vi.fn().mockResolvedValue(undefined);
      readonly load = vi.fn();
      constructor(readonly src: string) {
        built.push(this as unknown as FakeAudio);
      }
    },
  );
});

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Le service sur un pont simulé : ce qui est éprouvé ici est **quand il joue**, pas le décodage
 * d'un MP3 — jsdom n'a aucun moteur audio.
 */
async function make(
  overrides: {
    settings?: Partial<AppSettings>;
    unlisten?: () => void;
    windowLabel?: string | null;
  } = {},
) {
  TestBed.resetTestingModule();
  const settingsValue = signal<AppSettings>({ ...DEFAULT_SETTINGS, ...overrides.settings });
  const unlisten = vi.fn(overrides.unlisten ?? (() => undefined));
  let fire: ((action: ShortcutAction) => void) | null = null;
  const listen = vi.fn((_event: string, handler: (action: ShortcutAction) => void) => {
    fire = handler;
    return Promise.resolve(unlisten);
  });

  const windowLabel = vi.fn().mockResolvedValue(overrides.windowLabel ?? MAIN_WINDOW);

  TestBed.configureTestingModule({
    providers: [
      { provide: Invoke, useValue: { listen, windowLabel } },
      { provide: SettingsStore, useValue: { settings: settingsValue } },
    ],
  });

  const service = TestBed.inject(RecordingSound);
  // Deux tours : l'étiquette de la fenêtre est lue avant l'abonnement.
  await Promise.resolve();
  await Promise.resolve();
  return {
    service,
    listen,
    unlisten,
    settingsValue,
    start: built[0],
    stop: built[1],
    fire: (action: ShortcutAction) => fire?.(action),
  };
}

describe('RecordingSound', () => {
  it('preloads both sounds before anything is asked of it', async () => {
    // ⚠️ Un décodage MP3 déclenché à l'appui du raccourci s'entendrait : le son arriverait
    // après le début de la phrase, donc après l'overlay qu'il accompagne.
    const { start, stop } = await make();

    expect(start.src).toContain('sound-start.mp3');
    expect(stop.src).toContain('sound-stop.mp3');
    expect(start.preload).toBe('auto');
  });

  it('plays the start sound on start, and the stop sound on stop', async () => {
    const { fire, start, stop } = await make();

    fire('start');
    expect(start.play).toHaveBeenCalledOnce();
    expect(stop.play).not.toHaveBeenCalled();

    fire('stop');
    expect(stop.play).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️⚠️ **UN APPEL DIRECT OBÉIT AU MÊME RÉGLAGE QU'UN RACCOURCI.** Ce test disait l'inverse
   * jusqu'au 2026-08-09 — il gardait un `playNow` qui jouait *malgré* le réglage —, et son motif
   * avait cessé d'être vrai le 2026-08-06 : les sons se réglaient alors **par domaine**, la
   * dictée et la session ayant chacun le leur. Ils n'en ont plus qu'un. Un appel direct qui
   * l'ignorerait ferait sonner une application qu'on a mise en silence.
   */
  it('stays silent on a direct call too when the setting is off', async () => {
    const { service, start, stop } = await make({
      settings: { soundsEnabled: false },
    });

    service.play('start');
    service.play('stop');

    expect(start.play).not.toHaveBeenCalled();
    expect(stop.play).not.toHaveBeenCalled();
  });

  it('plays on a direct call when the setting is on', async () => {
    const { service, start, stop } = await make();

    service.play('start');
    expect(start.play).toHaveBeenCalledOnce();

    service.play('stop');
    expect(stop.play).toHaveBeenCalledOnce();
  });

  it('rewinds before replaying on demand too', async () => {
    const { service, start } = await make();

    service.play('start');
    start.currentTime = 1.4;
    service.play('start');

    expect(start.currentTime).toBe(0);
    expect(start.play).toHaveBeenCalledTimes(2);
  });

  it('rewinds before replaying — a second dictation must be heard too', async () => {
    const { fire, start } = await make();

    fire('start');
    start.currentTime = 1.4;
    fire('start');

    expect(start.currentTime).toBe(0);
    expect(start.play).toHaveBeenCalledTimes(2);
  });

  it('stays silent when the setting is off', async () => {
    const { fire, start } = await make({ settings: { soundsEnabled: false } });

    fire('start');

    expect(start.play).not.toHaveBeenCalled();
  });

  it('follows the setting as it changes, without a reload', async () => {
    const { fire, start, settingsValue } = await make();

    settingsValue.update((current) => ({ ...current, soundsEnabled: false }));
    fire('start');
    expect(start.play).not.toHaveBeenCalled();

    settingsValue.update((current) => ({ ...current, soundsEnabled: true }));
    fire('start');
    expect(start.play).toHaveBeenCalledOnce();
  });

  it('swallows a refused playback — the overlay already says everything', async () => {
    const { fire, start } = await make();
    start.play.mockRejectedValue(new Error('lecture refusée'));

    expect(() => {
      fire('start');
    }).not.toThrow();
  });

  it('stays quiet in any window but the main one', async () => {
    // ⚠️ `App` est la racine de CHAQUE fenêtre : sans ce garde, la fenêtre de l'overlay a son
    // propre exemplaire du service et le son part deux fois (constaté le 2026-07-30).
    const { listen } = await make({ windowLabel: 'overlay' });

    expect(listen).not.toHaveBeenCalled();
  });

  it('unsubscribes when its injector goes away', async () => {
    const { unlisten } = await make();

    TestBed.resetTestingModule();

    expect(unlisten).toHaveBeenCalled();
  });

  it('drops a subscription that arrives after the injector is gone', async () => {
    // Même garde que sur l'écran de dictée : l'abonnement s'obtient de façon asynchrone.
    TestBed.resetTestingModule();
    const unlisten = vi.fn();
    let settle: ((stop: () => void) => void) | undefined;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Invoke,
          useValue: {
            windowLabel: vi.fn().mockResolvedValue(MAIN_WINDOW),
            listen: vi.fn(
              () =>
                new Promise<() => void>((resolve) => {
                  settle = resolve;
                }),
            ),
          },
        },
        {
          provide: SettingsStore,
          useValue: { settings: signal<AppSettings>({ ...DEFAULT_SETTINGS }) },
        },
      ],
    });

    TestBed.inject(RecordingSound);
    // Deux tours pour laisser passer la lecture de l'étiquette, puis l'abonnement.
    await Promise.resolve();
    await Promise.resolve();
    TestBed.resetTestingModule();
    settle?.(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
