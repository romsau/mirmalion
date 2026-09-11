import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Permissions } from './permissions';
import { SettingsStore } from '../../store/settings/settings.store';
import { DEFAULT_SETTINGS } from '../../models/settings';
import type {
  Permission,
  PermissionStatus,
  PermissionsStatus,
} from '../bridge/permissions/permissions.bridge';
import { PermissionsBridge } from '../bridge/permissions/permissions.bridge';
import { ShortcutBridge } from '../bridge/shortcut/shortcut.bridge';

function permission(status: PermissionStatus, detail: string | null = null): Permission {
  return { status, detail };
}

function statusWith(overrides: Partial<PermissionsStatus> = {}): PermissionsStatus {
  return {
    microphone: permission('granted'),
    accessibility: permission('granted'),
    automation: permission('notDetermined'),
    audioCapture: permission('unknown', "macOS n'expose pas cet état"),
    ...overrides,
  };
}

/** Un magasin de réglages réduit à ce que le service lui demande : deux lectures et une écriture. */
function settingsStore({ loaded = true, accessibilityGranted = false } = {}) {
  return {
    loaded: signal(loaded),
    settings: signal({ ...DEFAULT_SETTINGS, accessibilityGranted }),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function provide(
  tauri: Partial<PermissionsBridge> & Partial<ShortcutBridge>,
  settings: ReturnType<typeof settingsStore> = settingsStore(),
): Permissions {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    // `startShortcut` par défaut : toute lecture qui constate l'Accessibilité accordée le
    // rappelle, et un test qui ne s'y intéresse pas ne doit pas avoir à le savoir.
    providers: [
      { provide: ShortcutBridge, useExisting: PermissionsBridge },
      { provide: PermissionsBridge, useValue: { startShortcut: vi.fn(), ...tauri } },
      { provide: SettingsStore, useValue: settings },
    ],
  });
  return TestBed.inject(Permissions);
}

