import { Component, computed, input, output } from '@angular/core';
import { Icon } from '../../../../../../shared/components/icon/icon';
import { Button } from '../../../../../../shared/components/button/button';

/**
 * La zone d'accueil d'un média local : une icône, une phrase, et un bouton pour ceux qui ne
 * glissent pas de fichiers. Elle montre le glisser sans le détecter — l'écran écoute la fenêtre
 * entière et lui en passe le verdict —, et le clic du bouton remonte jusqu'à l'hôte, d'où un
 * écouteur unique sur la zone.
 *
 * @example
 * ```html
 * <app-file-drop-zone [dragging]="dragging()" (browseRequested)="pick()" />
 * ```
 *
 * @remarks
 * ⚠️ Le `<button>` n'est pas décoratif : c'est la seule voie au clavier, le glisser-déposer ne
 * pouvant pas être la seule manière d'importer.
 */
@Component({
  selector: 'app-file-drop-zone',
  imports: [Icon, Button],
  templateUrl: './file-drop-zone.html',
  styleUrl: './file-drop-zone.scss',
  host: {
    '(click)': 'browseRequested.emit()',
  },
})
export class FileDropZone {
  /**
   * Un fichier est réellement en cours de glisser au-dessus de la fenêtre.
   *
   * @remarks
   * ⚠️ Ce n'est pas le survol de la souris : aucun retour n'apparaît quand le curseur passe sur
   * la zone sans rien porter, c'est ce qui distingue une cible de dépôt d'un bouton géant.
   */
  readonly dragging = input(false);

  /** L'utilisateur demande le sélecteur de fichiers du système. */
  readonly browseRequested = output<void>();

  /**
   * Le titre de la zone, qui change pendant le glisser.
   *
   * @remarks
   * ⚠️ Un seul nœud, et non deux `<p>` qu'on montre tour à tour comme le fait la maquette faute
   * de mieux : un lecteur d'écran annonce un texte qui change, pas la disparition d'un paragraphe
   * suivie de l'apparition d'un autre.
   */
  protected readonly title = computed(() =>
    this.dragging()
      ? $localize`:@@fichiers.drop.title.dragging:Déposez le fichier`
      : $localize`:@@fichiers.drop.title:Glissez un fichier audio ou vidéo`,
  );
}
