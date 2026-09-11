import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LanguageAssets } from './language-assets';
import { ASSET_EVENT } from '../bridge/languages/languages.bridge';
import type { EngineCapabilities } from '../bridge/languages/languages.bridge';
import { LANGUAGES } from '../../models/settings';
import { Invoke } from '../bridge/invoke/invoke';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';

function capabilities(installedLocales: string[]): EngineCapabilities {
  return {
    id: 'apple',
    streaming: true,
    locales: [...LANGUAGES],
    installedLocales,
    detail: null,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const tauri = {
    getSttCapabilities: vi.fn().mockResolvedValue(capabilities(['fr', 'en'])),
    installLanguage: vi.fn().mockResolvedValue(undefined),
    cancelLanguageInstall: vi.fn().mockResolvedValue(undefined),
    getLanguageInstallInFlight: vi.fn().mockResolvedValue(null),
    getLocaleReservations: vi.fn().mockResolvedValue({ reserved: [], maximum: 5 }),
    releaseLanguage: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn().mockResolvedValue(() => undefined),
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Invoke, useValue: tauri },
      { provide: LanguagesBridge, useValue: tauri },
    ],
  });
  return { tauri, service: TestBed.inject(LanguageAssets) };
}

describe('LanguageAssets', () => {
  it('reports only the languages whose resources are really on the machine', async () => {
    // ⚠️ « Couverte » et « utilisable » sont deux choses différentes : le moteur couvre les
    // six, la machine n'en a presque jamais six d'installées.
    const { service } = harness();
    await expect(service.installedLanguages()).resolves.toEqual(['fr', 'en']);
  });

  it('drops a locale the backend reports but the app does not know', async () => {
    // Un contrat qu'on ne vérifie qu'à un bout n'est vérifié nulle part.
    const { service } = harness({
      getSttCapabilities: vi.fn().mockResolvedValue(capabilities(['fr', 'nl', 'tr'])),
    });
    await expect(service.installedLanguages()).resolves.toEqual(['fr']);
  });

  it('claims every language when there is no engine at all', async () => {
    // En navigateur, prétendre que tout manque afficherait un avertissement sur les six.
    const { service } = harness({ getSttCapabilities: vi.fn().mockResolvedValue(null) });
    await expect(service.installedLanguages()).resolves.toEqual(LANGUAGES);
  });

  it('downloads only what it is asked to', async () => {
    const { service, tauri } = harness();
    await service.install('it');
    expect(tauri.installLanguage).toHaveBeenCalledExactlyOnceWith('it');
  });

  it('cancels without needing to know whether anything was running', async () => {
    const { service, tauri } = harness();
    await service.cancel();
    expect(tauri.cancelLanguageInstall).toHaveBeenCalledOnce();
  });

  it('finds a download already under way', async () => {
    // La fenêtre peut être fermée puis rouverte pendant le téléchargement, qui lui continue.
    const { service } = harness({
      getLanguageInstallInFlight: vi.fn().mockResolvedValue('it'),
    });
    await expect(service.inFlight()).resolves.toBe('it');
  });

  it('reports no download when none is running', async () => {
    const { service } = harness();
    await expect(service.inFlight()).resolves.toBeNull();
  });

  it('refuses an in-flight language it does not know', async () => {
    const { service } = harness({
      getLanguageInstallInFlight: vi.fn().mockResolvedValue('nl'),
    });
    await expect(service.inFlight()).resolves.toBeNull();
  });

  it('subscribes on the channel the backend emits on', async () => {
    const { service, tauri } = harness();
    const handler = vi.fn();
    await service.observe(handler);
    expect(tauri.listen).toHaveBeenCalledWith(ASSET_EVENT, handler);
  });

  /**
   * ⚠️⚠️ **LE PONT REND DES IDENTIFIANTS COMPLETS, LE RESTE DE L'APPLICATION DES CODES À DEUX
   * LETTRES.** `es-US`, `de-AT`, `pt-BR`… Comparer ces deux mondes par égalité est exactement le
   * piège qui a fait refuser une langue pourtant installée (2026-08-01) : ici, on ramène au code.
   */
  it('ramène les réservations aux six codes du périmètre', async () => {
    const { service } = harness({
      getLocaleReservations: vi
        .fn()
        .mockResolvedValue({ reserved: ['es-US', 'de-AT', 'pt-BR'], maximum: 5 }),
    });

    await expect(service.reservations()).resolves.toEqual({
      held: ['es', 'de', 'pt'],
      maximum: 5,
    });
  });

  /** Une locale hors périmètre ne doit pas se faufiler dans une liste typée `Language`. */
  it('ignore une réservation qui ne correspond à aucune des six langues', async () => {
    const { service } = harness({
      getLocaleReservations: vi.fn().mockResolvedValue({ reserved: ['nl-NL'], maximum: 5 }),
    });

    await expect(service.reservations()).resolves.toEqual({ held: [], maximum: 5 });
  });

  /**
   * Hors contexte Tauri le pont rend `null`. ⚠️ **Un plafond de zéro, et non cinq** : c'est ce
   * qui fait dire à l'appelant « aucun plafond à faire respecter » plutôt que « plus aucune
   * place », ce qui bloquerait toute installation dans un navigateur.
   */
  it('rend un plafond nul hors contexte Tauri', async () => {
    const { service } = harness({ getLocaleReservations: vi.fn().mockResolvedValue(null) });

    await expect(service.reservations()).resolves.toEqual({ held: [], maximum: 0 });
  });

  it('rend une réservation, et donc son pack', async () => {
    const { service, tauri } = harness();

    await service.release('es');

    expect(tauri.releaseLanguage).toHaveBeenCalledWith('es');
  });
});
