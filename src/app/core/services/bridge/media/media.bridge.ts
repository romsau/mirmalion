/**
 * Les médias locaux : leur inspection, leur transcription, et les documents qui en sortent.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';
import type { Language } from '../../../models/settings';

/**
 * Pourquoi un média déposé est refusé.
 *
 * @remarks
 * ⚠️ Ce sont des codes, et c'est le frontend qui écrit les phrases : l'interface est localisée
 * dans six langues au build, un message rédigé côté backend sortirait en français sur une
 * interface portugaise.
 *
 * Miroir de `MediaProblem` (`src-tauri/src/media/mod.rs`).
 */
export type MediaProblem = 'empty' | 'unreadable' | 'noAudioTrack' | 'multipleFiles' | 'noFile';

/**
 * Ce qu'on sait d'un média accepté.
 *
 * @remarks
 * ⚠️ `path` est le chemin d'origine : le fichier n'est ni copié, ni déplacé. C'est ce qui rendra
 * la ré-analyse possible.
 */
export interface MediaInfo {
  readonly path: string;
  /** Le nom du fichier, sans son dossier. Titre par défaut du document. */
  readonly fileName: string;
  readonly durationMs: number;
  readonly hasVideo: boolean;
}

/**
 * Le verdict du dépôt.
 *
 * @remarks
 * ⚠️ Un refus arrive en succès, pas en erreur : un {@link AppError} remonté d'`inspectMedia`
 * veut dire que la brique native est cassée, jamais que le fichier ne convient pas.
 *
 * Miroir de `MediaInspection` (`src-tauri/src/media/mod.rs`), marqué par `status` : la variante
 * acceptée porte les champs de {@link MediaInfo} à plat, à côté du marqueur.
 */
export type MediaInspection =
  | ({ readonly status: 'accepted' } & MediaInfo)
  | { readonly status: 'rejected'; readonly problem: MediaProblem };

/**
 * Pourquoi la langue parlée d'un média n'a pas pu être décidée.
 *
 * @remarks
 * ⚠️ Trois codes et non un : ils demandent trois gestes différents — rien à transcrire,
 * « installez cette langue », « installez-en une ». Un message unique laisserait l'utilisateur
 * sans issue dans deux cas sur trois.
 *
 * Miroir de `LanguageProblem` (`src-tauri/src/media/language.rs`).
 */
export type LanguageProblem =
  'noSpeech' | 'unsupportedLanguage' | 'tooShort' | 'noInstalledLanguage';

/**
 * Le verdict de détection de la langue parlée.
 *
 * @remarks
 * ⚠️ Une indécision arrive en succès, pas en erreur — même règle que {@link MediaInspection}.
 * Un {@link AppError} remonté de {@link Tauri.detectMediaLanguage} veut dire que la brique
 * native est cassée, jamais que le média est inexploitable.
 *
 * Miroir de `LanguageDetection` (`src-tauri/src/media/language.rs`).
 */
export type LanguageDetection =
  | { readonly status: 'detected'; readonly language: Language }
  | { readonly status: 'undecided'; readonly problem: LanguageProblem };

/**
 * Ce qu'un glisser de fichiers au-dessus de la fenêtre raconte.
 *
 * @remarks
 * ⚠️ `over` n'y figure pas : il arrive à chaque image, ne porte que des coordonnées, et rien
 * dans l'écran d'import n'en dépend.
 */
export type FileDropEvent =
  | { readonly kind: 'enter' }
  | { readonly kind: 'leave' }
  | { readonly kind: 'drop'; readonly paths: readonly string[] };

/** Un mot et sa fenêtre de temps, en millisecondes depuis le début du média. */
export interface TranscriptWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Un paragraphe : une suite de mots que rien n'a interrompu. */
export interface TranscriptParagraph {
  readonly words: readonly TranscriptWord[];
}

/**
 * Le transcript d'un média ou d'une session : du texte, sans aucune étiquette.
 *
 * @remarks
 * ⚠️ La frontière d'un paragraphe est le silence, et elle est posée côté Rust — voir
 * `PARAGRAPH_SILENCE_MS`.
 */
export interface Transcript {
  readonly language: string;
  readonly paragraphs: readonly TranscriptParagraph[];
}

/**
 * Un document ouvert dans une fenêtre-document.
 *
 * @remarks
 * - ⚠️ Il n'est conservé nulle part : fermer sa fenêtre le perd définitivement, d'où la modale
 *   de confirmation.
 * - ⚠️ Les mots horodatés restent côté Rust : plus de mille entrées pour six minutes, quand une
 *   fenêtre n'affiche que des paragraphes.
 */
