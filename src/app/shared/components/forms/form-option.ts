import type { IconName } from '../icon/icons';

/**
 * Une option proposée par un contrôle de formulaire.
 *
 * @remarks
 * ⚠️ `label` est du texte déjà traduit : les options arrivent en données et non en contenu
 * projeté, c'est donc à l'appelant de les localiser avec `$localize` avant de les passer.
 */
export interface FormOption<Value extends string = string> {
  /** Ce que le contrôle rend quand l'option est choisie. */
  readonly value: Value;
  /** Le texte affiché, déjà traduit. */
  readonly label: string;
  /** L'icône qui précède le libellé, quand le contrôle en affiche une. */
  readonly icon?: IconName;
  /**
   * L'option est proposée mais pas utilisable en l'état : la choisir doit d'abord la rendre
   * utilisable. Seul {@link ComboSelect} en tient compte — une liste native ne se style pas.
   *
   * @remarks
   * ⚠️ Ce n'est pas `disabled` : une option indisponible reste sélectionnable, et c'est
   * précisément la sélectionner qui déclenche ce qu'il faut. La désactiver enfermerait
   * l'utilisateur devant une langue sans aucun moyen de l'obtenir.
   */
  readonly unavailable?: boolean;

  /**
   * L'option ouvre un groupe : un filet la détache de ce qui la précède. Seul
   * {@link ComboSelect} en tient compte.
   *
   * @remarks
   * ⚠️ Elle reste une valeur comme les autres — on la choisit, elle se coche, elle s'affiche
   * dans le déclencheur. Le filet dit « ceci relève d'autre chose », jamais « ceci n'est pas une
   * valeur » : ça, c'est le rôle de la ligne d'action.
   */
  readonly separated?: boolean;

  /**
   * La branche de la cascade où ranger cette option — « Réunions », « Contenus ». Seul
   * {@link ComboSelect} en tient compte, et il bascule alors son panneau du rôle `listbox` au
   * rôle `menu` : un `listbox` ne prévoit pas de sous-menus.
   *
   * @remarks
   * - ⚠️ L'ordre des branches est celui des options, jamais trié : la première option d'un
   *   groupe fixe la place de sa branche, et l'appelant décide ainsi de l'ordre de lecture.
   * - ⚠️ Absent vaut ligne de premier niveau, et les deux se mélangent dans un même menu.
   */
  readonly group?: string;
}
