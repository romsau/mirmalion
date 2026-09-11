import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Live } from '../../services/live/live';
import type { SessionSummary } from '../../services/bridge/live/live.bridge';
import { toAppError, type AppError } from '../../models/app-error';

/**
 * Prépare un texte pour la recherche : sans accents, sans casse.
 *
 * `normalize('NFD')` sépare la lettre de son accent ; l'intervalle Unicode retiré est celui des
 * diacritiques combinants. Jumeau de celui de l'historique de dictée : à deux, l'extraire
 * coûterait un module pour six lignes.
 *
 * @remarks
 * ⚠️ C'est ce qui oblige à filtrer ici et non en SQL : SQLCipher n'embarque pas ICU, et SQLite
 * ne sait donc pas rapprocher « résumé » et « resume ».
 */
function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

/** L'historique des sessions tel que le panneau le lit. */
interface LiveHistoryState {
  /** Les sessions archivées, la plus récente d'abord. */
  readonly entries: readonly SessionSummary[];
  /** Ce que l'utilisateur tape dans le champ de recherche. */
  readonly search: string;
  /**
   * L'historique a-t-il déjà été lu ?
   *
   * @remarks
   * ⚠️ Distingue « pas encore lu » de « rien à montrer » : afficher l'invitation de l'état vide
   * pendant la lecture la ferait clignoter à chaque ouverture de l'écran.
   */
  readonly loaded: boolean;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

const initialState: LiveHistoryState = {
  entries: [],
  search: '',
  loaded: false,
  error: null,
};

/**
 * L'historique des sessions : ce qui a été enregistré, et les gestes qu'on peut faire dessus.
 *
 * Il injecte {@link Live} et non `Tauri` : le service de domaine parle au backend.
 *
 * @remarks
 * - ⚠️ Il ne tient aucun transcript : une session d'une heure pèse des centaines de kilo-octets
 *   quand le panneau en montre deux lignes. Le document entier se lit côté Rust, à l'ouverture.
 * - ⚠️ Le filtre s'applique à la source, jamais au DOM : masquer des lignes en CSS les laisserait
 *   dans l'ordre de tabulation et dans le compte annoncé aux lecteurs d'écran.
 */
export const LiveHistoryStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ entries, search, loaded }) => ({
    /**
     * Les sessions qui répondent à la recherche, du plus récent au plus ancien.
     *
     * @remarks
     * - ⚠️ La recherche porte sur le titre et sur le début du transcript, jamais sur la source :
     *   « Microsoft Teams » ne s'affiche nulle part dans la liste, et faire remonter une ligne
     *   sur un mot qu'on n'y voit pas donne un résultat qui a l'air faux.
     * - ⚠️ Une session sans titre ne se cherche pas par sa date : le repli daté est composé par
     *   le panneau, pas par le magasin, et n'entre donc pas dans le filtre.
     */
    filtered: computed(() => {
      const needle = foldForSearch(search().trim());
      if (needle === '') {
        return entries();
      }
      return entries().filter((session) =>
        foldForSearch(`${session.title ?? ''} ${session.preview}`).includes(needle),
      );
    }),
    /**
     * L'historique est-il vide ? Faux tant que rien n'a été lu.
     *
     * @remarks
     * ⚠️ Distinct de « la recherche ne rend rien » : la maquette a deux états séparés, une
     * invitation à enregistrer d'un côté, un « aucune session trouvée » de l'autre.
     */
    empty: computed(() => loaded() && entries().length === 0),
  })),
  withMethods((store, live = inject(Live)) => ({
    /**
     * Relit l'historique. La purge de rétention tourne côté backend à chaque appel, avant la
     * lecture — c'est ce qui la rend rétroactive.
     *
     * @remarks
     * ⚠️ Ne rejette jamais : un backend muet laisse le panneau vide plutôt que l'écran en
     * erreur, car on doit pouvoir démarrer une session même quand l'historique refuse de se lire.
     */
    async load(): Promise<void> {
      try {
        patchState(store, { entries: await live.sessions(), loaded: true });
      } catch (error) {
        patchState(store, { loaded: true, error: toAppError(error) });
      }
    },

    /** Retient ce que l'utilisateur tape dans le champ de recherche. */
    setSearch(search: string): void {
      patchState(store, { search });
    },

    /**
     * Rouvre une session dans sa fenêtre.
     *
     * @remarks
     * ⚠️ Un échec se dit : c'est le seul geste du panneau sans effet visible quand il rate — la
     * fenêtre ne s'ouvre pas, et sans message l'utilisateur reclique.
     */
    async open(id: number): Promise<void> {
      try {
        await live.openSession(id);
      } catch (error) {
        patchState(store, { error: toAppError(error) });
      }
    },

    /**
     * Copie une session dans le presse-papiers : le compte rendu s'il existe, le transcript
     * sinon.
     *
     * @remarks
     * ⚠️ Le texte se compose côté Rust, qui a les deux sous la main : le refaire ici donnerait
     * deux vérités pour un même document, celle qu'on exporte et celle qu'on copie.
     */
    async copy(id: number): Promise<void> {
      try {
        await navigator.clipboard.writeText(await live.sessionText(id));
      } catch (error) {
        patchState(store, { error: toAppError(error) });
      }
    },

    /**
     * Supprime une session, sans confirmation.
     *
     * La ligne quitte la liste avant l'aller-retour : le panneau répond au clic, pas au disque.
     * Un échec la remet en place et se dit dans une snackbar.
     *
     * @remarks
     * ⚠️ Seul « Tout supprimer » demande confirmation : une session perdue par erreur ne se
     * réenregistre pas.
     */
    async remove(id: number): Promise<void> {
      const previous = store.entries();
      patchState(store, { entries: previous.filter((session) => session.id !== id) });
      try {
        await live.deleteSession(id);
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
        await live.clearSessions();
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
