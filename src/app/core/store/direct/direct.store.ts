import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Live, NO_MICROPHONE, type LiveLine } from '../../services/live/live';
import { toAppError, type AppError } from '../../models/app-error';
import type {
  AudioSource,
  LiveDocument,
  LiveStream,
  LiveTranscriptEvent,
} from '../../services/bridge/live/live.bridge';

/**
 * Ce qui est en cours d'être dit, par flux. `null` quand ce flux se tait.
 *
 * @remarks
 * ⚠️ Une hypothèse par flux, et non une seule : les deux parlent en même temps, cas normal d'une
 * session animée. Une hypothèse unique ferait s'écraser mutuellement la voix des autres et celle
 * de l'utilisateur, chaque tampon effaçant le précédent.
 */
export interface PendingSpeech {
  /** Ce que le flux système est en train de dire. */
  readonly system: string | null;
  /** Ce que le micro est en train de dire. */
  readonly microphone: string | null;
}

/**
 * Un flux dont la transcription a renoncé, et pourquoi.
 *
 * @remarks
 * ⚠️ La raison est gardée, pas jetée : « les ressources de transcription de "fr" ne sont pas
 * installées » est exactement ce que l'utilisateur doit lire pour agir, là où un message
 * générique le laisserait chercher.
 */
export interface SilentStream {
  /** Le flux qui restera muet. */
  readonly stream: LiveStream;
  /** Ce que le moteur a dit de son renoncement, à montrer tel quel. */
  readonly reason: string;
}

/**
 * Ce que l'écran Direct sait de la machine — les faits, jamais les réglages.
 *
 * @remarks
 * - ⚠️ Même frontière qu'entre `DicteeStore` et `SettingsStore` : ici quelles applications
 *   émettent du son, là-bas les choix de l'utilisateur. Un fait ne se persiste pas.
 * - ⚠️ La source choisie vit ici et non dans les réglages : le sélecteur doit être sans sélection
 *   à chaque ouverture, car rejouer le choix précédent ferait enregistrer Zoom pendant qu'on
 *   parle sur Teams. C'est le seul champ de l'écran qui ne se mémorise pas.
 */
