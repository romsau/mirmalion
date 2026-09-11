import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Transcription } from '../../services/transcription/transcription';
import { toAppError, type AppError } from '../../models/app-error';
import type {
  ExportFormat,
  FileDocument,
  RenderedParagraph,
  TranscriptTranslation,
} from '../../services/bridge/media/media.bridge';

/**
 * Ce qui occupe une fenêtre-document à un instant donné.
 *
 * @remarks
 * - ⚠️ Une opération à la fois, et c'est cette valeur qui le garantit : tant qu'elle n'est pas
 *   `null`, aucune autre ne démarre. La contrainte est celle de cette fenêtre, pas du processus.
 * - ⚠️ `renaming` n'y figure pas : renommer est instantané côté Rust, et bloquer la fenêtre pour
 *   cela ferait clignoter le voile à chaque validation de titre.
 */
export type FiledocOperation = 'loading' | 'translating' | 'exporting' | 'copying' | 'closing';

/** Ce qu'une fenêtre-document sait du fichier qu'elle affiche. */
interface FiledocState {
  /**
   * L'identifiant du document — `filedoc-0`, `filedoc-1`… — ou `null` avant l'ouverture.
   *
   * @remarks
   * ⚠️ Ce n'est pas le segment d'URL, voir `DOCUMENT_ID_PREFIX` : le magasin reçoit
   * l'identifiant complet, il ne le recompose pas.
   */
  readonly id: string | null;
  /**
   * Le document, ou `null` tant qu'il n'a pas été lu.
   *
   * @remarks
   * ⚠️ `null` après lecture n'est pas une anomalie : hors contexte Tauri, le pont ne rend rien
   * et la fenêtre reste vide sans rien casser. C'est {@link FiledocState.loaded} qui distingue
   * « pas encore lu » de « rien à montrer ».
   */
  readonly document: FileDocument | null;
  /** La lecture initiale a-t-elle eu lieu ? Distingue « en cours » de « vide ». */
  readonly loaded: boolean;
  /**
   * Le transcript traduit, ou `null` quand on lit la langue d'origine.
   *
   * @remarks
   * ⚠️ C'est une vue, pas un remplacement : l'original reste intact dans
   * {@link FiledocState.document}, ce qui permet d'y revenir instantanément. Traduire détruit
   * l'horodatage au mot — ranger la traduction à la place ferait perdre sous-titres et JSON.
   */
  readonly translation: readonly RenderedParagraph[] | null;
  /** L'opération qui occupe la fenêtre, `null` quand elle est libre. */
  readonly operation: FiledocOperation | null;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

const initialState: FiledocState = {
  id: null,
  document: null,
  loaded: false,
  translation: null,
  operation: null,
  error: null,
};

/**
 * L'état d'une fenêtre-document de transcription de fichier.
 *
 * `providedIn: 'root'` y désigne la racine de cette fenêtre-là : chaque fenêtre-document est son
 * propre webview, donc sa propre application Angular et sa propre instance. Il n'injecte pas
 * `Tauri` — {@link Transcription} parle au backend.
 *
 * @remarks
 * ⚠️ Il ne compose aucun libellé, ni durée ni titre de secours : ce sont des textes d'interface,
 * localisés au build dans six langues. Le magasin rend des nombres et le document tel que Rust
 * l'a écrit.
 */
export const FiledocStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    /** Une opération occupe-t-elle la fenêtre ? */
    busy: computed(() => store.operation() !== null),

