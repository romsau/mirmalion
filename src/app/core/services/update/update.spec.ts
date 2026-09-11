import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Update } from './update';
import { Invoke } from '../bridge/invoke/invoke';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

/** Ce que le plugin rend : les trois gestes, et de quoi observer ce qu'on lui demande. */
function found(events: unknown[] = []) {
  return {
    version: '0.9.1',
    download: vi.fn(async (onEvent: (event: unknown) => void) => {
      for (const event of events) {
        onEvent(event);
      }
    }),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function service(isTauri: boolean): Update {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: Invoke, useValue: { isTauri: () => isTauri } }],
  });
  return TestBed.inject(Update);
}

describe('Update', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('outside a Tauri context', () => {
    it('check() gives null without reaching for the plugin', async () => {
      // `npm run start:web` doit rester utilisable : le pont rend `null`, il n'échoue pas.
      await expect(service(false).check()).resolves.toBeNull();
      expect(check).not.toHaveBeenCalled();
    });

    it('relaunch() does nothing rather than throwing', async () => {
      await expect(service(false).relaunch()).resolves.toBeUndefined();
      expect(relaunch).not.toHaveBeenCalled();
    });
  });

  it('gives null when the application is already up to date', async () => {
    vi.mocked(check).mockResolvedValue(null);
    await expect(service(true).check()).resolves.toBeNull();
  });

  it('carries the offered version, and nothing of the plugin with it', async () => {
    const update = found();
    vi.mocked(check).mockResolvedValue(update as never);

    const available = await service(true).check();

    expect(available?.version).toBe('0.9.1');
    // Le store ne doit jamais recevoir l'objet du plugin : seulement trois fonctions et un texte.
    expect(Object.keys(available ?? {}).sort()).toEqual([
      'dispose',
      'download',
      'install',
      'version',
    ]);
  });

  it('reports the download from 0 to 1', async () => {
    vi.mocked(check).mockResolvedValue(
      found([
        { event: 'Started', data: { contentLength: 200 } },
        { event: 'Progress', data: { chunkLength: 50 } },
        { event: 'Progress', data: { chunkLength: 50 } },
        { event: 'Finished' },
      ]) as never,
    );

    const ratios: number[] = [];
    const available = await service(true).check();
    await available?.download((ratio) => ratios.push(ratio));

    // Les morceaux s'ADDITIONNENT : deux fois 50 sur 200 font un quart puis une moitié.
    expect(ratios).toEqual([0.25, 0.5, 1]);
  });

  it('stays silent while the total size is unknown', async () => {
    // ⚠️ Sans le garde, le ratio vaudrait `Infinity` : une arithmétique fausse que la borne du
    // composant traduirait en 0 %, donc un défaut invisible. On ne rapporte simplement rien.
    vi.mocked(check).mockResolvedValue(
      found([
        { event: 'Started', data: {} },
        { event: 'Progress', data: { chunkLength: 50 } },
      ]) as never,
    );

    const ratios: number[] = [];
    const available = await service(true).check();
    await available?.download((ratio) => ratios.push(ratio));

    expect(ratios).toEqual([]);
  });

  it('delegates install and dispose to the plugin', async () => {
    const update = found();
    vi.mocked(check).mockResolvedValue(update as never);

    const available = await service(true).check();
    await available?.install();
    await available?.dispose();

    expect(update.install).toHaveBeenCalledOnce();
    expect(update.close).toHaveBeenCalledOnce();
  });

  it('relaunches through the process plugin', async () => {
    await service(true).relaunch();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
