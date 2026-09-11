import { Component, computed, input } from '@angular/core';
import { Icon } from '../icon/icon';
import type { IconName } from '../icon/icons';

/**
 * La couleur du bouton : un fond teinté au repos, inversé en fond plein au survol.
 *
 * `accent` par défaut, y compris pour supprimer et pour annuler ; `neutral` seulement pour
 * départager deux boutons côte à côte — seul, le neutre se lit comme un bouton éteint.
 *
 * @remarks
 * ⚠️ Ni `'warning'` ni `'danger'` : ce qui protège d'un geste destructeur est la modale de
 * confirmation, pas la teinte du bouton qui l'ouvre, et le blanc sur orange ne tient pas WCAG
 * (3,04:1). L'orange sert la signalétique d'état non cliquable, jamais un bouton.
 */
export type ButtonVariant = 'accent' | 'neutral';

/**
 * L'échelle du bouton — mêmes couleurs et même inversion dans les deux cas. `large` sert aux
 * appels à l'action : « Démarrer l'enregistrement », « Arrêter ».
 */
export type ButtonSize = 'default' | 'large';

/**
 * Le bouton de l'application : fond teinté au repos, inversé en fond plein au survol.
 *
 * Il n'y en a pas d'autre. Le libellé passe par `<ng-content>`, ce qui laisse l'appelant le
 * baliser i18n dans son gabarit ; en icône seule, {@link Button.ariaLabel} est obligatoire.
 *
 * @remarks
 * - ⚠️ Les exceptions actées sont des exceptions de taille, jamais de comportement : pour
 *   ajuster une hauteur, l'appelant redéfinit `--btn-h` au lieu d'ajouter une variante.
 * - ⚠️ `.h-act` n'est pas ce composant : les actions d'un élément d'historique n'ont pas de
 *   fond au repos et forment un composant à part.
 */
@Component({
  selector: 'app-button',
  imports: [Icon],
  templateUrl: './button.html',
  styleUrl: './button.scss',
  host: {
    '[class]': 'hostClasses()',
  },
})
export class Button {
  /** La teinte du bouton. */
  readonly variant = input<ButtonVariant>('accent');

  /** L'échelle du bouton. */
  readonly size = input<ButtonSize>('default');

  /**
   * Le bouton n'a que son icône : il devient carré.
   *
   * @remarks
   * ⚠️ Déclaré par l'appelant, jamais déduit du contenu : une règle `:has(.label:empty)` n'est
   * pas réinvalidée par WebKit quand le libellé réapparaît — le header perdant ses libellés en
   * fenêtre étroite —, et `aspect-ratio: 1` laisse un carré de 100 px au texte débordant.
   */
  readonly iconOnly = input(false);

  /** L'icône affichée, avant le libellé quand il y en a un. */
  readonly icon = input<IconName>();

  /**
   * Fait tourner l'icône : le bouton travaille.
   *
   * À l'appelant de changer aussi d'icône — `refresh` cède la place à l'anneau qui tourne : le
   * bouton n'a pas à décider quelle icône signifie « en cours ».
   *
   * @remarks
   * ⚠️ Un passe-plat vers `Icon`, jamais une animation posée ici : appliquée au bouton, la
   * rotation ferait tourner une image déjà rastérisée et retrouverait le tremblement décrit
   * dans les styles d'`Icon`.
   */
  readonly iconSpin = input(false);

  /** Le bouton ne répond plus. */
  readonly disabled = input(false);

  /**
   * L'état déplié de la zone que ce bouton commande, s'il en commande une. `undefined` par
   * défaut : un bouton ordinaire n'annonce rien.
   *
   * @remarks
   * ⚠️ `aria-expanded`, à ne pas confondre avec {@link Button.selected} / `aria-pressed` : le
   * premier dit qu'une zone est ouverte, le second qu'une bascule est enfoncée — et celui-là
   * s'accompagne d'une inversion visuelle permanente, dont ce cas ne veut pas.
   */
  readonly expanded = input<boolean | undefined>(undefined);

  /**
   * L'état sélectionné d'une bascule — « Maintenir / Mains libres » : le bouton reste inversé
   * en permanence, comme s'il était survolé.
   *
   * @remarks
   * ⚠️ `undefined` par défaut : un bouton ordinaire ne doit pas porter `aria-pressed="false"`,
   * qui l'annoncerait comme une bascule non enfoncée.
   */
  readonly selected = input<boolean | undefined>(undefined);

  /**
   * Le `type` de l'élément natif.
   *
   * @remarks
   * ⚠️ `button` par défaut, et non `submit` : dans un `<form>`, un bouton sans `type` soumet le
   * formulaire.
   */
  readonly type = input<'button' | 'submit'>('button');

  /** Le nom accessible. Obligatoire en icône seule, inutile dès qu'il y a un libellé. */
  readonly ariaLabel = input<string>();

  /** Les classes de l'hôte : variante, échelle, et forme carrée en icône seule. */
  protected readonly hostClasses = computed(() =>
    `variant-${this.variant()} size-${this.size()}${this.iconOnly() ? ' icon-only' : ''}`.trim(),
  );
}
