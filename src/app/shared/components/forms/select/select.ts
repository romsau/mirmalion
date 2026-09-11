import { Component, input, output } from '@angular/core';
import { Icon } from '../../icon/icon';
import type { FormOption } from '../form-option';

/**
 * Le `<select>` natif, habillé : on n'habille que la boîte et le chevron.
 *
 * Sans {@link Select.placeholder}, c'est un champ ; avec, c'est un menu de commandes —
 * « Exporter » — qui retombe seul sur son libellé de tête après chaque choix.
 *
 * @remarks
 * - ⚠️ La liste déroulée ne se style pas : dès qu'il y faut des cases, des icônes ou des
 *   sections, c'est `ComboSelect` qu'il faut, pas une entrée de plus ici.
 * - ⚠️ `value` est une entrée et non un modèle : c'est l'hôte qui repose la valeur choisie, ou
 *   la refuse. Un modèle interne rendrait le refus impossible — voir {@link Select.select}.
 */
@Component({
  selector: 'app-select',
  imports: [Icon],
  templateUrl: './select.html',
  styleUrl: './select.scss',
})
export class Select<Value extends string = string> {
  /** Les options proposées, dans l'ordre de la liste. */
  readonly options = input.required<readonly FormOption<Value>[]>();

  /** La valeur affichée. C'est l'hôte qui la repose après un choix, ou qui la refuse. */
  readonly value = input.required<Value>();

  /** Le contrôle ne répond plus. */
  readonly disabled = input(false);

  /** Le nom accessible du contrôle. */
  readonly ariaLabel = input.required<string>();

  /**
   * Le libellé d'une entrée de tête non choisissable, qui fait de ce menu une commande.
   *
   * Vide par défaut. Renseigné, il ajoute en tête une option `disabled hidden` : elle reste
   * affichée entre deux actions et n'apparaît jamais dans la liste déroulée.
   */
  readonly placeholder = input('');

  /**
   * Le choix de l'utilisateur.
   *
   * @remarks
   * ⚠️ Nommé `valueChange` à dessein : c'est ce qui laisse `[(value)]` s'écrire chez l'appelant,
   * sans modèle interne ici.
   */
  readonly valueChange = output<Value>();

  /**
   * Restaure le DOM sur la valeur de l'hôte, puis émet le choix.
   *
   * @param event - Le `change` du `<select>` natif.
   * @remarks
   * - ⚠️ Le navigateur a changé la sélection dans le dos d'Angular : rien ne la remettra en
   *   place tant que l'expression liée ne changera pas. C'est l'hôte qui fait apparaître la
   *   nouvelle valeur ; s'il la refuse, le contrôle est déjà revenu où il devait être.
   * - ⚠️ Sans scintillement : la détection de changements zoneless est planifiée en
   *   `requestAnimationFrame`, donc avant la peinture qui suivrait ce `change`.
   */
  protected select(event: Event): void {
    const control = event.target as HTMLSelectElement;
    const chosen = control.value as Value;
    control.value = this.value();
    this.valueChange.emit(chosen);
  }
}
