import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Theme } from './theme';
import { Settings } from '../settings/settings';
import { SettingsStore } from '../../store/settings/settings.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../models/settings';
import { ACCENT_PALETTE } from '../../models/accent-palette';
import { SystemBridge } from '../bridge/system/system.bridge';

/**
 * Ce qui se vérifie ici, c'est **ce que le document porte** — pas ce que le service croit
 * avoir écrit. Un test qui n'interrogerait que les signaux passerait alors même que rien ne
 * serait peint.
 */

const root = document.documentElement;

/** Les quatre variables telles que le navigateur les a réellement enregistrées. */
function painted() {
  return {
    theme: root.dataset['theme'],
    accent: root.style.getPropertyValue('--accent'),
    accent600: root.style.getPropertyValue('--accent-600'),
    accent50: root.style.getPropertyValue('--accent-50'),
    accentInk: root.style.getPropertyValue('--accent-ink'),
  };
}

let saved: Partial<AppSettings>[];
/** Les apparences natives demandées au backend, dans l'ordre. */
let nativeThemes: boolean[];
/** Ce que le pont renvoie — une promesse rompue, pour éprouver le chemin d'échec. */
let nativeThemeOutcome: () => Promise<void>;

function setUp(stored: Partial<AppSettings> = {}) {
  saved = [];
  nativeThemes = [];
  nativeThemeOutcome = () => Promise.resolve();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: Settings,
        useValue: {
          load: vi.fn().mockResolvedValue({
            settings: { ...DEFAULT_SETTINGS, ...stored },
            isFirstLaunch: false,
          }),
          save: vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => {
            saved.push(patch);
          }),
          detectInitialSettings: vi.fn().mockResolvedValue({}),
        },
      },
      {
        provide: SystemBridge,
        useValue: {
          setWindowTheme: vi.fn().mockImplementation((dark: boolean) => {
            nativeThemes.push(dark);
            return nativeThemeOutcome();
          }),
        },
      },
    ],
  });
  return { service: TestBed.inject(Theme), store: TestBed.inject(SettingsStore) };
}

/** Laisse l'effet de peinture s'exécuter. */
function flush() {
  TestBed.tick();
}

/**
 * Monte le service **et** relit les réglages, comme au démarrage de l'application.
 *
 * Sans la relecture, le store sert encore ses défauts : c'est le cas du tout premier instant,
 * couvert séparément par le premier test.
 */
async function setUpLoaded(stored: Partial<AppSettings>) {
  const context = setUp(stored);
  await context.store.load();
  flush();
  return context;
}

beforeEach(() => {
  delete root.dataset['theme'];
  root.removeAttribute('style');
});

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
  delete root.dataset['theme'];
  root.removeAttribute('style');
});

describe('Theme', () => {
  it('paints the default theme and its accent as soon as it is injected, before any disk read', () => {
    setUp({ theme: 'dark' });
    flush();

    const klein = ACCENT_PALETTE['klein'].light;
    expect(painted()).toEqual({
      theme: 'light',
      accent: klein.accent,
      accent600: klein.accent600,
      accent50: klein.accent50,
      accentInk: klein.accentInk,
    });
  });

  it('repaints the whole document when the accent changes, with no reload', async () => {
    const { service } = setUp();
    flush();
    expect(painted().accent).toBe(ACCENT_PALETTE['klein'].light.accent);

    await service.setAccent('emerald');
    flush();

    const emerald = ACCENT_PALETTE['emerald'].light;
    expect(painted().accent).toBe(emerald.accent);
    expect(painted().accentInk).toBe(emerald.accentInk);
    // Écrit sur disque, et sur la bonne clé : c'est le thème clair qui était actif.
    expect(saved).toEqual([{ accentLight: 'emerald' }]);
  });

  it('remembers one accent per theme, independently', async () => {
    const { service } = await setUpLoaded({ accentLight: 'rose', accentDark: 'teal' });
    expect(service.accent()).toBe('rose');
    expect(painted().accent).toBe(ACCENT_PALETTE['rose'].light.accent);

    await service.setTheme('dark');
    flush();
    // Basculer de thème réaffiche l'accent PROPRE à ce thème, pas celui qu'on regardait.
    expect(service.accent()).toBe('teal');
    expect(painted()).toMatchObject({
      theme: 'dark',
      accent: ACCENT_PALETTE['teal'].dark.accent,
      accentInk: ACCENT_PALETTE['teal'].dark.accentInk,
    });

    // Changer l'accent en sombre n'écrit que la clé du sombre.
    await service.setAccent('gold');
    flush();
    expect(saved).toEqual([{ theme: 'dark' }, { accentDark: 'gold' }]);

    // Et le clair a gardé le sien.
    await service.setTheme('light');
    flush();
    expect(service.accent()).toBe('rose');
    expect(painted().accent).toBe(ACCENT_PALETTE['rose'].light.accent);
  });

  it('paints the theme the settings were loaded with, not the one the system prefers', async () => {
    await setUpLoaded({ theme: 'dark', accentDark: 'violet' });

    expect(painted()).toMatchObject({
      theme: 'dark',
      accent: ACCENT_PALETTE['violet'].dark.accent,
    });
  });

  it('exposes the theme the settings store holds', async () => {
    const { service } = setUp();
    flush();
    expect(service.theme()).toBe('light');

    await service.setTheme('dark');
    expect(service.theme()).toBe('dark');
  });
});

/**
 * ⚠️ **Le cadre de la fenêtre ne se peint pas en CSS.** macOS le dessine selon l'apparence de
 * la `NSWindow`, qui ignore tout de `data-theme` — d'où un liseré clair d'un pixel en haut
 * d'une application sombre, mesuré sur capture le 2026-07-29. C'est le seul aspect du thème
 * qui doive traverser le pont.
 */
describe('apparence native de la fenêtre', () => {
  it('suit le thème peint, à chaque changement', async () => {
    const { service } = await setUpLoaded({ theme: 'light' });
    expect(nativeThemes.at(-1)).toBe(false);

    await service.setTheme('dark');
    flush();
    expect(nativeThemes.at(-1)).toBe(true);

    await service.setTheme('light');
    flush();
    expect(nativeThemes.at(-1)).toBe(false);
  });

  it('peint le document même si le pont échoue', async () => {
    // L'apparence native est cosmétique : son échec ne doit pas empêcher l'application de
    // se peindre, ni faire remonter une erreur non rattrapée.
    const { service } = setUp({ theme: 'light' });
    // ⚠️ **Après `setUp`, jamais avant** : il réinitialise le comportement du pont. Une
    // première version le réglait avant, si bien que la promesse n'était jamais rompue et
    // que le chemin d'échec n'était pas entré — le test passait sans rien éprouver.
    nativeThemeOutcome = () => Promise.reject(new Error('pont muet'));

    await service.setTheme('dark');
    flush();
    // ⚠️ Le rattrapage vit dans une micro-tâche : sans ce tour de boucle, le test se termine
    // avant que le `catch` ne s'exécute — et le chemin d'échec passerait pour couvert alors
    // qu'il ne serait jamais entré.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(painted().theme).toBe('dark');
    expect(nativeThemes.at(-1)).toBe(true);
  });
});
