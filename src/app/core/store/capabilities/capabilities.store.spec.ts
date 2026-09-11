import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CapabilitiesStore } from './capabilities.store';
import { Capabilities } from '../../services/capabilities/capabilities';
import type { Capability, SystemCapabilities } from '../../services/bridge/system/system.bridge';
import type { AppError } from '../../models/app-error';

const READY: Capability = { status: 'ready', detail: null };
const ABSENT: Capability = { status: 'unavailable', detail: 'demande macOS 26' };
const PENDING: Capability = { status: 'needsDownload', detail: 'modèle en cours' };

function capabilities(overrides: Partial<SystemCapabilities> = {}): SystemCapabilities {
  return {
    osVersion: '26.5.2',
    architecture: 'arm64',
    speechTranscriber: READY,
    foundationModels: READY,
    translation: READY,
    ...overrides,
  };
}

function store(load: () => Promise<SystemCapabilities | null>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: Capabilities, useValue: { load } }],
  });
  return TestBed.inject(CapabilitiesStore);
}

describe('CapabilitiesStore', () => {
  it('starts empty, without error, and not loading', () => {
    const instance = store(vi.fn().mockResolvedValue(null));
    expect(instance.capabilities()).toBeNull();
    expect(instance.error()).toBeNull();
    expect(instance.loading()).toBe(false);
  });

  it('exposes the flags once loaded, and never the OS version as a decision', async () => {
    const instance = store(vi.fn().mockResolvedValue(capabilities()));
    await instance.load();

    expect(instance.capabilities()).toEqual(capabilities());
    expect(instance.canTranscribeNatively()).toBe(true);
    expect(instance.canSummariseNatively()).toBe(true);
    expect(instance.canTranslateNatively()).toBe(true);
    expect(instance.needsDownloadedEngines()).toBe(false);
    expect(instance.loading()).toBe(false);
  });

  it('treats a brick whose model is missing as unusable', async () => {
    const instance = store(vi.fn().mockResolvedValue(capabilities({ foundationModels: PENDING })));
    await instance.load();
    expect(instance.canSummariseNatively()).toBe(false);
  });

  it('reports a legacy stack when no Apple engine is usable', async () => {
    const instance = store(
      vi
        .fn()
        .mockResolvedValue(capabilities({ speechTranscriber: ABSENT, foundationModels: ABSENT })),
    );
    await instance.load();

    expect(instance.needsDownloadedEngines()).toBe(true);
    expect(instance.canTranscribeNatively()).toBe(false);
    expect(instance.canSummariseNatively()).toBe(false);
    // Translation est natif depuis macOS 14.4 : il reste là, même sur un socle 15–25.
    expect(instance.canTranslateNatively()).toBe(true);
  });

  it('does not claim a legacy stack before anything is loaded', () => {
    const instance = store(vi.fn().mockResolvedValue(null));
    expect(instance.needsDownloadedEngines()).toBe(false);
    expect(instance.canTranscribeNatively()).toBe(false);
  });

  it('stores a typed error and stops loading when the backend fails', async () => {
    const failure: AppError = { kind: 'native', message: 'pont muet' };
    const instance = store(vi.fn().mockRejectedValue(failure));
    await instance.load();

    expect(instance.error()).toEqual(failure);
    expect(instance.capabilities()).toBeNull();
    expect(instance.loading()).toBe(false);
  });

  it('normalises an untyped rejection into an AppError', async () => {
    const instance = store(vi.fn().mockRejectedValue('boum'));
    await instance.load();
    expect(instance.error()).toEqual({ kind: 'native', message: 'boum' });
  });

  it('does not query the backend twice', async () => {
    const load = vi.fn().mockResolvedValue(capabilities());
    const instance = store(load);

    await instance.load();
    await instance.load();

    expect(load).toHaveBeenCalledOnce();
  });

  it('ignores a second call made while the first is still in flight', async () => {
    let release!: (value: SystemCapabilities) => void;
    const load = vi.fn().mockReturnValue(
      new Promise<SystemCapabilities>((resolve) => {
        release = resolve;
      }),
    );
    const instance = store(load);

    const first = instance.load();
    expect(instance.loading()).toBe(true);
    await instance.load();
    expect(load).toHaveBeenCalledOnce();

    release(capabilities());
    await first;
    expect(instance.loading()).toBe(false);
  });
});
