import { Service, inject } from '@angular/core';
import type {
  CopyRequest,
  ExportFormat,
  ExportRequest,
  FileDocument,
  TranscriptTranslation,
  TranscriptionProgress,
  TranscriptionRequest,
  TranslationProgress,
} from '../bridge/media/media.bridge';
import { SystemBridge } from '../bridge/system/system.bridge';
import { MediaBridge } from '../bridge/media/media.bridge';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';
import { Invoke } from '../bridge/invoke/invoke';

/**
 * Le nom de l'évènement Tauri qui porte l'avancée d'une transcription de fichier.
 *
 * Il vit ici et non dans `Tauri` : ce pont transporte des appels, il ne nomme pas les
 * évènements d'un domaine.
 *
 * @remarks
 * ⚠️ Miroir de `TRANSCRIPTION_EVENT` (`src-tauri/src/commands/transcription.rs`) : les deux
 * chaînes doivent rester identiques, et rien ne le vérifie à la compilation.
 */
export const FILE_TRANSCRIPTION_EVENT = 'file-transcription';

/**
 * Le nom de l'évènement Tauri qui porte l'avancée de la traduction d'un document.
 *
 * @remarks
 * - ⚠️ Miroir de `TRANSLATION_EVENT` (`src-tauri/src/commands/translation.rs`), comme
 *   {@link FILE_TRANSCRIPTION_EVENT} : rien ne tient les deux chaînes égales à la compilation.
 * - ⚠️ Partagé avec le Direct, seule chose de ce module qui le soit :
 *   `Live.onTranslationProgress` l'importe d'ici plutôt que d'en recopier le littéral.
 */
export const DOCUMENT_TRANSLATION_EVENT = 'document-translation';

/**
 * Pose un écouteur d'avancée de traduction, filtré sur un document. Rend le désabonnement.
 *
 * @remarks
 * ⚠️ Le filtre est la raison d'être de cette fonction : un évènement Tauri est diffusé à toutes
 * les fenêtres, et `Tauri.listen` pose un écouteur sans cible. Sans lui, chaque fenêtre-document
 * afficherait l'avancée de sa voisine. Écrite ici, avec l'évènement, plutôt que deux fois.
 */
export function listenToDocumentTranslation(
  core: Invoke,
  id: string,
  handler: (percent: number) => void,
): Promise<() => void> {
  return core.listen<TranslationProgress>(DOCUMENT_TRANSLATION_EVENT, (progress) => {
    if (progress.documentId === id) {
      handler(progress.percent);
    }
  });
}

/**
 * La transcription d'un fichier média et le document qu'elle produit, de bout en bout.
 *
 * Le backend n'en tient qu'une à la fois : {@link Transcription.cancel} n'a pas d'argument, et
 * l'écran Fichiers n'accepte qu'un dépôt.
 *
 * @remarks
 * ⚠️ Un magasin n'appelle jamais le pont : `FiledocStore` porte l'état d'une fenêtre-document,
 * ce service parle au backend. La règle vaut aussi pour ce qui n'est pas une commande IPC —
 * voir {@link Transcription.observeCloseRequest}, qui écoute la fenêtre.
 */
@Service()
export class Transcription {
  private readonly languages = inject(LanguagesBridge);
  private readonly bridge = inject(MediaBridge);
  private readonly core = inject(Invoke);
  private readonly system = inject(SystemBridge);

  /**
   * S'abonne à l'avancée d'une transcription. Rend le désabonnement.
   *
   * @remarks
   * ⚠️ À appeler avant {@link Transcription.transcribe} : le travail natif démarre aussitôt, et
   * les premières avancées d'un média court partiraient dans le vide.
   */
  async observeProgress(handler: (percent: number) => void): Promise<() => void> {
    return this.core.listen<TranscriptionProgress>(FILE_TRANSCRIPTION_EVENT, ({ percent }) => {
      handler(percent);
    });
  }

  /**
   * S'abonne à l'avancée de la traduction du document `id`. Rend le désabonnement.
   *
   * @remarks
   * - ⚠️ Le filtre par document est la raison d'être de cette méthode : un évènement Tauri est
   *   diffusé à toutes les fenêtres, et `Tauri.listen` pose un écouteur sans cible. Sans ce tri,
   *   chaque fenêtre-document afficherait l'avancée de sa voisine.
   * - ⚠️ La traduction ne rapporte que ce qu'elle a fait : une paire absente arrête la boucle
   *   sans dernier pourcentage. C'est l'écran qui retire son voile en voyant l'issue.
   */
  async observeTranslationProgress(
    id: string,
    handler: (percent: number) => void,
  ): Promise<() => void> {
    return listenToDocumentTranslation(this.core, id, handler);
  }

