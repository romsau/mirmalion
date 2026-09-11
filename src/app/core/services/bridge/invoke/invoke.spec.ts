import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { Invoke } from './invoke';
import { OVERLAY_EVENT } from '../overlay/overlay.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): Invoke {
  return TestBed.inject(Invoke);
}

describe('Invoke', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('isTauri() is false outside a Tauri context', () => {
    expect(bridge().isTauri()).toBe(false);
  });

  it('isTauri() is true inside a Tauri context', () => {
    window.__TAURI_INTERNALS__ = {};
    expect(bridge().isTauri()).toBe(true);
  });

  it('listen() hands back a no-op unsubscribe outside a Tauri context', async () => {
    // Le frontend reste utilisable dans un navigateur : simplement muet.
    const handler = vi.fn();
    const unlisten = await bridge().listen('whatever', handler);
    expect(unlisten()).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('listen() unwraps the payload before handing it over', async () => {
    // L'appelant veut la charge utile, pas l'enveloppe de Tauri.
    const unlisten = vi.fn();
    const listen = vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      handler({ payload: { state: 'done', chrono: false } });
      return unlisten;
    });
    vi.doMock('@tauri-apps/api/event', () => ({ listen }));
    window.__TAURI_INTERNALS__ = {};

    const handler = vi.fn();
    const result = await bridge().listen(OVERLAY_EVENT, handler);

    expect(listen).toHaveBeenCalledWith(OVERLAY_EVENT, expect.any(Function));
    expect(handler).toHaveBeenCalledWith({ state: 'done', chrono: false });
    expect(result).toBe(unlisten);
    vi.doUnmock('@tauri-apps/api/event');
  });

  it('windowLabel() says nothing outside a Tauri context', async () => {
    await expect(bridge().windowLabel()).resolves.toBeNull();
  });

  it('windowLabel() names the window that runs the code', async () => {
    // ⚠️ C'est ce qui permet à un effet global — un son — de ne partir que d'une seule
    // fenêtre : l'application Angular est la même dans toutes.
    vi.doMock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ label: 'overlay' }),
    }));
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().windowLabel()).resolves.toBe('overlay');
    vi.doUnmock('@tauri-apps/api/window');
  });
});
