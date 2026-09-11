import { Component, inject } from '@angular/core';
import { Button } from '../button/button';
import { MODAL_DATA, ModalRef } from '../../../core/services/modal/modal-ref';

/**
 * Ce qu'une confirmation a besoin de savoir.
 *
 * @remarks
 * ⚠️ Aucun texte n'a de valeur par défaut : un libellé générique — « OK », « Confirmer » — ne
 * dit pas ce qui va se passer, et c'est ce qui garantit que chaque texte est balisé i18n là où
 * il est écrit.
 */
export interface ConfirmData {
  readonly heading: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

/**
 * Ce que l'utilisateur a répondu.
 *
 * @remarks
 * ⚠️ `cancel` couvre Échap et le clic sur le fond autant que le bouton : un abandon est un
 * abandon, quelle qu'en soit la forme, et aucun appelant ne doit en déduire autre chose.
 */
export type ConfirmChoice = 'confirm' | 'cancel';

/**
 * La modale de confirmation, ouverte par `Modal.confirm()` : un titre, un message, deux boutons.
 *
 * Elle ne connaît ni le domaine ni ce qu'elle confirme — tous ses textes viennent de l'appelant,
 * et elle ne rend que le bouton pressé.
 *
 * @remarks
 * - ⚠️ Ses deux boutons ne diffèrent que par la variante, jamais par une couleur d'alerte :
 *   accent pour celui qui agit, neutre pour celui qui renonce, quelle que soit la gravité.
 * - ⚠️ Le focus initial va sur Annuler : le bouton destructeur focalisé partirait sur une
 *   frappe d'Entrée distraite.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [Button],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss',
})
export class ConfirmDialog {
  private readonly ref = inject<ModalRef<ConfirmChoice>>(ModalRef);
  protected readonly data = inject<ConfirmData>(MODAL_DATA);

  /** Ferme la modale sur `'confirm'`. */
  protected confirm(): void {
    this.ref.close('confirm');
  }

  /** Ferme la modale sur `'cancel'`. */
  protected cancel(): void {
    this.ref.close('cancel');
  }
}
