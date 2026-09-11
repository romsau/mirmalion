import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { appConfig } from './app.config';
import { applyWindowRoute, rememberRouteAcrossLocaleChange, routes } from './app.routes';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: currentLabel }),
}));

/** L'étiquette que la fenêtre courante annonce, pilotée par chaque test. */
let currentLabel = 'main';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/**
 * La configuration de démarrage n'a l'air de rien, mais c'est elle qui décide de ce que
 * l'application a sous les pieds. On ne vérifie pas la forme du tableau de providers — on
 * vérifie que **ce qui en dépend fonctionne** une fois monté.
 */
describe('appConfig', () => {
  it('boots an injector where routing works', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...appConfig.providers] });

    expect(TestBed.inject(Router)).toBeInstanceOf(Router);
  });
});

/**
 * Le **comportement** des routes est éprouvé par `window-shell.component.spec.ts`, qui navigue
 * réellement dans les quatre écrans avec le vrai routeur. Ce qui se vérifie ici, c'est la
 * promesse structurelle qu'aucune navigation ne révélerait : que rien n'est chargé d'emblée.
 */
describe('routes', () => {
  it('charge tout paresseusement — coquille comprise', () => {
    const everyRoute = routes.flatMap((route) => [route, ...(route.children ?? [])]);
    const rendering = everyRoute.filter((route) => route.redirectTo === undefined);

    expect(rendering.length).toBeGreaterThan(0);
    for (const route of rendering) {
      expect(route.component, `la route « ${route.path} » est chargée d’emblée`).toBeUndefined();
      expect(route.loadComponent).toBeTypeOf('function');
    }
  });

  it('chaque route paresseuse résout bien un composant', async () => {
    // Un chemin d'import faux ne se voit pas à la compilation : `loadComponent` n'est
    // qu'une fonction. La seule façon de le constater est de l'appeler.
    const everyRoute = routes.flatMap((route) => [route, ...(route.children ?? [])]);
    for (const route of everyRoute) {
      if (route.loadComponent === undefined) {
        continue;
      }
      await expect(route.loadComponent()).resolves.toBeTypeOf('function');
    }
  });

  it('déclare l’onboarding en route SŒUR, jamais sous la coquille', () => {
    // C'est ce qui lui évite d'hériter du header global et de la géométrie paysage. En
    // enfant, il aurait fallu les masquer par des conditions.
    expect(routes.some((route) => route.path === 'onboarding')).toBe(true);

    const shell = routes.find((route) => route.path === '');
    expect(shell?.children?.some((child) => child.path === 'onboarding')).not.toBe(true);
  });
});

/**
 * L'étiquette de la fenêtre **est** la route. Ce qui se vérifie ici est ce dont dépend chaque
 * fenêtre secondaire à venir — overlay, document, filedoc.
 */
describe('applyWindowRoute', () => {
  const initialUrl = '/index.html';

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    currentLabel = 'main';
    history.replaceState(null, '', initialUrl);
    // La route retenue survit à la fenêtre en test comme elle survivrait à un rechargement :
    // c'est tout son intérêt, et c'est pourquoi il faut la balayer entre deux cas.
    sessionStorage.clear();
  });

  it('ouvre la route qui porte le nom de la fenêtre', async () => {
    window.__TAURI_INTERNALS__ = {};
    currentLabel = 'onboarding';

    await applyWindowRoute();
    expect(location.pathname).toBe('/onboarding');
  });

  // ⚠️ **Une fenêtre en plusieurs exemplaires porte son identifiant dans son étiquette.** Le
  // tiret devient un séparateur de segments parce qu'Angular n'apparie ses paramètres que sur
  // un segment entier : `filedoc-:id` ne s'écrit pas.
  it('coupe l’étiquette d’une fenêtre ouverte en plusieurs exemplaires', async () => {
    window.__TAURI_INTERNALS__ = {};
    currentLabel = 'filedoc-3';

    await applyWindowRoute();
    expect(location.pathname).toBe('/filedoc/3');
  });

  it('laisse la fenêtre principale sur l’URL de départ', async () => {
    // Elle est la seule à n'avoir pas de route à elle : c'est la coquille qui redirige.
    window.__TAURI_INTERNALS__ = {};
    currentLabel = 'main';

    await applyWindowRoute();
    expect(location.pathname).toBe(initialUrl);
  });

  it('ne touche à rien hors contexte Tauri', async () => {
    // `npm run start:web` : pas de fenêtre nommée, donc pas d'URL à imposer.
    await applyWindowRoute();
    expect(location.pathname).toBe(initialUrl);
  });

  // ⚠️ **Changer de langue fait charger un autre bundle**, donc une autre URL. Sans cette
  // reprise, on quitterait les Options à l'instant même où l'on vient d'y régler la langue.
  it('rouvre la fenêtre principale sur la route retenue avant un changement de langue', async () => {
    window.__TAURI_INTERNALS__ = {};
    currentLabel = 'main';
    rememberRouteAcrossLocaleChange('/options/langues');

    await applyWindowRoute();

    expect(location.pathname).toBe('/options/langues');
  });

  // ⚠️ **Consommée une seule fois.** Laissée en place, elle ressusciterait au prochain
  // rechargement — l'utilisateur retomberait sur les Options sans l'avoir demandé.
  it('ne rejoue pas la route retenue au démarrage suivant', async () => {
    window.__TAURI_INTERNALS__ = {};
    currentLabel = 'main';
    rememberRouteAcrossLocaleChange('/options/langues');
    await applyWindowRoute();
    history.replaceState(null, '', initialUrl);

    await applyWindowRoute();

    expect(location.pathname).toBe(initialUrl);
  });

  // Une fenêtre secondaire redéduit sa route de son étiquette : elle n'a rien à retenir, et
  // une route restée d'un autre contexte ne doit pas la détourner.
  it('ignore la route retenue pour une fenêtre secondaire', async () => {
    window.__TAURI_INTERNALS__ = {};
    currentLabel = 'filedoc-1';
    rememberRouteAcrossLocaleChange('/options/langues');

    await applyWindowRoute();

    expect(location.pathname).toBe('/filedoc/1');
  });

  /**
   * ⚠️⚠️ **CHAQUE LANGUE VIT DANS SON DOSSIER**, et le routeur retire ce préfixe avant de
   * comparer : dans le bundle allemand, `/filedoc/3` désigne une route qu'il ne reconnaît pas.
   *
   * ⚠️ **Le défaut dormait depuis que les fenêtres secondaires existent** : aucun bundle autre
   * que le français n'avait jamais été chargé, faute de traductions. Il serait apparu à la
   * première fenêtre-document ouverte par un utilisateur allemand.
   */
  describe('dans un bundle qui n’est pas la locale source', () => {
    let base: HTMLBaseElement;

    beforeEach(() => {
      base = document.createElement('base');
      base.setAttribute('href', '/de/');
      document.head.append(base);
    });

    afterEach(() => base.remove());

    it('écrit la route d’une fenêtre secondaire SOUS le dossier de la langue', async () => {
      window.__TAURI_INTERNALS__ = {};
      currentLabel = 'filedoc-3';

      await applyWindowRoute();

      expect(location.pathname).toBe('/de/filedoc/3');
    });

    it('y remet aussi la route retenue à travers un changement de langue', async () => {
      window.__TAURI_INTERNALS__ = {};
      currentLabel = 'main';
      rememberRouteAcrossLocaleChange('/options/langues');

      await applyWindowRoute();

      expect(location.pathname).toBe('/de/options/langues');
    });
  });
});
