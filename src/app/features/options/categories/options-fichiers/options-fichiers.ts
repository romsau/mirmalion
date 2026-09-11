import { Component, computed, inject, signal } from '@angular/core';
import { ProgressBar } from '../../../../shared/components/progress-bar/progress-bar';
import { FileDropZone } from './components/file-drop-zone/file-drop-zone';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { Transcription } from '../../../../core/services/transcription/transcription';
import { toAppError } from '../../../../core/models/app-error';
import type { Language } from '../../../../core/models/settings';
import type {
  FileDropEvent,
  LanguageProblem,
  MediaInfo,
  MediaProblem,
} from '../../../../core/services/bridge/media/media.bridge';
import { MediaBridge } from '../../../../core/services/bridge/media/media.bridge';
import { subscriptions } from '../../../../core/services/bridge/subscriptions';

/**
 * Ce qu'on dit quand la langue ne se décide pas.
 *
 * @remarks
 * ⚠️ Quatre messages et non un, parce qu'il y a quatre gestes : changer de fichier, choisir la
 * langue soi-même, installer la langue parlée, ou en installer une. Un message unique laisserait
 * sans issue dans trois cas sur quatre. On y nomme l'écran où aller, sans proposer de bouton.
 */
function undecidedMessage(problem: LanguageProblem): string {
  switch (problem) {
    case 'noSpeech':
      return $localize`:@@fichiers.detect.noSpeech:Aucune parole n'a été trouvée dans ce fichier.`;
    case 'unsupportedLanguage':
      return $localize`:@@fichiers.detect.unsupportedLanguage:La langue parlée dans ce fichier n'est pas installée. Ajoutez-la dans Options ▸ Langues.`;
    case 'tooShort':
      return $localize`:@@fichiers.detect.tooShort:Ce fichier est trop court pour reconnaître la langue. Choisissez-la vous-même.`;
    case 'noInstalledLanguage':
      return $localize`:@@fichiers.detect.noInstalledLanguage:Aucune langue parlée n'est installée. Ajoutez-en une dans Options ▸ Langues.`;
  }
}

/**
 * Fichiers, panneau d'une famille des Options : on y dépose un média local, puis on le traite.
 *
 * @remarks
 * - ⚠️ Ce n'est pas un panneau de réglages, c'est la fonction elle-même : elle a quitté la
 *   navigation principale, et un nouvel utilisateur ne la trouvera pas seul.
 * - ⚠️ Le glisser-déposer passe par le pont, jamais par le DOM : wry détourne le glisser du
 *   WKWebView, et un `File` de `DataTransfer` n'expose aucun chemin absolu.
 * - ⚠️ Un refus n'entre jamais dans l'état « en cours » : le verdict tombe avant que `media` ne
 *   soit posé, sans quoi un traitement paraîtrait avoir commencé puis échoué.
 */
@Component({
  selector: 'app-options-fichiers',
  imports: [FileDropZone, ProgressBar],
  templateUrl: './options-fichiers.html',
  styleUrl: './options-fichiers.scss',
  host: {
    '[class.is-drag]': 'dragging()',
  },
})
export class OptionsFichiers {
  private readonly bridge = inject(MediaBridge);
  private readonly snackbar = inject(Snackbar);
  private readonly transcription = inject(Transcription);

  /** Un fichier est en cours de glisser au-dessus de la fenêtre. */
  protected readonly dragging = signal(false);

  /**
   * L'avancée de la transcription, en pourcentages entiers. Déterminée et vraie : le backend la
   * calcule sur la position dans le média, et n'émet que sur changement de pourcentage entier.
   */
  protected readonly percent = signal(0);

  /**
   * Le média accepté, en cours de traitement — `null` tant qu'on est à l'import.
   *
   * @remarks
   * ⚠️ C'est lui, et lui seul, qui fait basculer l'écran : il n'est posé qu'après un verdict
   * `accepted`.
   */
  protected readonly media = signal<MediaInfo | null>(null);

  /**
   * La détection de langue tourne — les toutes premières secondes du traitement.
   *
   * @remarks
   * ⚠️ Un état de plus pour trois secondes, et il le vaut : sans lui, la barre reste à 0 % sous
   * le nom du fichier, indiscernable d'une barre bloquée pendant que la machine travaille.
   */
  protected readonly detecting = signal(false);

  /**
   * Ce que la barre annonce — l'étape en cours, puis le nom du fichier.
   *
   * @remarks
   * ⚠️ Le pourcentage n'est pas masqué pendant la détection : il vaut 0, et c'est vrai — zéro
   * pour cent du média est transcrit.
   */
  protected readonly progressLabel = computed(() =>
    this.detecting()
      ? $localize`:@@fichiers.detect.working:Détection de la langue…`
      : (this.media()?.fileName ?? ''),
  );

