import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OptionsGeneral } from './options-general';
import { Settings } from '../../../../core/services/settings/settings';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { DicteeStore } from '../../../../core/store/dictee/dictee.store';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../core/models/settings';
import { ACCENT_PALETTE } from '../../../../core/models/accent-palette';
import type { InputDevice } from '../../../../core/services/bridge/dictation/dictation.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import { SystemBridge } from '../../../../core/services/bridge/system/system.bridge';

const DEVICES: readonly InputDevice[] = [
  { id: '1', name: 'Micro du MacBook Pro', isDefault: true },
  { id: '2', name: 'Blue Yeti', isDefault: false },
];

interface Options {
  readonly settings?: Partial<AppSettings>;
  readonly microphones?: readonly InputDevice[];
  /** L'état de l'élément d'ouverture de session, tel que macOS le rendra. */
  readonly loginItem?: boolean | null;
  /** Écrire l'élément d'ouverture échoue — dossier en lecture seule, profil géré. */
  readonly loginItemWriteFails?: boolean;
  /** Le lire échoue aussi, et le composant ne doit pas laisser d'erreur non traitée. */
  readonly loginItemReadFails?: boolean;
}

/**
 * Le **vrai** service de thème, sur un service de réglages simulé. C'est le trajet complet qui
 * est éprouvé — clic, écriture du réglage, repeinture du document —, pas seulement l'appel de
 * méthode : un thème qui se règle sans repeindre ne se verrait dans aucun test unitaire.
 *
 * ⚠️ **L'ouverture à la session, elle, ne passe PAS par les réglages** : elle vit dans macOS.
 * La doublure la simule par un état mutable, comme le ferait le système.
 */
async function render({
  settings = {},
  microphones,
  loginItem = false,
  loginItemWriteFails,
  loginItemReadFails,
}: Options = {}) {
  TestBed.resetTestingModule();
  const save = vi.fn().mockResolvedValue(undefined);
  const setDockVisible = vi.fn().mockResolvedValue(undefined);
  const load = vi.fn().mockResolvedValue(undefined);

  let registered = loginItem;
  const getLaunchAtLogin = vi.fn(() =>
    loginItemReadFails ? Promise.reject(new Error('illisible')) : Promise.resolve(registered),
  );
  const setLaunchAtLogin = vi.fn((enabled: boolean) => {
    if (loginItemWriteFails) {
      return Promise.reject(new Error('refusé'));
    }
    registered = enabled;
    return Promise.resolve();
  });

  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

  await TestBed.configureTestingModule({
    imports: [OptionsGeneral],
    providers: [
      // ⚠️ Le vrai service de thème est utilisé (voir plus haut) : il pousse l'apparence
      // native de la fenêtre, donc la doublure doit porter cette méthode aussi.
      { provide: Snackbar, useValue: snackbar },
      {
        provide: SystemBridge,
        useValue: {
          setDockVisible,
          setWindowTheme: vi.fn().mockResolvedValue(undefined),
          getLaunchAtLogin,
          setLaunchAtLogin,
        },
      },
      {
        provide: DicteeStore,
        useValue: { microphones: signal(microphones ?? DEVICES), load },
      },
      {
        provide: Settings,
        useValue: {
          load: vi.fn().mockResolvedValue({
            settings: { ...DEFAULT_SETTINGS, ...settings },
            isFirstLaunch: false,
          }),
          save,
          detectInitialSettings: vi.fn().mockReturnValue({}),
        },
      },
    ],
  }).compileComponents();

  // C'est `App` qui relit les réglages au démarrage ; monté seul, le composant part sinon des
  // valeurs par défaut et le test « part du thème enregistré » ne prouverait rien.
  await TestBed.inject(SettingsStore).load();

  const fixture = TestBed.createComponent(OptionsGeneral);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    save,
    load,
    setDockVisible,
    getLaunchAtLogin,
    setLaunchAtLogin,
    snackbar,
    refresh: async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    },
    row: () => element.querySelector<HTMLElement>('.row'),
    rows: () => [...element.querySelectorAll<HTMLElement>('.row')],
    // ⚠️ **Par LIBELLÉ et non par index** : les rangées ont changé d'ordre le 2026-08-06 en
    // se rangeant en trois sous-sections, et six index à décaler à la main sont six occasions
    // de se tromper en silence — un clic sur la mauvaise rangée passe pour un test qui passe.
    rowFor: (label: string) =>
      [...element.querySelectorAll<HTMLElement>('.row')].find(
        (row) => row.querySelector('.label')?.textContent?.trim() === label,
      ),
    labels: () => [...element.querySelectorAll('.label')].map((node) => node.textContent),
    // ⚠️ Les index suivent l'ordre du gabarit : sons, Dock, ouverture à la session. L'apparence
    // passe avant l'audio depuis le 2026-08-13 mais n'a **aucun** interrupteur — un groupe
    // segmenté et des pastilles —, donc ces trois index n'ont pas bougé.
    soundsToggle: () => element.querySelectorAll<HTMLButtonElement>('app-switch button')[0],
    dockToggle: () => element.querySelectorAll<HTMLButtonElement>('app-switch button')[1],
    loginToggle: () => element.querySelectorAll<HTMLButtonElement>('app-switch button')[2],
    segments: () => [...element.querySelectorAll<HTMLButtonElement>('app-segmented button')],
    swatches: () => [...element.querySelectorAll<HTMLButtonElement>('.swatch')],
    select: () => element.querySelector('select') as HTMLSelectElement,
    choose: async (value: string) => {
      const select = element.querySelector('select') as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      fixture.detectChanges();
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
});

