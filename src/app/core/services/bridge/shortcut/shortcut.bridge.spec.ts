import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { ShortcutBridge } from './shortcut.bridge';
import { SHORTCUT_EVENT } from './shortcut.bridge';
import type { ShortcutStatus } from './shortcut.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): ShortcutBridge {
  return TestBed.inject(ShortcutBridge);
}

describe('ShortcutBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('getShortcutStatus() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getShortcutStatus()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getShortcutStatus() tells a missing permission apart from a stopped tap', async () => {
    // ⚠️ Les deux se règlent différemment : cocher une case, ou redémarrer le tap. Les
    // confondre enverrait l'utilisateur dans les Réglages Système pour y trouver une case
    // déjà cochée.
    const stopped: ShortcutStatus = {
      listening: false,
      trusted: true,
      combo: null,
      mode: 'hold',
      enabled: true,
      recording: false,
      detail: "le raccourci global n'écoute pas",
    };
    vi.mocked(invoke).mockResolvedValue(stopped);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getShortcutStatus()).resolves.toEqual(stopped);
    expect(invoke).toHaveBeenCalledWith('get_shortcut_status', undefined);
  });

  it('startShortcut() does nothing outside a Tauri context', async () => {
    await expect(bridge().startShortcut()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('startShortcut() reinstalls the tap once the permission has been granted', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().startShortcut();
    expect(invoke).toHaveBeenCalledWith('start_shortcut', undefined);
  });

  it('stopShortcut() does nothing outside a Tauri context', async () => {
    await expect(bridge().stopShortcut()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stopShortcut() removes the tap', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().stopShortcut();
    expect(invoke).toHaveBeenCalledWith('stop_shortcut', undefined);
  });

  it('setShortcutMode() does nothing outside a Tauri context', async () => {
    await expect(bridge().setShortcutMode('toggle')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('setShortcutMode() sends the spelling the backend expects', async () => {
    // Les deux écritures doivent coïncider avec `ShortcutMode` côté Rust : une divergence
    // ferait échouer la commande sans que rien ne le dise à l'utilisateur.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().setShortcutMode('hold');
    expect(invoke).toHaveBeenCalledWith('set_shortcut_mode', { mode: 'hold' });

    await bridge().setShortcutMode('toggle');
    expect(invoke).toHaveBeenLastCalledWith('set_shortcut_mode', { mode: 'toggle' });
  });

  it('exposes the event name the backend emits on, as a single ordered channel', () => {
    expect(SHORTCUT_EVENT).toBe('shortcut');
  });

  it('insertAtCursor() resolves to null outside a Tauri context', async () => {
    await expect(bridge().insertAtCursor('bonjour')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('insertAtCursor() reports that nothing was waiting for the text', async () => {
    // ⚠️ Ce n'est pas un échec : la dictée part à l'historique, et le presse-papiers de
    // l'utilisateur n'a pas été touché.
    vi.mocked(invoke).mockResolvedValue('noEditableField');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().insertAtCursor('bonjour')).resolves.toBe('noEditableField');
    expect(invoke).toHaveBeenCalledWith('insert_at_cursor', { text: 'bonjour' });
  });

  it('getFocusVerdict() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getFocusVerdict()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getFocusVerdict() surfaces the silence of Chromium apps as its own answer', async () => {
    // ⚠️ « unknown » ne veut pas dire « rien où écrire » : Chrome ne répond simplement pas.
    vi.mocked(invoke).mockResolvedValue('unknown');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getFocusVerdict()).resolves.toBe('unknown');
    expect(invoke).toHaveBeenCalledWith('get_focus_verdict', undefined);
  });
});