  private readonly subs = subscriptions();

  /**
   * Le numéro du traitement en cours.
   *
   * @remarks
   * ⚠️ Il existe pour qu'un traitement abandonné ne parle plus au nom de l'écran : annuler rend la
   * main tout de suite, mais la promesse de `transcribe` retombe après un aller-retour dans le
   * moteur natif — assez tard pour effacer le média déposé depuis.
   */
  private run = 0;

  constructor() {
    void this.listen();
  }

  /**
   * Ouvre le sélecteur de fichiers du système, puis inspecte ce qui en sort.
   *
   * @remarks
   * - ⚠️ Le filtre vient du backend ({@link Tauri.supportedMediaExtensions}) : le recopier ici
   *   ferait un jour proposer un format que le moteur refuse.
   * - ⚠️ Annuler le sélecteur n'est pas un refus : rien à dire, rien à afficher.
   */
  protected async browseMedia(): Promise<void> {
    try {
      const extensions = await this.bridge.supportedMediaExtensions();
      const path = await this.bridge.pickMediaFile(extensions ?? []);
      if (path === null) {
        return;
      }
      await this.importMedia([path]);
    } catch {
      this.reportFailure();
    }
  }

  /**
   * Prononce le verdict de dépôt sur des chemins, et n'entre dans l'état « en cours » que s'ils
   * sont acceptés.
   *
   * `paths` est au pluriel parce que macOS peut en livrer plusieurs d'un coup, et que c'est un
   * cas de refus à part entière — tranché côté Rust, sans ouvrir aucun fichier.
   */
  protected async importMedia(paths: readonly string[]): Promise<void> {
    try {
      const verdict = await this.bridge.inspectMedia(paths);
      // Hors contexte Tauri, il n'y a pas de verdict : l'écran reste à l'import, muet.
      if (verdict === null) {
        return;
      }
      if (verdict.status === 'rejected') {
        this.snackbar.error(refusalMessage(verdict.problem));
        return;
      }
      this.media.set(verdict);
      this.startTranscription(verdict);
    } catch {
      this.reportFailure();
    }
  }

  /**
   * Lance la transcription du média accepté, et rend la main aussitôt.
   *
   * Au bout du travail, c'est le **backend** qui ouvre la fenêtre-document : cet écran n'a rien
   * à afficher du résultat, il revient simplement à l'import — prêt pour le média suivant.
   */
  protected startTranscription(media: MediaInfo): void {
    void this.transcribe(media);
  }

  /**
   * L'utilisateur renonce : retour à l'import, et arrêt réel du travail natif.
   *
   * @remarks
   * ⚠️ L'écran revient à l'import sans attendre la confirmation du moteur : l'arrêt est réel — le
   * drapeau est lu par le rappel de progression côté Swift — mais il ne prend effet qu'au
   * prochain tampon.
   */
  protected cancelImport(): void {
    this.run += 1;
    this.media.set(null);
    // La détection en vol, elle, ne s'arrête pas — mais son libellé n'a plus rien à dire, et
    // son `finally` est gardé par un jeton qu'on vient de faire avancer.
    this.detecting.set(false);
    void this.stopTranscription();
  }

  /**
   * Déroule la transcription : l'abonnement, l'appel, la sortie.
   *
   * @remarks
   * ⚠️ On s'abonne avant d'appeler : le travail natif démarre dans la foulée de la commande, et
   * un abonnement posé après elle manquerait les premières avancées — toutes, sur un média court.
   */
  private async transcribe(media: MediaInfo): Promise<void> {
    const run = ++this.run;
    this.percent.set(0);
    let unlisten: (() => void) | null = null;
    try {
      // ⚠️ La détection passe avant l'abonnement : elle dure quelques secondes et peut ne rien
      // décider — s'abonner d'abord poserait un écouteur sur un travail qui ne démarrera pas.
      // ⚠️ Le retour au repos est gardé par le jeton : une détection abandonnée finit quand même,
      // souvent après qu'un second média a démarré la sienne, et éteindrait son libellé.
      this.detecting.set(true);
      const language = await this.detectLanguage(media).finally(() => {
        if (this.run === run) {
          this.detecting.set(false);
        }
      });
      if (language === null) {
        // Le motif a déjà été dit ; il ne reste qu'à revenir à l'import.
        if (this.run === run) {
          this.media.set(null);
        }
        return;
      }
      unlisten = await this.transcription.observeProgress((percent) => {
        if (this.run === run) {
          this.percent.set(percent);
        }
      });
      await this.transcription.transcribe({
        path: media.path,
        fileName: media.fileName,
        language,
      });
      if (this.run === run) {
        this.media.set(null);
      }
    } catch (error) {
      // ⚠️ Une annulation n'est pas une panne et ne se dit pas : l'utilisateur vient de la
      // demander. Le jeton l'a déjà écartée ; ce qui reste ici est un vrai échec.
      if (this.run === run && toAppError(error).kind !== 'cancelled') {
        this.media.set(null);
        this.snackbar.error(
          $localize`:@@fichiers.transcription.failed:La transcription a échoué. Réessayez, et redémarrez Mirmalion si cela se reproduit.`,
        );
      }
    } finally {
      unlisten?.();
    }
  }