    /**
     * Y a-t-il quelque chose à perdre si l'on ferme ?
     *
     * @remarks
     * ⚠️ Décide aussi si les sous-titres sont proposés à l'export : un document absent ou un
     * transcript sans le moindre paragraphe rendrait un `.srt` que le lecteur accepte et qui ne
     * montre rien.
     */
    hasContent: computed(() => (store.document()?.transcript.paragraphs.length ?? 0) > 0),
  })),
  withMethods((store, transcription = inject(Transcription)) => {
    /**
     * Déroule une opération en tenant la règle « une à la fois », et rend ce qu'elle a produit —
     * `null` quand elle n'a pas eu lieu ou qu'elle a échoué.
     *
     * @remarks
     * ⚠️ Le refus est silencieux quand la fenêtre est déjà occupée : les contrôles sont
     * désactivés pendant l'opération, donc y arriver quand même est un accident de course. Dire
     * « occupé » accuserait l'utilisateur de quelque chose qu'il n'a pas fait.
     */
    async function guard<T>(
      operation: FiledocOperation,
      work: (id: string) => Promise<T>,
    ): Promise<T | null> {
      const id = store.id();
      if (id === null || store.operation() !== null) {
        return null;
      }
      patchState(store, { operation });
      try {
        const produced = await work(id);
        patchState(store, { operation: null });
        return produced;
      } catch (error) {
        patchState(store, { operation: null, error: toAppError(error) });
        return null;
      }
    }

    /**
     * Ce que l'export et la copie doivent écrire : la traduction affichée, ou rien.
     *
     * @remarks
     * ⚠️ `undefined` veut dire « relis le transcript », et c'est le cas nominal. Envoyer les
     * paragraphes d'origine reviendrait au même à l'œil, mais le backend n'y verrait que des
     * textes sans mots, et l'export JSON perdrait son horodatage au mot.
     */
    function displayedParagraphs(): readonly RenderedParagraph[] | undefined {
      return store.translation() ?? undefined;
    }

    /**
     * Déroule une opération qui remplace le document.
     *
     * @returns Vrai quand le travail est allé au bout.
     *
     * @remarks
     * - ⚠️ Le document affiché n'est pas effacé en cas d'échec : le transcript précédent est
     *   toujours juste, et le vider ferait perdre ce qu'on avait en plus de l'opération.
     * - ⚠️ `loaded` passe à vrai dans tous les cas, d'où le `finally` : sans lui, une lecture
     *   initiale qui échoue laisserait la fenêtre éternellement vide sans rien dire.
     */
    async function run(
      operation: FiledocOperation,
      work: (id: string) => Promise<FileDocument | null>,
    ): Promise<boolean> {
      const done = await guard(operation, async (id) => {
        try {
          patchState(store, { document: await work(id) });
        } finally {
          patchState(store, { loaded: true });
        }
        return true;
      });
      return done ?? false;
    }

    return {
      /**
       * Lit le document que cette fenêtre doit afficher — son premier geste.
       *
       * Rejouer l'appel sur le même identifiant relit le document.
       */
      async open(id: string): Promise<void> {
        patchState(store, { id });
        await run('loading', (current) => transcription.document(current));
      },

      /**
       * Renomme le document.
       *
       * @remarks
       * ⚠️ Aucune opération n'est posée : c'est une écriture immédiate côté Rust, et un voile de
       * travail sur un renommage donnerait l'image d'un outil qui peine sur un mot.
       */
      async rename(title: string): Promise<void> {
        const id = store.id();
        if (id === null) {
          return;
        }
        try {
          const document = await transcription.rename(id, title);
          // Hors contexte Tauri, le pont ne rend rien : on garde ce qu'on affichait plutôt que
          // de vider le titre sous les doigts de l'utilisateur.
          if (document !== null) {
            patchState(store, { document });
          }
        } catch (error) {
          patchState(store, { error: toAppError(error) });
        }
      },

      /**
       * Traduit le transcript vers `target`, et rend le genre de l'issue. Seul `translated`
       * remplace la vue ; l'appelant se sert du genre pour dire quoi.
       *
       * @remarks
       * - ⚠️ Trois des quatre issues ne sont pas des échecs : paire absente et paire non
       *   supportée sont une information, jamais un dépannage, et une annulation ne se dit pas
       *   du tout — elle ne rend d'ailleurs aucun paragraphe, l'écran garde ce qu'il affichait.
       * - ⚠️ `null` couvre trois cas indiscernables ici — aucun document, fenêtre occupée, pont
       *   muet — et un quatrième, l'échec, que `error` porte déjà.
       */
      async translate(target: string): Promise<TranscriptTranslation['kind'] | null> {
        const outcome = await guard('translating', (id) => transcription.translate(id, target));
        if (outcome === null) {
          return null;
        }
        if (outcome.kind === 'translated') {
          patchState(store, { translation: outcome.paragraphs });
        }
        return outcome.kind;
      },

      /**
       * Demande l'arrêt de la traduction en cours. C'est {@link FiledocStore.translate} qui
       * rendra `cancelled` et relâchera la fenêtre.
       *
       * @remarks
       * - ⚠️ Seule la traduction s'annule : les autres opérations n'ont aucune commande d'arrêt,
       *   et demander celle-ci pendant l'une d'elles viserait un travail qui n'existe pas.
       * - ⚠️ Un échec ne se dit pas et n'entre pas dans `error` : une snackbar rouge sur un geste
       *   d'abandon ferait croire à une panne, et la traduction ira simplement au bout.
       */
      async cancelTranslation(): Promise<void> {
        const id = store.id();
        if (id === null || store.operation() !== 'translating') {
          return;
        }
        try {
          await transcription.cancelTranslation(id);
        } catch {
          // Rien à dire : voir ci-dessus.
        }
      },

      /** Revient au transcript d'origine. Ne parle à personne : l'original n'a jamais bougé. */
      clearTranslation(): void {
        patchState(store, { translation: null });
      },

      /**
       * Exporte le document dans un fichier. Rend vrai quand un fichier a été écrit ; renoncer
       * dans la boîte « Enregistrer sous » rend faux, sans rien dire.
       *
       * @param date - Déjà résolue et localisée : ce magasin ne compose aucun texte.
       *
       * @remarks
       * - ⚠️ La fenêtre n'est occupée qu'à partir de l'écriture, jamais pendant la boîte système :
       *   un voile par-dessus elle annoncerait un travail qui n'a pas commencé.
       * - ⚠️ C'est la traduction affichée qui part, quand il y en a une : sans elle, l'écran
       *   montre de l'allemand et le fichier sort en français.
       */
      async exportTo(format: ExportFormat, date: string): Promise<boolean> {
        const id = store.id();
        if (id === null || store.operation() !== null) {
          return false;
        }
        let chosen: boolean;
        try {
          chosen = await transcription.chooseExportPath(id, date, format);
        } catch (error) {
          patchState(store, { error: toAppError(error) });
          return false;
        }
        if (!chosen) {
          return false;
        }
        const written = await guard('exporting', async (current) => {
          await transcription.export({
            id: current,
            format,
            paragraphs: displayedParagraphs(),
          });
          return true;
        });
        return written ?? false;
      },

      /**
       * Copie le document dans le presse-papiers, tel qu'il est affiché — voir
       * {@link displayedParagraphs}. Rend vrai quand la copie a eu lieu.
       *
       * @remarks
       * ⚠️ Une opération à part entière malgré sa brièveté : elle traverse le document entier
       * pour en produire deux représentations, et tient la même règle « une à la fois ».
       */
      async copy(): Promise<boolean> {
        const copied = await guard('copying', async (id) => {
          await transcription.copy({ id, paragraphs: displayedParagraphs() });
          return true;
        });
        return copied ?? false;
      },

      /**
       * Ferme le document : sa mémoire est libérée et sa fenêtre disparaît.
       *
       * @remarks
       * - ⚠️ Irréversible — il n'y a pas d'historique des fichiers. Ne l'appeler qu'après
       *   confirmation, ou quand {@link FiledocStore.hasContent} est faux.
       * - ⚠️ `closing` n'est jamais relâché au succès : la fenêtre est détruite dans la foulée, et
       *   le relâcher rouvrirait les contrôles d'un document qui n'existe plus.
       */
      async close(): Promise<void> {
        const id = store.id();
        if (id === null || store.operation() !== null) {
          return;
        }
        patchState(store, { operation: 'closing' });
        try {
          await transcription.close(id);
        } catch (error) {
          patchState(store, { operation: null, error: toAppError(error) });
        }
      },

      /** Oublie la dernière erreur, une fois qu'elle a été dite. */
      clearError(): void {
        patchState(store, { error: null });
      },
    };
  }),
);
