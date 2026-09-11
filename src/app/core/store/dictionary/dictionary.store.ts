import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Dictionary } from '../../services/dictionary/dictionary';
import { toAppError, type AppError } from '../../models/app-error';
import { foldEntry, type DictionaryTerm } from '../../models/dictionary-term';

/**
 * Ce qu'une saisie a produit — quatre issues, jamais un booléen : « refusé » ne dit pas
 * pourquoi, et l'écran doit distinguer un doublon d'une saisie vide pour le dire.
 *
 * @remarks
 * ⚠️ `'failed'` ne se dit pas par l'écran de saisie : le garde-fou du magasin l'a déjà annoncé
 * en snackbar. Il sert à ne pas enchaîner comme si l'ajout avait réussi — sans quoi le champ se
 * viderait sur un terme qui n'existe pas.
 */
export type EntryOutcome = 'added' | 'duplicate' | 'empty' | 'failed';

/** Le dictionnaire personnel tel que son écran le lit. */
interface DictionaryState {
  /** Les termes et leurs graphies, dans l'ordre de tri de la base. */
  readonly terms: readonly DictionaryTerm[];
  /**
   * Le dictionnaire a-t-il déjà été lu ?
   *
   * @remarks
   * ⚠️ Distingue « pas encore lu » de « rien dedans », que `terms.length === 0` confondrait :
   * l'écran montre soit rien, soit son invitation à créer un premier terme.
   */
  readonly loaded: boolean;
  /** Le filtre de la barre d'outils. Vide = tout est visible. */
  readonly query: string;
  /**
   * Le dernier échec, que l'écran annonce puis efface.
   *
   * @remarks
   * ⚠️ Aucune méthode ne doit laisser filer son rejet : c'est le seul écran où l'utilisateur
   * modifie des données persistées à la main, et une base indisponible y ferait qu'un terme
   * n'apparaît pas — ou ne disparaît pas — sans un mot.
   */
  readonly error: AppError | null;
}

const INITIAL: DictionaryState = { terms: [], loaded: false, query: '', error: null };

/**
 * Le dictionnaire personnel : les termes, leurs graphies, et le filtre de recherche.
 *
 * Il n'injecte pas `Tauri` — c'est {@link Dictionary} qui parle au backend, ce qui le rend
 * testable sans pont. L'état d'édition d'une ligne, lui, vit dans le composant de la ligne :
 * une frappe n'y fait pas recalculer la liste entière.
 *
 * @remarks
 * ⚠️ La liste est relue après chaque écriture, jamais retouchée sur place : un remaniement local
 * devrait rejouer le tri de la base (`COLLATE NOCASE`), et deux tris qui se ressemblent finissent
 * par diverger.
 */
export const DictionaryStore = signalStore(
  { providedIn: 'root' },
  withState(INITIAL),
  withComputed(({ terms, query }) => ({
    /**
     * Les termes que le filtre laisse passer, variantes comprises.
     *
     * @remarks
     * ⚠️ Le filtre porte aussi sur les variantes : on cherche un terme parce qu'une dictée l'a
     * écorché, donc on tape la graphie fautive, pas le terme correct qu'on n'a peut-être jamais
     * saisi.
     */
    visible: computed(() => {
      const needle = foldEntry(query());
      if (!needle) {
        return terms();
      }
      return terms().filter(
        (entry) =>
          foldEntry(entry.term).includes(needle) ||
          entry.variants.some((variant) => foldEntry(variant.value).includes(needle)),
      );
    }),
    /** Le nombre total de termes — celui qu'affiche la ligne des Options. */
    count: computed(() => terms().length),
  })),
  withMethods((store, dictionary = inject(Dictionary)) => {
    /** Relit tout. Le seul chemin par lequel `terms` change. */
    const reload = async (): Promise<void> => {
      patchState(store, { terms: await dictionary.list(), loaded: true });
    };

    /**
     * Enveloppe une écriture : relit la liste au succès, et transforme un échec en `error` que
     * l'écran annonce, en rendant `fallback`.
     *
     * @remarks
     * ⚠️ Rien à défaire en cas d'échec : la liste n'est jamais retouchée sur place mais relue,
     * elle en reste donc à ce que la base contient vraiment.
     */
    const guarded = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        const outcome = await work();
        await reload();
        return outcome;
      } catch (error) {
        patchState(store, { loaded: true, error: toAppError(error) });
        return fallback;
      }
    };

    return {
      /** L'écran a dit l'échec : il ne doit pas revenir au prochain rendu. */
      clearError(): void {
        patchState(store, { error: null });
      },

      /**
       * Charge le dictionnaire, sans jamais rejeter.
       *
       * @remarks
       * ⚠️ Appelé à chaque ouverture de l'écran : un rejet casserait la navigation.
       */
      async load(): Promise<void> {
        try {
          await reload();
        } catch (error) {
          patchState(store, { loaded: true, error: toAppError(error) });
        }
      },

      /** Retient le filtre de la barre d'outils. */
      setQuery(query: string): void {
        patchState(store, { query });
      },

      /**
       * Crée un terme, et dit ce que la saisie a produit.
       *
       * @remarks
       * ⚠️ Le doublon est refusé ici, avant l'appel, pour que le message soit dans la langue de
       * l'interface : une erreur remontée de Rust ne serait pas localisée. La contrainte `UNIQUE`
       * de la base reste derrière, en garde-fou d'intégrité.
       */
      async addTerm(raw: string): Promise<EntryOutcome> {
        const folded = foldEntry(raw);
        if (!folded) {
          return 'empty';
        }
        if (store.terms().some((entry) => foldEntry(entry.term) === folded)) {
          return 'duplicate';
        }
        return guarded(async () => {
          await dictionary.addTerm(raw.trim());
          return 'added' as const;
        }, 'failed');
      },

      /** Supprime un terme et ses graphies. Un échec s'annonce en snackbar. */
      async removeTerm(id: number): Promise<void> {
        await guarded(() => dictionary.removeTerm(id), undefined);
      },

      /**
       * Ajoute une graphie sous un terme, et dit ce que la saisie a produit.
       *
       * @remarks
       * ⚠️ Le doublon se juge dans le terme concerné, pas dans tout le dictionnaire — c'est la
       * contrainte de la base, `UNIQUE (term_id, variant)` : deux termes différents peuvent
       * légitimement partager une graphie.
       */
      async addVariant(termId: number, raw: string): Promise<EntryOutcome> {
        const folded = foldEntry(raw);
        if (!folded) {
          return 'empty';
        }
        const target = store.terms().find((entry) => entry.id === termId);
        if (target?.variants.some((variant) => foldEntry(variant.value) === folded)) {
          return 'duplicate';
        }
        return guarded(async () => {
          await dictionary.addVariant(termId, raw.trim());
          return 'added' as const;
        }, 'failed');
      },

      /** Supprime une graphie. Un échec s'annonce en snackbar. */
      async removeVariant(id: number): Promise<void> {
        await guarded(() => dictionary.removeVariant(id), undefined);
      },
    };
  }),
);
