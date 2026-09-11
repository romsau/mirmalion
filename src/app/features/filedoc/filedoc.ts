import { Component, LOCALE_ID, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Header } from '../../shared/components/header/header';
import { Icon } from '../../shared/components/icon/icon';
import { InlineTitle } from '../../shared/components/inline-title/inline-title';
import { DocOverlay } from '../../shared/components/doc-overlay/doc-overlay';
import { ComboSelect } from '../../shared/components/forms/combo-select/combo-select';
import {
  EXPORT_LABEL,
  exportOptionsFor,
  type ExportChoice,
} from '../../shared/components/forms/export-options';
import { TranscriptView } from './components/transcript-view/transcript-view';
import type { TranscriptLine } from './components/transcript-view/transcript-view';
import { FiledocStore } from '../../core/store/filedoc/filedoc.store';
import { Transcription } from '../../core/services/transcription/transcription';
import {
  DOCUMENT_ID_PREFIX,
  exportDate,
  windowDocumentId,
} from '../../core/models/document-window';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { LANGUAGE_ADJECTIVES, translationTargetOptions } from '../../core/models/language';
import type { TranslationTarget } from '../../core/models/settings';
import { drainErrors } from '../../core/services/snackbar/drain-errors';
import { subscriptions } from '../../core/services/bridge/subscriptions';

/**
 * La durée d'un média, en heures, minutes et secondes.
 *
 * @param durationMs - La durée du média.
 * @param locale - La langue de l'interface. Voir {@link Filedoc.meta}.
 *
 * @remarks
 * ⚠️ `Intl`, et pas un `padStart` : les chiffres d'un timecode sont des nombres, et leur rendu
 * suit la langue de l'interface — ce qui compte pour les locales à chiffres non latins.
 * `useGrouping: false` évite qu'une durée de plus de mille minutes prenne un séparateur.
 */
