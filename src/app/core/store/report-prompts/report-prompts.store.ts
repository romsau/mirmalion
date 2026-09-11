import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { LiveBridge, type ReportPrompt } from '../../services/bridge/live/live.bridge';
import { toAppError, type AppError } from '../../models/app-error';

/**
 * Le titre qu'on a donné à l'ancien prompt unique en le reprenant.
 *
 * @remarks
 * ⚠️ Traduit, et donné par l'interface : une migration SQL ne parle pas six langues.
 */
const LEGACY_TITLE = $localize`:@@direct.report.legacyTitle:Mon prompt personnalisé`;

/**
 * Ce que le titre d'un prompt vaut pour une comparaison : sans casse, sans espaces de bord.
 *
 * @remarks
 * ⚠️ `toLowerCase()` et non `toLocaleLowerCase()` : le second replie selon la LOCALE DE L'HÔTE
 * — en turc, `I` donne `ı` —, et deux titres jugés distincts sur une machine seraient un
 * doublon sur une autre, refusé par la base sans que l'interface l'ait vu venir. C'est le pli
 * de l'index `COLLATE NOCASE` de `report_prompts` que celui-ci doit suivre, pas celui du
 * système.
 */
function folded(title: string): string {
  return title.trim().toLowerCase();
}

interface ReportPromptsState {
  readonly prompts: readonly ReportPrompt[];
  readonly loaded: boolean;
  readonly error: AppError | null;
}

const INITIAL: ReportPromptsState = { prompts: [], loaded: false, error: null };

/** Ce qu'un enregistrement peut donner. */
export type PromptOutcome = 'added' | 'saved' | 'duplicate' | 'failed';

/**
 * Les prompts de compte rendu nommés : la liste et son CRUD.
 *
 * Il n'injecte pas `Tauri` — c'est {@link LiveBridge} qui parle au backend, ce qui le rend
 * testable sans pont.
 *
 * @remarks
 * ⚠️ La liste est relue après chaque écriture, jamais retouchée sur place : c'est le tri de la
 * base qui fait foi.
 */
export const ReportPromptsStore = signalStore(
  { providedIn: 'root' },
  withState(INITIAL),
  withMethods((store, bridge = inject(LiveBridge)) => {
    /**
     * L'abonnement inter-fenêtres est-il posé ?
     *
     * ⚠️ Hors de l'état, et non un champ de plus : il ne se lit pas dans un gabarit, et une
     * première lecture ratée fait rejouer `load()` — sans ce drapeau, la seconde tentative
     * poserait un second abonnement, et chaque écriture d'une autre fenêtre relirait la base
     * deux fois.
     */
    let subscribed = false;

    const reload = async (): Promise<void> => {
      patchState(store, { prompts: await bridge.listReportPrompts(), loaded: true });
    };

    const guarded = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        const outcome = await work();
        await reload();
        return outcome;
      } catch (error) {
        patchState(store, { error: toAppError(error) });
        return fallback;
      }
    };

    /**
     * Joue une écriture qui pose un titre, et rend `duplicate` quand la base le refuse.
     *
     * ⚠️ La liste du magasin peut être en retard d'une écriture faite dans une autre fenêtre :
     * `taken` n'écarte que ce qu'elle voit, et c'est l'index d'unicité qui tranche. L'erreur est
     * alors OUBLIÉE — l'appelant dit le doublon dans la langue de l'utilisateur, quand le
     * message du backend est écrit en français.
     */
    const titled = async (
      work: () => Promise<unknown>,
      done: PromptOutcome,
    ): Promise<PromptOutcome> => {
      const outcome = await guarded(async () => {
        await work();
        return done;
      }, 'failed' as PromptOutcome);
      if (outcome === 'failed' && store.error()?.kind === 'conflict') {
        patchState(store, { error: null });
        return 'duplicate';
      }
      return outcome;
    };

    const taken = (title: string, except: number | null): boolean =>
      store.prompts().some((entry) => entry.id !== except && folded(entry.title) === folded(title));

    return {
      /**
       * Ce titre est-il déjà porté par un autre prompt ?
       *
       * @remarks
       * ⚠️ `except` est le prompt en cours de modification, et l'exclure est le point : sans
       * lui, corriger une faute du texte sans toucher au titre serait refusé au nom du titre de
       * ce prompt même. C'est la règle que `add` et `rename` appliquent — une seule
       * comparaison pour les trois appelants.
       */
      taken(title: string, except: number | null): boolean {
        return taken(title, except);
      },

      /**
       * Oublie l'échec courant.
       *
       * @remarks
       * ⚠️ L'erreur du magasin survit à l'écriture qui l'a posée. Un appelant qui veut savoir si
       * SON écriture a échoué la vide donc avant de la jouer : ce qu'il lit ensuite désigne ce
       * geste-là, sans avoir à comparer avec ce qui traînait.
       */
      clearError(): void {
        patchState(store, { error: null });
      },

      /** Le prompt qui porte ce numéro, ou `undefined`. */
      byId(id: number | null): ReportPrompt | undefined {
        return id === null ? undefined : store.prompts().find((entry) => entry.id === id);
      },

      /**
       * Charge la liste. Idempotent : un second appel ne relance rien.
       *
       * @remarks
       * ⚠️ La reprise de l'ancien prompt unique passe AVANT la lecture : jouée après, elle
       * créerait une ligne que la liste déjà chargée ne montrerait pas. Son échec reste
       * sans effet sur la lecture : une reprise ratée est un incident, une liste vide serait
       * une panne.
       */
      async load(): Promise<void> {
        if (store.loaded()) {
          return;
        }
        try {
          await bridge.adoptLegacyLivePrompt(LEGACY_TITLE);
        } catch (error) {
          patchState(store, { error: toAppError(error) });
        }
        try {
          await reload();
        } catch (error) {
          patchState(store, { error: toAppError(error) });
        }
        // ⚠️ L'abonnement se pose MÊME si la lecture a échoué, et n'est jamais retiré : le
        // magasin est `providedIn: 'root'`, il vit autant que la fenêtre. Posé dans le `try`
        // de la lecture, une base momentanément fermée laissait la fenêtre sourde aux
        // écritures des autres pour toute la session.
        if (subscribed) {
          return;
        }
        subscribed = true;
        try {
          await bridge.onLivePromptChanged(() => void reload());
        } catch (error) {
          patchState(store, { error: toAppError(error) });
        }
      },

      async add(title: string, prompt: string): Promise<PromptOutcome> {
        if (taken(title, null)) {
          return 'duplicate';
        }
        return titled(() => bridge.createReportPrompt(title.trim(), prompt.trim()), 'added');
      },

      async rename(id: number, title: string, prompt: string): Promise<PromptOutcome> {
        if (taken(title, id)) {
          return 'duplicate';
        }
        return titled(() => bridge.updateReportPrompt(id, title.trim(), prompt.trim()), 'saved');
      },

      async remove(id: number): Promise<void> {
        await guarded(() => bridge.deleteReportPrompt(id), undefined);
      },
    };
  }),
);