interface DirectState {
  /** Les applications qui émettent, plus « Tout le système ». Relues à chaque ouverture. */
  readonly sources: readonly AudioSource[];
  /** Les sources ont-elles déjà été lues ? */
  readonly loaded: boolean;
  /** La source choisie. `null` tant que l'utilisateur n'a pas tranché. */
  readonly sourceId: string | null;
  /**
   * Un enregistrement est-il en cours ?
   *
   * @remarks
   * ⚠️ L'écran ne change d'état que sur ce drapeau, jamais sur l'intention de démarrer :
   * l'ouverture du tap prend ~2,7 s, et basculer avant qu'elle réussisse montrerait un bandeau
   * d'enregistrement sur une capture qui va échouer.
   */
  readonly recording: boolean;
  /** Le démarrage ou l'arrêt est-il en vol ? Le bouton s'en sert pour refuser un second clic. */
  readonly busy: boolean;
  /**
   * Ce qui était capté, relevé au démarrage.
   *
   * @remarks
   * ⚠️ Recopié, et non relu des sources à l'affichage : la liste se rafraîchit, et l'application
   * captée peut en disparaître en cours de session. Le bandeau doit continuer de dire ce qu'on
   * enregistre.
   */
  readonly recordingSource: string;
  /** Le micro était-il inclus dans la capture ? Relevé au démarrage lui aussi. */
  readonly recordingWithMicrophone: boolean;
  /**
   * Quand la capture a démarré, en millisecondes depuis l'époque. `null` au repos.
   *
   * @remarks
   * - ⚠️ Dans le magasin et non dans l'écran : quitter le Direct pour les Options détruit le
   *   composant, et un compteur qu'il tiendrait repartirait de zéro puis se figerait.
   * - ⚠️ L'heure murale, et non les échantillons écrits : `systemFrames / 16 000` se figerait si
   *   le tap se tarissait, alors que le chrono doit avancer même sur du silence.
   */
  readonly startedAtMs: number | null;
  /**
   * Le transcript acquis — les segments que le moteur ne remettra plus en cause.
   *
   * @remarks
   * - ⚠️ Rien n'en est jamais retiré : l'écran n'en affiche que la queue, mais c'est de cette
   *   liste que se fait le document de la session. Y plafonner l'accumulation perdrait le début
   *   de chaque session longue, en silence.
   * - ⚠️ Dans le magasin et non dans l'écran : la fenêtre peut se fermer pendant une session, et
   *   un transcript logé dans un composant mourrait avec lui.
   */
  readonly transcript: readonly LiveLine[];
  /** Ce qui est en train d'être dit, par flux. Voir {@link PendingSpeech}. */
  readonly pending: PendingSpeech;
  /**
   * Les flux dont la transcription a renoncé.
   *
   * @remarks
   * ⚠️ Un flux non transcrit n'arrête pas la session : l'audio continue d'être écrit, et c'est
   * lui qui compte. L'écran le dit sans le cacher — un transcript à moitié muet sans explication
   * serait pris pour une panne générale.
   */
  readonly silentStreams: readonly SilentStream[];
  /**
   * La traduction de chaque segment acquis, par identifiant de ligne.
   *
   * L'écran regroupe les traductions aux mêmes frontières que l'original, ce qui garde les deux
   * colonnes en regard sans que le magasin connaisse la notion de paragraphe.
   *
   * @remarks
   * - ⚠️ Par segment et non par paragraphe : un paragraphe grossit à chaque segment, et le
   *   retraduire réécrirait le bloc entier une dizaine de fois sous les yeux de l'utilisateur.
   * - ⚠️ Une ligne absente n'est pas une panne : elle n'est pas encore traduite, ou sa paire
   *   manque. Le paragraphe rend alors ce qu'il a.
   */
  readonly translations: Readonly<Record<number, string>>;
  /** Le compteur qui donne aux lignes leur clé stable. */
  readonly nextLineId: number;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

/** Aucune hypothèse en cours, sur aucun des deux flux. */
const NOTHING_PENDING: PendingSpeech = { system: null, microphone: null };

const initialState: DirectState = {
  sources: [],
  loaded: false,
  sourceId: null,
  recording: false,
  busy: false,
  recordingSource: '',
  recordingWithMicrophone: false,
  startedAtMs: null,
  transcript: [],
  pending: NOTHING_PENDING,
  silentStreams: [],
  translations: {},
  nextLineId: 0,
  error: null,
};

/** Le Direct : ce qu'on peut capter, ce qu'on capte, et le transcript qui en sort. */
export const DirectStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    /**
     * Peut-on démarrer ?
     *
     * @remarks
     * ⚠️ La source doit exister dans la liste courante, pas seulement être non nulle : une
     * application choisie puis fermée laisse un identifiant périmé, et démarrer dessus
     * échouerait côté natif alors qu'on peut le voir ici.
     */
    canStart: computed(() => {
      if (store.recording() || store.busy()) {
        return false;
      }
      const chosen = store.sourceId();
      return chosen !== null && store.sources().some((source) => source.id === chosen);
    }),
  })),
  withMethods((store, live = inject(Live)) => ({
    /**
     * Relit les sources captables.
     *
     * @remarks
     * - ⚠️ Ne rejette jamais : un backend muet laisse l'écran lisible, liste vide et bouton
     *   inactif, et l'erreur remonte par `error` pour une snackbar.
     * - ⚠️ La source choisie ne survit que si elle émet toujours : garder un identifiant disparu
     *   laisserait « Démarrer » actif sur un choix que l'écran ne montre plus.
     */
    async load(): Promise<void> {
      try {
        const sources = await live.audioSources();
        const chosen = store.sourceId();
        patchState(store, {
          sources,
          loaded: true,
          sourceId: sources.some((source) => source.id === chosen) ? chosen : null,
        });
      } catch (error) {
        patchState(store, { loaded: true, error: toAppError(error) });
      }
    },

    /** Retient la source choisie. */
    select(sourceId: string | null): void {
      patchState(store, { sourceId });
    },

    /**
     * Se remet à l'heure de ce que le backend sait de la session en cours. Ne rejette jamais :
     * un backend muet laisse l'écran sur ce qu'il croyait, et l'erreur remonte par `error`.
     *
     * @remarks
     * - ⚠️ Sans elle, une fenêtre qui naît au milieu d'une session ne sait rien : deux fenêtres
     *   la regardent, chacune avec son propre magasin, et une fenêtre principale rouverte en
     *   pleine session afficherait « Démarrer » sur un enregistrement d'une heure.
     * - ⚠️ La consolidation compte comme un enregistrement non fini : il n'y a qu'une capture
     *   audio, donc pas de seconde session tant qu'elle tourne.
     */
    async sync(): Promise<void> {
      try {
        const session = await live.session();
        patchState(store, {
          recording: session.phase !== 'idle',
          recordingSource: session.sourceName ?? '',
          recordingWithMicrophone: session.withMicrophone,
          startedAtMs: session.startedAtMs,
        });
      } catch (error) {
        patchState(store, { error: toAppError(error) });
      }
    },

    /**
     * Démarre l'enregistrement.
     *
     * @returns Vrai s'il a réellement commencé.
     *
     * @remarks
     * ⚠️ L'état ne bascule qu'au succès : un tap qui refuse de s'ouvrir laisse l'écran sur sa
     * configuration, avec l'erreur à dire. Basculer d'abord donnerait un bandeau
     * d'enregistrement sans enregistrement, et un « Arrêter » qui n'arrête rien.
     */
    async start(
      microphoneId: string | null,
      language: string | null,
      translationTarget: string | null,
    ): Promise<boolean> {
      const chosen = store.sourceId();
      const source = store.sources().find((entry) => entry.id === chosen);
      if (chosen === null || source === undefined) {
        return false;
      }

      // ⚠️ Le transcript précédent part au démarrage, jamais à l'arrêt : l'effacer à l'arrêt le
      // ferait disparaître sous les yeux de l'utilisateur au moment où il finit de parler.
      patchState(store, {
        busy: true,
        transcript: [],
        pending: NOTHING_PENDING,
        silentStreams: [],
        translations: {},
      });
      try {
        const document = await live.start(chosen, microphoneId, language, translationTarget);
        // ⚠️ L'instant de départ vient du backend : deux fenêtres affichent le même minuteur, et
        // chacune relevant sa propre heure compterait deux durées pour une seule session. Le
        // repli sur l'horloge locale ne sert qu'au navigateur, où il n'y a pas de backend.
        // ⚠️ Relevé au retour de l'appel, jamais avant : l'ouverture du tap prend ~2,7 s, et les
        // compter ferait démarrer le chrono en avance d'autant.
        patchState(store, {
          recording: true,
          busy: false,
          recordingSource: source.name,
          recordingWithMicrophone: microphoneId !== NO_MICROPHONE,
          startedAtMs: document?.startedAtMs ?? Date.now(),
        });
        return true;
      } catch (error) {
        patchState(store, { busy: false, error: toAppError(error) });
        return false;
      }
    },

    /**
     * Arrête l'enregistrement. La consolidation ne se lance pas d'ici : le backend l'enchaîne,
     * car fermer la fenêtre-session tuerait l'interface qui aurait dû s'en charger.
     *
     * @remarks
     * ⚠️ L'état redescend même si l'arrêt échoue : laisser l'écran bloqué sur un enregistrement
     * qu'on ne sait plus clore priverait l'utilisateur de tout recours. L'échec se dit, il
     * n'emprisonne pas.
     */
    async stop(): Promise<void> {
      patchState(store, { busy: true });
      try {
        await live.stop();
      } catch (error) {
        patchState(store, { error: toAppError(error) });
      } finally {
        patchState(store, { recording: false, busy: false, startedAtMs: null });
      }
    },

    /**
     * Prend acte d'une session arrêtée ailleurs. Idempotente, donc sans danger pour la fenêtre
     * qui a cliqué et qui reçoit l'évènement en écho.
     *
     * @remarks
     * ⚠️ Même effet que la fin de `stop` : les deux fenêtres portent un bouton « Arrêter », et
     * celle qui n'a pas cliqué doit redescendre aussi.
     */
    stopped(): void {
      patchState(store, {
        recording: false,
        busy: false,
        startedAtMs: null,
        pending: NOTHING_PENDING,
      });
    },

    /**
     * Applique un morceau de transcript : le cœur de la transcription en direct.
     *
     * `final` ajoute un segment acquis et ferme l'hypothèse de son flux ; `partial` remplace
     * celle du même flux ; `failed` note qu'un flux ne sera pas transcrit, sans rien jeter.
     *
     * @remarks
     * - ⚠️ Confondre les trois casse le texte : un `partial` traité comme un ajout répète la même
     *   phrase plusieurs fois par seconde, un `final` qui ne ferme pas son hypothèse la double.
     * - ⚠️ Un morceau vide n'entre pas : le moteur en produit entre deux énoncés, et chacun ferait
     *   clignoter l'hypothèse affichée.
     */
    applyTranscript(event: LiveTranscriptEvent): void {
      // ⚠️ Avant tout autre test, parce que `dropped` ne porte pas de texte : il dit « efface ce
      // que tu tenais », pas « voici du vide ». Le laisser tomber dans le test du texte vide le
      // ferait ignorer, et l'hypothèse d'écho resterait à l'écran.
      if (event.kind === 'dropped') {
        patchState(store, { pending: { ...store.pending(), [event.stream]: null } });
        return;
      }

      const text = event.text.trim();
      if (text.length === 0) {
        return;
      }

      if (event.kind === 'failed') {
        // ⚠️ Un flux ne se signale qu'une fois : le moteur peut échouer plusieurs fois de suite,
        // et répéter la snackbar en ferait un mur devant l'écran.
        const known = store.silentStreams().some((silent) => silent.stream === event.stream);
        patchState(store, {
          silentStreams: known
            ? store.silentStreams()
            : [...store.silentStreams(), { stream: event.stream, reason: text }],
          pending: { ...store.pending(), [event.stream]: null },
        });
        return;
      }

      if (event.kind === 'partial') {
        patchState(store, { pending: { ...store.pending(), [event.stream]: text } });
        return;
      }

      const id = store.nextLineId();
      patchState(store, {
        transcript: [
          ...store.transcript(),
          { id, stream: event.stream, text, paragraph: event.paragraph === true },
        ],
        nextLineId: id + 1,
        pending: { ...store.pending(), [event.stream]: null },
      });
    },

    /**
     * Abandonne l'hypothèse en cours sur les deux flux. Le transcript acquis, lui, ne bouge pas.
     *
     * @remarks
     * ⚠️ À appeler à l'arrêt : le moteur finalise ce qu'il peut, mais ce qu'il tenait de moins
     * sûr ne reviendra jamais, et l'hypothèse orpheline resterait affichée pour toujours.
     */
    dropPendingSpeech(): void {
      patchState(store, { pending: NOTHING_PENDING });
    },

    /**
     * Range la traduction d'un segment acquis.
     *
     * @remarks
     * - ⚠️ C'est la fenêtre qui traduit, pas le magasin : la traduction est une file séquentielle
     *   avec un moteur qui peut refuser, et cette mécanique appartient à l'écran. Le magasin ne
     *   fait que tenir le résultat, pour qu'il survive au composant.
     * - ⚠️ Une seconde traduction du même segment est ignorée : un segment acquis ne change plus,
     *   et la réécrire ne pourrait que faire clignoter la colonne.
     */
    translated(id: number, text: string): void {
      if (store.translations()[id] !== undefined) {
        return;
      }
      patchState(store, { translations: { ...store.translations(), [id]: text } });
    },

    /** Oublie la dernière erreur, une fois qu'elle a été dite. */
    clearError(): void {
      patchState(store, { error: null });
    },
  })),
);
