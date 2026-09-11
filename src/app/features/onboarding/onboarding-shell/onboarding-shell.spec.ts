import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideRouter } from '@angular/router';
import { OnboardingShell } from './onboarding-shell';
import { Permissions } from '../../../core/services/permissions/permissions';
import { Snackbar } from '../../../core/services/snackbar/snackbar';
import { SettingsStore } from '../../../core/store/settings/settings.store';
import { LanguagesStore } from '../../../core/store/languages/languages.store';
import { Translation } from '../../../core/services/translation/translation';
import { DEFAULT_SETTINGS, type AppSettings, type Language } from '../../../core/models/settings';
import type { PermissionsStatus } from '../../../core/services/bridge/permissions/permissions.bridge';
import { routes } from '../../../app.routes';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { PermissionsBridge } from '../../../core/services/bridge/permissions/permissions.bridge';
import { SystemBridge } from '../../../core/services/bridge/system/system.bridge';

const GRANTED: PermissionsStatus = {
  microphone: { status: 'granted', detail: null },
  accessibility: { status: 'granted', detail: null },
  automation: { status: 'unknown', detail: 'System Events n’est pas lancé' },
  audioCapture: { status: 'unknown', detail: 'macOS n’expose pas cet état' },
};

/** Les doublures, et ce que chaque test a besoin d'observer sur elles. */
function harnessFor(
  options: {
    degraded?: boolean;
    settings?: Partial<AppSettings>;
    installed?: readonly Language[];
  } = {},
) {
  const status = signal<PermissionsStatus | null>(null);
  // ⚠️ La langue par défaut est COHÉRENTE entre le réglage et ce qui est installé : sinon
  // chaque test partirait sur une langue à télécharger, et l'étape d'installation surgirait là
  // où aucun test ne l'attend.
  // Le store des langues est simulé par des signaux inscriptibles : ce sont eux que les tests
  // poussent pour rejouer une installation, comme le backend le ferait.
  const installedLanguages = signal<readonly Language[]>(options.installed ?? ['fr']);
  const install = signal<{ language: Language; progress: number | null } | null>(null);
  const remaining = signal(0);
  const error = signal<unknown>(null);
  // ⚠️ La doublure **imite la file du vrai store** : demander fait monter le reste à faire,
  // annuler le vide. Sans cela l'étape d'installation se traverserait instantanément, et les
  // tests éprouveraient un écran que personne ne voit jamais.
  return {
    status,
    installedLanguages,
    install,
    remaining,
    error,
    languages: {
      installedLanguages,
      install,
      remaining,
      error,
      watch: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(undefined),
      // ⚠️⚠️ **CETTE DOUBLURE RÉPOND PLUS VITE QUE LA VRAIE, ET C'EST UN PIÈGE CONNU** : le vrai
      // `requestInstall` interroge d'abord les réservations, donc la file ne se remplit qu'après
      // un aller-retour asynchrone. En incrémentant tout de suite, on ferme une fenêtre de
      // course qui existe en production — c'est ainsi que celle du 2026-08-02 est passée. Les
      // tests qui visent cette fenêtre **remplacent** ce mock par une version à barrière ; les
      // autres se contentent de celui-ci, qui reste le plus lisible.
      requestInstall: vi.fn(async (_language: Language) => {
        remaining.update((count) => count + 1);
      }),
      cancelInstall: vi.fn(async () => {
        remaining.set(0);
      }),
      clearError: vi.fn(() => error.set(null)),
    },
    permissions: {
      status,
      refresh: vi.fn(async () => {
        status.set(GRANTED);
        return GRANTED;
      }),
      recheck: vi.fn(async () => {
        status.set(GRANTED);
        return GRANTED;
      }),
      requestMicrophone: vi.fn().mockResolvedValue(GRANTED.microphone),
      requestAudioCapture: vi.fn().mockResolvedValue({ status: 'granted', detail: null }),
      requestAccessibility: vi.fn().mockResolvedValue(GRANTED.accessibility),
    },
    settings: {
      update: vi.fn().mockResolvedValue(undefined),
      isDegraded: () => options.degraded === true,
      settings: () => ({
        ...DEFAULT_SETTINGS,
        spokenLanguages: ['fr'] as readonly Language[],
        dictationLanguage: 'fr' as Language,
        ...options.settings,
      }),
    },
    snackbar: { error: vi.fn() },
    translation: { offerDownload: vi.fn().mockResolvedValue(false) },
    tauri: {
      finishOnboarding: vi.fn().mockResolvedValue(undefined),
      focusWindow: vi.fn().mockResolvedValue(undefined),
    },
  };
}

