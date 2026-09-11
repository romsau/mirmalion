import { Component, computed, inject, type Signal } from '@angular/core';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';
import type { IconName } from '../icon/icons';
import { MODAL_DATA } from '../../../core/services/modal/modal-ref';

/**
 * Où en est la mise à jour. Les trois états dessinés par la maquette, et rien d'autre.
 *
 * @remarks
 * ⚠️ Ni « à jour » ni « échec » : la modale ne s'ouvre que lorsqu'il y a quelque chose à
 * proposer, et un échec de téléchargement est une erreur, donc une snackbar d'erreur ordinaire.
 */
export type UpdateState = 'available' | 'downloading' | 'ready';

/**
 * Ce que l'utilisateur vient de demander.
 *
 * @remarks
 * ⚠️ Une seule sortie porte les quatre : « Plus tard » figure dans deux états et n'y veut pas
 * dire la même chose — renoncer au téléchargement, ou renoncer au redémarrage. L'hôte le
 * distingue par l'état qu'il a lui-même posé, sans deviner quel bouton a parlé.
 */
export type UpdateAction = 'later' | 'install' | 'cancel' | 'restart';

/** Ce que l'appelant fournit à la modale de mise à jour. */
export interface UpdateModalData {
  /** Où en est la mise à jour. */
  readonly state: Signal<UpdateState>;
  /**
   * La version proposée, telle qu'elle s'écrit — « 1.1.0 ».
   *
   * @remarks
   * ⚠️ Une chaîne, pas un numéro décomposé : c'est le manifeste qui la donne et la modale n'a
   * rien à en comparer. Le composant qui la formaterait finirait par la juger.
   */
  readonly version: Signal<string>;
  /** L'avancement, de 0 à 1. Ignoré hors de `downloading`. */
  readonly percent: Signal<number>;
  /** Ce que l'utilisateur vient de demander. */
  readonly action: (action: UpdateAction) => void;
}

/**
 * L'icône de chaque état, `null` quand il n'en porte pas.
 *
 * @remarks
 * ⚠️ « Prête » n'en a pas : la flèche circulaire du redémarrage se lisait « recharger », et le
 * bouton dit déjà ce que la modale attend. Les deux autres gardent la leur, qui dit ce que le
 * texte ne dit pas — une flèche qui descend, un anneau qui tourne.
 */
const ICONS: Readonly<Record<UpdateState, IconName | null>> = {
  available: 'download',
  downloading: 'spinner',
  ready: null,
};

/**
 * Le contenu de la modale de mise à jour : icône, message, barre, boutons, empilés et centrés.
 *
 * Il ne décide rien — il affiche l'état qu'on lui donne et rend l'intention à l'appelant, qui
 * seul sait quand refermer.
 *
 * @remarks
 * ⚠️ Ni voile, ni boîte, ni ombre : le service `Modal` les dessine, ainsi que le `role="dialog"`
 * et le nom accessible. Les redire ferait deux cartes l'une dans l'autre et deux dialogues.
 */
@Component({
  selector: 'app-update-modal',
  imports: [Button, Icon],
  templateUrl: './update-modal.html',
  styleUrl: './update-modal.scss',
})
export class UpdateModal {
  protected readonly data = inject(MODAL_DATA) as UpdateModalData;

  /**
   * La version proposée, lue par le gabarit.
   *
   * @remarks
   * ⚠️ Le gabarit passe par ce raccourci et non par `data.version()` : le texte extrait porte
   * l'expression dans son `equiv-text`, et la changer fait dériver les cinq traductions de
   * `@@update.available`.
   */
  protected readonly version = this.data.version;

  /** L'icône de l'état courant, `null` pour celui qui n'en porte pas. */
  protected readonly icon = computed(() => ICONS[this.data.state()]);

  /**
   * Le remplissage de la barre, de 0 à 1.
   *
   * @remarks
   * ⚠️ Borné ici, pas chez l'appelant : la source est un compteur d'octets venu du réseau, donc
   * une valeur qu'on ne contrôle pas, et une largeur hors bornes déborderait la boîte.
   */
  protected readonly ratio = computed(() => Math.min(Math.max(this.data.percent(), 0), 1));
}
