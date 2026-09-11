import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Live, stepPercent } from '../../services/live/live';
import { toAppError, type AppError } from '../../models/app-error';
import type { Language, TranslationTarget } from '../../models/settings';
import type {
  LiveContent,
  LiveDocument,
  LiveExportRequest,
  LiveProgress,
  ReportKind,
  ReportSection,
} from '../../services/bridge/live/live.bridge';
import type { ExportFormat, RenderedParagraph } from '../../services/bridge/media/media.bridge';

/** Le genre d'issue d'une traduction, tel que l'appelant doit le dire — ou le taire. */
export type TranslationKind = 'translated' | 'pairMissing' | 'pairUnsupported' | 'cancelled';

/** Ce qu'une fenêtre-session sait du document qu'elle affiche. */
interface DirectdocState {
  /**
   * L'identifiant du document — `live-0`, `live-1`… — ou `null` avant l'ouverture.
   *
   * @remarks
   * ⚠️ Ce n'est pas le segment d'URL, voir `LIVE_ID_PREFIX` : le magasin reçoit l'identifiant
   * complet, il ne le recompose pas.
   */
  readonly id: string | null;
  /** Le document, ou `null` tant qu'il n'a pas été lu. */
  readonly document: LiveDocument | null;
  /**
   * La session de cette fenêtre enregistre-t-elle encore ?
   *
   * @remarks
   * ⚠️ Posée à l'ouverture puis menée par les évènements, jamais recalculée depuis le document :
   * celui-ci ne se termine qu'à la fin de la consolidation, alors que le panneau doit basculer
   * sous le voile dès l'arrêt.
   */
  readonly recording: boolean;
  /** La consolidation tourne-t-elle ? C'est ce que le voile couvre. */
  readonly finalising: boolean;
  /** Une génération ou un export est-il en vol ? */
  readonly working: boolean;
  /**
   * L'étape en cours, telle que le backend l'a annoncée. `null` tant qu'il n'a rien dit.
   *
   * @remarks
   * ⚠️ Remise à `null` au début de chaque attente, jamais à sa fin : deux attentes se suivent — on
   * finalise, puis on demande un compte rendu — et la seconde s'ouvrirait sinon sur la dernière
   * étape de la première, à 100 %, pendant le temps d'un aller-retour.
   */
  readonly step: LiveProgress | null;
  /**
   * La vue en cours de traduction, `null` quand rien ne traduit.
   *
   * @remarks
   * ⚠️ Un contenu et non un booléen : c'est lui qui nomme le voile. Dans la vue transcript il n'y
   * a peut-être aucun compte rendu, et annoncer qu'on traduit celui-ci laisserait croire qu'il en
   * existe un.
   */
  readonly translatingContent: LiveContent | null;
  /**
   * L'avancée de la traduction, en pourcentages entiers.
   *
   * @remarks
   * ⚠️ Remise à zéro au départ de chaque traduction, sinon la suivante partirait du pourcentage
   * de la précédente et paraîtrait presque finie avant d'avoir commencé.
   */
  readonly translationPercent: number;
  /**
   * Le transcript traduit, ou `null` quand c'est l'original qu'on lit.
   *
   * @remarks
   * ⚠️ Une vue, pas un remplacement : l'original ne bouge jamais — il reste dans le document, côté
   * Rust, et « Langue d'origine » y revient sans un appel. C'est aussi ce qui protège les
   * horodatages au mot, que la traduction détruit.
   */
  readonly transcriptTranslation: readonly RenderedParagraph[] | null;
  /** La langue affichée par le sélecteur, côté transcript. */
  readonly transcriptTarget: TranslationTarget;
  /** Le compte rendu traduit, intitulés compris, ou `null` — voir ci-dessus. */
  readonly reportTranslation: readonly ReportSection[] | null;
  /** La langue affichée par le sélecteur, côté compte rendu. */
  readonly reportTarget: TranslationTarget;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

const initialState: DirectdocState = {
  id: null,
  document: null,
  recording: false,
  finalising: false,
  working: false,
  step: null,
  translatingContent: null,
  translationPercent: 0,
  transcriptTranslation: null,
  transcriptTarget: 'none',
  reportTranslation: null,
  reportTarget: 'none',
  error: null,
};

/**
 * L'état d'une fenêtre-session : son document, ce qu'elle attend, et ce qu'elle traduit.
 *
 * `providedIn: 'root'` y désigne la racine de cette fenêtre-là : chaque fenêtre-session est son
 * propre webview, donc sa propre application Angular et sa propre instance. Il n'injecte pas les
 * ponts — {@link Live} parle au backend.
 *
 * @remarks
 * ⚠️ Il ne compose aucun libellé, ni titre de secours ni date : ce sont des textes d'interface,
 * localisés au build dans six langues. Le magasin rend des nombres, des genres d'issue et le
 * document tel que Rust l'a écrit.
 */
export const DirectdocStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    /** La fenêtre travaille : le voile couvre son contenu. */
    veiled: computed(
      () => store.finalising() || store.working() || store.translatingContent() !== null,
    ),

