import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { OptionsLanguesParlees } from './options-langues-parlees';
import { Settings } from '../../../../core/services/settings/settings';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { LanguageAssets } from '../../../../core/services/language-assets/language-assets';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Language,
} from '../../../../core/models/settings';
import type { AssetInstallEvent } from '../../../../core/services/bridge/languages/languages.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';

/**
 * Monte le sous-écran sur un service de ressources simulé. `emit` rejoue ce que le backend
 * enverrait : c'est le seul chemin qui termine une installation, donc le seul qui allume
 * l'interrupteur.
 */
async function render(
  options: {
    settings?: Partial<AppSettings>;
    installed?: readonly Language[];
    assets?: Record<string, unknown>;
    /** Ce que l'URL porte dans `?installer=`, quand elle porte quelque chose. */
    installer?: string;
  } = {},
) {
  TestBed.resetTestingModule();
  const save = vi.fn().mockResolvedValue(undefined);
  let listener: ((event: AssetInstallEvent) => void) | null = null;
  const assets = {
    installedLanguages: vi.fn().mockResolvedValue(options.installed ?? ['fr']),
    inFlight: vi.fn().mockResolvedValue(null),
    install: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    // Le quota de réservations : `maximum: 0` veut dire « hors contexte Tauri », donc aucun
    // plafond à faire respecter — c'est le défaut, et il laisse passer toutes les demandes.
    reservations: vi.fn().mockResolvedValue({ held: [], maximum: 0 }),
    release: vi.fn().mockResolvedValue(undefined),
    observe: vi.fn().mockImplementation((handler: (event: AssetInstallEvent) => void) => {
      listener = handler;
      return Promise.resolve(() => undefined);
    }),
    ...options.assets,
  };

  await TestBed.configureTestingModule({
    imports: [OptionsLanguesParlees],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: convertToParamMap(
              options.installer === undefined ? {} : { installer: options.installer },
            ),
          },
        },
      },
      { provide: LanguageAssets, useValue: assets },
      {
        provide: Settings,
        useValue: {
          load: vi.fn().mockResolvedValue({
            settings: { ...DEFAULT_SETTINGS, ...options.settings },
            isFirstLaunch: false,
          }),
          save,
          detectInitialSettings: vi.fn().mockReturnValue({}),
        },
      },
    ],
  }).compileComponents();

  await TestBed.inject(SettingsStore).load();

  const fixture = TestBed.createComponent(OptionsLanguesParlees);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;

  const rowFor = (name: string): HTMLElement => {
    const row = [...element.querySelectorAll<HTMLElement>('.lang-row')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (row === undefined) {
      throw new Error(`aucune rangée « ${name} »`);
    }
    return row;
  };

  const refresh = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  return {
    fixture,
    element,
    save,
    assets,
    rowFor,
    refresh,
    emit: (event: AssetInstallEvent) => listener?.(event),
    // La modale se rend dans l'overlay du CDK, hors de l'élément du composant.
    modal: () => document.querySelector('app-language-install'),
    modalText: () => document.querySelector('app-language-install')?.textContent ?? '',
    clickInModal: (label: string) => {
      const target = [
        ...document.querySelectorAll<HTMLButtonElement>('app-language-install button'),
      ].find((button) => button.textContent?.trim() === label);
      if (target === undefined) {
        throw new Error(`aucun bouton « ${label} » dans la modale`);
      }
      target.click();
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  document.querySelectorAll('.cdk-overlay-container').forEach((node) => node.remove());
});

describe('OptionsLanguesParlees', () => {
  it('tient en une phrase', async () => {
    const { element } = await render();
    expect(element.querySelector('.fam-desc')?.textContent?.trim()).toBe(
      'Les langues proposées à la dictée et à la session.',
    );
  });

  it('ne montre AUCUNE icône d’état, ni rien sous la liste', async () => {
    // Le téléchargement s'annonce quand il part, pas en permanence sur des lignes qu'on ne
    // compte pas.
    const { element } = await render();
    expect(element.querySelectorAll('.lang-row svg')).toHaveLength(0);
    expect(element.querySelector('.lang-legend')).toBeNull();
    expect(element.querySelector('.lang-note')).toBeNull();
  });

  it('porte l’état « à télécharger » dans le nom accessible', async () => {
    const { rowFor } = await render({ installed: ['fr'] });
    expect(rowFor('Italien').querySelector('button')?.getAttribute('aria-label')).toBe(
      'Dicter en Italien — à télécharger',
    );
  });

  describe('la dernière langue allumée', () => {
    it('ne s’éteint pas, et dit pourquoi', async () => {
      // La seule règle qui reste : une application de dictée sans langue ne dicte rien.
      const { rowFor } = await render({ settings: { spokenLanguages: ['fr'] } });
      const row = rowFor('Français');
      expect(row.querySelector('button')?.disabled).toBe(true);
      expect(row.getAttribute('data-hint')).toBe('Au moins une langue parlée est nécessaire.');
      expect(row.querySelector('button')?.getAttribute('aria-label')).toContain(
        'Au moins une langue parlée est nécessaire.',
      );
    });

    it('garde son état, figée ou non', async () => {
      // Défaut mesuré sur la maquette : un désactivé délavé faisait passer la dernière langue
      // pour éteinte, et elle paraissait « se recocher toute seule ».
      const { rowFor } = await render({ settings: { spokenLanguages: ['fr'] } });
      expect(rowFor('Français').querySelector('button')?.getAttribute('aria-checked')).toBe('true');
    });

    it('ne fige rien quand il n’y a aucune langue activée', async () => {
      // Cas de repli : le réglage garantit une liste non vide, mais un fichier tronqué ou une
      // migration ratée peuvent en produire une. Figer « la dernière » n'aurait alors aucun
      // sens — il n'y en a pas.
      const { rowFor } = await render({ settings: { spokenLanguages: [] } });
      expect(rowFor('Français').querySelector('button')?.disabled).toBe(false);
      expect(rowFor('Français').getAttribute('data-hint')).toBeNull();
    });

    it('se libère dès qu’une seconde langue est activée', async () => {
      const { rowFor } = await render({
        settings: { spokenLanguages: ['fr', 'en'] },
        installed: ['fr', 'en'],
      });
      expect(rowFor('Français').querySelector('button')?.disabled).toBe(false);
    });
  });

  describe('une langue déjà installée', () => {
    it('s’active sans rien demander', async () => {
      const { fixture, rowFor, save, modal } = await render({
        settings: { spokenLanguages: ['fr'] },
        installed: ['fr', 'it'],
      });
      rowFor('Italien').click();
      await fixture.whenStable();
      expect(modal()).toBeNull();
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ spokenLanguages: ['fr', 'it'] }));
    });

    it('s’éteint sans rien demander — ses ressources restent sur le Mac', async () => {
      const { fixture, rowFor, save, modal } = await render({
        settings: { spokenLanguages: ['fr', 'en'] },
        installed: ['fr', 'en'],
      });
      rowFor('Anglais').click();
      await fixture.whenStable();
      expect(modal()).toBeNull();
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ spokenLanguages: ['fr'] }));
    });
  });

  describe('une langue absente', () => {
    it('DEMANDE avant d’installer, et ne télécharge rien à l’ouverture', async () => {
      // Basculer une case dans une liste de six n'est pas le clic qui engage plusieurs
      // centaines de mégaoctets : c'est « Installer » qui l'est.
      const { fixture, rowFor, assets, modalText } = await render({ installed: ['fr'] });
      rowFor('Italien').click();
      await fixture.whenStable();

      expect(modalText()).toContain('Installer la langue italienne ?');
      expect(assets.install).not.toHaveBeenCalled();
    });

    it('n’allume l’interrupteur ni à la demande, ni au clic sur « Installer »', async () => {
      const { rowFor, assets, refresh, save, clickInModal } = await render({ installed: ['fr'] });
      rowFor('Italien').click();
      await refresh();
      expect(rowFor('Italien').querySelector('button')?.getAttribute('aria-checked')).toBe('false');

      clickInModal('Installer');
      await refresh();

      expect(assets.install).toHaveBeenCalledWith('it');
      // Le téléchargement est asynchrone : la langue n'est pas encore là, donc l'interrupteur
      // non plus. Ce serait promettre une dictée que l'application ne peut pas tenir.
      expect(save).not.toHaveBeenCalledWith(
        expect.objectContaining({ spokenLanguages: expect.arrayContaining(['it']) }),
      );
      expect(rowFor('Italien').querySelector('button')?.getAttribute('aria-checked')).toBe('false');
    });

    it('s’active quand les ressources ARRIVENT, et referme la modale', async () => {
      const { rowFor, refresh, save, emit, clickInModal, modal } = await render({
        settings: { spokenLanguages: ['fr'] },
        installed: ['fr'],
      });
      rowFor('Italien').click();
      await refresh();
      clickInModal('Installer');
      await refresh();

      emit({ kind: 'installed', language: 'it' });
      await refresh();

      expect(save).toHaveBeenCalledWith(expect.objectContaining({ spokenLanguages: ['fr', 'it'] }));
      expect(modal()).toBeNull();
    });

    it('reste éteinte quand on refuse', async () => {
      const { rowFor, refresh, save, assets, clickInModal, modal } = await render({
        settings: { spokenLanguages: ['fr'] },
        installed: ['fr'],
      });
      rowFor('Italien').click();
      await refresh();
      clickInModal('Annuler');
      await refresh();

      expect(assets.install).not.toHaveBeenCalled();
      expect(modal()).toBeNull();
      expect(save).not.toHaveBeenCalledWith(
        expect.objectContaining({ spokenLanguages: expect.arrayContaining(['it']) }),
      );
    });

    it('reste éteinte quand on annule en cours de téléchargement', async () => {
      const { rowFor, refresh, save, assets, clickInModal, modal } = await render({
        settings: { spokenLanguages: ['fr'] },
        installed: ['fr'],
      });
      rowFor('Italien').click();
      await refresh();
      clickInModal('Installer');
      await refresh();
      clickInModal('Annuler');
      await refresh();

      expect(assets.cancel).toHaveBeenCalled();
      expect(modal()).toBeNull();
      expect(save).not.toHaveBeenCalledWith(
        expect.objectContaining({ spokenLanguages: expect.arrayContaining(['it']) }),
      );
    });
  });

  /**
   * L'URL peut demander une installation — c'est ainsi qu'un manque signalé ailleurs mène ici.
   * Elle emprunte la modale de l'interrupteur, et ses gardes avec.
   */
  describe('le paramètre « installer »', () => {
    it('OUVRE l’installation de la langue demandée quand elle est absente', async () => {
      const { modalText, assets, refresh } = await render({ installer: 'en', installed: ['fr'] });
      await refresh();

      expect(modalText()).toContain('Installer la langue anglaise ?');
      // ⚠️ Ouvrir n'est pas télécharger : « Installer » reste le seul clic qui engage.
      expect(assets.install).not.toHaveBeenCalled();
    });

    it('ne demande RIEN quand la langue est déjà installée', async () => {
      const { modal, refresh, save } = await render({
        installer: 'fr',
        installed: ['fr'],
        settings: { spokenLanguages: ['fr'] },
      });
      await refresh();

      expect(modal()).toBeNull();
      // ⚠️ Et rien n'est écrit : une modale qui s'ouvre puis se referme d'elle-même ne laisse
      // aucune trace à l'écran, mais elle réinscrirait la langue dans les réglages.
      expect(save).not.toHaveBeenCalled();
    });

    it('n’ouvre rien quand l’URL ne demande rien', async () => {
      const { modal, refresh } = await render({ installed: ['fr'] });
      await refresh();

      expect(modal()).toBeNull();
    });

    it('ignore un code de langue inconnu', async () => {
      const { modal, refresh } = await render({ installer: 'klingon', installed: ['fr'] });
      await refresh();

      expect(modal()).toBeNull();
    });

    it('attend de savoir ce qui est installé avant de proposer quoi que ce soit', async () => {
      // ⚠️ Tant que la machine n'a pas répondu, la liste des langues installées est VIDE :
      // proposer à cet instant reviendrait à proposer une langue déjà présente.
      const { modal, refresh } = await render({
        installer: 'fr',
        assets: { installedLanguages: vi.fn().mockReturnValue(new Promise(() => undefined)) },
      });
      await refresh();

      expect(modal()).toBeNull();
    });

    it('n’ouvre la modale QU’UNE fois', async () => {
      // ⚠️ L'effet lit les langues installées : sans désarmement, l'arrivée d'une AUTRE langue
      // le réveillerait et reposerait la question à laquelle on vient de répondre non.
      const { modal, modalText, refresh, clickInModal, emit } = await render({
        installer: 'en',
        installed: ['fr'],
        settings: { spokenLanguages: ['fr'] },
        assets: { inFlight: vi.fn().mockResolvedValue('it') },
      });
      await refresh();
      expect(modalText()).toContain('Installer la langue anglaise ?');

      clickInModal('Annuler');
      await refresh();
      expect(modal()).toBeNull();

      emit({ kind: 'installed', language: 'it' });
      await refresh();

      expect(modal()).toBeNull();
    });
  });

  it('revient à la famille', async () => {
    const { fixture, element } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    element.querySelector<HTMLButtonElement>('button')?.click();
    fixture.detectChanges();
    expect(navigate).toHaveBeenCalledWith(['/options', 'langues']);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render({ installed: ['fr'] })).element);
  });

  /**
   * ⚠️⚠️ **« POUR EN AJOUTER UNE, EN RETIRER UNE »**, vu de l'écran *(porteur, 2026-08-01)*.
   * Le plafond d'Apple porte sur les langues **installées par nous** — libérer un créneau fait
   * retélécharger la langue libérée. Quand rien n'est libérable, il faut le **dire**, et dire
   * quoi faire : c'est une consigne, pas une panne, d'où une snackbar d'information.
   */
  it('dit quoi faire quand le quota est plein et que rien n’est libérable', async () => {
    const { rowFor, clickInModal, refresh } = await render({
      // Une seule place, tenue par une langue **encore activée** : rien à sacrifier.
      settings: { spokenLanguages: ['en'] },
      installed: ['en'],
      assets: { reservations: vi.fn().mockResolvedValue({ held: ['en'], maximum: 1 }) },
    });

    rowFor('Italien')?.querySelector('button')?.click();
    await refresh();
    clickInModal('Installer');
    await refresh();

    const snackbar = document.querySelector('app-snackbar-item');
    expect(snackbar?.textContent).toContain('éteignez-en une autre');
    // ⚠️ L'interrupteur reste ÉTEINT : rien n'a été installé, et l'allumer promettrait une
    // dictée impossible.
    expect(rowFor('Italien')?.querySelector('button')?.getAttribute('aria-checked')).toBe('false');
    // ⚠️ **Et la modale se ferme.** La laisser reposer sa question inviterait à recliquer
    // « Installer » pour se heurter au même refus, sans que rien n'ait changé entre-temps.
    expect(document.querySelector('app-language-install')).toBeNull();
  });

  /**
   * ⚠️⚠️ **LE DÉFAUT DU 2026-08-02, ET C'EST CE TEST QUI LE GARDE.** Le store posait son
   * `error`, **personne ne le lisait sur cet écran** — seul l'onboarding le faisait. Un échec
   * refermait donc `install`, la modale retombait sur son premier temps, et cliquer
   * « Installer » n'avait à l'œil **aucun effet** : « rien ne se passe, la pop-up ne se ferme
   * pas ». Trois symptômes pour une cause, et aucun message.
   *
   * ⚠️ Le message est **générique**, comme à l'onboarding : la cause d'Apple est une chaîne en
   * anglais, elle part au journal et non à l'écran.
   */
  it('DIT l’échec au lieu de retomber en silence sur sa question', async () => {
    const { rowFor, clickInModal, refresh, emit } = await render({
      settings: { spokenLanguages: ['fr'] },
      installed: ['fr'],
    });

    rowFor('Italien')?.querySelector('button')?.click();
    await refresh();
    clickInModal('Installer');
    await refresh();

    emit({ kind: 'failed', language: 'it', message: 'The network connection was lost.' });
    await refresh();

    const snackbar = document.querySelector('app-snackbar-item');
    expect(snackbar?.textContent).toContain("Le téléchargement n'a pas abouti");
    // ⚠️ Le message d'Apple, en anglais, ne doit **jamais** atteindre l'écran.
    expect(snackbar?.textContent).not.toContain('network connection');
    expect(document.querySelector('app-language-install')).toBeNull();
    expect(rowFor('Italien')?.querySelector('button')?.getAttribute('aria-checked')).toBe('false');
  });

  /**
   * Le refus vient parfois du **natif** et non de la règle Angular — l'état du quota peut avoir
   * changé sous nos pieds. On retombe alors sur le même état, donc sur le même message localisé.
   *
   * ⚠️⚠️ **CE CHEMIN A ÉTÉ ROMPU AU MILIEU DU PONT PENDANT UNE JOURNÉE** : Swift émettait
   * `full`, Angular l'attendait, et le relais Rust ne savait pas le lire — il le jetait. Le
   * contrat des trois étages est désormais tenu par `reads_every_kind_swift_can_emit`
   * (`src-tauri/src/commands/assets.rs`) ; ce test-ci ne garde que l'étage du dessus.
   */
  it('traduit un refus de quota venu du natif', async () => {
    const { rowFor, clickInModal, refresh, emit } = await render({
      settings: { spokenLanguages: ['fr'] },
      installed: ['fr'],
      assets: { reservations: vi.fn().mockResolvedValue({ held: ['fr'], maximum: 5 }) },
    });

    rowFor('Italien')?.querySelector('button')?.click();
    await refresh();
    clickInModal('Installer');
    await refresh();

    emit({ kind: 'full', language: 'it' });
    await refresh();

    expect(document.querySelector('app-snackbar-item')?.textContent).toContain(
      'éteignez-en une autre',
    );
    expect(rowFor('Italien')?.querySelector('button')?.getAttribute('aria-checked')).toBe('false');
  });
});
