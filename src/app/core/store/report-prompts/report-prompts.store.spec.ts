import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReportPromptsStore } from './report-prompts.store';
import { LiveBridge, type ReportPrompt } from '../../services/bridge/live/live.bridge';

const CLIENT: ReportPrompt = { id: 1, title: 'Client', prompt: 'Décisions.' };
const VEILLE: ReportPrompt = { id: 2, title: 'Veille', prompt: 'Ce qui bouge.' };

function store(bridge: Partial<LiveBridge> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: LiveBridge,
        useValue: {
          listReportPrompts: vi.fn().mockResolvedValue([CLIENT, VEILLE]),
          createReportPrompt: vi.fn().mockResolvedValue(CLIENT),
          updateReportPrompt: vi.fn().mockResolvedValue(CLIENT),
          deleteReportPrompt: vi.fn().mockResolvedValue(undefined),
          adoptLegacyLivePrompt: vi.fn().mockResolvedValue(false),
          onLivePromptChanged: vi.fn().mockResolvedValue(() => undefined),
          ...bridge,
        },
      },
    ],
  });
  return TestBed.inject(ReportPromptsStore);
}

describe('ReportPromptsStore', () => {
  it('starts empty and unloaded', () => {
    const instance = store();
    expect(instance.prompts()).toEqual([]);
    expect(instance.loaded()).toBe(false);
  });

  it('loads the list once', async () => {
    const list = vi.fn().mockResolvedValue([CLIENT]);
    const instance = store({ listReportPrompts: list });

    await instance.load();
    await instance.load();

    expect(list).toHaveBeenCalledOnce();
    expect(instance.prompts()).toEqual([CLIENT]);
  });

  /**
   * ⚠️ **La reprise passe AVANT la première lecture**, et une seule fois : jouée après, elle
   * créerait une ligne que la liste déjà chargée ne montrerait pas.
   */
  it('adopts the legacy prompt before it reads the list', async () => {
    const order: string[] = [];
    const instance = store({
      adoptLegacyLivePrompt: vi.fn(async () => {
        order.push('adopt');
        return true;
      }),
      listReportPrompts: vi.fn(async () => {
        order.push('list');
        return [CLIENT];
      }),
    });

    await instance.load();
    expect(order).toEqual(['adopt', 'list']);
  });

  it('refuses a duplicate title without touching the backend', async () => {
    const create = vi.fn();
    const instance = store({ createReportPrompt: create });
    await instance.load();

    // ⚠️ Sans tenir compte de la casse ni des espaces : « client » est déjà pris.
    await expect(instance.add('  client  ', 'Autre chose.')).resolves.toBe('duplicate');
    expect(create).not.toHaveBeenCalled();
  });

  it('lets a prompt keep its own title while its text changes', async () => {
    const instance = store();
    await instance.load();
    await expect(instance.rename(CLIENT.id, 'Client', 'Autre chose.')).resolves.toBe('saved');
  });

  it('refuses to rename onto a title another prompt already holds', async () => {
    const update = vi.fn();
    const instance = store({ updateReportPrompt: update });
    await instance.load();

    await expect(instance.rename(CLIENT.id, ' veille ', 'Autre chose.')).resolves.toBe('duplicate');
    expect(update).not.toHaveBeenCalled();
  });

  it('adds a prompt', async () => {
    const instance = store();
    await instance.load();
    await expect(instance.add('Nouveau', 'Texte.')).resolves.toBe('added');
  });

  it('removes a prompt', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const instance = store({ deleteReportPrompt: remove });
    await instance.load();

    await instance.remove(CLIENT.id);
    expect(remove).toHaveBeenCalledWith(CLIENT.id);
  });

  /**
   * ⚠️ **Une reprise ratée n'est pas une panne** : la liste doit charger quand même, quelle que
   * soit la raison de l'échec — ici comme dans deux ans.
   */
  it('loads the list even when adopting the legacy prompt fails', async () => {
    const list = vi.fn().mockResolvedValue([CLIENT, VEILLE]);
    const instance = store({
      adoptLegacyLivePrompt: vi
        .fn()
        .mockRejectedValue({ kind: 'database', message: 'disque plein' }),
      listReportPrompts: list,
    });

    await instance.load();

    expect(list).toHaveBeenCalledOnce();
    expect(instance.loaded()).toBe(true);
    expect(instance.prompts()).toEqual([CLIENT, VEILLE]);
    expect(instance.error()).toEqual({ kind: 'database', message: 'disque plein' });
  });

  it('turns a reading failure into a typed error rather than a throw', async () => {
    const instance = store({
      listReportPrompts: vi.fn().mockRejectedValue({ kind: 'database', message: 'disque plein' }),
    });

    await instance.load();

    expect(instance.error()).toEqual({ kind: 'database', message: 'disque plein' });
  });

  /**
   * ⚠️ **Une première lecture ratée ne marque PAS la liste comme chargée** : posé, `loaded`
   * ferait renoncer tout appel suivant, et la fenêtre resterait vide pour la session entière
   * après un incident d'un instant.
   */
  it('leaves the list unloaded when the first reading fails, and reads again', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce({ kind: 'database', message: 'disque plein' })
      .mockResolvedValue([CLIENT]);
    const instance = store({ listReportPrompts: list });

    await instance.load();
    expect(instance.loaded()).toBe(false);

    await instance.load();

    expect(instance.loaded()).toBe(true);
    expect(instance.prompts()).toEqual([CLIENT]);
  });

  /**
   * ⚠️ **L'abonnement inter-fenêtres survit à une lecture ratée**, et ne se pose qu'une fois :
   * posé dans le `try` de la lecture, un échec laissait la fenêtre sourde aux écritures des
   * autres pour toute la session ; posé sans garde, la seconde tentative en aurait posé un
   * second.
   */
  it('subscribes once even when the first reading fails', async () => {
    const subscribe = vi.fn().mockResolvedValue(() => undefined);
    const instance = store({
      listReportPrompts: vi
        .fn()
        .mockRejectedValueOnce({ kind: 'database', message: 'disque plein' })
        .mockResolvedValue([CLIENT]),
      onLivePromptChanged: subscribe,
    });

    await instance.load();
    expect(subscribe).toHaveBeenCalledOnce();

    await instance.load();

    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('turns a failing subscription into a typed error rather than a throw', async () => {
    const instance = store({
      onLivePromptChanged: vi.fn().mockRejectedValue({ kind: 'io', message: 'bus fermé' }),
    });

    await instance.load();

    expect(instance.loaded()).toBe(true);
    expect(instance.error()).toEqual({ kind: 'io', message: 'bus fermé' });
  });

  it('turns a backend failure into a typed error rather than a throw', async () => {
    const instance = store({
      createReportPrompt: vi.fn().mockRejectedValue({ kind: 'database', message: 'disque plein' }),
    });
    await instance.load();

    await expect(instance.add('Nouveau', 'Texte.')).resolves.toBe('failed');
    expect(instance.error()).toEqual({ kind: 'database', message: 'disque plein' });
  });

  it('re-reads the list when another window changes it', async () => {
    // ⚠️ Une propriété d'objet, pas une variable `let` : TypeScript infère `never` pour une
    // variable captée réassignée dans le rappel générique de `vi.fn`, ici contourné.
    const captured: { notify: (() => void) | null } = { notify: null };
    const list = vi.fn().mockResolvedValue([CLIENT]);
    const instance = store({
      listReportPrompts: list,
      onLivePromptChanged: vi.fn(async (handler: () => void) => {
        captured.notify = handler;
        return () => undefined;
      }),
    });
    await instance.load();
    expect(list).toHaveBeenCalledOnce();

    captured.notify?.();
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠️ La règle que la modale interroge avant d'ouvrir « Enregistrer », et c'est la MÊME que
   * celle d'`add` et de `rename` : deux comparaisons de titres divergeraient un jour.
   */
  it('says whether a title is taken, the edited prompt aside', async () => {
    const instance = store();
    await instance.load();

    expect(instance.taken('  client  ', null)).toBe(true);
    // Le prompt qu'on modifie ne se dispute pas son propre titre.
    expect(instance.taken('Client', CLIENT.id)).toBe(false);
    expect(instance.taken('Veille', CLIENT.id)).toBe(true);
    expect(instance.taken('Neuf', null)).toBe(false);
  });

  /**
   * ⚠️ Deux fenêtres écrivent ce magasin : un appelant qui veut savoir si SON écriture a échoué
   * vide l'erreur avant de la jouer, au lieu de comparer celle d'après à celle d'avant.
   */
  it('forgets the failure it carries when asked to', async () => {
    const instance = store({
      listReportPrompts: vi.fn().mockRejectedValue(new Error('base close')),
    });
    await instance.load();
    expect(instance.error()).not.toBeNull();

    instance.clearError();

    expect(instance.error()).toBeNull();
  });

  /**
   * ⚠️ **Un titre que la base refuse rend `duplicate`, pas `failed`**, et l'erreur est oubliée :
   * la liste peut être en retard d'une écriture faite dans une autre fenêtre, et c'est l'index
   * d'unicité qui tranche. Le message du backend est écrit en français — c'est l'appelant qui
   * dit le doublon dans la langue de l'utilisateur.
   */
  it('reads a conflict from the backend as a duplicate, and forgets it', async () => {
    const taken = { kind: 'conflict', message: 'un autre prompt porte déjà ce titre' };
    const instance = store({
      createReportPrompt: vi.fn().mockRejectedValue(taken),
      updateReportPrompt: vi.fn().mockRejectedValue(taken),
    });
    await instance.load();

    await expect(instance.add('Neuf', 'Texte.')).resolves.toBe('duplicate');
    expect(instance.error()).toBeNull();

    await expect(instance.rename(CLIENT.id, 'Client', 'Texte.')).resolves.toBe('duplicate');
    expect(instance.error()).toBeNull();
  });

  /**
   * ⚠️ **Le pli est celui de l'index `COLLATE NOCASE`, pas celui de la machine** :
   * `toLocaleLowerCase` replie `I` en `ı` sur un hôte turc, et deux titres jugés distincts là-bas
   * seraient un doublon que la base refuserait sans que l'interface l'ait vu venir.
   */
  it('folds titles without asking the host locale', async () => {
    const instance = store({
      listReportPrompts: vi.fn().mockResolvedValue([{ id: 9, title: 'INDEX', prompt: '…' }]),
    });
    await instance.load();

    expect(instance.taken('index', null)).toBe(true);
    expect('INDEX'.toLocaleLowerCase('tr')).not.toBe('index');
  });

  it('finds a prompt by its number, and rends undefined for one that is gone', async () => {
    const instance = store();
    await instance.load();

    expect(instance.byId(CLIENT.id)).toEqual(CLIENT);
    expect(instance.byId(404)).toBeUndefined();
    expect(instance.byId(null)).toBeUndefined();
  });
});
