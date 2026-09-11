import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Capabilities, isUsable } from './capabilities';
import type { Capability, SystemCapabilities } from '../bridge/system/system.bridge';
import { SystemBridge } from '../bridge/system/system.bridge';

const READY: Capability = { status: 'ready', detail: null };

const CAPABILITIES: SystemCapabilities = {
  osVersion: '26.5.2',
  architecture: 'arm64',
  speechTranscriber: READY,
  foundationModels: READY,
  translation: READY,
};

function provide(tauri: Partial<SystemBridge>): Capabilities {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: SystemBridge, useValue: tauri }],
  });
  return TestBed.inject(Capabilities);
}

describe('Capabilities', () => {
  it('returns what the backend reports', async () => {
    const getSystemCapabilities = vi.fn().mockResolvedValue(CAPABILITIES);
    await expect(provide({ getSystemCapabilities }).load()).resolves.toEqual(CAPABILITIES);
    expect(getSystemCapabilities).toHaveBeenCalledOnce();
  });

  it('returns null outside a Tauri context', async () => {
    const service = provide({ getSystemCapabilities: vi.fn().mockResolvedValue(null) });
    await expect(service.load()).resolves.toBeNull();
  });

  it('lets a backend failure propagate untouched', async () => {
    const failure = { kind: 'native' as const, message: 'pont muet' };
    const service = provide({ getSystemCapabilities: vi.fn().mockRejectedValue(failure) });
    await expect(service.load()).rejects.toEqual(failure);
  });
});

describe('isUsable', () => {
  it('is true only for a ready capability', () => {
    expect(isUsable({ status: 'ready', detail: null })).toBe(true);
  });

  it('is false when the brick is present but its model is missing', () => {
    expect(isUsable({ status: 'needsDownload', detail: 'modèle en cours de téléchargement' })).toBe(
      false,
    );
  });

  it('is false when the brick is absent', () => {
    expect(isUsable({ status: 'unavailable', detail: 'demande macOS 26' })).toBe(false);
  });

  it('is false when there is no capability at all', () => {
    expect(isUsable(undefined)).toBe(false);
  });
});
