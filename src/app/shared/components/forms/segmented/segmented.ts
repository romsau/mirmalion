import { Component, input, model } from '@angular/core';
import { Icon } from '../../icon/icon';
import type { FormOption } from '../form-option';

/**
 * Le contrôle segmenté : deux ou trois choix exclusifs, côte à côte sur un rail creusé.
 *
 * @remarks
 * ⚠️ Ce n'est pas `Button` en état sélectionné. La maquette dessine deux motifs distincts :
 * `.seg-btn.is-active` — ici — pose une pastille claire sur le rail, quand `.mode-btn.is-active`
 * remplit d'accent plein et relève, lui, de `Button` en état sélectionné.
 */
@Component({
  selector: 'app-segmented',
  imports: [Icon],
  templateUrl: './segmented.html',
  styleUrl: './segmented.scss',
})
export class Segmented<Value extends string = string> {
  /** Les segments, dans l'ordre où ils s'affichent. */
  readonly options = input.required<readonly FormOption<Value>[]>();

  /** Le segment retenu. */
  readonly value = model.required<Value>();

  /** Le nom du groupe. Les boutons se nomment eux-mêmes, mais le groupe qu'ils forment, non. */
  readonly ariaLabel = input.required<string>();
}
