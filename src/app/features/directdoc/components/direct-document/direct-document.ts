import { Component, computed, input, linkedSignal, output } from '@angular/core';
import { Button } from '../../../../shared/components/button/button';
import { InlineTitle } from '../../../../shared/components/inline-title/inline-title';
import { ComboSelect } from '../../../../shared/components/forms/combo-select/combo-select';
import type { LockedGroup } from '../../../../shared/components/forms/combo-select/combo-select';
import type { FormOption } from '../../../../shared/components/forms/form-option';
import {
  EXPORT_LABEL,
  exportOptionsFor,
  type ExportChoice,
} from '../../../../shared/components/forms/export-options';
import { TranscriptView } from '../../../filedoc/components/transcript-view/transcript-view';
import type { TranscriptLine } from '../../../filedoc/components/transcript-view/transcript-view';
import {
  REPORT_PROMPT_GROUP_INDEX,
  SESSION_RENAME_LABEL,
  SESSION_TITLE_FIELD_LABEL,
  reportPromptGroupLabel,
} from '../../../../core/services/live/live';
import { translationTargetOptions } from '../../../../core/models/language';
import type { TranslationTarget } from '../../../../core/models/settings';
import type { LiveContent, ReportSection } from '../../../../core/services/bridge/live/live.bridge';

/** Ce qu'un export demande : un format — ou la copie — et le contenu de la vue affichée. */
export interface DirectExport {
  readonly choice: Exclude<ExportChoice, ''>;
  readonly content: LiveContent;
}

/**
 * Ce qu'une traduction demande : une langue cible, et la vue à traduire.
 *
 * @remarks
 * ⚠️ `content` voyage pour la même raison que sur {@link DirectExport} : la barre est partagée
 * par les deux vues, et le composant est le seul à savoir laquelle est sous les yeux.
 */
export interface DirectTranslation {
  readonly target: TranslationTarget;
  readonly content: LiveContent;
}

/**
 * Le panneau document de la fenêtre-session : le transcript, puis le compte rendu quand il existe.
 * Un seul composant pour les deux vues, qui partagent tête, barre d'actions, traduction et export
 * — seuls changent ce qu'il y a sous le filet et la présence de la bascule.
 *
 * @example
 * ```html
 * <app-direct-document
 *   [title]="…" [meta]="…" [sections]="…" [lines]="…" [kind]="…" [kinds]="…"
 *   [transcriptTarget]="…" [reportTarget]="…" [busy]="…"
 *   (renamed)="…" (kindChange)="…" (translate)="…" (exported)="…"
 * />
 * ```
 *
 * @remarks
 * - ⚠️ Aucun compte rendu ne part tout seul : une session qui s'arrête rend un transcript, et le
 *   compte rendu est un geste. Ne pas le rétablir en trouvant le document nu.
 * - ⚠️ Le transcript est en lecture seule, verbatim figé : pas d'éditeur en v1.
 */
@Component({
  selector: 'app-direct-document',
  imports: [Button, InlineTitle, ComboSelect, TranscriptView],
  templateUrl: './direct-document.html',
  styleUrl: './direct-document.scss',
})
export class DirectDocument {
  /** Le titre de la session, tel que l'en-tête l'affiche. */
  readonly title = input.required<string>();
  /** « 20 juil. 2026 · Microsoft Teams » — composée par la coquille. */
  readonly meta = input.required<string>();
  /** Les rubriques du compte rendu, vides tant qu'il n'y en a pas. */
  readonly sections = input.required<readonly ReportSection[]>();
  /** Les paragraphes du transcript consolidé. */
  readonly lines = input.required<readonly TranscriptLine[]>();
  /**
   * La forme affichée par le sélecteur : un type livré, ou le numéro d'un prompt nommé.
   *
   * @remarks
   * ⚠️ `'none'` en fait partie tant qu'aucun compte rendu n'existe, bien qu'il ne soit pas un
   * `ReportKind` côté Rust : c'est une réponse de l'interface, que la coquille n'envoie jamais au
   * backend.
   */
  readonly kind = input.required<string>();
  /**
   * Les entrées du menu, prompts nommés compris.
   *
   * @remarks
   * ⚠️ Composées par la coquille et non ici : elle seule connaît les prompts, et deux listes
   * bâties de part et d'autre s'oublieraient l'une l'autre au premier prompt ajouté.
   */
  readonly kinds = input.required<readonly FormOption<string>[]>();
  /**
   * La langue du transcript affiché, `'none'` quand c'est l'original. Une langue par vue : le
   * menu porte sur celle où l'on est, comme « Exporter », et basculer ne déclenche aucun travail.
   *
   * @remarks
   * ⚠️ Une langue unique aurait obligé à traduire l'autre vue en douce à chaque bascule — plusieurs
   * minutes de voile sur un simple aller-retour, à ~4,5 ms par caractère.
   */
  readonly transcriptTarget = input.required<TranslationTarget>();
  /** La langue du compte rendu affiché — voir {@link DirectDocument.transcriptTarget}. */
  readonly reportTarget = input.required<TranslationTarget>();
  /** Un travail est-il en vol ? Les trois menus de la barre refusent alors un second geste. */
  readonly busy = input(false);

  /** L'utilisateur vient de donner un nouveau titre à la session. */
  readonly renamed = output<string>();
  /** L'utilisateur vient de désigner une forme de compte rendu. */
  readonly kindChange = output<string>();
  /**
   * Une traduction est demandée pour la vue affichée.
   *
   * @remarks
   * ⚠️ Le composant ne traduit pas et ne retient rien : c'est {@link DirectDocument.transcriptTarget}
   * et son homologue qui décident de ce que le menu montre, la coquille les remettant à leur
   * valeur d'avant quand la traduction n'aboutit pas.
   */
  readonly translate = output<DirectTranslation>();
  /**
   * Un export a été demandé, sur le contenu de la vue affichée.
   *
   * @remarks
   * ⚠️ Le composant n'exporte pas : le chemin, le dialogue et l'écriture appartiennent à la
   * coquille, comme pour la génération.
   */
  readonly exported = output<DirectExport>();