function formatDuration(durationMs: number, locale: string): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const pad = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  const plain = new Intl.NumberFormat(locale, { useGrouping: false });
  const seconds = pad.format(total % 60);
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${plain.format(hours)}:${pad.format(minutes)}:${seconds}`
    : `${plain.format(minutes)}:${seconds}`;
}

/**
 * La fenêtre-document d'une transcription de fichier : elle assemble des composants qui reçoivent
 * et émettent, sans jamais appeler le pont. Son identifiant vient de l'URL — le segment n'est pas
 * l'identifiant, voir `windowDocumentId`.
 *
 * @remarks
 * - ⚠️ Fermer ne demande rien : une transcription se refait en quelques secondes, le média source
 *   n'ayant jamais quitté le disque. Ne pas réintroduire de modale de confirmation.
 * - ⚠️ Les voies de fermeture restent toutes interceptées : `close_file_document` libère la
 *   mémoire du document côté Rust.
 */
@Component({
  selector: 'app-filedoc',
  imports: [Header, Icon, InlineTitle, TranscriptView, DocOverlay, ComboSelect],
  templateUrl: './filedoc.html',
  styleUrl: './filedoc.scss',
})
export class Filedoc {
  private readonly store = inject(FiledocStore);
  private readonly transcription = inject(Transcription);
  private readonly snackbar = inject(Snackbar);
  private readonly locale = inject(LOCALE_ID);

  private readonly subs = subscriptions();

  /** L'identifiant du document affiché — celui de la fenêtre, pas le segment d'URL. */
  private readonly id = windowDocumentId(
    DOCUMENT_ID_PREFIX,
    inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '',
  );

  /**
   * La langue affichée par le sélecteur « Traduire vers ». C'est la valeur d'un contrôle : le
   * document, lui, ne connaît que son transcript d'origine.
   *
   * @remarks
   * ⚠️ Elle est posée avant le travail et rendue si le travail n'aboutit pas : ce signal, et lui
   * seul, décide de ce que le menu affiche — le contrôle ne retient rien. Voir
   * {@link Filedoc.translateTo}.
   */
  protected readonly translationTarget = signal<TranslationTarget>('none');

  protected readonly loaded = this.store.loaded;
  protected readonly busy = this.store.busy;

  /**
   * La traduction est-elle en cours ?
   *
   * @remarks
   * ⚠️ Elle décide à la fois de la barre et du bouton « Annuler » : la traduction est la seule
   * opération qui sache où elle en est et la seule qu'on sache arrêter. Deux conditions séparées
   * auraient fini par diverger.
   */
  protected readonly translating = computed(() => this.store.operation() === 'translating');

  protected readonly translationOptions = translationTargetOptions();

  /**
   * Le menu « Exporter », amputé des sous-titres quand il n'y a pas un mot à horodater.
   *
   * @remarks
   * ⚠️ Un `.srt` sans réplique est un fichier que le lecteur accepte et qui ne montre rien — pire
   * qu'une absence, l'utilisateur croyant avoir exporté. Les autres formats restent : un document
   * vide donne un fichier vide, ce qui est au moins honnête.
   */
  protected readonly exportOptions = computed(() => exportOptionsFor(this.store.hasContent()));

  /**
   * La valeur du menu « Exporter ». Constante : c'est une commande, pas un champ — elle retombe
   * sur « Exporter » après chaque action.
   */
  protected readonly exportValue: ExportChoice = '';

  /** Le titre du document, tel que l'en-tête l'affiche. */
  protected readonly title = computed(() => this.store.document()?.title ?? '');
  /** Le nom du fichier d'origine — le repli du titre quand le champ est vidé. */
  protected readonly fileName = computed(() => this.store.document()?.fileName ?? '');

  /**
   * La ligne d'informations sous le titre : la durée du média.
   *
   * @remarks
   * - ⚠️ La maquette y dessine une date, dont le backend n'a aucune — un fichier importé n'a pas
   * de date de session, et celle du jour ne dirait rien de vrai d'un enregistrement de l'an
   * dernier.
   * - ⚠️ La locale se passe, elle ne se laisse pas deviner : `Intl` sans locale rend celle de
   * l'environnement, donc celle de macOS, quand l'interface est celle du bundle chargé.
   */
  protected readonly meta = computed(() =>
    formatDuration(this.store.document()?.durationMs ?? 0, this.locale),
  );

  /**
   * Les paragraphes, dans la forme que `TranscriptView` attend.
   *
   * @remarks
   * ⚠️ La traduction, quand il y en a une, remplace le texte et rien d'autre.
   */
  protected readonly lines = computed<readonly TranscriptLine[]>(() => {
    const document = this.store.document();
    if (document === null) {
      return [];
    }
    return (
      this.store.translation() ??
      document.transcript.paragraphs.map((paragraph) => ({
        text: paragraph.words.map((word) => word.text).join(' '),
      }))
    );
  });

  /**
   * L'avancée de la traduction en cours, en pourcentages entiers. Elle vit ici et non dans le
   * magasin : c'est l'état d'un affichage, et le magasin ne parle jamais au pont.
   *
   * @remarks
   * ⚠️ Remise à zéro au départ de chaque traduction, sinon la suivante partirait du pourcentage
   * de la précédente et paraîtrait presque finie avant d'avoir commencé.
   */
  private readonly translationPercent = signal(0);

  /**
   * Ce que la barre du voile affiche : un pourcentage pour la traduction, rien pour le reste.
   *
   * @remarks
   * ⚠️ Seule la traduction sait où elle en est — elle boucle paragraphe par paragraphe, pondérée
   * par les caractères côté Rust. L'export, la copie et la fermeture n'émettent rien : leur barre
   * reste indéterminée, et un pourcentage inventé serait faux.
   */
  protected readonly workProgress = computed(() =>
    this.translating() ? this.translationPercent() : null,
  );

  /** Ce que le voile de travail annonce, ou `null` quand il n'y a rien à annoncer. */
  protected readonly workLabel = computed(() => {
    switch (this.store.operation()) {
      case 'translating':
        return $localize`:@@filedoc.work.translating:Traduction…`;
      case 'exporting':
        return $localize`:@@filedoc.work.exporting:Export…`;
      case 'copying':
        return $localize`:@@filedoc.work.copying:Copie…`;
      case 'closing':
        return $localize`:@@filedoc.work.closing:Fermeture…`;
      default:
        return null;
    }
  });

  /**
   * Le libellé du menu d'export — son libellé de tête et son nom accessible. Une seule chaîne pour
   * les deux : le mot affiché entre deux actions est ce que le contrôle fait.
   */
  protected readonly exportLabel = EXPORT_LABEL;

  constructor() {
    void this.store.open(this.id);
    void this.listen();

    drainErrors(this.store);
  }

  /** Renomme la transcription. */
  protected async rename(title: string): Promise<void> {
    await this.store.rename(title);
  }

  /**
   * Traduit le transcript, ou revient à la langue d'origine — un retour instantané, l'original
   * n'ayant jamais quitté le magasin.
   *
   * @remarks
   * - ⚠️ Une paire absente n'est pas une panne : le backend rend un succès qui dit « je n'ai pas
   *   traduit ». On l'annonce en information, et le sélecteur revient à la langue qu'il affichait.
   * - ⚠️ Une annulation ne se dit pas du tout, et on ne nomme jamais la paire — seulement la
   *   langue cible : l'interface ne parle pas de couples ordonnés.
   */
  protected async translateTo(target: TranslationTarget): Promise<void> {
    const previous = this.translationTarget();
    this.translationTarget.set(target);
    if (target === 'none') {
      this.store.clearTranslation();
      return;
    }
    // ⚠️ La barre repart de zéro à chaque traduction : gardée, elle afficherait le pourcentage de
    // la précédente et la nouvelle paraîtrait presque finie avant de commencer.
    this.translationPercent.set(0);
    const outcome = await this.store.translate(target);
    if (outcome === 'translated') {
      return;
    }
    this.translationTarget.set(previous);
    if (outcome === 'pairMissing') {
      this.snackbar.info(
        $localize`:@@translation.pairMissing:La traduction vers la langue ${LANGUAGE_ADJECTIVES[target]}:name: n'est pas installée. Ajoutez-la dans Options ▸ Langues.`,
      );
    } else if (outcome === 'pairUnsupported') {
      this.snackbar.info(
        $localize`:@@translation.pairUnsupported:La traduction vers la langue ${LANGUAGE_ADJECTIVES[target]}:name: n'est pas prise en charge.`,
      );
    }
    // `cancelled` : rien à dire, l'arrêt vient d'être demandé.
    // `null` : rien n'a eu lieu, ou l'échec est déjà parti dire son message.
  }

  /**
   * L'utilisateur demande l'arrêt de la traduction, depuis le voile de travail.
   *
   * @remarks
   * ⚠️ Le voile reste jusqu'à l'issue, contrairement à l'écran Fichiers : le retirer avant que le
   * backend n'ait rendu `cancelled` ferait clignoter des contrôles qu'une traduction encore
   * vivante rendrait inertes.
   */
  protected cancelTranslation(): void {
    void this.store.cancelTranslation();
  }

  /**
   * Le menu « Exporter » vient d'être actionné. Il déclenche, il ne retient rien.
   *
   * @remarks
   * ⚠️ Rien n'est attendu ici : le gabarit ne peut pas suivre une promesse, et le voile de travail
   * du magasin dit déjà que la fenêtre est occupée.
   */
  protected pickExport(choice: ExportChoice): void {
    void this.runExport(choice);
  }

  /**
   * Ferme la fenêtre — le seul chemin, quelle que soit la voie empruntée : pastille rouge, ⌘W ou
   * menu. Aucune question n'est posée, voir l'en-tête du composant.
   *
   * @remarks
   * ⚠️ `close_file_document` libère la mémoire du document côté Rust, ce qu'une fermeture native
   * laissée passer ne ferait pas.
   */
  protected async requestClose(): Promise<void> {
    await this.store.close();
  }

  /**
   * Le travail d'export, une fois le format connu.
   *
   * @remarks
   * - ⚠️ La date part résolue : Rust ne fabrique aucun texte localisé, pas même dans un nom de
   * fichier. Voir `exportDate`.
   * - ⚠️ Rien ne se dit quand l'utilisateur renonce dans « Enregistrer sous » : un abandon
   *   volontaire n'a pas à être commenté.
   */
  private async runExport(choice: ExportChoice): Promise<void> {
    if (choice === 'copy') {
      if (await this.store.copy()) {
        this.snackbar.success(
          $localize`:@@filedoc.export.copied:Transcription copiée dans le presse-papiers.`,
        );
      }
      return;
    }
    // ⚠️ Le libellé de tête n'entre jamais dans la liste, donc aucun geste ne peut produire `''`.
    // Cette garde tient la promesse du type : `''` fait partie d'`ExportChoice` parce que c'est la
    // valeur portée entre deux actions, et il faut l'écarter avant de la prendre pour un format.
    if (choice === '') {
      return;
    }
    if (await this.store.exportTo(choice, exportDate(this.locale))) {
      this.snackbar.success($localize`:@@filedoc.export.written:Transcription exportée.`);
    }
  }

  /**
   * Branche les deux écoutes de la fenêtre — la fermeture et l'avancée d'une traduction — et se
   * débranche avec elle.
   *
   * @remarks
   * ⚠️ L'abonnement à la progression est posé à l'ouverture, pas au départ d'une traduction : le
   * travail natif démarre dans la foulée de la commande, et un abonnement posé après elle
   * manquerait les premières avancées. Le tenir pour la vie de la fenêtre supprime la course.
   */
  private async listen(): Promise<void> {
    await this.subs.keep(
      this.transcription.observeCloseRequest(() => {
        void this.requestClose();
      }),
    );
    await this.subs.keep(
      this.transcription.observeTranslationProgress(this.id, (percent) => {
        this.translationPercent.set(percent);
      }),
    );
  }
}
