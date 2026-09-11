import { Component, computed, inject } from '@angular/core';
import { OptionRow } from '../../components/option-row/option-row';
import { ComboSelect } from '../../../../shared/components/forms/combo-select/combo-select';
import { Switch } from '../../../../shared/components/forms/switch/switch';
import { Button } from '../../../../shared/components/button/button';
import { Icon } from '../../../../shared/components/icon/icon';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { drainErrors } from '../../../../core/services/snackbar/drain-errors';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import {
  ReportPromptsStore,
  type PromptOutcome,
} from '../../../../core/store/report-prompts/report-prompts.store';
import {
  REPORT_PROMPT_GROUP_INDEX,
  reportPromptGroupLabel,
  reportTypeOptions,
} from '../../../../core/services/live/live';
import {
  DUPLICATE_TITLE_MESSAGE,
  ReportPromptForm,
  type ReportPromptFormData,
  type ReportPromptFormResult,
} from './components/report-prompt-form/report-prompt-form';
import type { ReportPrompt } from '../../../../core/services/bridge/live/live.bridge';
import type { LiveReportType } from '../../../../core/models/settings';

/**
 * Combien de prompts personnalisés au plus.
 *
 * @remarks
 * ⚠️ Le miroir de `MAX_REPORT_PROMPTS` (`src-tauri/src/commands/prompts.rs`), qui est la vraie
 * borne : celle-ci ne fait qu'éteindre le bouton avant qu'on la heurte.
 */
const MAX_REPORT_PROMPTS = 20;

/** La largeur de la modale d'un prompt : la plus large des trois, celle de la maquette. */
const PROMPT_MODAL_COLUMNS = 3;

/**
 * Le compteur qui rend son identifiant DOM unique à chaque instance.
 *
 * @remarks
 * ⚠️ Un identifiant écrit en dur serait dupliqué dès qu'une seconde instance serait montée, et
 * l'`aria-labelledby` de la liste désignerait alors deux éléments — ce que ni jsdom ni AXE ne
 * relèvent.
 */
let instances = 0;

/**
 * La catégorie de réglages Direct : l'indicateur visuel, la forme de compte rendu par défaut, et
 * la liste des prompts personnalisés.
 *
 * @remarks
 * - ⚠️ Le type de compte rendu propose, il ne déclenche pas : il pré-choisit l'entrée du sélecteur
 *   de la fenêtre-session. « Pas de compte rendu » est le défaut, l'arrêt ne générant rien.
 * - ⚠️ Les prompts ne vivent pas dans les réglages — leur titre nomme un client autant que leur
 *   texte — mais dans la base chiffrée, d'où la fenêtre-session les lit aussi.
 */
@Component({
  selector: 'app-options-direct',
  imports: [OptionRow, ComboSelect, Switch, Button, Icon],
  templateUrl: './options-direct.html',
  styleUrl: './options-direct.scss',
})
export class OptionsDirect {
  private readonly settings = inject(SettingsStore);
  private readonly modal = inject(Modal);
  private readonly snackbar = inject(Snackbar);

  protected readonly prompts = inject(ReportPromptsStore);

  /** Les options du menu, prompts nommés compris. */
  protected readonly reportTypes = computed(() => reportTypeOptions(this.prompts.prompts()));

  /** L'identifiant de l'intitulé qui nomme la liste, unique à cette instance. */
  protected readonly listLabelId = `cp-list-label-${(instances += 1)}`;

  /** Aucun prompt n'existe encore. */
  protected readonly empty = computed(() => this.prompts.prompts().length === 0);

  /**
   * La rubrique se grise quand elle n'a rien à dérouler.
   *
   * @remarks
   * ⚠️ Montrée et non retirée, et toujours au même rang : une rubrique qui apparaît en se
   * remplissant n'apprend pas qu'elle existe, et une qui change de place fait bouger le menu.
   */
  protected readonly lockedGroups = computed(() =>
    this.empty() ? [{ group: reportPromptGroupLabel(), index: REPORT_PROMPT_GROUP_INDEX }] : [],
  );

  /**
   * Le libellé du bouton d'ajout, qui est aussi le titre de la boîte qu'il ouvre.
   *
   * @remarks
   * ⚠️ Écrit ici et interpolé, jamais balisé dans le gabarit : le contenu d'un élément porte des
   * espaces de bord que `$localize` n'a pas, et l'extracteur y verrait deux textes pour un
   * identifiant.
   */
  protected readonly addLabel = $localize`:@@direct.prompt.add:Ajouter un prompt personnalisé`;

  /** Le plafond est atteint : « Ajouter » s'éteint. */
  protected readonly full = computed(() => this.prompts.prompts().length >= MAX_REPORT_PROMPTS);

  /** La pilule est-elle montrée pendant une session ? */
  protected readonly overlayVisible = computed(() => this.settings.settings().liveOverlayVisible);

  /**
   * Ce que le menu montre : l'identifiant du prompt choisi, ou le type livré.
   *
   * @remarks
   * ⚠️ Un identifiant qui ne désigne plus rien retombe sur « Pas de compte rendu » : le réglage
   * peut avoir survécu à la suppression du prompt dans une autre fenêtre.
   */
  protected readonly reportType = computed(() => {
    const settings = this.settings.settings();
    if (settings.liveReportType !== 'custom') {
      return settings.liveReportType as string;
    }
    const chosen = this.prompts.byId(settings.liveReportPromptId);
    return chosen === undefined ? 'none' : String(chosen.id);
  });