  protected readonly renameLabel = SESSION_RENAME_LABEL;
  protected readonly fieldLabel = SESSION_TITLE_FIELD_LABEL;
  protected readonly exportLabel = EXPORT_LABEL;
  /**
   * Le nom accessible du menu de traduction, qui change avec la vue.
   *
   * @remarks
   * ⚠️ « Traduire le compte rendu vers » devant un compte rendu qui n'existe pas encore
   * promettrait qu'il y en a un.
   */
  protected readonly translateLabel = computed(() =>
    this.showing() === 'report'
      ? $localize`:@@direct.document.translateReport:Traduire le compte rendu vers`
      : $localize`:@@direct.document.translateTranscript:Traduire le transcript vers`,
  );
  protected readonly translationOptions = translationTargetOptions();

  /** La langue de ce qui est affiché — celle des deux que la vue courante désigne. */
  protected readonly translationTarget = computed(() =>
    this.showing() === 'report' ? this.reportTarget() : this.transcriptTarget(),
  );

  /**
   * L'utilisateur a désigné une langue.
   *
   * @remarks
   * ⚠️ Rechoisir la même ne relance rien, à l'inverse du sélecteur de type : `ComboSelect` émet
   * sur toute sélection — ce qui permet de régénérer sur le type déjà choisi — mais retraduire
   * dans la langue affichée coûterait plusieurs minutes de voile pour un texte inchangé.
   */
  protected pickTranslation(target: TranslationTarget): void {
    if (target === this.translationTarget()) {
      return;
    }
    this.translate.emit({ target, content: this.content() });
  }
  /**
   * La valeur du menu « Exporter ». Constante : c'est une commande, pas un champ.
   *
   * @remarks
   * ⚠️ C'est elle qui fait retomber le déclencheur sur « Exporter » après chaque action.
   */
  protected readonly exportValue: ExportChoice = '';
  protected readonly showTranscript = $localize`:@@direct.document.showTranscript:Afficher le transcript`;
  protected readonly showReport = $localize`:@@direct.document.showReport:Afficher le compte rendu`;

  /**
   * La rubrique des prompts, montrée grisée au rang qu'elle gardera une fois pleine.
   *
   * @remarks
   * - ⚠️ Montrée et non retirée : une rubrique absente n'apprend pas qu'elle existe.
   * - ⚠️ Posée sans condition : `ComboSelect` ne verrouille pas un nom que les options rangent
   *   déjà, si bien qu'aucune branche morte ne s'écrit ici.
   */
  protected readonly lockedGroups: readonly LockedGroup[] = [
    { group: reportPromptGroupLabel(), index: REPORT_PROMPT_GROUP_INDEX },
  ];

  /**
   * Le menu « Exporter », amputé des sous-titres devant un compte rendu et complet devant le
   * transcript, dont les mots sont horodatés.
   *
   * @remarks
   * ⚠️ Un compte rendu n'a aucun timing : un `.srt` dont tous les repères vaudraient `00:00:00`
   * serait accepté par le lecteur sans rien montrer — pire qu'une absence, l'utilisateur croyant
   * avoir exporté.
   */
  protected readonly exportOptions = computed(() => exportOptionsFor(this.showing() !== 'report'));

  /**
   * Ce que l'export porte : la vue où l'on est.
   *
   * @remarks
   * ⚠️ Pas de troisième choix, et surtout pas une archive : la barre d'actions est partagée par
   * les deux vues, et chaque contrôle y veut dire ce qu'il dit pour la vue courante. Un sélecteur
   * de contenu redemanderait ce que l'écran affiche déjà.
   */
  protected readonly content = computed<LiveContent>(() =>
    this.showing() === 'report' ? 'report' : 'transcript',
  );

  /** Ce document porte-t-il un compte rendu ? C'est ce dont tout le reste se dérive. */
  protected readonly hasReport = computed(() => this.sections().length > 0);
  /** La session n'a produit aucun texte. */
  protected readonly isEmpty = computed(() => this.lines().length === 0);

  /**
   * Le menu « Exporter » vient d'être actionné. Il déclenche, il ne retient rien.
   *
   * @remarks
   * ⚠️ La garde sur `''` tient la promesse du type, pas celle du composant : le libellé de tête
   * n'entre jamais dans la liste, donc aucun geste ne peut produire cette valeur.
   */
  protected pickExport(choice: ExportChoice): void {
    if (choice === '') {
      return;
    }
    this.exported.emit({ choice, content: this.content() });
  }

  /**
   * Le panneau affiché sous le filet : le transcript, puis le compte rendu dès qu'il arrive.
   *
   * @remarks
   * ⚠️ Un `linkedSignal` et non un `computed` : entre deux arrivées de compte rendu, l'utilisateur
   * reste maître de ce qu'il regarde, ce qu'un `computed` lui aurait retiré.
   */
  protected readonly showing = linkedSignal<boolean, 'report' | 'transcript'>({
    source: this.hasReport,
    computation: (has) => (has ? 'report' : 'transcript'),
  });

  /** Le nom de la bascule : elle annonce la vue vers laquelle elle mène. */
  protected readonly toggleLabel = computed(() =>
    this.showing() === 'report' ? this.showTranscript : this.showReport,
  );

  /** Passe d'une vue à l'autre. */
  protected toggle(): void {
    this.showing.update((showing) => (showing === 'report' ? 'transcript' : 'report'));
  }
}