    /**
     * Le travail en cours peut-il être abandonné ? Une génération et une traduction, oui.
     *
     * @remarks
     * ⚠️ La finalisation n'offre aucun « Annuler », et ce n'est pas un oubli : l'audio est déjà
     * capté, il n'y a plus rien à renoncer, et abandonner ne rendrait que le transcript brut —
     * moins bien pour le même prix.
     */
    cancellable: computed(() => store.working() || store.translatingContent() !== null),

    /**
     * Ce que la barre montre. `null` = en cours, durée inconnue.
     *
     * @remarks
     * ⚠️ Ce n'est pas ce calcul qui empêche la barre de reculer, c'est le backend : son total est
     * fixé avant la première étape et il franchit son plan dans l'ordre.
     */
    progress: computed(() => {
      // ⚠️ La traduction sait où elle en est, pondérée par les caractères côté Rust. C'est la
      // seule des trois attentes qui rapporte un pourcentage plutôt qu'un compte d'étapes.
      if (store.translatingContent() !== null) {
        return store.translationPercent();
      }
      const step = store.step();
      return step === null ? null : stepPercent(step.done, step.total);
    }),

    /**
     * Les rubriques affichées : la traduction si elle existe, l'original sinon.
     *
     * @remarks
     * ⚠️ C'est aussi ce qui décide de la bascule et du menu d'export, tous deux dérivés de « ce
     * document a-t-il un compte rendu ? » : une traduction en rend exactement autant que
     * l'original, donc la réponse ne change pas.
     */
    sections: computed(() => store.reportTranslation() ?? store.document()?.report ?? []),

    /**
     * La langue vers laquelle cette session est suivie, `null` s'il n'y en a pas.
     *
     * @remarks
     * ⚠️ Elle vient du document, pas des réglages : `liveTranslationTarget` dit ce que le
     * formulaire propose, et toucher ce réglage pour préparer la session suivante changerait la
     * langue de celle qui tourne — les deux fenêtres partagent le même fichier.
     */
    translationTarget: computed(
      () => (store.document()?.translationTarget ?? null) as Language | null,
    ),

