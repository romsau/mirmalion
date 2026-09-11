import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { OverlayBridge } from './overlay.bridge';
import type { OverlayPayload } from './overlay.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): OverlayBridge {
  return TestBed.inject(OverlayBridge);
}

describe('OverlayBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('showOverlay() does nothing outside a Tauri context', async () => {
    await expect(bridge().showOverlay('listening', false)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('showOverlay() carries the state and whether a chrono is wanted', async () => {
    // ⚠️ `chrono` est **la seule** différence entre dictée et session.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().showOverlay('listening', true);
    expect(invoke).toHaveBeenCalledWith('show_overlay', { state: 'listening', chrono: true });
  });

  it('hideOverlay() does nothing outside a Tauri context', async () => {
    await expect(bridge().hideOverlay()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('hideOverlay() asks the backend to remove the floating window', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().hideOverlay();
    expect(invoke).toHaveBeenCalledWith('hide_overlay', undefined);
  });

  it('getOverlayState() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getOverlayState()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getOverlayState() returns what the pill must show right now', async () => {
    // Elle comble l'intervalle pendant lequel le webview de la fenêtre montait encore.
    const payload: OverlayPayload = { state: 'preparing', chrono: false };
    vi.mocked(invoke).mockResolvedValue(payload);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getOverlayState()).resolves.toEqual(payload);
    expect(invoke).toHaveBeenCalledWith('get_overlay_state', undefined);
  });

  it('resizeOverlay() does nothing outside a Tauri context', async () => {
    await expect(bridge().resizeOverlay(200, 56)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('resizeOverlay() hands the measurement to the backend, which bounds it', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().resizeOverlay(240, 56);
    expect(invoke).toHaveBeenCalledWith('resize_overlay', { width: 240, height: 56 });
  });
});