type Doubles = ReturnType<typeof harnessFor>;

async function render(
  doubles: Doubles = harnessFor(),
): Promise<{ fixture: ComponentFixture<OnboardingShell>; doubles: Doubles }> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: SystemBridge, useExisting: PermissionsBridge },
      provideRouter([]),
      { provide: Permissions, useValue: doubles.permissions },
      { provide: SettingsStore, useValue: doubles.settings },
      { provide: LanguagesStore, useValue: doubles.languages },
      { provide: Translation, useValue: doubles.translation },
      { provide: Snackbar, useValue: doubles.snackbar },
      { provide: PermissionsBridge, useValue: doubles.tauri },
    ],
  });
  const fixture = TestBed.createComponent(OnboardingShell);
  await fixture.whenStable();
  return { fixture, doubles };
}

/** `fixture.nativeElement` est `any` : on le type une fois, ici, plutôt qu'à chaque appel. */
function rootOf(fixture: ComponentFixture<OnboardingShell>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Passe de Bienvenue aux Autorisations comme l'utilisateur le fait : en cliquant. */
async function goToPermissions(fixture: ComponentFixture<OnboardingShell>) {
  rootOf(fixture).querySelector<HTMLButtonElement>('.onb-footer button')?.click();
  await fixture.whenStable();
}

function footer(fixture: ComponentFixture<OnboardingShell>) {
  return rootOf(fixture).querySelectorAll<HTMLButtonElement>('.onb-footer button');
}

/** « Continuer » des autorisations : on arrive au choix des langues parlées. */
async function goToSpoken(fixture: ComponentFixture<OnboardingShell>) {
  await goToPermissions(fixture);
  footer(fixture)[1]?.click();
  await fixture.whenStable();
}

/** Le bouton du pied de l'étape des langues — « Continuer » quand rien n'est à obtenir. */
async function goToTranslation(fixture: ComponentFixture<OnboardingShell>) {
  await goToSpoken(fixture);
  footer(fixture)[0]?.click();
  await fixture.whenStable();
}

/**
 * La rangée d'une langue, désignée par son nom.
 *
 * ⚠️ Le nom se lit dans `.lang-name`, jamais dans le texte de la rangée entière : une langue
 * choisie dont les ressources ont disparu porte en plus la marque « à télécharger », et
 * comparer le tout ferait disparaître de la recherche exactement les rangées qu'on éprouve ici.
 */
function rowFor(fixture: ComponentFixture<OnboardingShell>, name: string): HTMLElement {
  const row = [...rootOf(fixture).querySelectorAll<HTMLElement>('.lang-row')].find(
    (candidate) => candidate.querySelector('.lang-name')?.textContent?.trim() === name,
  );
  if (row === undefined) {
    throw new Error(`aucune rangée « ${name} »`);
  }
  return row;
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('OnboardingShell', () => {
  it('shows the welcome step under the application header', async () => {
    const { fixture } = await render();
    const root = rootOf(fixture);

    expect(root.querySelector('app-header')).not.toBeNull();
    expect(root.querySelector('app-onboarding-welcome')).not.toBeNull();
    expect(root.querySelector('app-onboarding-permissions')).toBeNull();
  });

  it('wears the same brand as everywhere else, and no window-specific title', async () => {
    // La maquette y écrivait « Mirmalion » en toutes lettres. Aligné sur décision du porteur :
    // le logo est l'identité de l'application partout, l'onboarding n'y fait pas exception.
    const { fixture } = await render();
    const root = rootOf(fixture);

    expect(root.querySelector('app-header .mark')).not.toBeNull();
    expect(root.textContent).not.toContain('Mirmalion');
  });

  it('offers no navigation — this window has nowhere to go', async () => {
    // ⚠️ Les quatre entrées mènent à des écrans que cette fenêtre n'a pas. Proposer
    // « Options » avant qu'une seule autorisation soit accordée n'aurait aucun sens.
    const { fixture } = await render();
    const root = rootOf(fixture);

    expect(root.querySelector('app-header nav')).toBeNull();
    // Un seul bouton dans toute la fenêtre : l'appel à l'action de l'étape.
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });

  it('makes every background element of the header a drag handle', async () => {
    // ⚠️ Tauri compare la cible **exacte** du clic : un élément sans l'attribut ne déplace
    // rien, et la fenêtre paraît collée à l'écran. Le défaut a déjà été livré deux fois.
    //
    // On parcourt **tous les descendants**, pas seulement les enfants directs : une première
    // version s'arrêtait au premier niveau et serait passée au vert le jour où le groupe
    // `.tb-left` s'est intercalé entre la barre et ses éléments.
    const { fixture } = await render();
    const bar = rootOf(fixture).querySelector('app-header');

    expect(bar?.hasAttribute('data-tauri-drag-region')).toBe(true);
    const descendants = Array.from(bar?.querySelectorAll('*') ?? []);
    expect(descendants.length).toBeGreaterThan(0);
    for (const element of descendants) {
      expect(
        element.hasAttribute('data-tauri-drag-region'),
        `« ${element.className || element.tagName} » ne déplace pas la fenêtre`,
      ).toBe(true);
    }
  });

  it('never puts a drag handle on a control', async () => {
    // Un bouton qui déplace la fenêtre ne se clique plus : le geste part en glisser.
    const { fixture } = await render();
    for (const control of Array.from(rootOf(fixture).querySelectorAll('button, a, input'))) {
      expect(control.hasAttribute('data-tauri-drag-region')).toBe(false);
    }
  });

  it('reads the permissions the moment the second step appears', async () => {
    // ⚠️ **Lire ne demande rien** : c'est ce qui a été mesuré, et c'est ce qui
    // rend cet appel légitime au rendu. Sans lui, l'utilisateur verrait trois lignes sans
    // état — et « Autoriser » sur une permission déjà accordée.
    const { fixture, doubles } = await render();
    await goToPermissions(fixture);

    expect(doubles.permissions.recheck).toHaveBeenCalledOnce();
    expect(rootOf(fixture).querySelector('app-onboarding-permissions')).not.toBeNull();
    expect(rootOf(fixture).querySelector('app-onboarding-welcome')).toBeNull();
  });

  it('makes no system call at all before a click', async () => {
    // Le principe cardinal, vérifié là où il peut l'être : **rien** ne part d'un rendu.
    const { doubles } = await render();

    expect(doubles.permissions.requestMicrophone).not.toHaveBeenCalled();
    expect(doubles.permissions.requestAccessibility).not.toHaveBeenCalled();
    expect(doubles.permissions.requestAudioCapture).not.toHaveBeenCalled();
    expect(doubles.permissions.refresh).not.toHaveBeenCalled();
    expect(doubles.permissions.recheck).not.toHaveBeenCalled();
  });

  it('prompts for the microphone only on the microphone row', async () => {
    const { fixture, doubles } = await render();
    doubles.status.set(null);
    await goToPermissions(fixture);
    doubles.status.set({ ...GRANTED, microphone: { status: 'notDetermined', detail: null } });
    await fixture.whenStable();

    const rows = rootOf(fixture).querySelectorAll('app-permission-row');
    rows[0]?.querySelector<HTMLButtonElement>('button')?.click();
    await fixture.whenStable();

    expect(doubles.permissions.requestMicrophone).toHaveBeenCalledOnce();
    expect(doubles.permissions.requestAccessibility).not.toHaveBeenCalled();
    expect(doubles.permissions.requestAudioCapture).not.toHaveBeenCalled();
    // ⚠️ Sans cela, la fenêtre retombe derrière les autres applications au retour du prompt :
    // l'app n'est pas dans le Dock, macOS rend le premier plan à qui l'avait avant.
    expect(doubles.tauri.focusWindow).toHaveBeenCalledOnce();
  });

  it('registers the app for accessibility, then sends the user to the pane', async () => {
    const { fixture, doubles } = await render();
    await goToPermissions(fixture);
    doubles.status.set({ ...GRANTED, accessibility: { status: 'denied', detail: null } });
    await fixture.whenStable();

    const rows = rootOf(fixture).querySelectorAll('app-permission-row');
    rows[1]?.querySelector<HTMLButtonElement>('button')?.click();
    await fixture.whenStable();

    expect(doubles.permissions.requestAccessibility).toHaveBeenCalledOnce();
    expect(doubles.permissions.requestMicrophone).not.toHaveBeenCalled();
    // ⚠️ **Et surtout pas de retour au premier plan ici** : on vient d'envoyer l'utilisateur
    // dans les Réglages Système pour y cocher une case. Lui repasser devant l'en empêcherait.
    expect(doubles.tauri.focusWindow).not.toHaveBeenCalled();
  });

  it('asks for audio capture here, and not at the first live', async () => {
    // ⚠️ Cette permission n'a ni préflight ni demande explicite : le seul déclencheur possible
    // est la création d'un tap audio. C'est le prix de l'accorder dans l'onboarding plutôt
    // qu'au milieu d'une session — et c'est ce que la règle demande.
    const { fixture, doubles } = await render();
    await goToPermissions(fixture);
    doubles.status.set({ ...GRANTED, audioCapture: { status: 'unknown', detail: null } });
    await fixture.whenStable();

    const rows = rootOf(fixture).querySelectorAll('app-permission-row');
    rows[2]?.querySelector<HTMLButtonElement>('button')?.click();
    await fixture.whenStable();

    expect(doubles.permissions.requestAudioCapture).toHaveBeenCalledOnce();
    expect(doubles.permissions.requestMicrophone).not.toHaveBeenCalled();
    expect(doubles.permissions.requestAccessibility).not.toHaveBeenCalled();
    expect(doubles.tauri.focusWindow).toHaveBeenCalledOnce();
  });

  it('releases the row and speaks up when the bridge throws', async () => {
    // Deux défauts en un : sans le `finally`, le bouton resterait désactivé pour toujours ;
    // sans le `catch`, la promesse rejetée n'aurait personne pour la rattraper — un rejet non
    // traité, muet pour l'utilisateur, alors que le gabarit est le seul appelant.
    const { fixture, doubles } = await render();
    doubles.permissions.requestMicrophone.mockRejectedValue(new Error('pont muet'));
    await goToPermissions(fixture);
    doubles.status.set({ ...GRANTED, microphone: { status: 'notDetermined', detail: null } });
    await fixture.whenStable();

    const button = rootOf(fixture)
      .querySelectorAll('app-permission-row')[0]
      ?.querySelector<HTMLButtonElement>('button');
    button?.click();
    await fixture.whenStable();

    expect(
      rootOf(fixture)
        .querySelectorAll('app-permission-row')[0]
        ?.querySelector<HTMLButtonElement>('button')?.disabled,
    ).toBe(false);
    expect(doubles.snackbar.error).toHaveBeenCalledOnce();
  });

  it('rescans everything on Revérifier — including what costs a tap', async () => {
    const { fixture, doubles } = await render();
    await goToPermissions(fixture);
    doubles.permissions.recheck.mockClear();

    footer(fixture)[0]?.click();
    await fixture.whenStable();

    expect(doubles.permissions.recheck).toHaveBeenCalledOnce();
  });

  it('reports a rescan that could not be done', async () => {
    const { fixture, doubles } = await render();
    doubles.permissions.recheck.mockRejectedValue(new Error('pont muet'));
    await goToPermissions(fixture);

    expect(doubles.snackbar.error).toHaveBeenCalledOnce();
  });

  describe('surveillance des autorisations', () => {
    // ⚠️ **Le défaut que cette surveillance corrige** (observé le 2026-07-29) : l'utilisateur
    // revenait des Réglages Système, où il venait d'accorder l'Accessibilité, devant une ligne
    // inchangée — et devait deviner qu'il fallait cliquer « Revérifier ».
    beforeEach(() => {
      // ⚠️ **Seul `setInterval` est simulé.** Un faux temps complet fige aussi les promesses
      // et les micro-tâches, et `fixture.whenStable()` n'aboutit alors jamais : la suite
      // expirait à 5 s. On ne simule que ce dont la surveillance dépend.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('watches nothing while the welcome step is up', async () => {
      const { doubles } = await render();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(doubles.permissions.refresh).not.toHaveBeenCalled();
    });

    it('reads on its own once the permissions step is up', async () => {
      const { fixture, doubles } = await render();
      await goToPermissions(fixture);
      doubles.permissions.refresh.mockClear();

      await vi.advanceTimersByTimeAsync(4_000);
      expect(doubles.permissions.refresh.mock.calls.length).toBeGreaterThan(0);
    });

    it('reads, and never asks — the poll must not be a back door', async () => {
      // Ce que la surveillance ne doit **jamais** faire : retenter le tap audio. Un tap créé
      // et détruit toutes les secondes et demie, ce n'est pas de la surveillance.
      const { fixture, doubles } = await render();
      await goToPermissions(fixture);
      doubles.permissions.recheck.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(doubles.permissions.recheck).not.toHaveBeenCalled();
      expect(doubles.permissions.requestMicrophone).not.toHaveBeenCalled();
      expect(doubles.permissions.requestAudioCapture).not.toHaveBeenCalled();
    });

    it('holds still while a system prompt is waiting for an answer', async () => {
      // Une lecture qui atterrirait après la réponse de l'utilisateur, mais avec un état
      // d'avant, écraserait l'octroi qu'il vient de donner.
      const { fixture, doubles } = await render();
      let answer = () => undefined as void;
      doubles.permissions.requestMicrophone.mockImplementation(
        () => new Promise((resolve) => (answer = () => resolve(GRANTED.microphone))),
      );
      await goToPermissions(fixture);
      doubles.status.set({ ...GRANTED, microphone: { status: 'notDetermined', detail: null } });
      await fixture.whenStable();

      rootOf(fixture)
        .querySelectorAll('app-permission-row')[0]
        ?.querySelector<HTMLButtonElement>('button')
        ?.click();
      doubles.permissions.refresh.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(doubles.permissions.refresh).not.toHaveBeenCalled();

      answer();
      await fixture.whenStable();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(doubles.permissions.refresh.mock.calls.length).toBeGreaterThan(0);
    });

    it('stays silent when a watch pass fails', async () => {
      // Une snackbar toutes les secondes et demie transformerait une gêne en harcèlement.
      const { fixture, doubles } = await render();
      await goToPermissions(fixture);
      doubles.snackbar.error.mockClear();
      doubles.permissions.refresh.mockRejectedValue(new Error('pont muet'));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(doubles.snackbar.error).not.toHaveBeenCalled();
    });

    it('stops watching when the window goes away', async () => {
      const { fixture, doubles } = await render();
      await goToPermissions(fixture);
      fixture.destroy();
      doubles.permissions.refresh.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(doubles.permissions.refresh).not.toHaveBeenCalled();
    });
  });

  it('writes the flag BEFORE closing the window, never after', async () => {
    // ⚠️ La fenêtre qui exécute ce code est celle que la commande ferme : une écriture encore
    // en vol y mourrait avec elle, et l'onboarding se rejouerait au lancement suivant.
    const order: string[] = [];
    const doubles = harnessFor();
    doubles.settings.update.mockImplementation(async () => {
      order.push('drapeau');
    });
    doubles.tauri.finishOnboarding.mockImplementation(async () => {
      order.push('fermeture');
    });

    const { fixture } = await render(doubles);
    await goToTranslation(fixture);
    order.length = 0; // l'entrée dans la traduction a déjà écrit les langues parlées
    footer(fixture)[0]?.click();
    await fixture.whenStable();

    expect(doubles.settings.update).toHaveBeenLastCalledWith({
      translationLanguages: [],
      onboardingCompleted: true,
    });
    expect(order).toEqual(['drapeau', 'fermeture']);
  });

  it('says so when the flag could not be saved', async () => {
    // Le store n'échoue jamais bruyamment. Sans ce contrôle, l'onboarding se rejouerait sans
    // que personne comprenne pourquoi — exactement l'échec silencieux que la règle interdit.
    const { fixture, doubles } = await render(harnessFor({ degraded: true }));
    await goToTranslation(fixture);
    footer(fixture)[0]?.click();
    await fixture.whenStable();

    expect(doubles.snackbar.error).toHaveBeenCalledOnce();
    // On ferme quand même : l'utilisateur a demandé à continuer.
    expect(doubles.tauri.finishOnboarding).toHaveBeenCalledOnce();
  });

  it('keeps the window usable when the exit itself fails', async () => {
    // En succès, la promesse ne revient jamais — le webview est détruit. Seul l'échec revient,
    // et il laisse l'utilisateur devant l'onboarding : se taire le laisserait cliquer dans le
    // vide.
    const { fixture, doubles } = await render();
    doubles.tauri.finishOnboarding.mockRejectedValue(new Error('fenêtre introuvable'));
    await goToTranslation(fixture);
    footer(fixture)[0]?.click();
    await fixture.whenStable();

    expect(doubles.snackbar.error).toHaveBeenCalledOnce();
    expect(rootOf(fixture).querySelector('app-onboarding-translation')).not.toBeNull();
  });

  it('stays quiet when the flag was saved', async () => {
    const { fixture, doubles } = await render();
    await goToTranslation(fixture);
    footer(fixture)[0]?.click();
    await fixture.whenStable();

    expect(doubles.snackbar.error).not.toHaveBeenCalled();
  });

  describe('les trois étapes de langues', () => {
    it('enchaîne les autorisations sur le choix des langues parlées', async () => {
      const { fixture } = await render();
      await goToSpoken(fixture);

      expect(rootOf(fixture).querySelector('app-onboarding-spoken')).not.toBeNull();
      expect(rootOf(fixture).querySelector('app-onboarding-permissions')).toBeNull();
    });

    it('n’engage AUCUN téléchargement tant que rien n’est demandé', async () => {
      // Le principe cardinal, appliqué au réseau : cocher est gratuit, seul le bouton engage.
      const { fixture, doubles } = await render();
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();

      expect(doubles.languages.requestInstall).not.toHaveBeenCalled();
    });

    it('n’écrit AUCUNE langue tant qu’on n’a pas quitté l’étape', async () => {
      // Une écriture à chaque clic laisserait, en cas d'abandon, une langue activée mais
      // absente : l'application promettrait une dictée qu'elle ne peut pas tenir.
      const { fixture, doubles } = await render();
      await goToSpoken(fixture);
      doubles.settings.update.mockClear();
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();

      expect(doubles.settings.update).not.toHaveBeenCalled();
    });

    it('saute l’installation quand rien de neuf n’est coché', async () => {
      const { fixture, doubles } = await render();
      await goToTranslation(fixture);

      expect(doubles.languages.requestInstall).not.toHaveBeenCalled();
      expect(rootOf(fixture).querySelector('app-onboarding-translation')).not.toBeNull();
    });

    it('demande TOUTES les langues manquantes, et la file les enchaîne', async () => {
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      rowFor(fixture, 'Portugais').click();
      await fixture.whenStable();

      footer(fixture)[0]?.click();
      await fixture.whenStable();

      expect(doubles.languages.requestInstall).toHaveBeenCalledWith('it');
      expect(doubles.languages.requestInstall).toHaveBeenCalledWith('pt');
      expect(rootOf(fixture).querySelector('app-onboarding-download')).not.toBeNull();
    });

    /**
     * ⚠️⚠️ **LA COURSE DU 2026-08-02, TROUVÉE AU PREMIER PASSAGE RÉEL DE L'ONBOARDING.**
     * `actOnSpoken` change d'étape **avant** de remplir la file, et remplir la file coûte un
     * aller-retour IPC par langue. L'effet de sortie voyait donc `remaining() === 0` sur une
     * file pas encore née, et enchaînait sur la traduction : l'étape d'installation se sautait
     * elle-même, les langues s'installaient en arrière-plan, et **plus personne ne les
     * activait** — `enterTranslation` filtre sur ce qui est installé, et rien ne l'était.
     * Symptôme rapporté : « l'installation a semblé instantanée, je suis tout de suite passé à
     * la page des langues de traduction ».
     *
     * ⚠️⚠️ **ET VOICI POURQUOI AUCUN TEST NE L'AVAIT VUE : LA DOUBLURE ÉTAIT PLUS RAPIDE QUE LA
     * RÉALITÉ.** Le `requestInstall` simulé incrémente la file *synchroniquement*, donc la
     * fenêtre de course n'existait pas dans les tests. On la rouvre ici avec une barrière que le
     * test tient lui-même. *Une doublure qui répond plus vite que la vraie ne peut, par
     * construction, reproduire aucune course.*
     */
    it('n’enchaîne PAS sur la traduction pendant que la file se remplit', async () => {
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      rowFor(fixture, 'Portugais').click();
      await fixture.whenStable();

      let openTheGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openTheGate = resolve;
      });
      doubles.languages.requestInstall = vi.fn(async () => {
        await gate;
        doubles.remaining.update((count) => count + 1);
      });

      footer(fixture)[0]?.click();
      await fixture.whenStable();

      // La file est encore vide — et l'étape ne doit surtout pas en conclure qu'elle a fini.
      expect(rootOf(fixture).querySelector('app-onboarding-download')).not.toBeNull();
      expect(rootOf(fixture).querySelector('app-onboarding-translation')).toBeNull();

      openTheGate();
      // ⚠️ Un `setTimeout(0)` et non un `whenStable()` : la boucle a encore un tour par langue
      // à dérouler en microtâches, et `whenStable` rend la main avant qu'elles soient épuisées.
      // C'est la fin du REMPLISSAGE qu'on attend ici, pas la stabilité de l'affichage.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
      doubles.installedLanguages.set(['fr', 'it', 'pt']);
      doubles.remaining.set(0);
      await fixture.whenStable();

      // ⚠️ Et c'est bien ce qui vient d'arriver qui s'active : le défaut n'écrivait que les
      // langues déjà présentes avant l'étape.
      expect(doubles.settings.update).toHaveBeenCalledWith({
        spokenLanguages: ['fr', 'it', 'pt'],
      });
    });

    /**
     * ⚠️ Annuler **pendant** le remplissage doit arrêter le remplissage. La fenêtre est étroite
     * — un aller-retour par langue — mais le geste qu'elle trahit est le plus explicite de
     * l'écran : sans ce garde, la boucle remettait en file les langues suivantes juste après
     * que l'utilisateur a dit non.
     */
    it('cesse de remplir la file dès qu’on annule', async () => {
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      rowFor(fixture, 'Portugais').click();
      await fixture.whenStable();

      let openTheGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openTheGate = resolve;
      });
      const asked: string[] = [];
      doubles.languages.requestInstall = vi.fn(async (language: Language) => {
        asked.push(language);
        await gate;
      });

      footer(fixture)[0]?.click();
      await fixture.whenStable();
      // On annule alors que la première demande n'a pas encore rendu la main.
      rootOf(fixture).querySelector<HTMLButtonElement>('app-progress-bar button')?.click();
      await fixture.whenStable();
      openTheGate();
      await fixture.whenStable();

      expect(asked).toEqual(['it']);
      expect(rootOf(fixture).querySelector('app-onboarding-spoken')).not.toBeNull();
    });

    it('nomme une seule langue, et n’en énumère jamais plusieurs', async () => {
      const { fixture } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      expect(rootOf(fixture).querySelector('.label')?.textContent?.trim()).toBe(
        'Installation de la langue italienne',
      );
    });

    it('ne les énumère pas quand il y en a plusieurs', async () => {
      // Une liste de cinq noms sous une barre unique laisserait croire qu'on suit celle du haut.
      const { fixture } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      rowFor(fixture, 'Portugais').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      expect(rootOf(fixture).querySelector('.label')?.textContent?.trim()).toBe(
        'Installation des langues',
      );
    });

    it('« Annuler » interrompt vraiment, et ramène composer', async () => {
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      rootOf(fixture).querySelector<HTMLButtonElement>('app-progress-bar button')?.click();
      await fixture.whenStable();

      expect(doubles.languages.cancelInstall).toHaveBeenCalledOnce();
      expect(rootOf(fixture).querySelector('app-onboarding-spoken')).not.toBeNull();
    });

    it('enchaîne sur la traduction quand la file se vide sans erreur', async () => {
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      // Le backend a fini : la langue est là, la file est vide.
      doubles.installedLanguages.set(['fr', 'it']);
      doubles.remaining.set(0);
      await fixture.whenStable();

      expect(rootOf(fixture).querySelector('app-onboarding-translation')).not.toBeNull();
      expect(doubles.settings.update).toHaveBeenCalledWith({ spokenLanguages: ['fr', 'it'] });
    });

    it('RAMÈNE au choix des langues quand un téléchargement échoue, et le dit', async () => {
      // Décision du porteur : l'utilisateur y décoche la langue fautive et repart. Rien ne le
      // bloque — le bouton redevient « Continuer » dès que plus rien de neuf n'est coché.
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      doubles.error.set(new Error('réseau'));
      doubles.remaining.set(0);
      await fixture.whenStable();

      expect(doubles.snackbar.error).toHaveBeenCalledOnce();
      expect(rootOf(fixture).querySelector('app-onboarding-spoken')).not.toBeNull();
      expect(doubles.languages.clearError).toHaveBeenCalled();
    });

    it('n’active JAMAIS une langue dont les ressources ne sont pas arrivées', async () => {
      const { fixture, doubles } = await render(harnessFor({ installed: ['fr'] }));
      await goToSpoken(fixture);
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      // Annulé : rien n'est installé. On revient composer, puis on décoche et on continue.
      rootOf(fixture).querySelector<HTMLButtonElement>('app-progress-bar button')?.click();
      await fixture.whenStable();
      rowFor(fixture, 'Italien').click();
      await fixture.whenStable();
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      expect(doubles.settings.update).toHaveBeenCalledWith({ spokenLanguages: ['fr'] });
    });

    it('ne laisse JAMAIS la liste des langues parlées vide', async () => {
      // Cas de repli : la file s'est vidée sans erreur, mais rien n'est arrivé. Écrire la liste
      // filtrée telle quelle la viderait — et une application de dictée sans langue ne dicte
      // rien. On garde alors la valeur en place.
      const { fixture, doubles } = await render(
        harnessFor({ installed: [], settings: { spokenLanguages: ['fr'] } }),
      );
      await goToSpoken(fixture);
      footer(fixture)[0]?.click();
      await fixture.whenStable();

      doubles.remaining.set(0);
      await fixture.whenStable();

      expect(doubles.settings.update).toHaveBeenCalledWith({ spokenLanguages: ['fr'] });
    });

    describe('la case pré-cochée de la traduction', () => {
      it('coche la langue détectée quand l’utilisateur en parle plusieurs', async () => {
        const { fixture } = await render(
          harnessFor({
            installed: ['fr', 'en'],
            settings: { spokenLanguages: ['fr', 'en'], dictationLanguage: 'fr' },
          }),
        );
        await goToTranslation(fixture);

        expect(
          rowFor(fixture, 'Français').querySelector('button')?.getAttribute('aria-checked'),
        ).toBe('true');
      });

      it('ne coche RIEN quand il n’en parle qu’une', async () => {
        // « Dicter en français, traduire vers le français » ne ferait rien.
        const { fixture } = await render(
          harnessFor({ installed: ['fr'], settings: { spokenLanguages: ['fr'] } }),
        );
        await goToTranslation(fixture);

        for (const row of rootOf(fixture).querySelectorAll('.lang-row button')) {
          expect(row.getAttribute('aria-checked')).toBe('false');
        }
      });

      it('se décoche, et une autre cible se coche', async () => {
        const { fixture, doubles } = await render(
          harnessFor({
            installed: ['fr', 'en'],
            settings: { spokenLanguages: ['fr', 'en'], dictationLanguage: 'fr' },
          }),
        );
        await goToTranslation(fixture);

        rowFor(fixture, 'Français').click(); // la pré-cochée s'éteint
        rowFor(fixture, 'Italien').click();
        await fixture.whenStable();

        doubles.settings.update.mockClear();
        footer(fixture)[0]?.click();
        await fixture.whenStable();

        expect(doubles.settings.update).toHaveBeenLastCalledWith({
          translationLanguages: ['it'],
          onboardingCompleted: true,
        });
      });

      it('ne demande AUCUNE feuille à l’ouverture de l’écran', async () => {
        // ⚠️ C'est la garde la plus importante de cette étape : la case pré-cochée est posée
        // sur le signal, pas par le geste. Sinon une feuille système surgirait à l'arrivée.
        const { doubles } = await render(
          harnessFor({
            installed: ['fr', 'en'],
            settings: { spokenLanguages: ['fr', 'en'], dictationLanguage: 'fr' },
          }),
        );
        expect(doubles.translation.offerDownload).not.toHaveBeenCalled();
      });

      it('la demande au CLIC, avec les langues parlées', async () => {
        const { fixture, doubles } = await render(
          harnessFor({
            installed: ['fr', 'en'],
            settings: { spokenLanguages: ['fr', 'en'], dictationLanguage: 'fr' },
          }),
        );
        await goToTranslation(fixture);
        rowFor(fixture, 'Italien').click();
        await fixture.whenStable();

        expect(doubles.translation.offerDownload).toHaveBeenCalledWith('it', ['fr', 'en']);
      });

      it('ne demande rien quand on DÉCOCHE', async () => {
        const { fixture, doubles } = await render(
          harnessFor({
            installed: ['fr', 'en'],
            settings: { spokenLanguages: ['fr', 'en'], dictationLanguage: 'fr' },
          }),
        );
        await goToTranslation(fixture);
        rowFor(fixture, 'Français').click(); // la pré-cochée
        await fixture.whenStable();

        expect(doubles.translation.offerDownload).not.toHaveBeenCalled();
      });

      it('est un choix ENREGISTRÉ, jamais un geste', async () => {
        // Elle ne déclenche aucune préparation : sinon une feuille système surgirait à
        // l'ouverture de l'écran.
        const { fixture, doubles } = await render(
          harnessFor({
            installed: ['fr', 'en'],
            settings: { spokenLanguages: ['fr', 'en'], dictationLanguage: 'fr' },
          }),
        );
        await goToTranslation(fixture);
        doubles.settings.update.mockClear();
        footer(fixture)[0]?.click();
        await fixture.whenStable();

        expect(doubles.settings.update).toHaveBeenLastCalledWith({
          translationLanguages: ['fr'],
          onboardingCompleted: true,
        });
      });
    });
  });

  it('has no accessibility violations, on either step', async () => {
    const { fixture } = await render();
    await expectNoAxeViolations(rootOf(fixture));

    await goToPermissions(fixture);
    await expectNoAxeViolations(rootOf(fixture));
  });

  it('is what the /onboarding route actually loads', async () => {
    // Avec le **vrai** tableau de routes : c'est la seule façon de prouver que la fenêtre
    // d'onboarding, dont l'URL est posée avant le démarrage d'Angular, atterrit bien ici.
    // Vérifier la forme du tableau ne dirait rien de ce que le routeur charge.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SystemBridge, useExisting: PermissionsBridge },
        provideRouter(routes),
        {
          provide: PermissionsBridge,
          useValue: { setWindowTheme: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    });

    const harness = await RouterTestingHarness.create('/onboarding');
    harness.detectChanges();

    const element = harness.fixture.nativeElement as HTMLElement;
    expect(element.querySelector('app-onboarding-welcome')).not.toBeNull();
  });
});
