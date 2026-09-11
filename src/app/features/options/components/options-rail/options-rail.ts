import { Component, input, output } from '@angular/core';
import { Icon } from '../../../../shared/components/icon/icon';

/**
 * Les sept catégories de réglages qui existent. L'ordre est celui du rail — une d'entre elles
 * n'y est pas montrée, voir {@link OPTIONS_RAIL_CATEGORIES}.
 *
 * Il se lit en trois temps : les familles par fonctionnalité (`general` en tête), puis les deux
 * transverses — `dictionnaire` avant `langues`, de ce qui vaut partout à ce qui délimite —,
 * puis ce qui relève de la machine.
 *
 * @remarks
 * ⚠️ Aucune famille `dictee` : ne pas la recréer pour y poser un réglage de dictée, la réponse
 * est `general`. Une famille de réglages pour un seul interrupteur est une famille de trop.
 */
export type OptionsCategoryId =
  'general' | 'direct' | 'fichiers' | 'dictionnaire' | 'langues' | 'moteurs' | 'historique';

/**
 * Les sept identifiants qui existent, dans l'ordre des familles.
 *
 * @remarks
 * ⚠️ C'est la liste des URL valides, pas celle du rail : `categoryFromUrl` la consulte, et une
 * famille masquée reste atteignable par son adresse, panneau compris.
 */
export const OPTIONS_CATEGORIES: readonly OptionsCategoryId[] = [
  'general',
  'direct',
  'fichiers',
  'dictionnaire',
  'langues',
  'moteurs',
  'historique',
];

/**
 * Les familles qui existent mais que le rail ne montre pas. Il n'en reste qu'une : `moteurs`
 * attend un second moteur à choisir.
 *
 * @remarks
 * - ⚠️ Masquer, et non supprimer : composants, routes et tests restent, pour qu'une famille qui
 *   revient retrouve sa place sans être réécrite.
 */
const HIDDEN_FROM_RAIL: readonly OptionsCategoryId[] = ['moteurs'];

/**
 * Les familles que le rail affiche, dans l'ordre.
 *
 * @remarks
 * ⚠️ Dérivée de {@link OPTIONS_CATEGORIES}, jamais recopiée : une seconde liste écrite à la main
 * se désordonnerait à la première famille insérée. Le gabarit, lui, écrit ses entrées en toutes
 * lettres — le balisage i18n doit y vivre —, et cette constante tient les tests en face de lui.
 */
export const OPTIONS_RAIL_CATEGORIES: readonly OptionsCategoryId[] = OPTIONS_CATEGORIES.filter(
  (category) => !HIDDEN_FROM_RAIL.includes(category),
);

/**
 * Le rail de gauche des Options : il porte `aria-current` et dit seul où l'on est.
 *
 * @remarks
 * - ⚠️ Ce n'est pas `Button` : la maquette lui donne son propre motif — transparent au repos,
 *   aplat d'accent plein sur l'actif. Un `Button` s'allumerait au survol comme s'il était choisi.
 * - ⚠️ Il n'appelle pas le routeur, il émet : autonome, il serait inutilisable dans une coquille
 *   qui n'aurait pas les mêmes routes.
 * - ⚠️ Sur une URL de famille masquée, aucune entrée ne s'allume — plutôt que de retomber sur
 *   « Général », ce qui rendrait la famille inatteignable.
 */
@Component({
  selector: 'app-options-rail',
  imports: [Icon],
  templateUrl: './options-rail.html',
  styleUrl: './options-rail.scss',
})
export class OptionsRail {
  /** La famille ouverte, celle que le rail allume. */
  readonly current = input.required<OptionsCategoryId>();

  /** Une famille a été choisie. L'hôte décide de la navigation. */
  readonly select = output<OptionsCategoryId>();
}
