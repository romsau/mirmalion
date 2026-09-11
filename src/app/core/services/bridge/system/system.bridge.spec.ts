import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { SystemBridge } from './system.bridge';
import type { AppInfo, DatabaseStatus, SystemCapabilities } from './system.bridge';
import type { AppError } from '../../../models/app-error';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): SystemBridge {
  return TestBed.inject(SystemBridge);
}

describe('SystemBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('getAppInfo() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getAppInfo()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getAppInfo() returns the info from invoke inside a Tauri context', async () => {
    const info: AppInfo = {
      name: 'app',
      version: '0.0.0',
      tauriVersion: '2.0.0',
      platform: 'macos',
    };
    vi.mocked(invoke).mockResolvedValue(info);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getAppInfo()).resolves.toEqual(info);
    expect(invoke).toHaveBeenCalledWith('get_app_info', undefined);
  });

  it('rejects with the backend AppError as-is, not an opaque string', async () => {
    const backendError: AppError = { kind: 'keychain', message: 'trousseau verrouillé' };
    vi.mocked(invoke).mockRejectedValue(backendError);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getAppInfo()).rejects.toEqual(backendError);
  });

  it('normalises a non-conforming rejection into a typed AppError', async () => {
    vi.mocked(invoke).mockRejectedValue('command not found');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getAppInfo()).rejects.toEqual({
      kind: 'native',
      message: 'command not found',
    });
  });

  it('getSystemCapabilities() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getSystemCapabilities()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getSystemCapabilities() returns the flags reported by the backend', async () => {
    const capabilities: SystemCapabilities = {
      osVersion: '26.5.2',
      architecture: 'arm64',
      speechTranscriber: { status: 'ready', detail: null },
      foundationModels: { status: 'needsDownload', detail: 'modèle en cours' },
      translation: { status: 'ready', detail: null },
    };
    vi.mocked(invoke).mockResolvedValue(capabilities);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getSystemCapabilities()).resolves.toEqual(capabilities);
    expect(invoke).toHaveBeenCalledWith('get_system_capabilities', undefined);
  });

  it('getDatabaseStatus() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getDatabaseStatus()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getDatabaseStatus() returns the schema versions reported by the backend', async () => {
    const status: DatabaseStatus = { schemaVersion: 1, expectedSchemaVersion: 1 };
    vi.mocked(invoke).mockResolvedValue(status);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getDatabaseStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('get_database_status', undefined);
  });

  it('getInterfaceLocale() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getInterfaceLocale()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getInterfaceLocale() returns the locale the backend resolved at startup', async () => {
    vi.mocked(invoke).mockResolvedValue('it');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getInterfaceLocale()).resolves.toBe('it');
    expect(invoke).toHaveBeenCalledWith('get_interface_locale', undefined);
  });

  it('setInterfaceLanguage() asks the backend to switch bundles', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().setInterfaceLanguage('pt')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('set_interface_language', { locale: 'pt' });
  });

  it('setDockVisible() does nothing outside a Tauri context', async () => {
    await expect(bridge().setDockVisible(true)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('setDockVisible() asks for the policy, both ways', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().setDockVisible(true);
    expect(invoke).toHaveBeenCalledWith('set_dock_visible', { visible: true });

    await bridge().setDockVisible(false);
    expect(invoke).toHaveBeenLastCalledWith('set_dock_visible', { visible: false });
  });

  it('setWindowCompact() does nothing outside a Tauri context', async () => {
    await expect(bridge().setWindowCompact(true)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('setWindowCompact() sends the layout, never a pixel width', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().setWindowCompact(true);
    expect(invoke).toHaveBeenCalledWith('set_window_compact', { compact: true });

    await bridge().setWindowCompact(false);
    expect(invoke).toHaveBeenLastCalledWith('set_window_compact', { compact: false });
  });

  it('setWindowTheme() does nothing outside a Tauri context', async () => {
    await expect(bridge().setWindowTheme(true)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('setWindowTheme() sends the appearance the native frame must follow', async () => {
    // ⚠️ Le cadre de la fenêtre est dessiné par macOS, qui ignore tout de `data-theme` :
    // c'est le seul aspect du thème qui doive traverser le pont.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().setWindowTheme(true);
    expect(invoke).toHaveBeenCalledWith('set_window_theme', { dark: true });

    await bridge().setWindowTheme(false);
    expect(invoke).toHaveBeenLastCalledWith('set_window_theme', { dark: false });
  });

  it('focusWindow() does nothing outside a Tauri context', async () => {
    await expect(bridge().focusWindow()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('focusWindow() asks the backend to bring the window forward', async () => {
    // ⚠️ L'application n'est pas dans le Dock : après un prompt TCC, macOS rend le premier
    // plan à l'application précédente et la nôtre retombe derrière.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().focusWindow();
    expect(invoke).toHaveBeenCalledWith('focus_window', undefined);
  });

  it('toggleWindowZoom() does nothing outside a Tauri context', async () => {
    await expect(bridge().toggleWindowZoom()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **Aucun argument, et c'est le fond du contrat** : la commande agit sur la fenêtre d'où
   * l'appel part, et c'est elle qui refuse d'agrandir ce qui n'est pas redimensionnable. Le
   * webview ne désigne ni fenêtre ni taille.
   */
  it('toggleWindowZoom() asks the backend, naming neither window nor size', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().toggleWindowZoom();
    expect(invoke).toHaveBeenCalledWith('toggle_window_zoom', undefined);
  });

  it('finishOnboarding() does nothing outside a Tauri context', async () => {
    await expect(bridge().finishOnboarding()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('finishOnboarding() asks the backend, and carries no flag of its own', async () => {
    // ⚠️ Le drapeau `onboardingCompleted` vit dans les réglages et s'écrit **avant** cet
    // appel : la commande ne fait qu'ouvrir la fenêtre principale et fermer la sienne.
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().finishOnboarding();
    expect(invoke).toHaveBeenCalledWith('finish_onboarding', undefined);
  });

  it('onCloseRequested() gives an inert unsubscribe outside a Tauri context', async () => {
    const handler = vi.fn();
    const unlisten = await bridge().onCloseRequested(handler);

    expect(unlisten()).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('onCloseRequested() stops the close and warns its host', async () => {
    const stop = () => undefined;
    let deliver: (event: { preventDefault: () => void }) => void = () => undefined;
    const onCloseRequested = vi.fn(async (received: (event: never) => void) => {
      deliver = received as unknown as (event: { preventDefault: () => void }) => void;
      return stop;
    });
    vi.doMock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ onCloseRequested }),
    }));
    window.__TAURI_INTERNALS__ = {};

    const handler = vi.fn();
    await expect(bridge().onCloseRequested(handler)).resolves.toBe(stop);

    const preventDefault = vi.fn();
    deliver({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    vi.doUnmock('@tauri-apps/api/window');
  });

  it('getLaunchAtLogin() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getLaunchAtLogin()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getLaunchAtLogin() reads the real login item', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getLaunchAtLogin()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('get_launch_at_login', undefined);
  });

  it('setLaunchAtLogin() does nothing outside a Tauri context', async () => {
    await expect(bridge().setLaunchAtLogin(true)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('setLaunchAtLogin() registers the app with the session', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().setLaunchAtLogin(true);
    expect(invoke).toHaveBeenCalledWith('set_launch_at_login', { enabled: true });
  });
});