describe('Permissions', () => {
  /**
   * ⚠️ **Le symptôme que ce rappel existe pour éviter** : l'utilisateur coche l'Accessibilité
   * dans les Réglages Système, revient dans l'application, et ⌃⌥ reste muet jusqu'au prochain
   * lancement. Tout *paraît* en ordre — la case est cochée, l'écran dit « accordée » — et rien
   * ne marche.
   */
  it('puts the keyboard tap back the moment Accessibility is granted', async () => {
    const startShortcut = vi.fn().mockResolvedValue(undefined);
    const getPermissionsStatus = vi
      .fn()
      .mockResolvedValueOnce(statusWith({ accessibility: permission('denied') }))
      .mockResolvedValueOnce(statusWith({ accessibility: permission('granted') }));
    const service = provide({ getPermissionsStatus, startShortcut });

    await service.refresh();
    expect(startShortcut).not.toHaveBeenCalled();

    await service.refresh();
    expect(startShortcut).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Sur la TRANSITION seulement.** `start_shortcut` réinitialise la machine du
   * raccourci : le rappeler à chaque lecture couperait une dictée en cours, et les écrans
   * relisent les autorisations à chaque affichage.
   */
  it('does not put the tap back again on every later read', async () => {
    const startShortcut = vi.fn().mockResolvedValue(undefined);
    const service = provide({
      getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
      startShortcut,
    });

    await service.refresh();
    await service.refresh();
    await service.refresh();

    expect(startShortcut).toHaveBeenCalledOnce();
  });

  it('leaves the tap alone when Accessibility is still refused', async () => {
    const startShortcut = vi.fn().mockResolvedValue(undefined);
    const service = provide({
      getPermissionsStatus: vi
        .fn()
        .mockResolvedValue(statusWith({ accessibility: permission('denied') })),
      startShortcut,
    });

    await service.refresh();
    expect(startShortcut).not.toHaveBeenCalled();
  });

  it('starts empty — nothing is read until someone asks', () => {
    const getPermissionsStatus = vi.fn();
    const service = provide({ getPermissionsStatus });

    expect(service.status()).toBeNull();
    expect(service.dictationReady()).toBe(false);
    expect(getPermissionsStatus).not.toHaveBeenCalled();
  });

  it('publishes what the backend reports', async () => {
    const expected = statusWith();
    const service = provide({ getPermissionsStatus: vi.fn().mockResolvedValue(expected) });

    await expect(service.refresh()).resolves.toEqual(expected);
    expect(service.status()).toEqual(expected);
  });

  it('reflects a change made in System AppSettings while the app was running', async () => {
    const getPermissionsStatus = vi
      .fn()
      .mockResolvedValueOnce(statusWith({ accessibility: permission('notDetermined') }))
      .mockResolvedValueOnce(statusWith({ accessibility: permission('granted') }));
    const service = provide({ getPermissionsStatus });

    await service.refresh();
    expect(service.dictationReady()).toBe(false);

    // C'est tout l'objet du bouton « Revérifier » : l'Accessibilité s'accorde hors de
    // l'application, et rien ne vient nous prévenir.
    await service.refresh();
    expect(service.dictationReady()).toBe(true);
  });

  it('returns null outside a Tauri context', async () => {
    const service = provide({ getPermissionsStatus: vi.fn().mockResolvedValue(null) });

    await expect(service.refresh()).resolves.toBeNull();
    expect(service.status()).toBeNull();
    expect(service.dictationReady()).toBe(false);
  });

  it('lets a backend failure propagate untouched', async () => {
    const failure = { kind: 'permission' as const, message: 'pont muet' };
    const service = provide({ getPermissionsStatus: vi.fn().mockRejectedValue(failure) });

    await expect(service.refresh()).rejects.toEqual(failure);
  });

  describe('dictationReady', () => {
    it('needs both the microphone and Accessibility', async () => {
      for (const overrides of [
        { microphone: permission('denied') },
        { accessibility: permission('notDetermined') },
        { microphone: permission('denied'), accessibility: permission('denied') },
      ]) {
        const service = provide({
          getPermissionsStatus: vi.fn().mockResolvedValue(statusWith(overrides)),
        });
        await service.refresh();
        expect(service.dictationReady()).toBe(false);
      }
    });

    it('ignores automation and audio capture', async () => {
      // Ni l'une ni l'autre ne conditionne la dictée : la voie d'insertion n'est pas
      // tranchée, et l'enregistrement audio ne sert qu'à la session.
      const service = provide({
        getPermissionsStatus: vi
          .fn()
          .mockResolvedValue(
            statusWith({ automation: permission('denied'), audioCapture: permission('denied') }),
          ),
      });

      await service.refresh();
      expect(service.dictationReady()).toBe(true);
    });
  });

  describe('requestMicrophone', () => {
    it('updates only the microphone, leaving the other three untouched', async () => {
      const initial = statusWith({ microphone: permission('notDetermined') });
      const granted = permission('granted');
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(initial),
        requestMicrophone: vi.fn().mockResolvedValue(granted),
      });
      await service.refresh();

      await expect(service.requestMicrophone()).resolves.toEqual(granted);
      expect(service.status()).toEqual({ ...initial, microphone: granted });
    });

    it('reports a refusal without pretending anything else changed', async () => {
      const denied = permission('denied', 'refusée');
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestMicrophone: vi.fn().mockResolvedValue(denied),
      });
      await service.refresh();

      await expect(service.requestMicrophone()).resolves.toEqual(denied);
      expect(service.status()?.microphone).toEqual(denied);
      expect(service.dictationReady()).toBe(false);
    });

    it('leaves the state alone when nothing has been read yet', async () => {
      const service = provide({
        requestMicrophone: vi.fn().mockResolvedValue(permission('granted')),
      });

      await service.requestMicrophone();
      expect(service.status()).toBeNull();
    });

    it('returns null outside a Tauri context', async () => {
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestMicrophone: vi.fn().mockResolvedValue(null),
      });
      const before = await service.refresh();

      await expect(service.requestMicrophone()).resolves.toBeNull();
      expect(service.status()).toEqual(before);
    });

    it('lets a backend failure propagate untouched', async () => {
      const failure = { kind: 'permission' as const, message: 'micro injoignable' };
      const service = provide({ requestMicrophone: vi.fn().mockRejectedValue(failure) });

      await expect(service.requestMicrophone()).rejects.toEqual(failure);
    });
  });

  describe('requestAudioCapture', () => {
    it('updates only audio capture, leaving the other three untouched', async () => {
      const initial = statusWith();
      const granted = permission('granted');
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(initial),
        requestAudioCapture: vi.fn().mockResolvedValue(granted),
      });
      await service.refresh();

      await expect(service.requestAudioCapture()).resolves.toEqual(granted);
      expect(service.status()).toEqual({ ...initial, audioCapture: granted });
    });

    it('leaves the state alone when nothing has been read yet', async () => {
      const service = provide({
        requestAudioCapture: vi.fn().mockResolvedValue(permission('granted')),
      });

      await service.requestAudioCapture();
      expect(service.status()).toBeNull();
    });

    it('returns null outside a Tauri context', async () => {
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAudioCapture: vi.fn().mockResolvedValue(null),
      });
      const before = await service.refresh();

      await expect(service.requestAudioCapture()).resolves.toBeNull();
      expect(service.status()).toEqual(before);
    });

    it('lets a backend failure propagate untouched', async () => {
      const failure = { kind: 'permission' as const, message: 'tap impossible' };
      const service = provide({ requestAudioCapture: vi.fn().mockRejectedValue(failure) });

      await expect(service.requestAudioCapture()).rejects.toEqual(failure);
    });
  });

  describe('refresh vs recheck — la lecture bon marché et la vérification complète', () => {
    it('never touches audio capture on a plain read, however often it runs', async () => {
      // ⚠️ **La raison d'être de la séparation.** L'écran d'onboarding relit en boucle pour
      // détecter un octroi fait dans les Réglages Système ; si `refresh` retentait le tap,
      // l'application en créerait et détruirait un toutes les secondes et demie.
      const requestAudioCapture = vi.fn();
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAudioCapture,
      });

      await service.refresh();
      await service.refresh();
      expect(requestAudioCapture).not.toHaveBeenCalled();
      expect(service.status()?.audioCapture.status).toBe('unknown');
    });

    it('keeps a verdict already given, instead of erasing it with an « unknown »', async () => {
      // Une lecture rend **toujours** `unknown` — il n'y a pas de préflight. Sans ce report,
      // chaque tour de surveillance effacerait ce que l'utilisateur vient d'accorder.
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAudioCapture: vi.fn().mockResolvedValue(permission('granted')),
      });
      await service.refresh();
      await service.requestAudioCapture();

      await service.refresh();
      expect(service.status()?.audioCapture.status).toBe('granted');
    });

    it('does not probe on recheck either, until the user has asked once', async () => {
      // ⚠️ Sinon « Revérifier » ferait surgir un prompt — le principe cardinal contourné par
      // la porte de derrière.
      const requestAudioCapture = vi.fn();
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAudioCapture,
      });

      await service.recheck();
      expect(requestAudioCapture).not.toHaveBeenCalled();
    });

    it('re-tries the tap on recheck once the choice has been made', async () => {
      const requestAudioCapture = vi
        .fn()
        .mockResolvedValueOnce(permission('denied', 'refusée'))
        .mockResolvedValueOnce(permission('granted'));
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAudioCapture,
      });

      await service.refresh();
      await service.requestAudioCapture();
      expect(service.status()?.audioCapture.status).toBe('denied');

      // L'utilisateur est allé cocher la case dans les Réglages Système : seule une nouvelle
      // tentative peut l'apprendre.
      await service.recheck();
      expect(requestAudioCapture).toHaveBeenCalledTimes(2);
      expect(service.status()?.audioCapture.status).toBe('granted');
    });

    it('keeps the last verdict when the re-try comes back empty', async () => {
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAudioCapture: vi
          .fn()
          .mockResolvedValueOnce(permission('granted'))
          .mockResolvedValueOnce(null),
      });
      await service.refresh();
      await service.requestAudioCapture();

      await service.recheck();
      expect(service.status()?.audioCapture.status).toBe('granted');
    });

    it('recheck outside a Tauri context stays null, and probes nothing', async () => {
      const requestAudioCapture = vi.fn();
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(null),
        requestAudioCapture,
      });

      await expect(service.recheck()).resolves.toBeNull();
      expect(requestAudioCapture).not.toHaveBeenCalled();
    });
  });

  describe('requestAccessibility', () => {
    it('registers the app and publishes the state it came back with', async () => {
      const pending = permission('notDetermined', 'à cocher dans les Réglages Système');
      const requestAccessibility = vi.fn().mockResolvedValue(pending);
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAccessibility,
      });
      await service.refresh();

      await expect(service.requestAccessibility()).resolves.toEqual(pending);
      expect(requestAccessibility).toHaveBeenCalledOnce();
      expect(service.status()?.accessibility).toEqual(pending);
    });

    it('does not pretend the permission was granted', async () => {
      // L'octroi se constate à la lecture suivante, jamais au retour de cet appel : inscrire
      // l'application dans un volet de réglages n'accorde rien.
      const service = provide({
        getPermissionsStatus: vi
          .fn()
          .mockResolvedValue(statusWith({ accessibility: permission('notDetermined') })),
        requestAccessibility: vi.fn().mockResolvedValue(permission('notDetermined')),
      });
      await service.refresh();

      await service.requestAccessibility();
      expect(service.dictationReady()).toBe(false);
    });

    it('leaves the state alone when nothing has been read yet', async () => {
      const service = provide({
        requestAccessibility: vi.fn().mockResolvedValue(permission('notDetermined')),
      });

      await service.requestAccessibility();
      expect(service.status()).toBeNull();
    });

    it('returns null outside a Tauri context', async () => {
      const service = provide({
        getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()),
        requestAccessibility: vi.fn().mockResolvedValue(null),
      });
      const before = await service.refresh();

      await expect(service.requestAccessibility()).resolves.toBeNull();
      expect(service.status()).toEqual(before);
    });

    it('lets a backend failure propagate untouched', async () => {
      const failure = { kind: 'permission' as const, message: 'Réglages Système injoignables' };
      const service = provide({ requestAccessibility: vi.fn().mockRejectedValue(failure) });

      await expect(service.requestAccessibility()).rejects.toEqual(failure);
    });
  });

  describe('la mémoire de ce qui a été accordé', () => {
    /**
     * ⚠️ Le drapeau s'écrit à la première lecture qui constate l'octroi, et **une seule fois** :
     * l'Accessibilité s'accorde hors de l'application, et chaque écran relit les autorisations.
     */
    it('remembers the first time Accessibility is seen granted, and only then', async () => {
      const settings = settingsStore();
      const service = provide(
        { getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()) },
        settings,
      );

      await service.refresh();
      expect(settings.update).toHaveBeenCalledWith({ accessibilityGranted: true });

      settings.settings.set({ ...DEFAULT_SETTINGS, accessibilityGranted: true });
      await service.refresh();
      expect(settings.update).toHaveBeenCalledOnce();
    });

    /**
     * ⚠️ **Rien avant que les réglages ne soient relus.** Avant, la valeur en mémoire vaut le
     * défaut : écrire alors graverait un octroi qui n'a peut-être jamais eu lieu.
     */
    it('writes nothing while the settings have not been read back', async () => {
      const settings = settingsStore({ loaded: false });
      const service = provide(
        { getPermissionsStatus: vi.fn().mockResolvedValue(statusWith()) },
        settings,
      );

      await service.refresh();
      expect(settings.update).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ Le seul cas de perte qui soit muet : l'Accessibilité n'a pas de pop-up, le raccourci
     * cesse simplement de répondre. C'est ce que ce signal permet d'expliquer.
     */
    it('says the grant vanished once it had been given', async () => {
      const settings = settingsStore({ accessibilityGranted: true });
      const service = provide(
        {
          getPermissionsStatus: vi
            .fn()
            .mockResolvedValue(statusWith({ accessibility: permission('denied') })),
        },
        settings,
      );
      expect(service.accessibilityLost()).toBe(false);

      await service.refresh();
      expect(service.accessibilityLost()).toBe(true);
    });

    /**
     * ⚠️ **Jamais au premier lancement** : sans octroi passé, une autorisation absente est le
     * travail de l'onboarding, pas une disparition à expliquer.
     */
    it('stays silent when the grant was never given', async () => {
      const service = provide({
        getPermissionsStatus: vi
          .fn()
          .mockResolvedValue(statusWith({ accessibility: permission('denied') })),
      });

      await service.refresh();
      expect(service.accessibilityLost()).toBe(false);
    });

    it('concludes nothing while the settings have not been read back', async () => {
      const settings = settingsStore({ loaded: false, accessibilityGranted: true });
      const service = provide(
        {
          getPermissionsStatus: vi
            .fn()
            .mockResolvedValue(statusWith({ accessibility: permission('denied') })),
        },
        settings,
      );

      await service.refresh();
      expect(service.accessibilityLost()).toBe(false);
    });
  });
});
