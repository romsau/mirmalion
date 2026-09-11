import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { OptionsDirect } from './options-direct';
import { ComboSelect } from '../../../../shared/components/forms/combo-select/combo-select';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { ReportPromptsStore } from '../../../../core/store/report-prompts/report-prompts.store';
import {
  REPORT_PROMPT_GROUP_INDEX,
  reportPromptGroupLabel,
} from '../../../../core/services/live/live';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../core/models/settings';
import type { ReportPromptFormData } from './components/report-prompt-form/report-prompt-form';
import type { AppError } from '../../../../core/models/app-error';
import type { ReportPrompt } from '../../../../core/services/bridge/live/live.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const CLIENT: ReportPrompt = {
  id: 7,
  title: 'Client',
  prompt: 'Décisions, tâches et risques, dans cet ordre, en trois sections nommées.',
};

const VEILLE: ReportPrompt = {
  id: 9,
  title: 'Veille',
  prompt: 'Les annonces, leur source, et ce qui change pour nous.',
};

/** Le titre de la boîte d'ajout, celui qu'une modification ne doit pas porter. */
const HEADING_ADD = 'Ajouter un prompt personnalisé';

/** Vingt prompts : le plafond, celui que Rust refuse de dépasser. */
function twenty(): readonly ReportPrompt[] {
  return Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    title: `Prompt ${index + 1}`,
    prompt: 'texte',
  }));
}

/** Ce que le magasin porte comme échec — le sien est écrit, jamais oublié. */
const REFUSED: AppError = { kind: 'database', message: 'écriture refusée' };

interface Options {
  readonly prompts?: readonly ReportPrompt[];
  /** L'échec que le magasin porte AVANT le geste : celui-là ne doit plus se redire. */
  readonly error?: AppError | null;
  /** Le fichier de réglages refuse d'être écrit. */
  readonly settingsFails?: boolean;
  readonly liveReportType?: AppSettings['liveReportType'];
  readonly liveReportPromptId?: number | null;
  readonly liveOverlayVisible?: boolean;
}

