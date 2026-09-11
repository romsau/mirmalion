import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Dictation } from '../../services/dictation/dictation';
import type { DictationRecord } from '../../services/bridge/dictation/dictation.bridge';
import { toAppError, type AppError } from '../../models/app-error';

/**
 * Le texte qu'une dictée montre dans l'historique : le dernier obtenu, jamais le brut.
 *
 * L'ordre remonte le pipeline à l'envers — une variante absente dit que son étape n'a pas eu
 * lieu, on prend donc la précédente. Le brut, lui, ne manque jamais.
 *
 * @remarks
 * ⚠️ C'est le dernier obtenu qui a été inséré au curseur. Afficher le brut montrerait un texte
 * que l'utilisateur n'a jamais vu : celui d'avant nettoyage, reformulation et traduction.
 */
export function displayedText(entry: DictationRecord): string {
  return entry.translatedText ?? entry.rephrasedText ?? entry.cleanedText ?? entry.rawText;
}

/**
 * Prépare un texte pour la recherche : sans accents, sans casse.
 *
 * `normalize('NFD')` sépare la lettre de son accent ; l'intervalle Unicode retiré est celui des
 * diacritiques combinants.
 *
 * @remarks
 * ⚠️ C'est ce qui oblige à filtrer ici et non en SQL : SQLite ne sait pas ignorer les accents
 * sans l'extension ICU, que SQLCipher n'embarque pas.
 */
function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

/** L'historique de dictée tel que le panneau le lit. */
interface DictationHistoryState {
  /** Les dictées enregistrées, la plus récente d'abord. */
  readonly entries: readonly DictationRecord[];
  /** Ce que l'utilisateur tape dans le champ de recherche. */
  readonly search: string;
  /**
   * L'historique a-t-il déjà été lu ?
   *
   * @remarks
   * ⚠️ Distingue « pas encore lu » de « rien à montrer », que la liste vide confondrait :
   * l'état vide et son invitation à dicter clignoteraient à chaque ouverture du panneau.
   */
  readonly loaded: boolean;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

const initialState: DictationHistoryState = {
  entries: [],
  search: '',
  loaded: false,
  error: null,
};

/**
 * L'historique de dictée : ce qui a été dicté, et les gestes qu'on peut faire dessus.
 *
 * Il injecte {@link Dictation} et non `Tauri` : le service de domaine parle au backend, le
 * magasin porte l'état. Jumeau de `LiveHistoryStore`, qui suit le même partage.
 *
 * @remarks
 * ⚠️ Le filtre s'applique à la source, jamais au DOM : masquer des éléments en CSS les
 * laisserait dans l'ordre de tabulation et dans le compte annoncé aux lecteurs d'écran.
 */
export const DictationHistoryStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ entries, search, loaded }) => ({
    /** Les entrées qui répondent à la recherche, dans l'ordre reçu — le plus récent d'abord. */
    filtered: computed(() => {
      const needle = foldForSearch(search().trim());
      if (needle === '') {
        return entries();
      }
      return entries().filter((entry) => foldForSearch(displayedText(entry)).includes(needle));
    }),
    /**
     * L'historique est-il vide ? Faux tant que rien n'a été lu.
     *
     * @remarks
     * ⚠️ Distinct de « la recherche ne rend rien » : la maquette a deux états séparés, une
     * invitation à dicter d'un côté, un « aucune dictée trouvée » de l'autre.
     */
    empty: computed(() => loaded() && entries().length === 0),
  })),
  withMethods((store, dictation = inject(Dictation)) => ({
    /**
     * Relit l'historique.
     *
     * @remarks
     * ⚠️ Ne rejette jamais : un backend muet laisse le panneau vide plutôt que l'écran en
     * erreur, et la dictée continue de fonctionner.
     */
    async load(): Promise<void> {
      try {
        patchState(store, { entries: await dictation.dictations(), loaded: true });
      } catch (error) {
        patchState(store, { loaded: true, error: toAppError(error) });
      }
    },

    /** Retient ce que l'utilisateur tape dans le champ de recherche. */
    setSearch(search: string): void {
      patchState(store, { search });
    },

    /**
     * Supprime une dictée, sans confirmation.
     *
     * L'entrée quitte la liste avant l'aller-retour : le panneau répond au clic, pas au disque.
     * Un échec la remet en place et se dit dans une snackbar.
     *
     * @remarks
     * ⚠️ Seul « Tout supprimer » demande confirmation : une entrée perdue par erreur se redicte,
     * un historique entier ne se retrouve pas.
     */
    async remove(id: number): Promise<void> {
      const previous = store.entries();
      patchState(store, { entries: previous.filter((entry) => entry.id !== id) });
      try {
        await dictation.deleteDictation(id);
      } catch (error) {
        patchState(store, { entries: previous, error: toAppError(error) });
      }
    },

    /**
     * Vide l'historique.
     *
     * @remarks
     * ⚠️ À n'appeler que derrière la modale de confirmation : rien de ce qui part ne se retrouve.
     */
    async clear(): Promise<void> {
      const previous = store.entries();
      patchState(store, { entries: [] });
      try {
        await dictation.clearDictations();
      } catch (error) {
        patchState(store, { entries: previous, error: toAppError(error) });
      }
    },

    /** L'erreur a été dite : on l'oublie, sans quoi la snackbar reviendrait au rendu suivant. */
    clearError(): void {
      patchState(store, { error: null });
    },
  })),
);
