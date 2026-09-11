import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { PermissionsBridge } from './permissions.bridge';
import type { Permission, PermissionsStatus } from './permissions.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): PermissionsBridge {
  return TestBed.inject(PermissionsBridge);
}

describe('PermissionsBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('getPermissionsStatus() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getPermissionsStatus()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getPermissionsStatus() returns the four permissions reported by the backend', async () => {
    const status: PermissionsStatus = {
      microphone: { status: 'granted', detail: null },
      accessibility: { status: 'notDetermined', detail: 'se règle dans les Réglages Système' },
      automation: { status: 'denied', detail: 'refusée' },
      audioCapture: { status: 'unknown', detail: "macOS n'expose pas cet état" },
    };
    vi.mocked(invoke).mockResolvedValue(status);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getPermissionsStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('get_permissions_status', undefined);
  });

  it('requestMicrophone() resolves to null outside a Tauri context', async () => {
    await expect(bridge().requestMicrophone()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requestMicrophone() returns the state obtained after the system prompt', async () => {
    const granted: Permission = { status: 'granted', detail: null };
    vi.mocked(invoke).mockResolvedValue(granted);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().requestMicrophone()).resolves.toEqual(granted);
    expect(invoke).toHaveBeenCalledWith('request_microphone', undefined);
  });

  it('requestAudioCapture() resolves to null outside a Tauri context', async () => {
    await expect(bridge().requestAudioCapture()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requestAudioCapture() returns the verdict of the tap attempt', async () => {
    // ⚠️ Aucun préflight n'existe pour cette catégorie TCC : la demande **est** la lecture.
    const granted: Permission = { status: 'granted', detail: null };
    vi.mocked(invoke).mockResolvedValue(granted);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().requestAudioCapture()).resolves.toEqual(granted);
    expect(invoke).toHaveBeenCalledWith('request_audio_capture', undefined);
  });

  it('requestAccessibility() resolves to null outside a Tauri context', async () => {
    await expect(bridge().requestAccessibility()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requestAccessibility() registers the app and returns the state before the toggle', async () => {
    // ⚠️ Ce que la commande fait vraiment : **inscrire** l'application dans le volet. Sans
    // cela, l'utilisateur y arrive et n'a aucune case à cocher au nom de Mirmalion.
    const pending: Permission = { status: 'notDetermined', detail: 'à cocher dans les Réglages' };
    vi.mocked(invoke).mockResolvedValue(pending);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().requestAccessibility()).resolves.toEqual(pending);
    expect(invoke).toHaveBeenCalledWith('request_accessibility', undefined);
  });
});
