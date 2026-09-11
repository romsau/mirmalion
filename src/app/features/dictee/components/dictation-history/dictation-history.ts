import { Component, computed, inject } from '@angular/core';
import {
  HistoryPanel,
  type HistoryEntry,
} from '../../../../shared/components/history-panel/history-panel';
import { Icon } from '../../../../shared/components/icon/icon';
import {
  DictationHistoryStore,
  displayedText,
} from '../../../../core/store/dictation-history/dictation-history.store';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { drainErrors } from '../../../../core/services/snackbar/drain-errors';

/**
 * L'historique de dictée : branche le store de dictée sur le panneau générique.
 *
 * Il n'ajoute que ce qui relève du domaine — quel texte montrer, la confirmation avant
 * d'effacer, la copie au presse-papiers. Le panneau ne connaît ni store, ni modale, ni dictée.
 */
@Component({
  selector: 'app-dictation-history',
  imports: [HistoryPanel, Icon],
  templateUrl: './dictation-history.html',
  styleUrl: './dictation-history.scss',
})
export class DictationHistory {
  protected readonly store = inject(DictationHistoryStore);

  // Les libellés du panneau : ils nomment la dictée, donc ils viennent d'ici.

  private readonly modal = inject(Modal);
  private readonly snackbar = inject(Snackbar);

  /**
   * Les lignes du panneau, filtrées par la recherche.
   *
   * @remarks
   * ⚠️ Le texte montré est celui qui a été inséré au curseur, pas le brut : c'est le seul que
   * l'utilisateur ait jamais vu. Voir `displayedText`.
   */
  protected readonly entries = computed<readonly HistoryEntry[]>(() =>
    this.store.filtered().map((entry) => ({ id: entry.id, text: displayedText(entry) })),
  );

  constructor() {
    void this.store.load();

    drainErrors(this.store);
  }

  /** Filtre l'historique sur ce que l'utilisateur cherche. */
  protected search(value: string): void {
    this.store.setSearch(value);
  }

  /**
   * Copie une dictée dans le presse-papiers. Le geste étant explicite, le presse-papiers est
   * écrasé sans détour — contrairement à l'insertion au curseur, qui le restaure.
   */
  protected async copy(id: number): Promise<void> {
    const entry = this.store.entries().find((candidate) => candidate.id === id);
    if (entry === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(displayedText(entry));
    } catch {
      // ⚠️ Le message ne cite pas le texte : ce serait du contenu utilisateur dans l'interface
      // d'erreur, et il est déjà sous les yeux de qui vient de cliquer.
      this.snackbar.error($localize`:@@history.copyFailed:Copie impossible.`);
    }
  }

  /** Supprime une dictée. Sans confirmation : une entrée perdue se redicte en quelques secondes. */
  protected remove(id: number): void {
    void this.store.remove(id);
  }

  /**
   * Vide l'historique, derrière une confirmation obligatoire. L'asymétrie avec la suppression
   * unitaire est voulue : un historique entier ne se retrouve pas.
   */
  protected async clearAll(): Promise<void> {
    const confirmed = await this.modal.confirm({
      heading: $localize`:@@common.deleteAll.heading:Tout supprimer ?`,
      message: $localize`:@@history.dictee.clearAll.message:Toutes les dictées de l'historique seront supprimées. Cette action est irréversible.`,
      confirmLabel: $localize`:@@common.deleteAll:Tout supprimer`,
      cancelLabel: $localize`:@@common.cancel:Annuler`,
    });
    if (confirmed) {
      void this.store.clear();
    }
  }
}
