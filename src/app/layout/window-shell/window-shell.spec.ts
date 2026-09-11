import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideRouter, Router } from '@angular/router';
import { WindowShell, screenFromUrl } from './window-shell';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { Modal } from '../../core/services/modal/modal';
import { Permissions } from '../../core/services/permissions/permissions';
import { Update, type AvailableUpdate } from '../../core/services/update/update';
import { routes } from '../../app.routes';
import { expectNoAxeViolations } from '../../../testing/axe';
import { Invoke } from '../../core/services/bridge/invoke/invoke';
import { DictationBridge } from '../../core/services/bridge/dictation/dictation.bridge';
import { LanguagesBridge } from '../../core/services/bridge/languages/languages.bridge';
import { LiveBridge } from '../../core/services/bridge/live/live.bridge';
import { MediaBridge } from '../../core/services/bridge/media/media.bridge';
import { PermissionsBridge } from '../../core/services/bridge/permissions/permissions.bridge';
import { ShortcutBridge } from '../../core/services/bridge/shortcut/shortcut.bridge';
import { SystemBridge } from '../../core/services/bridge/system/system.bridge';

/** Une mise à jour proposée par le serveur, dont on observe les gestes. */
function offer(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    version: '0.9.1',
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Le vrai routeur, avec les vraies routes. Un routeur simulé aurait laissé passer une
 * redirection cassée ou un `pathMatch` oublié — précisément ce que cette coquille orchestre.
 *
 * ⚠️ **Le `UpdateStore` est le VRAI**, seul son service est doublé : c'est l'enchaînement
 * complet — contrôle, proposition, gestes de la barre — qui est éprouvé ici, et non un état
 * posé à la main qui n'aurait prouvé que le gabarit.
 */
async function render(
  options: {
    setWindowCompact?: () => Promise<void>;
    update?: AvailableUpdate | null;
    checkFails?: boolean;
    relaunch?: () => Promise<void>;
    /** Ce que le service d'autorisations répond au démarrage. Absent : le vrai service. */
    accessibility?: 'lost' | 'granted' | 'unreadable';
    /**
     * Les langues que le moteur déclare tenir. Absent : le pont rend `null`, et l'application
     * les tient alors toutes pour présentes — voir `LanguageAssets.installedLanguages`.
     */
    installed?: readonly string[] | 'unreadable';
    /** Ce que l'utilisateur répond à la proposition de réinstaller. */
    reinstall?: boolean;
  } = {},
) {
  TestBed.resetTestingModule();
  const setWindowCompact = vi.fn(options.setWindowCompact ?? (() => Promise.resolve()));
  const relaunch = vi.fn(options.relaunch ?? (() => Promise.resolve()));
  const error = vi.fn();
  const info = vi.fn();
  const permissions =
    options.accessibility === undefined
      ? []
      : [
          {
            provide: Permissions,
            useValue: {
              refresh: vi
                .fn()
                .mockImplementation(() =>
                  options.accessibility === 'unreadable'
                    ? Promise.reject(new Error('pont muet'))
                    : Promise.resolve({}),
                ),
              accessibilityLost: () => options.accessibility === 'lost',
            },
          },
        ];
  const check =
    options.checkFails === true
      ? vi.fn().mockRejectedValue(new Error('hors ligne'))
      : vi.fn().mockResolvedValue(options.update ?? null);
  const reinstall = options.reinstall ?? false;
  const capabilities =
    options.installed === undefined || options.installed === 'unreadable'
      ? null
      : { id: 'apple', streaming: true, locales: [], installedLocales: options.installed };
  const getSttCapabilities =
    options.installed === 'unreadable'
      ? vi.fn().mockRejectedValue(new Error('pont muet'))
      : vi.fn().mockResolvedValue(capabilities);
  TestBed.configureTestingModule({
    providers: [
      { provide: DictationBridge, useExisting: Invoke },
      { provide: LanguagesBridge, useExisting: Invoke },
      { provide: LiveBridge, useExisting: Invoke },
      { provide: MediaBridge, useExisting: Invoke },
      { provide: PermissionsBridge, useExisting: Invoke },
      { provide: ShortcutBridge, useExisting: Invoke },
      { provide: SystemBridge, useExisting: Invoke },
      provideRouter(routes),
      { provide: Update, useValue: { check, relaunch } },
      { provide: Snackbar, useValue: { error, info, success: vi.fn(), clear: vi.fn() } },
      ...permissions,
      // `setWindowTheme` : la coquille ne l'appelle pas, mais `Theme` — injecté par
      // tout ce qui monte l'application — le fait à chaque peinture.
      {
        provide: Invoke,
        // ⚠️ La doublure porte aussi ce que les ÉCRANS montés appellent, et pas seulement ce
        // que la coquille appelle : le routeur est le vrai, donc l'écran Dictée s'ouvre
        // réellement et interroge le pont. C'est voulu — un écran qui casserait au montage
        // doit se voir ici.
        useValue: {
          // Le vrai `UpdateStore` traverse `Update`, doublé plus haut : `isTauri` n'a donc
          // aucune conséquence ici, mais l'omettre laisserait un `TypeError` silencieux dans
          // le `catch` du contrôle — un défaut du double qui ressemblerait à une app à jour.
          isTauri: () => false,
          setWindowCompact,
          setWindowTheme: vi.fn().mockResolvedValue(undefined),
          listen: vi.fn().mockResolvedValue(() => undefined),
          listInputDevices: vi.fn().mockResolvedValue([]),
          getSttCapabilities,
          getLanguageInstallInFlight: vi.fn().mockResolvedValue(null),
          setShortcutMode: vi.fn().mockResolvedValue(undefined),
          getLaunchAtLogin: vi.fn().mockResolvedValue(false),
          // Le panneau d'options Fichiers s'abonne au glisser-déposer dès son montage.
          onFileDrop: vi.fn().mockResolvedValue(() => undefined),
          // L'écran Direct injecte `RecordingSound` pour ses bips, et celui-ci demande dans
          // quelle fenêtre il tourne avant de s'abonner au raccourci.
          windowLabel: vi.fn().mockResolvedValue('main'),
          // …et l'écran interroge les sources captables.
          listAudioSources: vi.fn().mockResolvedValue([]),
          // ⚠️ **Ce trou-ci s'est vu le jour où une doublure de `Snackbar` a été posée** : l'écran
          // Dictée demande son prompt de reformulation au montage, la méthode manquait, et
          // l'erreur partait en snackbar — invisible tant que la vraie snackbar l'absorbait en
          // silence. Le test ne cassait pas ; il mesurait juste autre chose que ce qu'il disait.
          getRephrasingPrompt: vi.fn().mockResolvedValue(null),
          // ⚠️ **Le même trou, et pour la même raison** : Options ▸ Direct charge ses prompts
          // de compte rendu au montage, et `ReportPromptsStore` avale ses propres échecs. Les
          // deux méthodes manquantes ne cassaient donc rien — elles laissaient seulement le
          // magasin arriver vide, et l'épreuve mesurer autre chose que ce qu'elle dit.
          adoptLegacyLivePrompt: vi.fn().mockResolvedValue(false),
          listReportPrompts: vi.fn().mockResolvedValue([]),
          // La coquille relit les autorisations au démarrage pour savoir si l'Accessibilité a
          // disparu ; hors Tauri, la lecture rend `null` et il n'y a rien à en conclure.
          getPermissionsStatus: vi.fn().mockResolvedValue(null),
          startShortcut: vi.fn().mockResolvedValue(undefined),
        },
      },
    ],
  });

  // ⚠️ Le VRAI service de modales, et `confirm` seulement espionné : la modale de mise à jour
  // doit se monter pour de bon, sinon les tests presseraient des boutons qui n'existent pas.
  const confirm = vi.spyOn(TestBed.inject(Modal), 'confirm').mockResolvedValue(reinstall);

  const harness = await RouterTestingHarness.create('/');
  const element = harness.fixture.nativeElement as HTMLElement;
  // Le contrôle part de la construction de la coquille : il faut le laisser aboutir avant que
  // la barre puisse apparaître.
  const settle = async () => {
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  await settle();
  return {
    harness,
    element,
    setWindowCompact,
    check,
    relaunch,
    snackbarError: error,
    snackbarInfo: info,
    confirm,
    settle,
    /**
     * La modale de mise à jour, ou `null` si rien n'est proposé.
     *
     * ⚠️ Cherchée dans `document` et non dans la fixture : le service de modales monte sa boîte
     * dans l'overlay, hors de l'arbre du composant. La chercher dans `element` rendrait
     * toujours `null`, et les tests passeraient en ne mesurant rien.
     */
    bar: () => document.querySelector('app-update-modal'),
    /** Presse le bouton de la modale portant ce libellé. */
    press: async (label: string) => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('app-update-modal button')];
      const target = buttons.find((button) => button.textContent?.trim() === label);
      if (target === undefined) {
        throw new Error(`bouton « ${label} » absent de la modale`);
      }
      target.click();
      await settle();
    },
    goto: async (url: string) => {
      await harness.navigateByUrl(url);
      harness.detectChanges();
    },
    /** Les noms accessibles des entrées du header, dans l'ordre rendu. */
    entries: () =>
      [...element.querySelectorAll<HTMLButtonElement>('app-header nav button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('screenFromUrl', () => {
  it('lit le segment d’URL comme identifiant d’écran', () => {
    expect(screenFromUrl('/dictee')).toBe('dictee');
    expect(screenFromUrl('/direct')).toBe('direct');
    expect(screenFromUrl('/options')).toBe('options');
  });

  it('ne connaît plus d’écran « fichiers »', () => {
    expect(screenFromUrl('/fichiers')).not.toBe('fichiers');
  });

  it('ignore ce qui suit le chemin', () => {
    expect(screenFromUrl('/options?famille=general')).toBe('options');
    expect(screenFromUrl('/direct#live')).toBe('direct');
  });

  it('retombe sur l’accueil pour tout ce qu’elle ne connaît pas', () => {
    expect(screenFromUrl('/')).toBe('dictee');
    expect(screenFromUrl('/historique')).toBe('dictee');
    expect(screenFromUrl('')).toBe('dictee');
  });
});

describe('WindowShell', () => {
  it('ouvre sur la dictée : le chemin vide y redirige', async () => {
    const { harness, entries } = await render();

    expect(TestBed.inject(Router).url).toBe('/dictee');
    expect(harness.fixture.nativeElement.querySelector('app-dictee')).not.toBeNull();
    // L'entrée « Dictée » manque : c'est ainsi que le header dit où l'on est.
    expect(entries()).toEqual(['Direct', 'Options']);
  });

  it('navigue vers l’écran que le header demande', async () => {
    const { element, harness, goto } = await render();

    const options = element.querySelector<HTMLButtonElement>(
      'app-header nav button[aria-label="Options"]',
    );
    options?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    // `/options` redirige vers sa première catégorie : la coquille demande bien
    // « options », c'est l'écran qui choisit où il ouvre.
    expect(TestBed.inject(Router).url).toBe('/options/general');
    expect(element.querySelector('app-options')).not.toBeNull();

    await goto('/direct');
    expect(element.querySelector('app-direct')).not.toBeNull();
  });

  it('ramène à l’accueil une URL inconnue', async () => {
    const { goto } = await render();

    await goto('/nulle-part');

    expect(TestBed.inject(Router).url).toBe('/dictee');
  });

  it('resserre la fenêtre sur Dictée, et la rouvre ailleurs', async () => {
    // ⚠️ La Dictée s'ouvre **repliée** : son panneau d'historique est fermé par défaut,
    // et une fenêtre large y laisserait une moitié vide.
    const { goto, setWindowCompact } = await render();

    expect(setWindowCompact).toHaveBeenLastCalledWith(true);

    await goto('/options');
    expect(setWindowCompact).toHaveBeenLastCalledWith(false);

    // ⚠️⚠️ **SESSION EST ÉTROITE ELLE AUSSI, PANNEAU REPLIÉ.** Ce test attendait `false`, du
    // temps où l'écran n'était qu'un titre sans panneau : l'écran livré en a un, replié par
    // défaut, et la maquette applique `.window.hist-collapsed { width: 450px }` à
    // `.direct-config` exactement comme à `.dictee`. Une fenêtre de 900 px y laissait une
    // moitié vide (porteur, 2026-08-04).
    await goto('/direct');
    expect(setWindowCompact).toHaveBeenLastCalledWith(true);
  });

  it('passe le header en mode compact avec la fenêtre étroite', async () => {
    const { element, goto } = await render();
    const compact = () => element.querySelector('app-header')?.classList.contains('compact');

    // L'écran d'accueil est déjà replié : le header y est compact dès l'ouverture.
    expect(compact()).toBe(true);

    // Session a un panneau, replié par défaut : le header y est compact comme sur l'accueil.
    await goto('/direct');
    expect(compact()).toBe(true);

    // Options n'a pas de panneau et occupe toute la largeur.
    await goto('/options');
    expect(compact()).toBe(false);
  });

  it('ne se replie plus que sur les écrans à panneau', async () => {
    // ⚠️ La branche « Fichiers, compact sans condition » part avec l'écran : les Options sont
    // larges, et la zone de dépôt hérite de la largeur du panneau.
    const { element, goto } = await render();

    await goto('/options/fichiers');

    expect(element.querySelector('app-options-fichiers')).not.toBeNull();
    expect(element.querySelector('app-header')?.classList.contains('compact')).toBe(false);
  });

  it('absorbe un redimensionnement en échec : la navigation continue', async () => {
    const { goto, element } = await render({
      setWindowCompact: () => Promise.reject(new Error('fenêtre fermée')),
    });

    await goto('/direct');

    expect(element.querySelector('app-direct')).not.toBeNull();
  });

  it('n’a aucune violation d’accessibilité, sur les trois écrans', async () => {
    const { element, goto } = await render();

    for (const url of ['/dictee', '/direct', '/options']) {
      await goto(url);
      await expectNoAxeViolations(element);
    }
  });

  // ⚠️⚠️ **CE TEST EXISTE PARCE QU'AXE NE PEUT PAS LE FAIRE À NOTRE PLACE** *(P6-07,
  // 2026-08-10)*. Sa règle `region` — « du contenu hors de tout repère » — est `pageLevel:
  // true` : elle ne s'évalue que sur une page entière, jamais sur le `fixture.nativeElement`
  // qu'analyse `expectNoAxeViolations`. Le défaut a donc traversé 1 500 tests verts, et il a
  // fallu ouvrir l'application dans un vrai navigateur pour le voir.
  //
  // ⚠️ **Il vérifie que l'écran est DEDANS**, pas seulement que la balise existe : le routeur
  // insère le composant **après** `<router-outlet>`, donc sortir la balise de `<main>` ne
  // casserait rien de visible et ne se verrait nulle part ailleurs.
  describe('la barre de mise à jour', () => {
    it('reste absente quand l’application est à jour', async () => {
      // Ne rien avoir à dire, c'est ne pas s'afficher : la barre n'a pas d'état « à jour ».
      const { bar } = await render();

      expect(bar()).toBeNull();
    });

    it('annonce la version proposée dès l’ouverture de la fenêtre', async () => {
      const { bar } = await render({ update: offer() });

      expect(bar()?.textContent).toContain('0.9.1');
    });

    it('télécharge sans installer, puis installe et redémarre — deux gestes', async () => {
      // ⚠️ C'est la maquette qui l'impose : « prête à être installée » est un état, donc
      // « Mettre à jour » ne doit PAS remplacer le bundle.
      const update = offer();
      const { press, relaunch, bar } = await render({ update });

      await press('Mettre à jour');
      expect(update.download).toHaveBeenCalledOnce();
      expect(update.install).not.toHaveBeenCalled();
      expect(bar()?.textContent).toContain('prête à être installée');

      await press('Redémarrer maintenant');
      expect(update.install).toHaveBeenCalledOnce();
      expect(relaunch).toHaveBeenCalledOnce();
    });

    it('« Plus tard » retire la barre et rend la ressource', async () => {
      const update = offer();
      const { press, bar } = await render({ update });

      await press('Plus tard');

      expect(bar()).toBeNull();
      expect(update.dispose).toHaveBeenCalledOnce();
    });

    it('« Annuler » pendant le téléchargement n’installe rien', async () => {
      const pending: { finish?: () => void } = {};
      const update = offer({
        download: vi.fn(() => new Promise<void>((resolve) => (pending.finish = resolve))),
      });
      const { press, bar, settle } = await render({ update });

      await press('Mettre à jour');
      await press('Annuler');
      pending.finish?.();
      await settle();

      expect(bar()).toBeNull();
      expect(update.install).not.toHaveBeenCalled();
    });

    it('dit un téléchargement en échec, en snackbar', async () => {
      const update = offer({ download: vi.fn().mockRejectedValue(new Error('coupure réseau')) });
      const { press, snackbarError, bar } = await render({ update });

      await press('Mettre à jour');

      expect(snackbarError).toHaveBeenCalledWith('coupure réseau');
      expect(bar()).toBeNull();
    });

    it('ne dit RIEN quand c’est le contrôle qui échoue', async () => {
      // ⚠️⚠️ **RÈGLE DE PRODUIT.** Une application qui se vante de marcher sans réseau ne peut
      // pas reprocher à chaque lancement hors ligne de ne pas avoir joint son serveur.
      const { snackbarError, bar } = await render({ checkFails: true });

      expect(snackbarError).not.toHaveBeenCalled();
      expect(bar()).toBeNull();
    });

    it('survit à la navigation — c’est ce qui la distingue des autres', async () => {
      // ⚠️ La raison d'être du montage DÉCLARATIF dans la coquille plutôt que dans l'overlay du
      // CDK : les notifications transitoires s'effacent à la première navigation, celle-ci non.
      const { bar, goto } = await render({ update: offer() });

      await goto('/options');
      expect(bar()).not.toBeNull();

      await goto('/direct');
      expect(bar()).not.toBeNull();
    });

    it('n’a aucune violation d’accessibilité une fois affichée', async () => {
      // Elle vit HORS du `<main>` : c'est un contexte que le spec du composant seul ne couvre pas.
      const { element } = await render({ update: offer() });

      await expectNoAxeViolations(element);
    });
  });

  it('range l’écran dans un repère de page, pour qui navigue au lecteur d’écran', async () => {
    const { element, goto } = await render();

    for (const [url, screen] of [
      ['/dictee', 'app-dictee'],
      ['/options', 'app-options'],
    ] as const) {
      await goto(url);
      const main = element.querySelector('main');

      expect(main).not.toBeNull();
      expect(main?.querySelector(screen)).not.toBeNull();
    }
  });

  describe("l'Accessibilité disparue", () => {
    /**
     * ⚠️ Le seul cas de perte muet : macOS retire l'autorisation sans un mot, le raccourci
     * global cesse de répondre, et rien à l'écran ne relie les deux. Le message est ce lien.
     */
    it('explains a grant that vanished, and says where to give it back', async () => {
      const { snackbarInfo } = await render({ accessibility: 'lost' });

      expect(snackbarInfo).toHaveBeenCalledOnce();
      const said = snackbarInfo.mock.calls[0][0] as string;
      expect(said).toContain('Accessibilité');
      expect(said).toContain('Réglages Système');
    });

    /**
     * ⚠️ **Jamais quand l'autorisation est en place** : le message doit se taire, sans quoi il
     * inquiéterait à chaque démarrage pour un état parfaitement sain.
     */
    it('says nothing when the grant is still there', async () => {
      const { snackbarInfo } = await render({ accessibility: 'granted' });

      expect(snackbarInfo).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ **Une lecture en échec se tait**, comme le contrôle de mise à jour : ne pas savoir
     * n'est pas une nouvelle, et ce serait le premier mot de l'application au démarrage.
     */
    it('stays quiet when the permissions cannot be read at all', async () => {
      const { snackbarInfo, snackbarError } = await render({ accessibility: 'unreadable' });

      expect(snackbarInfo).not.toHaveBeenCalled();
      expect(snackbarError).not.toHaveBeenCalled();
    });
  });

  /**
   * ⚠️ **Le contrôle ne partait qu'au démarrage**, et la fenêtre principale se cache au lieu de
   * se détruire : sur une application de barre des menus qu'on ne quitte jamais, une version
   * sortie après le lancement n'était jamais proposée.
   *
   * Cette épreuve traverse la chaîne entière — le battement de la coquille ET la règle des six
   * heures du magasin —, d'où l'horloge avancée en plus des minuteurs.
   */
  describe('une langue parlée disparue', () => {
    /**
     * ⚠️ **Le cas qui a coûté une soirée.** macOS reprend les modèles de transcription qu'il a
     * donnés : une langue choisie la semaine dernière peut avoir disparu ce matin. Sans ce
     * contrôle, l'utilisateur ne l'apprenait qu'en lançant une session — et, avant que le Direct
     * ne refuse, il enregistrait du silence sans qu'un mot le lui dise.
     */
    it('propose de réinstaller une langue choisie que le moteur n’a plus', async () => {
      const { confirm } = await render({ installed: ['fr'] });

      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0]?.[0]).toMatchObject({
        heading: 'Installer la langue anglaise ?',
      });
    });

    it('mène à l’écran des langues, qui porte le seul chemin de téléchargement', async () => {
      const { settle } = await render({ installed: ['fr'], reinstall: true });
      const router = TestBed.inject(Router);

      // ⚠️ On attend la CONDITION, jamais un nombre de tours choisi au jugé : la proposition
      // traverse deux promesses — les langues installées, puis la réponse à la modale — et un
      // `whenStable` unique passait ou non selon la charge de la machine.
      for (let attempt = 0; attempt < 10 && router.url === '/dictee'; attempt += 1) {
        await settle();
      }

      expect(router.url).toBe('/options/langues/parlees?installer=en');
    });

    /** Renoncer ne doit rien lancer : le réseau ne part que sur un geste explicite. */
    it('ne va nulle part quand on renonce', async () => {
      const { harness } = await render({ installed: ['fr'], reinstall: false });
      await harness.fixture.whenStable();

      expect(TestBed.inject(Router).url).toBe('/dictee');
    });

    it('se tait quand toutes les langues choisies sont là', async () => {
      const { confirm } = await render({ installed: ['fr', 'en', 'es', 'de', 'it', 'pt'] });

      expect(confirm).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ Ne pas savoir n'est pas une nouvelle à annoncer, et ce serait le premier mot de
     * l'application au démarrage : un pont muet rend toutes les langues pour présentes.
     */
    it('se tait quand le moteur ne dit rien de ce qu’il a', async () => {
      const { confirm } = await render();

      expect(confirm).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ **La mise à jour passe toujours devant.** Le contrôle des langues est local et répond
     * tout de suite, celui des mises à jour passe par le réseau : laissés en parallèle, les deux
     * avis s'ouvraient dans l'ordre de leur latence, et la langue arrivait la première.
     */
    it('attend d’avoir répondu à la mise à jour avant de parler des langues', async () => {
      const { confirm, bar, press, settle } = await render({
        installed: ['fr'],
        update: offer(),
      });

      expect(bar()).not.toBeNull();
      expect(confirm).not.toHaveBeenCalled();

      await press('Plus tard');
      await settle();

      expect(confirm).toHaveBeenCalledOnce();
    });

    /** Sans mise à jour à proposer, rien ne retarde l'avis de langue. */
    it('parle des langues tout de suite quand rien n’est à mettre à jour', async () => {
      const { confirm } = await render({ installed: ['fr'] });

      expect(confirm).toHaveBeenCalledOnce();
    });

    /** ⚠️ Une lecture en échec se tait aussi : un pont muet n'est pas une langue disparue. */
    it('se tait quand la lecture elle-même échoue', async () => {
      const { confirm } = await render({ installed: 'unreadable' });

      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('le battement de mise à jour', () => {
    it('redemande sans attendre un redémarrage de l’application', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { check, settle } = await render();
        expect(check).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await settle();

        expect(check).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