export interface FileDocument {
  readonly id: string;
  readonly title: string;
  /** Le nom du fichier d'origine — le repli du titre quand l'utilisateur vide le champ. */
  readonly fileName: string;
  readonly path: string;
  readonly language: string;
  readonly durationMs: number;
  readonly transcript: Transcript;
}

/**
 * Un paragraphe réduit à son texte, tel que la traduction le rend.
 *
 * @remarks
 * ⚠️ Plus de mots horodatés, et ce n'est pas une omission : traduire détruit l'horodatage au mot
 * — l'ordre change, le nombre change, aucune correspondance ne survit. Les bornes du paragraphe
 * restent justes, ce sont celles de l'audio.
 *
 * Miroir de `RenderedParagraph` (`src-tauri/src/transcript/mod.rs`).
 */
export interface RenderedParagraph {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/**
 * Ce qu'il advient d'une demande de traduction de transcript. Miroir de
 * `TranscriptTranslation` (`src-tauri/src/translation/paragraphs.rs`).
 *
 * @remarks
 * - ⚠️ `pairMissing`, `pairUnsupported` et `cancelled` arrivent en succès : ce sont des issues
 *   nominales, jamais des pannes. Une annulation ne se dit même pas — elle a été demandée.
 * - ⚠️ `cancelled` ne porte aucun paragraphe : une traduction interrompue en laisserait à moitié
 *   traduits. L'écran garde ce qu'il montrait.
 * - ⚠️ `source` et `target` composent une phrase qui ne nomme que la langue cible.
 */
export type TranscriptTranslation =
  | { readonly kind: 'translated'; readonly paragraphs: readonly RenderedParagraph[] }
  | { readonly kind: 'pairMissing'; readonly source: string; readonly target: string }
  | { readonly kind: 'pairUnsupported'; readonly source: string; readonly target: string }
  | { readonly kind: 'cancelled' };

/**
 * Un format d'export. Huit, et c'est le backend qui en dicte les extensions.
 *
 * @remarks
 * ⚠️ `srt` et `vtt` n'ont de sens que sur un transcript : un compte rendu n'a aucun timing à
 * porter, et un fichier de sous-titres dont tous les repères vaudraient `00:00:00` serait
 * accepté par le lecteur sans rien montrer.
 *
 * Miroir d'`ExportFormat` (`src-tauri/src/export/format.rs`).
 */
export type ExportFormat =
  'markdown' | 'plainText' | 'csv' | 'json' | 'srt' | 'vtt' | 'pdf' | 'docx';

/**
 * Ce qu'il faut pour écrire un export.
 *
 * @remarks
 * ⚠️ **Aucun chemin d'écriture ici.** La boîte « Enregistrer sous » est ouverte par Rust, dans son
 * propre processus : le frontend demande un export, il ne dit pas où. Rajouter un champ `path`
 * ferait refuser la requête — le backend est en `deny_unknown_fields`, et c'est voulu.
 */
export interface ExportRequest {
  readonly id: string;
  readonly format: ExportFormat;
  /**
   * Les paragraphes tels que la fenêtre les affiche, ou absent pour relire le transcript.
   *
   * @remarks
   * - ⚠️ Le fichier doit ressembler à l'écran : la traduction est une vue qui vit côté frontend,
   *   quand le backend ne connaît que le transcript d'origine. Sans ce champ, une fenêtre
   *   affichant de l'allemand exportait un `.docx` français.
   * - ⚠️ Absent n'est pas « vide » : c'est le cas de tout document non traduit, et c'est ce qui
   *   garde au JSON ses mots horodatés — que la traduction ne peut pas porter.
   */
  readonly paragraphs?: readonly RenderedParagraph[];
}

/** Ce qu'il faut pour copier un document dans le presse-papiers. */
export interface CopyRequest {
  readonly id: string;
  /** Les paragraphes affichés, ou absent pour relire le transcript — voir {@link ExportRequest}. */
  readonly paragraphs?: readonly RenderedParagraph[];
}

/** Ce qu'il faut pour lancer une transcription. */
export interface TranscriptionRequest {
  readonly path: string;
  readonly fileName: string;
  readonly language: string;
}

/** L'avancement d'une transcription, en pourcentages entiers. */
export interface TranscriptionProgress {
  readonly percent: number;
}

/**
 * L'avancement de la traduction d'un document, en pourcentages entiers.
 *
 * @remarks
 * ⚠️ L'identifiant n'est pas décoratif : plusieurs fenêtres-documents vivent en parallèle et un
 * évènement Tauri est diffusé à toutes — sans ce champ, la barre d'un document afficherait
 * l'avancée du voisin. C'est le service de domaine qui filtre, voir `observeTranslationProgress`.
 */
export interface TranslationProgress {
  readonly documentId: string;
  readonly percent: number;
}

/** Les médias locaux : leur inspection, leur transcription, et les documents qui en sortent. */
@Service()
export class MediaBridge {
  private readonly core = inject(Invoke);

