import { Component, LOCALE_ID, computed, inject } from '@angular/core';
import {
  HistoryPanel,
  type HistoryEntry,
} from '../../../../shared/components/history-panel/history-panel';
import { Icon } from '../../../../shared/components/icon/icon';
import { LiveHistoryStore } from '../../../../core/store/live-history/live-history.store';
import { liveTitle, sessionMeta } from '../../../../core/services/live/live';
import { Modal } from '../../../../core/services/modal/modal';
import { drainErrors } from '../../../../core/services/snackbar/drain-errors';

/**
 * La hauteur d'une ligne de session, espacement compris, en pixels : 60 px de ligne — marges de
 * 10 px, titre de 13,5 px, écart de 3 px, méta de 11,5 px — plus 9 px entre deux lignes.
 *
 * @remarks
 * ⚠️ C'est ce que le défilement virtuel de la CDK prend pour argent comptant, et elle est à
 * taille fixe : une valeur fausse décale la liste d'un cran tous les quelques écrans, sans rien
 * casser de visible. Elle descend jusqu'au style par `--hist-item-h`, seule source.
 */
const ROW_HEIGHT = 69;

/**
 * L'historique des sessions : branche le magasin sur le panneau générique.
 *
 * Il n'ajoute que ce qui relève du domaine — comment se nomme une session sans titre, ce que dit
 * sa méta, la confirmation avant de tout effacer, l'ouverture d'une fenêtre au clic. Le panneau
 * ne connaît ni magasin, ni modale, ni session, ce qui lui permet de servir aussi la dictée.
 *
 * @remarks
 * ⚠️ Jumeau de `DictationHistory` : deux historiques qui se ressemblent à l'écran doivent se
 * ressembler dans le code, sans quoi une correction faite chez l'un manque l'autre.
 */
@Component({
  selector: 'app-direct-history',
  imports: [HistoryPanel, Icon],
  templateUrl: './direct-history.html',
  styleUrl: './direct-history.scss',
})
export class DirectHistory {
  protected readonly store = inject(LiveHistoryStore);

  /** La hauteur d'une ligne, descendue au panneau et à son défilement virtuel. */
  protected readonly rowHeight = ROW_HEIGHT;

  // Les libellés du panneau : ils nomment la session, donc ils viennent d'ici.

  private readonly locale = inject(LOCALE_ID);
  private readonly modal = inject(Modal);

  /**
   * Les lignes du panneau, filtrées par la recherche, titre et méta compris.
   *
   * @remarks
   * ⚠️ Le repli daté se compose ici et non en base : `title` vaut `null` tant que la session
   * n'est pas nommée, et l'écrire à l'archivage le figerait dans la langue du jour. Même
   * fonction que l'en-tête de la fenêtre-session, donc même intitulé des deux côtés.
   */
  protected readonly entries = computed<readonly HistoryEntry[]>(() =>
    this.store.filtered().map((session) => ({
      id: session.id,
      text: liveTitle(session.title, new Date(session.startedAtMs), this.locale),
      meta: sessionMeta(session.startedAtMs, session.endedAtMs, this.locale),
    })),
  );

  constructor() {
    void this.store.load();

    drainErrors(this.store);
  }

  /** Filtre l'historique sur ce que l'utilisateur cherche. */
  protected search(value: string): void {
    this.store.setSearch(value);
  }

  /** Rouvre la fenêtre d'une session — ou ramène devant celle qui est déjà là. */
  protected open(id: number): void {
    void this.store.open(id);
  }

  /** Copie une session dans le presse-papiers. */
  protected copy(id: number): void {
    void this.store.copy(id);
  }

  /** Supprime une session. Sans confirmation : elle s'efface une par une, en connaissance de cause. */
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
      message: $localize`:@@history.direct.clearAll.message:Toutes les sessions de l'historique seront supprimées, transcripts et comptes rendus compris. Cette action est irréversible.`,
      confirmLabel: $localize`:@@common.deleteAll:Tout supprimer`,
      cancelLabel: $localize`:@@common.cancel:Annuler`,
    });
    if (confirmed) {
      void this.store.clear();
    }
  }
}