  /**
   * La langue parlée du média, ou `null` si elle ne se décide pas — le motif ayant alors déjà été
   * dit à l'utilisateur.
   *
   * @remarks
   * - ⚠️ Ne pas la remplacer par un sélecteur de langue : le produit ne veut aucun réglage à
   *   l'import, et l'écran l'annonce en toutes lettres.
   * - ⚠️ Hors contexte Tauri, il n'y a pas de verdict et l'on rend `null` sans rien dire.
   */
  private async detectLanguage(media: MediaInfo): Promise<Language | null> {
    const verdict = await this.bridge.detectMediaLanguage(media.path);
    if (verdict === null) {
      return null;
    }
    if (verdict.status === 'undecided') {
      this.snackbar.error(undecidedMessage(verdict.problem));
      return null;
    }
    return verdict.language;
  }

  /**
   * Demande au moteur natif d'arrêter la transcription en cours.
   *
   * @remarks
   * ⚠️ Un échec ne se dit pas : la commande est idempotente et sans échec côté Rust, et
   * l'utilisateur voit déjà son écran revenir à l'import — une snackbar le ferait douter d'un
   * geste qui a abouti.
   */
  private async stopTranscription(): Promise<void> {
    try {
      await this.transcription.cancel();
    } catch {
      // Rien à dire : voir ci-dessus.
    }
  }

  /**
   * Branche le glisser-déposer de la fenêtre. Voir l'en-tête pour le pourquoi.
   *
   * @remarks
   * ⚠️ Un glisser au-dessus de l'écran « en cours » est ignoré, teinte comprise : une seule
   * opération à la fois par fenêtre, et promettre un second import qu'on refuserait ensuite
   * serait pire que de ne rien promettre.
   */
  private async listen(): Promise<void> {
    await this.subs.keep(
      this.bridge.onFileDrop((event) => {
        this.onFileDrop(event);
      }),
    );
  }

  private onFileDrop(event: FileDropEvent): void {
    if (this.media() !== null) {
      return;
    }
    if (event.kind === 'enter') {
      this.dragging.set(true);
      return;
    }
    // Le dépôt clôt le glisser : macOS n'envoie pas de `leave` derrière lui.
    this.dragging.set(false);
    if (event.kind === 'drop') {
      void this.importMedia(event.paths);
    }
  }

  /**
   * Annonce une panne de l'analyse.
   *
   * @remarks
   * ⚠️ La panne a son propre message, distinct des cinq refus : un `AppError` remonté par
   * l'inspection dit que la brique native est cassée, jamais que le fichier ne convient pas.
   */
  private reportFailure(): void {
    this.snackbar.error(
      $localize`:@@fichiers.reject.failed:L'analyse du média a échoué. Réessayez, et redémarrez Mirmalion si cela se reproduit.`,
    );
  }
}

/**
 * Le message d'un refus. Cinq motifs, cinq phrases : qui a déposé une vidéo muette n'a pas la même
 * chose à faire que qui a déposé un fichier corrompu.
 *
 * @remarks
 * - ⚠️ Une phrase, et courte : une snackbar disparaît en six secondes. Elle dit ce qui bloque et,
 *   s'il y a quelque chose à faire, quoi faire — ne pas la rallonger.
 * - ⚠️ Les formats se nomment ici et nulle part ailleurs : la validation ouvre le conteneur,
 *   jamais l'extension, et une liste affichée au repos ferait paraître refusé ce qu'on accepte.
 */
function refusalMessage(problem: MediaProblem): string {
  switch (problem) {
    case 'empty':
      return $localize`:@@fichiers.reject.empty:Ce fichier est vide.`;
    case 'unreadable':
      return $localize`:@@fichiers.reject.unreadable:Fichier illisible. Essayez un MP3, M4A, WAV, MP4 ou MOV.`;
    case 'noAudioTrack':
      return $localize`:@@fichiers.reject.noAudioTrack:Cette vidéo n'a pas de son.`;
    case 'multipleFiles':
      return $localize`:@@fichiers.reject.multipleFiles:Un seul fichier à la fois.`;
    case 'noFile':
      return $localize`:@@fichiers.reject.noFile:Glissez un fichier audio ou vidéo.`;
  }
}
