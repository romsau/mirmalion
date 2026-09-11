import { Component, input, output } from '@angular/core';
import { Icon } from '../../../../shared/components/icon/icon';

/**
 * Le titre d'un sous-écran, qui est aussi le bouton retour : un chevron seul serait une cible
 * minuscule, tandis que chevron et titre réunis font une cible de la largeur du titre.
 *
 * @remarks
 * - ⚠️ Le nom accessible n'est pas le titre : annoncer « bouton Dictionnaire personnel » dirait
 *   où l'on est, pas où l'on va. D'où {@link SubscreenHeader.backLabel}, posé en `aria-label`.
 * - ⚠️ Ce n'est pas un `<h1>` : le titre visuel est porté par un bouton, et en faire un titre de
 *   document demanderait un second élément.
 */
@Component({
  selector: 'app-subscreen-header',
  imports: [Icon],
  templateUrl: './subscreen-header.html',
  styleUrl: './subscreen-header.scss',
})
export class SubscreenHeader {
  /** Le titre du sous-écran — ce qui est écrit. */
  readonly title = input.required<string>();

  /** Ce qui est annoncé : la destination du retour, pas le titre. */
  readonly backLabel = input.required<string>();

  /** Le retour a été demandé. L'hôte décide où il mène. */
  readonly back = output<void>();
}