  constructor() {
    void this.prompts.load();

    // ⚠️ Les échecs du magasin se disent une fois puis s'oublient, comme dans les huit autres
    // écrans : la reprise de l'ancien prompt unique en fait partie, et son échec ne se voyait
    // nulle part.
    drainErrors(this.prompts);
  }

  /** Toute la ligne est cliquable, pas seulement l'interrupteur. */
  protected toggleOverlay(): void {
    this.setOverlay(!this.overlayVisible());
  }

  /** Montre ou masque la pilule pendant une session. */
  protected setOverlay(liveOverlayVisible: boolean): void {
    void this.settings.update({ liveOverlayVisible });
  }

  /** Retient la forme de compte rendu par défaut — un type livré, ou un prompt nommé. */
  protected pickReportType(value: string): void {
    const prompt = this.prompts.byId(Number(value));
    void this.settings.update(
      prompt === undefined
        ? { liveReportType: value as LiveReportType, liveReportPromptId: null }
        : { liveReportType: 'custom', liveReportPromptId: prompt.id },
    );
  }

  /** Le nom accessible du crayon d'une ligne : il nomme le prompt qu'il ouvre. */
  protected editLabel(prompt: ReportPrompt): string {
    const title = prompt.title;
    return $localize`:@@direct.prompt.editOne:Modifier ${title}:title:`;
  }

  /** Le nom accessible de la corbeille d'une ligne. */
  protected removeLabel(prompt: ReportPrompt): string {
    const title = prompt.title;
    return $localize`:@@direct.prompt.removeOne:Supprimer le prompt ${title}:title:`;
  }

  /** Ouvre la modale d'ajout et enregistre ce qu'elle rend. */
  protected async addPrompt(): Promise<void> {
    const written = await this.openForm(null);
    if (written !== undefined) {
      this.announce(await this.prompts.add(written.title, written.prompt));
    }
  }

  /** Ouvre la modale sur un prompt existant et enregistre ce qu'elle rend. */
  protected async editPrompt(prompt: ReportPrompt): Promise<void> {
    const written = await this.openForm(prompt);
    if (written !== undefined) {
      this.announce(await this.prompts.rename(prompt.id, written.title, written.prompt));
    }
  }

  /**
   * Supprime un prompt, derrière une confirmation.
   *
   * @remarks
   * ⚠️ Le réglage retombe sur « Pas de compte rendu » quand c'est lui qu'on supprime : sinon le
   * sélecteur montrerait une valeur introuvable dans sa propre liste.
   * ⚠️ Le réglage part AVANT la suppression, et l'échec de l'un annule l'autre : c'est ce qui
   * interdit les deux moitiés d'état où le réglage désigne un prompt disparu, ou perd un défaut
   * que rien n'a supprimé.
   */
  protected async removePrompt(prompt: ReportPrompt): Promise<void> {
    const confirmed = await this.modal.confirm({
      heading: $localize`:@@direct.prompt.delete.heading:Supprimer ce prompt ?`,
      message: $localize`:@@direct.prompt.delete.message:Ce prompt personnalisé sera supprimé. Les comptes rendus déjà produits avec lui sont conservés.`,
      confirmLabel: $localize`:@@direct.prompt.delete.confirm:Supprimer le prompt`,
      cancelLabel: $localize`:@@common.cancel:Annuler`,
    });
    if (!confirmed) {
      return;
    }
    const settings = this.settings.settings();
    if (settings.liveReportType === 'custom' && settings.liveReportPromptId === prompt.id) {
      await this.settings.update({ liveReportType: 'none', liveReportPromptId: null });
      // ⚠️ Le réglage n'a pas pu être écrit : on n'enlève rien. `App` dit déjà l'échec — le
      // redire ici l'écrirait deux fois —, et renoncer est ce qui tient le piège ci-dessus.
      if (this.settings.error() !== null) {
        return;
      }
    }
    await this.prompts.remove(prompt.id);
  }

  /**
   * Dit le titre déjà pris. Une écriture réussie se tait.
   *
   * @remarks
   * ⚠️ Le doublon SEUL est dit ici : `drainErrors` porte tous les autres échecs, et les dire
   * des deux côtés les écrirait deux fois. Le doublon lui échappe parce qu'il n'est pas une
   * erreur du magasin mais une issue, traduite ici.
   */
  private announce(outcome: PromptOutcome): void {
    if (outcome === 'duplicate') {
      this.snackbar.error(DUPLICATE_TITLE_MESSAGE);
    }
  }

  /**
   * Monte la modale d'un prompt et attend son issue. `undefined` est l'abandon.
   *
   * @remarks
   * ⚠️ `taken` exclut le prompt en cours de modification, et c'est le magasin qui compare :
   * refaire le pli ici ferait vivre deux règles de titre qui divergeraient un jour.
   */
  private openForm(prompt: ReportPrompt | null): Promise<ReportPromptFormResult | undefined> {
    return this.modal.open<ReportPromptFormResult, ReportPromptFormData>(ReportPromptForm, {
      heading:
        prompt === null ? this.addLabel : $localize`:@@direct.prompt.edit:Modifier le prompt`,
      columns: PROMPT_MODAL_COLUMNS,
      fill: true,
      data: {
        prompt,
        taken: (title: string) => this.prompts.taken(title, prompt?.id ?? null),
      },
    }).closed;
  }
}