  /**
   * Transcrit un média puis ouvre sa fenêtre-document, d'un seul geste.
   *
   * Longue : quelques secondes pour six minutes de média, davantage ensuite.
   *
   * @remarks
   * ⚠️ Rejette aussi lorsque l'utilisateur annule — c'est à l'appelant de distinguer un abandon
   * d'une panne.
   */
  async transcribe(request: TranscriptionRequest): Promise<FileDocument | null> {
    return this.bridge.transcribeMedia(request);
  }

  /** Demande l'arrêt du travail en cours. Sans effet s'il n'y en a pas. */
  async cancel(): Promise<void> {
    await this.bridge.cancelMediaTranscription();
  }

  /** Relit un document. Premier appel d'une fenêtre-document à son démarrage. */
  async document(id: string): Promise<FileDocument | null> {
    return this.bridge.getFileDocument(id);
  }

  /** Renomme le document. Un titre vidé retombe sur le nom du fichier, côté Rust. */
  async rename(id: string, title: string): Promise<FileDocument | null> {
    return this.bridge.renameFileDocument(id, title);
  }

  /**
   * Traduit le transcript vers `target`, et rend les paragraphes traduits.
   *
   * @remarks
   * ⚠️ Une paire absente, une paire non supportée et une annulation arrivent en succès, portées
   * par le genre du résultat. Traiter un `pairMissing` comme une panne afficherait un message de
   * dépannage là où il faut une information, quand une annulation n'en demande aucun.
   */
  async translate(id: string, target: string): Promise<TranscriptTranslation | null> {
    return this.bridge.translateDocument(id, target);
  }

  /**
   * Demande l'arrêt de la traduction du document `id`. Sans effet s'il n'y en a pas.
   *
   * @remarks
   * ⚠️ Nommée par son document, contrairement à {@link Transcription.cancel} : le backend ne
   * tient qu'une transcription à la fois, mais autant de traductions que de fenêtres ouvertes.
   */
  async cancelTranslation(id: string): Promise<void> {
    await this.languages.cancelDocumentTranslation(id);
  }

  /**
   * Ouvre « Enregistrer sous ». Rend vrai quand l'utilisateur a désigné un fichier.
   *
   * @remarks
   * ⚠️ Le chemin ne revient pas ici : Rust le retient. C'est {@link Transcription.export} qui
   * écrit, et une seule fois par choix.
   */
  async chooseExportPath(id: string, date: string, format: ExportFormat): Promise<boolean> {
    return this.bridge.chooseExportPath(id, date, format);
  }

  /** Écrit l'export à l'emplacement choisi, tel que la fenêtre affiche le document. */
  async export(request: ExportRequest): Promise<void> {
    await this.bridge.exportDocument(request);
  }

  /** Copie le document dans le presse-papiers, en HTML et en Markdown. */
  async copy(request: CopyRequest): Promise<void> {
    await this.bridge.copyDocument(request);
  }

  /**
   * Ferme un document, libère sa mémoire et ferme sa fenêtre.
   *
   * @remarks
   * ⚠️ Le résultat est perdu définitivement : il n'y a pas d'historique des fichiers. N'appeler
   * qu'une fois la confirmation obtenue, ou quand il n'y a rien à perdre.
   */
  async close(id: string): Promise<void> {
    await this.bridge.closeFileDocument(id);
  }

  /**
   * Intercepte toutes les demandes de fermeture de la fenêtre courante. Rend le désabonnement.
   *
   * @remarks
   * - ⚠️ Seule voie qui les attrape toutes : la pastille rouge, ⌘W et Fichier ▸ Fermer
   *   produisent le même `CloseRequested`, et `lifecycle.rs` ne pose aucun `prevent_close` sur
   *   une fenêtre-document. Sans cette interception, la pastille rouge détruit le document.
   * - ⚠️ La fermeture est empêchée à chaque fois : c'est `close_file_document` qui ferme la
   *   fenêtre, après avoir libéré le document. Laisser passer l'évènement fuirait le document.
   */
  async observeCloseRequest(handler: () => void): Promise<() => void> {
    return this.system.onCloseRequested(handler);
  }
}
