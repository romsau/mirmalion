import {
  Component,
  ViewContainerRef,
  computed,
  input,
  output,
  viewChild,
  type Injector,
  type Type,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { Button } from '../button/button';

/**
 * La boîte de toutes les modales : le cadre, l'en-tête, et le comportement commun.
 *
 * C'est ici — et une seule fois — que vivent `role="dialog"`, `aria-modal`, le nom accessible
 * et le piège de focus. Un composant monté dedans ne décrit que son contenu.
 *
 * @remarks
 * ⚠️ Elle ne se monte pas à la main : c'est `Modal` qui l'attache, avec l'overlay, le voile, la
 * touche Échap et le clic sur le fond — des évènements de l'overlay, pas de la boîte.
 */
@Component({
  selector: 'app-modal-container',
  imports: [CdkTrapFocus, Button],
  templateUrl: './modal-container.html',
  styleUrl: './modal-container.scss',
})
export class ModalContainer {
  /**
   * Le titre de la boîte.
   *
   * @remarks
   * ⚠️ Obligatoire, parce que c'est le nom accessible du dialogue : sans lui, un lecteur
   * d'écran annonce « dialogue » et rien d'autre.
   */
  readonly heading = input.required<string>();

  /** 1, 2 ou 3 colonnes — 460, 640 ou 820 px. Figée à l'ouverture, voir la feuille SCSS. */
  readonly columns = input<1 | 2 | 3>(1);

  /**
   * Une largeur en pixels qui l'emporte sur le palier de {@link ModalContainer.columns}. `null`
   * retient le palier.
   *
   * @remarks
   * ⚠️ Le `max-width` de la feuille reste au-dessus d'elle : la fenêtre repliée ne fait que
   * 450 px, où même le palier d'une colonne ne tient pas.
   */
  readonly width = input<number | null>(null);

  /**
   * Le bouton de fermeture de l'en-tête.
   *
   * Une modale de confirmation n'en a pas : ses deux actions sont déjà explicites, et une
   * troisième sortie ne ferait qu'ajouter une façon d'annuler.
   */
  readonly dismissible = input(true);

  /**
   * Cache l'en-tête sans perdre le nom accessible : {@link ModalContainer.heading} sert alors
   * d'`aria-label`.
   *
   * @remarks
   * ⚠️ Réservé aux modales qui ne portent qu'un bloc déjà titré — le bloc de progression, qui
   * affiche son propre libellé —, sinon le titre paraîtrait deux fois. Le nom accessible, lui,
   * reste indispensable.
   */
  readonly bare = input(false);

  /**
   * La boîte prend toute la hauteur qu'on lui laisse, et son corps devient une colonne.
   *
   * @remarks
   * ⚠️ Les deux vont ensemble : sans hauteur, un corps en colonne n'a aucun espace libre à
   * distribuer, et sans colonne, un enfant `flex: 1` du contenu monté reste inerte.
   */
  readonly fill = input(false);

  /** Les classes du panneau : le palier de colonnes, et la hauteur pleine si on la demande. */
  protected readonly panelClasses = computed(
    () => `columns-${this.columns()}${this.fill() ? ' is-fill' : ''}`,
  );

  /** La fermeture est demandée. Échap et le clic-fond passent par le service. */
  readonly dismissed = output<void>();

  private readonly host = viewChild.required('content', { read: ViewContainerRef });

  /**
   * Monte le composant demandé à l'intérieur de la boîte.
   *
   * @param component - Le contenu de la modale.
   * @param injector - L'injecteur fourni par `Modal`, qui porte `MODAL_DATA` et le `ModalRef`.
   */
  mount<T>(component: Type<T>, injector: Injector): void {
    this.host().createComponent(component, { injector });
  }
}