describe('OptionsGeneral', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════
  // ⚠️⚠️ LE MICRO EST ARRIVÉ ICI LE 2026-08-06, ET IL N'Y A PLUS QU'UN SEUL MICRO.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  //
  // *(porteur)*. Il a vécu sur l'écran de dictée, puis dans Options ▸ Dictée, pendant que le
  // Direct en avait un **second** à lui. C'est un seul appareil : deux réglages coûtaient plus
  // qu'ils ne servaient. ⚠️ Ne pas les redédoubler en lisant l'ancien motif — « on dicte au
  // casque et on enregistre au micro de la salle » — sans que le porteur le redemande.

  it('reads the machine inputs on its own', async () => {
    // ⚠️ On peut arriver ici sans passer par un écran qui capte — par le menu du tray, au
    // premier lancement. Sans cette lecture, la liste n'aurait que le micro système.
    const { load } = await render();
    expect(load).toHaveBeenCalled();
  });

  it('puts the system microphone first, and never twice', async () => {
    // Le défaut système est déjà représenté par la première entrée : le lister à nouveau sous
    // son nom de matériel proposerait deux fois le même micro.
    const { select } = await render();
    expect([...select().options].map((option) => option.textContent?.trim())).toEqual([
      'Micro système (par défaut)',
      'Blue Yeti',
    ]);
  });

  it('shows the microphone already recorded in the settings', async () => {
    const { select } = await render({ settings: { microphoneId: '2' } });
    expect(select().value).toBe('2');
  });

  it('turns the empty microphone value back into « none chosen », and writes the rest through', async () => {
    // ⚠️ `''` est une convention du `<select>`, qui ne transporte que des chaînes. La laisser
    // fuir écrirait une chaîne vide là où le réglage annonce `string | null`. Un identifiant
    // réel, lui, traverse intact — c'est celui de Core Audio, opaque et à ne pas retoucher.
    const { choose, save } = await render({ settings: { microphoneId: '2' } });

    await choose('');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ microphoneId: null }));

    await choose('2');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ microphoneId: '2' }));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **AUCUN TEXTE NU DANS LA CATÉGORIE — ELLE N'EST FAITE QUE DE RANGÉES.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * **Défaut réel, vu par le porteur le 2026-08-06** : en déplaçant un bloc, le `<!--` qui
   * ouvrait le commentaire d'en-tête est parti avec lui. Son texte s'est retrouvé **rendu à
   * l'écran**, en haut de la page — deux paragraphes de prose destinée aux relecteurs.
   *
   * ⚠️⚠️ **ET RIEN NE L'A VU** : ni les 1362 tests, ni AXE. Les assertions portaient sur
   * `.label`, `.row`, les contrôles — sur ce qu'on avait *prévu* d'afficher, jamais sur ce que
   * l'écran affichait *en trop*. Un commentaire mal fermé est un mode de panne silencieux du
   * HTML : le navigateur ne signale rien, il affiche.
   *
   * ⚠️ **Ce test regarde donc les nœuds de TEXTE directs de l'hôte**, pas les libellés. C'est la
   * seule formulation qui attrape un commentaire ouvert, une balise mal fermée ou un morceau de
   * gabarit tombé hors de sa rangée.
   */
  it('ne rend aucun texte hors de ses rangées', async () => {
    const { element } = await render();

    const loose = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim())
      .filter((text) => text !== undefined && text.length > 0);

    expect(loose).toEqual([]);
  });

  /**
   * ⚠️⚠️ **LES SONS SONT ARRIVÉS ICI LE 2026-08-06, ET IL N'Y EN A PLUS QU'UN** *(porteur)*.
   * Il y avait `dictationSoundsEnabled` et `liveSoundsEnabled`, chacun seul dans sa famille de
   * réglages. L'argument tenait — on ne dicte pas et on n'enregistre pas dans les mêmes
   * circonstances — mais il ne valait pas **deux familles pour un interrupteur chacune**.
   */
  it('part de ce qui est enregistré pour les sons', async () => {
    const { soundsToggle } = await render({ settings: { soundsEnabled: false } });
    expect(soundsToggle().getAttribute('aria-checked')).toBe('false');
  });

  it('écrit le réglage des sons, depuis le contrôle comme depuis la ligne', async () => {
    const { soundsToggle, rowFor, save, refresh } = await render({
      settings: { soundsEnabled: true },
    });

    soundsToggle().click();
    await refresh();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ soundsEnabled: false }));

    // Toute la ligne est cliquable, pas seulement l'interrupteur.
    rowFor('Sons de démarrage / arrêt')?.click();
    await refresh();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ soundsEnabled: true }));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **TROIS SOUS-SECTIONS DEPUIS LE 2026-08-06 (porteur) : AUDIO, APPARENCE, SYSTÈME.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * « Général » a grossi — le micro et les sons l'ont rejoint — et six rangées à plat ne se
   * lisaient plus.
   *
   * ⚠️⚠️ **L'APPARENCE EST PASSÉE EN PREMIER LE 2026-08-13** *(porteur)*. L'ordre était
   * audio → apparence → système ; c'est **une décision de produit**, pas une déduction, et
   * l'ancien raisonnement — « l'audio d'abord parce que c'est ce qui fait marcher
   * l'application » — se lisait très bien lui aussi. Ne pas le rejouer.
   */
  it('range les six réglages en trois sous-sections, l’apparence d’abord', async () => {
    const { element, labels } = await render();

    expect([...element.querySelectorAll('.opt-section')].map((s) => s.textContent?.trim())).toEqual(
      ['Apparence', 'Audio', 'Système'],
    );
    expect(labels()).toEqual([
      'Thème',
      "Couleur d'accent",
      'Micro',
      'Sons de démarrage / arrêt',
      'Afficher dans le Dock',
      'Lancer au démarrage',
    ]);
  });

  /**
   * ⚠️⚠️ **UN SEUL FILET PAR SECTION, SOUS SON TITRE — ET AUCUN ENTRE LES RANGÉES** *(porteur,
   * 2026-08-06)*. Découper chaque rangée hachait la page : six traits de même poids ne disaient
   * plus lesquels comptaient.
   */
  it('pose le filet sous le titre de section, jamais entre les rangées', async () => {
    const { element } = await render();
    const rows = [...element.querySelectorAll('app-option-row')];

    expect(rows).not.toHaveLength(0);
    expect(rows.every((row) => row.classList.contains('is-in-section'))).toBe(true);
  });

  /**
   * ⚠️ **L'icône est `aria-hidden`** : elle redit le titre, elle ne l'augmente pas. Un lecteur
   * d'écran qui l'annoncerait ferait entendre deux fois la même chose.
   */
  it('masque les icônes de section aux lecteurs d’écran', async () => {
    const { element } = await render();
    const icons = [...element.querySelectorAll('.opt-section app-icon svg')];

    expect(icons).toHaveLength(3);
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('propose les deux thèmes, et marque celui qui est actif', async () => {
    const { rowFor, segments } = await render();

    expect(rowFor('Thème')).toBeDefined();
    expect(segments().map((s) => s.textContent?.trim())).toEqual(['Clair', 'Sombre']);
    expect(segments()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('repeint le document quand on choisit l’autre thème', async () => {
    const { segments, refresh, save } = await render();
    expect(document.documentElement.dataset['theme']).toBe('light');

    segments()[1].click();
    await refresh();

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  /** Le clic sur la ligne : c'est le garde-fou de la décision « l'appelant décide ». */
  it('bascule aussi quand on clique la ligne, hors du contrôle', async () => {
    const { rowFor, refresh } = await render();

    rowFor('Thème')?.click();
    await refresh();
    expect(document.documentElement.dataset['theme']).toBe('dark');

    rowFor('Thème')?.click();
    await refresh();
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('part du thème enregistré, pas d’un défaut codé en dur', async () => {
    const { segments } = await render({ settings: { theme: 'dark' } });

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(segments()[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('offre les seize teintes, chacune nommée', async () => {
    const { swatches } = await render();

    expect(swatches()).toHaveLength(16);
    // ⚠️ Un bouton dont le seul contenu est une couleur de fond est muet : le nom accessible
    // n'est pas un ornement, c'est la seule chose qui le distingue des quinze autres.
    expect(swatches().map((node) => node.getAttribute('aria-label'))).toContain('Bleu Klein');
    expect(swatches().every((node) => node.getAttribute('aria-label'))).toBe(true);
  });

  it('marque la teinte du thème courant, et elle seule', async () => {
    const { swatches } = await render({ settings: { accentLight: 'rose' } });

    const pressed = swatches().filter((node) => node.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('aria-label')).toBe('Rose');
  });

  it('repeint l’application aussitôt qu’une teinte est choisie', async () => {
    const { swatches, refresh, save } = await render();

    swatches()[0].click();
    await refresh();

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      ACCENT_PALETTE.red.light.accent,
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ accentLight: 'red' }));
  });

  /**
   * ⚠️ Les deux thèmes mémorisent leur teinte séparément. Sans ce test, écrire `accentLight`
   * en thème sombre passerait inaperçu — l'aperçu serait juste, la persistance fausse.
   */
  it('écrit la teinte du thème actif, pas celle de l’autre', async () => {
    const { swatches, refresh, save } = await render({ settings: { theme: 'dark' } });

    swatches()[15].click();
    await refresh();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ accentDark: 'rose' }));
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ accentLight: 'rose' }));
  });

  it('n’a pas de ligne cliquable pour les teintes', async () => {
    // Seize valeurs ne se « basculent » pas : cliquer la ligne devrait en choisir une, et
    // laquelle ? Un clic hors des pastilles ne doit donc rien écrire.
    const { rowFor, refresh, save } = await render();

    rowFor("Couleur d'accent")?.click();
    await refresh();

    expect(save).not.toHaveBeenCalled();
  });

  // ⚠️ Les deux états sont posés explicitement, aucun ne s'appuie sur le défaut : celui-ci a
  // basculé une fois — le Dock est vrai par défaut depuis —, et ces épreuves l'avaient suivi
  // sans le dire.
  it('part de ce qui est enregistré pour le Dock', async () => {
    const off = await render({ settings: { showInDock: false } });
    expect(off.dockToggle()?.getAttribute('aria-checked')).toBe('false');

    const on = await render({ settings: { showInDock: true } });
    expect(on.dockToggle()?.getAttribute('aria-checked')).toBe('true');
  });

  it('écrit le réglage du Dock AVANT de l’appliquer', async () => {
    // ⚠️ L'ordre compte : si l'application échoue, l'utilisateur retrouve au moins son choix au
    // prochain démarrage, qui relit ce même fichier.
    const { dockToggle, refresh, save, setDockVisible } = await render({
      settings: { showInDock: false },
    });

    dockToggle()?.click();
    await refresh();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ showInDock: true }));
    expect(setDockVisible).toHaveBeenCalledWith(true);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      setDockVisible.mock.invocationCallOrder[0],
    );
  });

  it('bascule le Dock au clic sur la ligne, hors du contrôle', async () => {
    const { rowFor, refresh, setDockVisible } = await render({
      settings: { showInDock: false },
    });

    rowFor('Afficher dans le Dock')?.click();
    await refresh();

    expect(setDockVisible).toHaveBeenCalledWith(true);
  });

  /**
   * ⚠️ **Lu de macOS, jamais des réglages.** C'est ce qui distingue cet interrupteur des deux
   * autres : l'utilisateur peut retirer l'élément d'ouverture depuis Réglages Système, et un
   * `computed` sur notre fichier resterait allumé en promettant un démarrage qui n'arrive plus.
   */
  it('part de l’état RÉEL de l’ouverture à la session', async () => {
    const on = await render({ loginItem: true });

    expect(on.getLaunchAtLogin).toHaveBeenCalled();
    expect(on.loginToggle()?.getAttribute('aria-checked')).toBe('true');
  });

  it('inscrit l’application à la session, puis relit l’état', async () => {
    const { loginToggle, refresh, setLaunchAtLogin, getLaunchAtLogin } = await render();

    loginToggle()?.click();
    await refresh();

    expect(setLaunchAtLogin).toHaveBeenCalledWith(true);
    // Deux lectures : celle du montage, puis celle qui confirme l'écriture.
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
    expect(loginToggle()?.getAttribute('aria-checked')).toBe('true');
  });

  it('bascule l’ouverture à la session au clic sur la ligne', async () => {
    const { rowFor, refresh, setLaunchAtLogin } = await render();

    rowFor('Lancer au démarrage')?.click();
    await refresh();

    expect(setLaunchAtLogin).toHaveBeenCalledWith(true);
  });

  /**
   * ⚠️ **Le piège que ferme le mode contrôlé.** Un interrupteur qui bascule tout seul serait
   * resté allumé ici : l'expression `[checked]` vaut toujours `false`, donc Angular ne
   * réécrit rien. L'application promettrait un démarrage qui n'arrive jamais.
   */
  it('reste éteint quand macOS refuse l’élément d’ouverture', async () => {
    const { loginToggle, refresh } = await render({ loginItemWriteFails: true });

    loginToggle()?.click();
    await refresh();

    expect(loginToggle()?.getAttribute('aria-checked')).toBe('false');
  });

  /**
   * ⚠️⚠️ **UN INTERRUPTEUR QUI NE BOUGE PAS N'EXPLIQUE RIEN** *(P6-05, 2026-08-09)*. Le refus
   * était avalé : en mode contrôlé, le seul retour était **l'absence de mouvement**,
   * indiscernable d'un clic mal visé. Et les motifs sont hors de portée de l'utilisateur —
   * dossier en lecture seule, profil géré par une organisation.
   */
  it('dit pourquoi l’interrupteur n’a pas bougé', async () => {
    const { loginToggle, refresh, snackbar } = await render({ loginItemWriteFails: true });

    loginToggle()?.click();
    await refresh();

    expect(snackbar.error).toHaveBeenCalledOnce();
  });

  it('ne dit rien quand macOS accepte', async () => {
    const { loginToggle, refresh, snackbar } = await render();

    loginToggle()?.click();
    await refresh();

    expect(snackbar.error).not.toHaveBeenCalled();
  });

  it('reste éteint hors contexte Tauri, où la lecture rend null', async () => {
    // `null` n'est ni vrai ni faux : l'interrupteur ne doit pas l'interpréter comme allumé.
    const { loginToggle } = await render({ loginItem: null });

    expect(loginToggle()?.getAttribute('aria-checked')).toBe('false');
  });

  /**
   * ⚠️⚠️ **UNE LECTURE EN ÉCHEC N'EST PAS UNE PREUVE QUE C'EST ÉTEINT** *(P6-05)*. Elle écrivait
   * « éteint », c'est-à-dire qu'elle **affirmait sur une absence de preuve** — la faute exacte
   * que le collage au curseur se refuse ailleurs. Elle ne touche plus à rien : l'interrupteur
   * garde ce qu'il montrait, et un échec d'écriture a déjà eu sa snackbar.
   */
  it('ne renverse pas l’interrupteur quand l’état de la session est illisible', async () => {
    const { loginToggle } = await render({ loginItem: true, loginItemReadFails: true });

    // Il n'a jamais rien pu lire, donc il en est resté à son état initial — et surtout, il ne
    // prétend pas savoir.
    expect(loginToggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const { element } = await render();
    await expectNoAxeViolations(element);
  });

  /**
   * ⚠️ **Seules les rangées à menu déroulant sont inertes** — la couleur d'accent et le micro.
   * Celles qui portent un interrupteur restent cliquables sur toute leur largeur, et doivent donc
   * garder leur teinte au survol. Voir l'entrée `passive` d'`OptionRow`.
   */
  it('ne rend inertes que les rangées sans action propre', async () => {
    const { element } = await render();
    const inertes = [...element.querySelectorAll('app-option-row')]
      .filter((row) => row.classList.contains('is-passive'))
      .map((row) => row.querySelector('.label')?.textContent);

    expect(inertes).toEqual(["Couleur d'accent", 'Micro']);
  });
});