    /**
     * La langue parlée, telle que le document la porte depuis son ouverture — posée sur un
     * transcript vide, précisément pour être lisible pendant l'enregistrement.
     */
    spokenLanguage: computed(() => store.document()?.transcript.language ?? ''),
  })),
  withMethods((store, live = inject(Live)) => {
    /** Range la langue choisie du côté de la vue concernée. */
    function setTarget(content: LiveContent, target: TranslationTarget): void {
      patchState(
        store,
        content === 'report' ? { reportTarget: target } : { transcriptTarget: target },
      );
    }

    /** Range la traduction obtenue du côté de la vue concernée, ou l'efface. */
    function setTranslation(
      content: LiveContent,
      translated: readonly RenderedParagraph[] | readonly ReportSection[] | null,
    ): void {
      patchState(
        store,
        content === 'report'
          ? { reportTranslation: translated as readonly ReportSection[] | null }
          : { transcriptTranslation: translated as readonly RenderedParagraph[] | null },
      );
    }

    /** La fenêtre est-elle libre d'entreprendre un travail long ? */
    function idle(): boolean {
      return !store.working() && !store.recording() && store.translatingContent() === null;
    }

    /**
     * Ce que l'écran montre, quand ce n'est pas ce que le document porte.
     *
     * @remarks
     * ⚠️ Rien n'est envoyé quand rien n'est traduit, cas courant où le backend relit le document.
     * Un champ toujours présent obligerait à recomposer ici ce que seul Rust sait rendre.
     */
    function displayed(content: LiveContent): Pick<LiveExportRequest, 'paragraphs' | 'sections'> {
      if (content === 'report') {
        const sections = store.reportTranslation();
        return sections === null ? {} : { sections };
      }
      const paragraphs = store.transcriptTranslation();
      return paragraphs === null ? {} : { paragraphs };
    }

    /**
     * Tient le voile de travail autour d'une opération, et retient son échec.
     *
     * @remarks
     * ⚠️ On réutilise `working`, qui sert déjà la génération : deux drapeaux se contrediraient, et
     * un export lancé pendant une génération relâcherait le sien en premier.
     */
    async function guard(work: (id: string) => Promise<void>): Promise<boolean> {
      const id = store.id();
      if (id === null) {
        return false;
      }
      patchState(store, { working: true });
      try {
        await work(id);
        return true;
      } catch (error) {
        patchState(store, { error: toAppError(error) });
        return false;
      } finally {
        patchState(store, { working: false });
      }
    }

    return {
      /**
       * Lit le document que cette fenêtre doit afficher — son premier geste.
       *
       * @remarks
       * ⚠️ C'est le document qui décide si l'on enregistre, pas le magasin de session : plusieurs
       * fenêtres-sessions terminées peuvent être ouvertes pendant qu'une autre enregistre, et
       * chacune ne doit parler que d'elle-même.
       */
      async open(id: string): Promise<void> {
        patchState(store, { id });
        try {
          const found = await live.document(id);
          patchState(store, {
            document: found,
            recording: found !== null && found.endedAtMs === null,
          });
        } catch (error) {
          // ⚠️ Un échec se dit et laisse l'écran lisible : une fenêtre vide sans explication passe
          // pour un plantage.
          patchState(store, { error: toAppError(error) });
        }
      },

      /**
       * Lève le voile de finalisation avant l'aller-retour d'arrêt.
       *
       * @remarks
       * ⚠️ Ici et non à l'évènement, bien que l'évènement arrive : entre le clic et l'aller-retour
       * IPC il s'écoule assez de temps pour qu'un second clic parte.
       */
      finalise(): void {
        patchState(store, { step: null, finalising: true });
      },

      /** La session de cette fenêtre n'enregistre plus. */
      stopRecording(): void {
        patchState(store, { recording: false });
      },

      /**
       * La session s'est arrêtée — ici ou dans l'autre fenêtre. Rend vrai quand c'était la sienne.
       *
       * @remarks
       * ⚠️ Filtré sur l'identifiant : un évènement Tauri est diffusé à toutes les fenêtres, et une
       * fenêtre-session terminée qui traînerait à côté lèverait un voile sur un document immobile.
       */
      stopped(documentId: string): boolean {
        if (documentId !== store.id()) {
          return false;
        }
        patchState(store, { recording: false, step: null, finalising: true });
        return true;
      },

      /**
       * La consolidation est finie : le document complet arrive dans l'évènement.
       *
       * @remarks
       * ⚠️ Le transcript vient d'être remplacé en entier, écho écarté : une traduction d'avant ne
       * correspondrait plus à rien. Le cas est rare — il faudrait avoir traduit pendant
       * l'enregistrement — et le taire laisserait un texte fantôme à l'écran.
       */
      finalised(document: LiveDocument): void {
        if (document.id !== store.id()) {
          return;
        }
        patchState(store, {
          document,
          finalising: false,
          transcriptTranslation: null,
          transcriptTarget: 'none',
        });
      },

      /**
       * Une étape de plus est franchie.
       *
       * @remarks
       * ⚠️ Filtré sur l'identifiant : plusieurs fenêtres-sessions peuvent travailler en parallèle —
       * l'une finalisant, l'autre générant son compte rendu. Sans ce filtre, chacune afficherait
       * l'avancée de la voisine.
       */
      progressed(progress: LiveProgress): void {
        if (progress.documentId !== store.id()) {
          return;
        }
        patchState(store, { step: progress });
      },

      /** L'avancée d'une traduction, telle que le backend la pousse. */
      translationProgressed(percent: number): void {
        patchState(store, { translationPercent: percent });
      },

      /**
       * Traduit la vue demandée, ou revient à son original — un retour instantané, l'original
       * n'ayant jamais quitté le document. Rend le genre de l'issue, que l'appelant sait dire.
       *
       * @remarks
       * ⚠️ Le sélecteur est posé avant le travail et rendu s'il n'aboutit pas : une paire absente,
       * non supportée ou une annulation laissent le texte inchangé, et le menu doit le dire.
       */
      async translate(
        content: LiveContent,
        target: TranslationTarget,
      ): Promise<TranslationKind | null> {
        const id = store.id();
        if (id === null || !idle()) {
          return null;
        }
        const previous = content === 'report' ? store.reportTarget() : store.transcriptTarget();
        setTarget(content, target);
        if (target === 'none') {
          setTranslation(content, null);
          return null;
        }

        patchState(store, { translationPercent: 0, translatingContent: content });
        try {
          const outcome =
            content === 'report'
              ? await live.translateReport(id, target)
              : await live.translateTranscript(id, target);
          if (outcome === null) {
            // Hors contexte Tauri : il n'y a rien à traduire et rien à annoncer.
            setTarget(content, previous);
            return null;
          }
          if (outcome.kind === 'translated') {
            setTranslation(content, 'sections' in outcome ? outcome.sections : outcome.paragraphs);
            return outcome.kind;
          }
          setTarget(content, previous);
          return outcome.kind;
        } catch (error) {
          setTarget(content, previous);
          patchState(store, { error: toAppError(error) });
          return null;
        } finally {
          patchState(store, { translatingContent: null });
        }
      },

      /**
       * Renonce au travail en cours — une génération, ou une traduction.
       *
       * @remarks
       * - ⚠️ On ne baisse pas le voile ici : l'arrêt se constate entre deux passes et peut mettre
       *   quelques secondes à s'observer. C'est le retour du travail annulé qui conclut.
       * - ⚠️ Un échec d'annulation ne se dit pas : la commande est idempotente et sans échec côté
       *   Rust, et hors contexte Tauri il n'y a rien à annuler.
       */
      cancel(): void {
        const id = store.id();
        if (id === null) {
          return;
        }
        // ⚠️ Deux travaux annulables, un seul bouton — et ils ne peuvent pas courir ensemble : la
        // traduction est refusée pendant une génération, et l'inverse aussi.
        if (store.translatingContent() !== null) {
          void live.cancelTranslation(id);
          return;
        }
        void live.cancelReport(id);
      },

      /**
       * Génère — ou régénère — le compte rendu.
       *
       * @remarks
       * ⚠️ Un compte rendu neuf efface la traduction du précédent : elle traduit des rubriques qui
       * n'existent plus. Le menu retombe sur « Langue d'origine », ce qui est la vérité — le modèle
       * vient d'écrire dans la langue du transcript. On ne retraduit pas d'office : ce serait
       * plusieurs minutes que personne n'a demandées.
       */
      async generate(kind: ReportKind, prompt: string | null): Promise<void> {
        const id = store.id();
        if (id === null || !idle()) {
          return;
        }
        patchState(store, { step: null, working: true });
        try {
          const written = await live.generateReport(id, kind, prompt);
          if (written !== null) {
            patchState(store, {
              document: written,
              reportTranslation: null,
              reportTarget: 'none',
            });
          }
        } catch (error) {
          patchState(store, { error: toAppError(error) });
        } finally {
          patchState(store, { working: false });
        }
      },

      /**
       * Renomme la session.
       *
       * @remarks
       * ⚠️ Un titre vidé n'écrit pas un titre vide : le backend ramène le repli, et l'en-tête
       * retombe sur « Session du {date} » plutôt que de rester blanc.
       */
      async rename(title: string): Promise<void> {
        const id = store.id();
        if (id === null) {
          return;
        }
        try {
          const renamed = await live.rename(id, title);
          // Hors contexte Tauri, le pont ne rend rien : on garde ce qu'on affichait.
          if (renamed !== null) {
            patchState(store, { document: renamed });
          }
        } catch (error) {
          patchState(store, { error: toAppError(error) });
        }
      },

      /**
       * Copie la vue affichée dans le presse-papiers. Rend vrai quand la copie a eu lieu.
       *
       * @param title - Déjà résolu et localisé : ce magasin ne compose aucun texte.
       */
      async copy(content: LiveContent, title: string): Promise<boolean> {
        if (!idle()) {
          return false;
        }
        return guard(async (id) => {
          await live.copyDocument({ id, content, title, ...displayed(content) });
        });
      },

      /**
       * Écrit la vue affichée dans un fichier. Rend vrai quand un fichier a été écrit ; renoncer
       * dans « Enregistrer sous » rend faux, sans rien dire.
       *
       * @param date - Déjà résolue et localisée : voir {@link DirectdocStore.copy}.
       *
       * @remarks
       * - ⚠️ Le dialogue avant le voile : il est modal, et l'utilisateur peut y rester une minute
       *   ou renoncer. Poser `working` d'abord figerait la fenêtre pour rien.
       * - ⚠️ C'est la traduction affichée qui part, quand il y en a une : sans elle, l'écran montre
       *   de l'anglais et le fichier sort en français.
       */
      async exportTo(
        content: LiveContent,
        format: ExportFormat,
        title: string,
        date: string,
      ): Promise<boolean> {
        const id = store.id();
        if (id === null || !idle()) {
          return false;
        }
        let chosen: boolean;
        try {
          chosen = await live.chooseExportPath(id, title, date, format);
        } catch (error) {
          patchState(store, { error: toAppError(error) });
          return false;
        }
        if (!chosen) {
          return false;
        }
        return guard(async (current) => {
          await live.exportDocument({
            id: current,
            content,
            format,
            title,
            ...displayed(content),
          });
        });
      },

      /** Ferme le document : sa mémoire est libérée côté Rust et sa fenêtre disparaît. */
      async close(): Promise<void> {
        const id = store.id();
        if (id !== null) {
          await live.closeDocument(id);
        }
      },

      /** Oublie la dernière erreur, une fois qu'elle a été dite. */
      clearError(): void {
        patchState(store, { error: null });
      },
    };
  }),
);