  /**
   * Les extensions que le sélecteur « Parcourir l'ordinateur » doit proposer.
   *
   * @remarks
   * ⚠️ C'est le backend qui dicte la liste, et elle ne se recopie pas ici : le filtre du
   * sélecteur et la validation réelle doivent parler du même périmètre, sinon le sélecteur
   * finira par proposer un format que le moteur refuse — ou par en refuser un qu'il sait lire.
   */
  async supportedMediaExtensions(): Promise<readonly string[] | null> {
    return this.core.call<string[]>('supported_media_extensions');
  }

  /**
   * Ouvre le sélecteur de fichiers de macOS, filtré, et rend le chemin choisi — `null` si
   * l'utilisateur a annulé.
   *
   * @remarks
   * - ⚠️ `extensions` vient de {@link supportedMediaExtensions}, jamais d'une constante locale.
   * - ⚠️ Le filtre est un confort, pas la validation : le verdict se prononce en ouvrant le
   *   conteneur, dans {@link inspectMedia} — un `.mp4` renommé `.mp3` doit être accepté.
   * - ⚠️ Le nom du filtre n'est pas affiché sur macOS, dont le panneau d'ouverture n'a pas de
   *   menu de format : d'où une étiquette technique et non un texte localisé.
   */
  async pickMediaFile(extensions: readonly string[]): Promise<string | null> {
    if (!this.core.isTauri()) {
      return null;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    return open({
      multiple: false,
      directory: false,
      filters: [{ name: 'media', extensions: [...extensions] }],
    });
  }

  /**
   * Dit si ce qui vient d'être déposé ou choisi est traitable, avant tout traitement.
   *
   * @param paths - Au pluriel parce que le glisser-déposer de macOS peut en porter plusieurs,
   * et que c'est un cas de refus à part entière.
   *
   * @remarks
   * ⚠️ Un refus arrive ici en `Ok` — voir {@link MediaInspection}. Ne pas confondre les deux
   * issues.
   */
  async inspectMedia(paths: readonly string[]): Promise<MediaInspection | null> {
    return this.core.call<MediaInspection>('inspect_media', { paths });
  }

  /**
   * Identifie la langue parlée d'un média accepté, avant de le transcrire.
   *
   * @remarks
   * - ⚠️ Elle est longue — de l'ordre de trois secondes : aucune API d'Apple n'identifie une
   *   langue parlée, alors on transcrit trente secondes d'échantillon par langue installée et on
   *   demande au reconnaisseur laquelle des sorties est écrite dans la langue qui l'a produite.
   * - ⚠️ Une indécision arrive ici en `Ok` — voir {@link LanguageDetection}. Ne pas confondre
   *   les deux issues.
   */
  async detectMediaLanguage(path: string): Promise<LanguageDetection | null> {
    return this.core.call<LanguageDetection>('detect_media_language', { path });
  }

  /**
   * Transcrit un média, puis ouvre sa fenêtre-document.
   *
   * @remarks
   * - ⚠️ Un seul geste, à dessein : une commande d'ouverture séparée obligerait cette page à
   *   renvoyer au backend les milliers de mots horodatés qu'elle vient de recevoir, soit deux
   *   sérialisations complètes pour une fenêtre qui n'affiche que des paragraphes.
   * - ⚠️ Longue : de l'ordre de quatre secondes pour six minutes de média. S'abonner à la
   *   progression avant d'appeler, sans quoi les premières avancées sont perdues.
   */
  async transcribeMedia(media: TranscriptionRequest): Promise<FileDocument | null> {
    return this.core.call<FileDocument>('transcribe_media', { media });
  }

  /**
   * Demande l'arrêt de la transcription en cours.
   *
   * @remarks
   * ⚠️ Sans échec : annuler ce qui n'existe pas n'est pas une erreur, l'utilisateur peut cliquer
   * juste après la fin.
   */
  async cancelMediaTranscription(): Promise<void> {
    await this.core.call<null>('cancel_media_transcription', {});
  }

  /** Relit un document. C'est le premier appel d'une fenêtre-document à son démarrage. */
  async getFileDocument(id: string): Promise<FileDocument | null> {
    return this.core.call<FileDocument>('get_file_document', { id });
  }

  /** Renomme le document. ⚠️ Un titre vidé retombe sur le nom du fichier. */
  async renameFileDocument(id: string, title: string): Promise<FileDocument | null> {
    return this.core.call<FileDocument>('rename_file_document', { id, title });
  }

  /**
   * Ferme un document, libère sa mémoire et ferme sa fenêtre.
   *
   * @remarks
   * ⚠️ Le résultat est perdu définitivement. Ne l'appeler qu'après confirmation.
   */
  async closeFileDocument(id: string): Promise<void> {
    await this.core.call<null>('close_file_document', { id });
  }

  /**
   * Traduit le transcript d'un document ouvert et rend les paragraphes traduits.
   *
   * @remarks
   * - ⚠️ La langue source n'est pas un paramètre : c'est celle du transcript, détectée au dépôt.
   *   La laisser choisir permettrait `en→ja` sur un transcript français.
   * - ⚠️ Rien n'est rangé côté Rust : la traduction est une vue, pas un remplacement.
   * - ⚠️ Longue — ~4,5 ms par caractère ; elle rapporte son avancée (`document-translation`) et
   *   s'arrête sur {@link cancelDocumentTranslation}. Paire absente et annulation arrivent en
   *   succès, portées par {@link TranscriptTranslation}.
   */
  async translateDocument(id: string, target: string): Promise<TranscriptTranslation | null> {
    return this.core.call<TranscriptTranslation>('translate_document', { id, target });
  }

  /**
   * Ouvre « Enregistrer sous » et retient l'emplacement choisi, côté Rust.
   *
   * @returns vrai quand l'utilisateur a désigné un fichier, faux s'il a renoncé.
   *
   * @remarks
   * ⚠️ La boîte est ouverte **par Rust**, et le chemin choisi ne revient jamais ici : c'est ce
   * qui empêche le webview de désigner un fichier à écrire.
   * ⚠️ `date` part déjà formatée : Rust n'a ni catalogue de langues ni calendrier, et en écrire
   * un figerait un format américain dans le nom de fichier d'un utilisateur allemand.
   */
  async chooseExportPath(id: string, date: string, format: ExportFormat): Promise<boolean> {
    return (await this.core.call<boolean>('choose_export_path', { id, date, format })) ?? false;
  }

  /**
   * Rend le document dans le format demandé et l'écrit à l'emplacement choisi.
   *
   * @remarks
   * ⚠️ À appeler après {@link chooseExportPath}, et une seule fois par choix : l'emplacement se
   * consomme côté Rust. Sans choix préalable, la commande refuse.
   */
  async exportDocument(request: ExportRequest): Promise<void> {
    await this.core.call<null>('export_document', { request });
  }

  /**
   * Place le document dans le presse-papiers, en deux représentations : HTML et Markdown.
   *
   * @remarks
   * ⚠️ Le presse-papiers n'est pas restauré, contrairement au collage de la dictée : ici, c'est
   * l'utilisateur qui a demandé à copier.
   */
  async copyDocument(request: CopyRequest): Promise<void> {
    await this.core.call<null>('copy_document', { request });
  }

  /**
   * S'abonne au glisser-déposer de fichiers sur la fenêtre. Rend le désabonnement.
   *
   * @remarks
   * - ⚠️ Les évènements HTML5 de glisser ne parviennent jamais à la page : sur macOS, wry
   *   détourne `draggingEntered` / `performDragOperation` du WKWebView sans rappeler `super` dès
   *   que `dragDropEnabled` vaut vrai — le défaut de Tauri 2. Un `(drop)` de gabarit ne se
   *   déclenche donc que dans `npm run start:web`.
   * - ⚠️ C'est aussi le seul endroit d'où un chemin peut venir : un `File` de `DataTransfer`
   *   n'expose aucun chemin absolu, garantie du navigateur et non omission de Tauri.
   */
  async onFileDrop(handler: (event: FileDropEvent) => void): Promise<() => void> {
    if (!this.core.isTauri()) {
      return () => undefined;
    }
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') {
        handler({ kind: 'enter' });
      } else if (payload.type === 'leave') {
        handler({ kind: 'leave' });
      } else if (payload.type === 'drop') {
        handler({ kind: 'drop', paths: payload.paths });
      }
      // `over` arrive à chaque image et ne porte que des coordonnées : rien à en faire.
    });
  }
}