async function render(options: Options = {}) {
  TestBed.resetTestingModule();

  const list = signal<readonly ReportPrompt[]>(options.prompts ?? []);
  const failure = signal<AppError | null>(options.error ?? null);
  const store = {
    prompts: list,
    error: failure,
    clearError: vi.fn(() => failure.set(null)),
    /** Fait échouer la prochaine écriture, comme le magasin le ferait. */
    breaks: () => failure.set(REFUSED),
    byId: (id: number | null) =>
      id === null ? undefined : list().find((entry) => entry.id === id),
    // La vraie règle du magasin, celle qu'`add` et `rename` appliquent : sans casse, sans
    // espaces de bord, et le prompt en cours de modification écarté.
    taken: (title: string, except: number | null) =>
      list().some(
        (entry) =>
          entry.id !== except && entry.title.trim().toLowerCase() === title.trim().toLowerCase(),
      ),
    load: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue('added'),
    rename: vi.fn().mockResolvedValue('saved'),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const settingsValue = signal<AppSettings>({
    ...DEFAULT_SETTINGS,
    ...(options.liveOverlayVisible === undefined
      ? {}
      : { liveOverlayVisible: options.liveOverlayVisible }),
    ...(options.liveReportType === undefined ? {} : { liveReportType: options.liveReportType }),
    ...(options.liveReportPromptId === undefined
      ? {}
      : { liveReportPromptId: options.liveReportPromptId }),
  });
  // ⚠️ La doublure APPLIQUE le correctif : un magasin qui ne bougerait pas ferait relire à
  // l'écran la valeur d'avant, et « la ligne bascule dans les deux sens » ne prouverait rien.
  const settingsFailure = signal<AppError | null>(null);
  const settings = {
    settings: settingsValue,
    error: settingsFailure,
    update: vi.fn(async (patch: Partial<AppSettings>) => {
      // Le vrai magasin vide son erreur en entrant, puis la repose si l'écriture échoue.
      settingsFailure.set(options.settingsFails === true ? REFUSED : null);
      settingsValue.update((current) => ({ ...current, ...patch }));
    }),
  };

  // ⚠️ La doublure rend une poignée dont `closed` se résout tout de suite : sans elle, chaque
  // ouverture laisserait une promesse en vol et les épreuves se termineraient avant l'écriture.
  let answer: { title: string; prompt: string } | undefined;
  const snackbar = { error: vi.fn(), info: vi.fn() };
  const modal = {
    open: vi.fn((_component: unknown, config: { heading: string; data: ReportPromptFormData }) => {
      void config;
      return { closed: Promise.resolve(answer) };
    }),
    confirm: vi.fn().mockResolvedValue(false),
  };

  await TestBed.configureTestingModule({
    imports: [OptionsDirect],
    providers: [
      { provide: ReportPromptsStore, useValue: store },
      { provide: SettingsStore, useValue: settings },
      { provide: Modal, useValue: modal },
      { provide: Snackbar, useValue: snackbar },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(OptionsDirect);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;

  const combo = () =>
    fixture.debugElement.query(By.directive(ComboSelect)).componentInstance as ComboSelect<string>;

  return {
    fixture,
    element,
    store,
    settings,
    modal,
    snackbar,
    /** Ce que la modale rendra à la prochaine ouverture. */
    answers: (result: { title: string; prompt: string } | undefined) => {
      answer = result;
    },
    refresh: async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    },
    combo,
    labels: () =>
      [...element.querySelectorAll('app-option-row .label')].map((node) => node.textContent),
    toggle: () => element.querySelector<HTMLButtonElement>('[role="switch"]'),
    row: (label: string) =>
      [...element.querySelectorAll<HTMLElement>('.row')].find(
        (row) => row.querySelector('.label')?.textContent?.trim() === label,
      ),
    trigger: () => element.querySelector<HTMLElement>('.cselect-trigger'),
    addButton: () => element.querySelector<HTMLButtonElement>('.cp-head app-button button')!,
    editButton: (index: number) =>
      element.querySelectorAll<HTMLButtonElement>('.cp-row .h-act.copy')[index],
    deleteButton: (index: number) =>
      element.querySelectorAll<HTMLButtonElement>('.cp-row .h-act.del')[index],
    /** Choisit une valeur dans le menu, sans passer par l'overlay. */
    pick: (value: string) => {
      combo().valueChange.emit(value);
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('OptionsDirect', () => {
  it('porte ses deux réglages, sans sous-titre', async () => {
    const { element, labels } = await render();

    expect(labels()).toEqual([
      "Afficher l'indicateur visuel pendant un direct",
      'Type de compte rendu par défaut',
    ]);
    expect(element.querySelector('.sublabel')).toBeNull();
  });

  /**
   * ⚠️ **« Indicateur visuel », pas « pilule »** : « pilule » est notre mot de code — celui du
   * composant et du code Rust — et il ne dit rien à qui lit un écran de réglages.
   */
  it('ne dit jamais « pilule » à l’utilisateur', async () => {
    const { element } = await render();
    expect(element.textContent?.toLowerCase()).not.toContain('pilule');
  });

  it('part de ce qui est enregistré pour l’indicateur', async () => {
    const { toggle } = await render({ liveOverlayVisible: false });
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('écrit l’indicateur, depuis le contrôle comme depuis la ligne', async () => {
    const { toggle, row, settings, refresh } = await render({ liveOverlayVisible: true });

    toggle()?.click();
    await refresh();
    expect(settings.update).toHaveBeenCalledWith({ liveOverlayVisible: false });

    // Toute la ligne est cliquable, pas seulement l'interrupteur.
    row("Afficher l'indicateur visuel pendant un direct")?.click();
    await refresh();
    expect(settings.update).toHaveBeenCalledWith({ liveOverlayVisible: true });
  });

  it('charge la liste des prompts en arrivant', async () => {
    const { store } = await render();
    expect(store.load).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ Un prompt fait plusieurs phrases : quatre pavés de prose empilés ne se parcourent pas.
   */
  it('n’affiche que les titres, jamais le texte des prompts', async () => {
    const { element } = await render({ prompts: [CLIENT, VEILLE] });

    expect(
      [...element.querySelectorAll('.cp-title')].map((node) => node.textContent?.trim()),
    ).toEqual(['Client', 'Veille']);
    expect(element.textContent).not.toContain(CLIENT.prompt);
  });

  it('dit quoi faire quand la liste est vide', async () => {
    const { element } = await render({ prompts: [] });
    expect(element.querySelector('.cp-empty')?.textContent).toContain('Aucun prompt');
  });

  it('n’affiche plus l’état vide dès qu’un prompt existe', async () => {
    const { element } = await render({ prompts: [CLIENT] });
    expect(element.querySelector('.cp-empty')).toBeNull();
  });

  it('ouvre la modale d’AJOUT sur le bouton, sans prompt à modifier', async () => {
    const { addButton, modal } = await render({ prompts: [] });
    addButton().click();

    expect(modal.open).toHaveBeenCalledOnce();
    const [, config] = modal.open.mock.calls[0];
    expect(config.data.prompt).toBeNull();
    expect(config.heading).toBe(HEADING_ADD);
  });

  /**
   * ⚠️ Le titre de la boîte dit lequel des deux gestes on fait : une même modale qui ajoute et
   * qui modifie doit se nommer, sinon on ne sait plus si l'on écrase ce qu'on vient d'ouvrir.
   */
  it('ouvre la modale de MODIFICATION sur le crayon, avec son prompt', async () => {
    const { editButton, modal } = await render({ prompts: [CLIENT] });
    editButton(0).click();

    const [, config] = modal.open.mock.calls[0];
    expect(config.data.prompt).toEqual(CLIENT);
    expect(config.heading).not.toBe(HEADING_ADD);
  });

  it('enregistre ce que la modale d’ajout a rendu', async () => {
    const { addButton, answers, store, refresh } = await render({ prompts: [] });
    answers({ title: 'Client', prompt: 'Décisions et tâches' });

    addButton().click();
    await refresh();

    expect(store.add).toHaveBeenCalledExactlyOnceWith('Client', 'Décisions et tâches');
  });

  it('n’écrit rien quand la modale d’ajout est abandonnée', async () => {
    const { addButton, store, refresh } = await render({ prompts: [] });

    addButton().click();
    await refresh();

    expect(store.add).not.toHaveBeenCalled();
  });

  it('enregistre ce que la modale de modification a rendu', async () => {
    const { editButton, answers, store, refresh } = await render({ prompts: [CLIENT] });
    answers({ title: 'Client', prompt: 'Autre chose' });

    editButton(0).click();
    await refresh();

    expect(store.rename).toHaveBeenCalledExactlyOnceWith(CLIENT.id, 'Client', 'Autre chose');
  });

  it('n’écrit rien quand la modification est abandonnée', async () => {
    const { editButton, store, refresh } = await render({ prompts: [CLIENT] });

    editButton(0).click();
    await refresh();

    expect(store.rename).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **`taken` exclut le prompt en cours de modification** : sans cela, corriger une faute du
   * texte sans toucher au titre serait refusé au nom du titre de ce prompt même.
   */
  it('ne compte pas le prompt qu’on modifie parmi les titres pris', async () => {
    const { editButton, modal } = await render({ prompts: [CLIENT, VEILLE] });
    editButton(0).click();

    const [, config] = modal.open.mock.calls[0];
    expect(config.data.taken('Client')).toBe(false);
    // La casse et les espaces de bord ne font pas deux titres différents.
    expect(config.data.taken('  veille ')).toBe(true);
  });

  it('compte tous les titres à l’ajout', async () => {
    const { addButton, modal } = await render({ prompts: [CLIENT] });
    addButton().click();

    const [, config] = modal.open.mock.calls[0];
    expect(config.data.taken('Client')).toBe(true);
    expect(config.data.taken('Veille')).toBe(false);
  });

  it('éteint « Ajouter » au plafond de vingt prompts', async () => {
    const { addButton } = await render({ prompts: twenty() });
    expect(addButton().disabled).toBe(true);
  });

  it('laisse « Ajouter » allumé sous le plafond', async () => {
    const { addButton } = await render({ prompts: [CLIENT] });
    expect(addButton().disabled).toBe(false);
  });

  it('demande confirmation avant de supprimer', async () => {
    const { deleteButton, modal, store, refresh } = await render({ prompts: [CLIENT] });
    modal.confirm.mockResolvedValue(false);

    deleteButton(0).click();
    await refresh();

    expect(modal.confirm).toHaveBeenCalledOnce();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('supprime une fois la confirmation obtenue', async () => {
    const { deleteButton, modal, store, settings, refresh } = await render({ prompts: [CLIENT] });
    modal.confirm.mockResolvedValue(true);

    deleteButton(0).click();
    await refresh();

    expect(store.remove).toHaveBeenCalledExactlyOnceWith(CLIENT.id);
    // Le réglage ne désignait pas ce prompt : il n'a pas à bouger.
    expect(settings.update).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ Supprimer le prompt qui servait de défaut fait retomber le réglage sur « Pas de compte
   * rendu ». Sans cela, le sélecteur montrerait une valeur introuvable dans sa propre liste.
   */
  it('remet le défaut à « Pas de compte rendu » en supprimant le prompt choisi', async () => {
    const { deleteButton, modal, settings, refresh } = await render({
      prompts: [CLIENT],
      liveReportType: 'custom',
      liveReportPromptId: CLIENT.id,
    });
    modal.confirm.mockResolvedValue(true);

    deleteButton(0).click();
    await refresh();

    expect(settings.update).toHaveBeenCalledWith({
      liveReportType: 'none',
      liveReportPromptId: null,
    });
  });

  it('laisse le défaut tranquille en supprimant un AUTRE prompt', async () => {
    const { deleteButton, modal, settings, refresh } = await render({
      prompts: [CLIENT, VEILLE],
      liveReportType: 'custom',
      liveReportPromptId: VEILLE.id,
    });
    modal.confirm.mockResolvedValue(true);

    deleteButton(0).click();
    await refresh();

    expect(settings.update).not.toHaveBeenCalled();
  });

  it('retient le prompt choisi dans le menu, et le type qui va avec', async () => {
    const { pick, settings } = await render({ prompts: [CLIENT] });
    pick(String(CLIENT.id));

    expect(settings.update).toHaveBeenCalledWith({
      liveReportType: 'custom',
      liveReportPromptId: CLIENT.id,
    });
  });

  it('retient un type livré, et oublie le prompt qui l’était', async () => {
    const { pick, settings } = await render({ prompts: [CLIENT] });
    pick('lecture');

    expect(settings.update).toHaveBeenCalledWith({
      liveReportType: 'lecture',
      liveReportPromptId: null,
    });
  });

  it('part du type enregistré, pas d’un défaut codé en dur', async () => {
    const { trigger } = await render({ liveReportType: 'client' });
    expect(trigger()?.textContent?.trim()).toBe('Point client');
  });

  it('montre le prompt choisi par son titre', async () => {
    const { trigger } = await render({
      prompts: [CLIENT],
      liveReportType: 'custom',
      liveReportPromptId: CLIENT.id,
    });
    expect(trigger()?.textContent?.trim()).toBe('Client');
  });

  /**
   * ⚠️ Un identifiant qui ne désigne plus rien retombe sur « Pas de compte rendu » : le réglage
   * peut avoir survécu à la suppression du prompt dans une autre fenêtre.
   */
  it('retombe sur « Pas de compte rendu » quand le prompt choisi a disparu', async () => {
    const { trigger } = await render({
      prompts: [],
      liveReportType: 'custom',
      liveReportPromptId: 404,
    });
    expect(trigger()?.textContent?.trim()).toBe('Pas de compte rendu');
  });

  it('grise la rubrique quand aucun prompt n’existe', async () => {
    const { combo } = await render({ prompts: [] });
    expect(combo().lockedGroups()).toEqual([
      { group: reportPromptGroupLabel(), index: REPORT_PROMPT_GROUP_INDEX },
    ]);
  });

  it('ne grise plus rien dès qu’un prompt existe', async () => {
    const { combo } = await render({ prompts: [CLIENT] });
    expect(combo().lockedGroups()).toEqual([]);
  });

  /**
   * ⚠️ **La rangée du type de compte rendu n'a pas d'action propre** : elle porte un menu
   * déroulant. L'autre porte un interrupteur et reste cliquable sur toute sa largeur.
   */
  /**
   * ⚠️ **Une vraie liste**, `<ul>` et `<li>`, nommée par son intitulé : le rendu ne bouge pas
   * d'un pixel, mais un lecteur d'écran annonce alors « liste » et son nombre d'éléments.
   */
  it('annonce la liste comme une liste, et la nomme', async () => {
    const { element } = await render({ prompts: [CLIENT, VEILLE] });
    const list = element.querySelector('ul.cp-list');

    expect(list?.querySelectorAll('li.cp-row')).toHaveLength(2);
    const label = list?.getAttribute('aria-labelledby');
    expect(label).not.toBeNull();
    expect(element.querySelector(`#${label}`)?.textContent?.trim()).toBe('Prompts personnalisés');

    // ⚠️ Unique par instance : deux écrans montés ensemble dupliqueraient l'identifiant, et
    // l'`aria-labelledby` désignerait deux éléments — ce que ni jsdom ni AXE ne relèvent.
    const second = await render({ prompts: [CLIENT] });
    expect(second.element.querySelector('ul.cp-list')?.getAttribute('aria-labelledby')).not.toBe(
      label,
    );
  });

  /**
   * ⚠️ L'état vide est hors de la liste : une liste d'un élément qui dit « il n'y en a aucun »
   * s'annoncerait comme un contenu.
   */
  it('ne monte aucune liste tant qu’il n’y a rien à lister', async () => {
    const { element } = await render({ prompts: [] });
    expect(element.querySelector('ul.cp-list')).toBeNull();
  });

  /**
   * ⚠️ **Une écriture refusée par la base se DIT** — il n'y a pas de page d'erreur, toutes les
   * notifications transitoires passent par la snackbar.
   */
  it('dit un échec d’écriture, à l’ajout comme à la suppression', async () => {
    const ajout = await render({ prompts: [] });
    ajout.answers({ title: 'Client', prompt: 'Décisions' });
    ajout.store.add.mockImplementation(async () => {
      ajout.store.breaks();
      return 'failed';
    });
    ajout.addButton().click();
    await ajout.refresh();
    expect(ajout.snackbar.error).toHaveBeenCalledExactlyOnceWith('écriture refusée');

    const suppression = await render({ prompts: [CLIENT] });
    suppression.modal.confirm.mockResolvedValue(true);
    suppression.store.remove.mockImplementation(async () => {
      suppression.store.breaks();
    });
    suppression.deleteButton(0).click();
    await suppression.refresh();
    expect(suppression.snackbar.error).toHaveBeenCalledExactlyOnceWith('écriture refusée');
  });

  it('dit un titre pris que la base a refusé sous nos pieds', async () => {
    const { editButton, answers, store, snackbar, refresh } = await render({ prompts: [CLIENT] });
    answers({ title: 'Veille', prompt: 'Autre chose' });
    store.rename.mockResolvedValue('duplicate');

    editButton(0).click();
    await refresh();

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('Ce titre est déjà pris.');
  });

  /**
   * ⚠️ **L'échec que le magasin porte au montage se dit**, et c'est la seule trace de la reprise
   * de l'ancien prompt unique : elle est jouée par `load()`, sans geste de l'utilisateur, et
   * seul `drainErrors` peut la dire.
   */
  it('dit l’échec que le magasin portait déjà, une fois, puis l’oublie', async () => {
    const { snackbar, store } = await render({ prompts: [CLIENT], error: REFUSED });

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('écriture refusée');
    expect(store.clearError).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Le doublon n'est PAS dit deux fois** : c'est une issue traduite ici, et non un échec du
   * magasin — le dire des deux côtés l'écrirait une seconde fois par-dessus.
   */
  it('ne dit rien de plus quand le doublon a déjà été annoncé', async () => {
    const { editButton, answers, store, snackbar, refresh } = await render({ prompts: [CLIENT] });
    answers({ title: 'Veille', prompt: 'Autre chose' });
    store.rename.mockResolvedValue('duplicate');

    editButton(0).click();
    await refresh();

    expect(snackbar.error).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Le réglage part avant la suppression, et son échec annule la suppression.** Sans cela,
   * le défaut serait perdu alors que le prompt, lui, serait toujours là.
   */
  it('n’enlève rien quand le réglage n’a pas pu être réécrit', async () => {
    const { deleteButton, modal, store, snackbar, refresh } = await render({
      prompts: [CLIENT],
      liveReportType: 'custom',
      liveReportPromptId: CLIENT.id,
      settingsFails: true,
    });
    modal.confirm.mockResolvedValue(true);

    deleteButton(0).click();
    await refresh();

    expect(store.remove).not.toHaveBeenCalled();
    // ⚠️ `App` dit déjà l'échec d'un réglage, pour les quinze appelants d'`update()` : le
    // redire ici l'écrirait deux fois.
    expect(snackbar.error).not.toHaveBeenCalled();
  });

  it('se tait quand l’écriture a réussi', async () => {
    const { addButton, answers, snackbar, refresh } = await render({ prompts: [] });
    answers({ title: 'Client', prompt: 'Décisions' });

    addButton().click();
    await refresh();

    expect(snackbar.error).not.toHaveBeenCalled();
  });

  it('ne rend inerte que la rangée à menu déroulant', async () => {
    const { element } = await render();
    const inertes = [...element.querySelectorAll('app-option-row')]
      .filter((row) => row.classList.contains('is-passive'))
      .map((row) => row.querySelector('.label')?.textContent);

    expect(inertes).toEqual(['Type de compte rendu par défaut']);
  });

  it('n’a aucune violation d’accessibilité, liste vide comme remplie', async () => {
    await expectNoAxeViolations((await render({ prompts: [] })).element);
    await expectNoAxeViolations((await render({ prompts: [CLIENT, VEILLE] })).element);
  });
});
