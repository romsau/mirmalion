import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { Settings } from './core/services/settings/settings';
import { Snackbar } from './core/services/snackbar/snackbar';
import { DEFAULT_SETTINGS } from './core/models/settings';
import { ACCENT_PALETTE } from './core/models/accent-palette';
import { expectNoAxeViolations } from '../testing/axe';
import { Invoke } from './core/services/bridge/invoke/invoke';
import { SystemBridge } from './core/services/bridge/system/system.bridge';

async function render(settings: Partial<Settings> = {}, windowLabel: string | null = 'main') {
  TestBed.resetTestingModule();
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn() };
  const bridge = {
    windowLabel: vi.fn().mockResolvedValue(windowLabel),
    setWindowTheme: vi.fn().mockResolvedValue(undefined),
    isTauri: () => false,
    listen: vi.fn().mockResolvedValue(() => undefined),
  };
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter([]),
      { provide: Snackbar, useValue: snackbar },
      { provide: Invoke, useValue: bridge },
      { provide: SystemBridge, useValue: bridge },
      {
        provide: Settings,
        useValue: {
          load: vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, isFirstLaunch: false }),
          save: vi.fn().mockResolvedValue(undefined),
          detectInitialSettings: vi.fn().mockReturnValue({}),
          ...settings,
        },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, snackbar, element: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
});

describe('App', () => {
  it('se monte', async () => {
    const { fixture } = await render();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('ne fait que router : la mise en page appartient à la coquille', async () => {
    const { element } = await render();

    expect(element.querySelector('router-outlet')).not.toBeNull();
    // Surtout pas de header ici : les fenêtres secondaires (document, overlay, onboarding)
    // partagent cette racine et n'en ont pas.
    expect(element.querySelector('app-header')).toBeNull();
  });

  /**
   * ⚠️ **Le test qui garde la peinture.** `Theme` n'a d'effet que s'il est instancié,
   * et rien dans le gabarit ne le consomme : une injection retirée par mégarde ne casserait
   * aucun autre test — l'application s'ouvrirait simplement sans thème ni teinte.
   */
  it('monte le service de thème : le document est peint dès la racine', async () => {
    const root = document.documentElement;
    root.removeAttribute('data-theme');

    await render();

    expect(root.dataset['theme']).toBe(DEFAULT_SETTINGS.theme);
    expect(root.style.getPropertyValue('--accent')).toBe(
      ACCENT_PALETTE[DEFAULT_SETTINGS.accentLight].light.accent,
    );
  });

  it('relit les réglages du disque au démarrage', async () => {
    const load = vi.fn().mockResolvedValue({
      settings: { ...DEFAULT_SETTINGS, theme: 'dark' as const },
      isFirstLaunch: false,
    });

    await render({ load });

    expect(load).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('reste utilisable quand le disque refuse de répondre', async () => {
    const { element } = await render({
      load: vi.fn().mockRejectedValue(new Error('disque plein')),
    });

    expect(element.querySelector('router-outlet')).not.toBeNull();
    expect(document.documentElement.dataset['theme']).toBe(DEFAULT_SETTINGS.theme);
  });

  /**
   * ⚠️⚠️ **LE MAGASIN PROMETTAIT DE « SIGNALER » L'ÉCHEC, ET PERSONNE NE L'ÉCOUTAIT**
   * *(P6-05, 2026-08-09)*. Seul l'onboarding consultait `isDegraded` ; partout ailleurs,
   * l'utilisateur voyait sa valeur changée à l'écran et la retrouvait perdue au redémarrage.
   */
  describe('un réglage qui n’a pas pu être écrit', () => {
    it('se dit dans la fenêtre principale', async () => {
      const { snackbar } = await render({
        load: vi.fn().mockRejectedValue(new Error('disque plein')),
      });

      expect(snackbar.error).toHaveBeenCalledOnce();
    });

    /**
     * ⚠️ **Chaque fenêtre porte son propre magasin et échoue de la même façon.** Sans ce garde,
     * un disque plein ferait apparaître la même phrase dans chaque document ouvert — et dans la
     * pilule, qui est une fenêtre sans interaction posée au-dessus de toutes les applications.
     */
    it('ne se dit pas ailleurs que dans la fenêtre principale', async () => {
      const { snackbar } = await render(
        { load: vi.fn().mockRejectedValue(new Error('disque plein')) },
        'overlay',
      );

      expect(snackbar.error).not.toHaveBeenCalled();
    });

    it('ne se dit pas quand tout va bien', async () => {
      const { snackbar } = await render();
      expect(snackbar.error).not.toHaveBeenCalled();
    });
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const { element } = await render();
    await expectNoAxeViolations(element);
  });
});
