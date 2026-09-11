import { Component, input, output } from '@angular/core';
import { Icon } from '../../../../../../shared/components/icon/icon';
import { Button } from '../../../../../../shared/components/button/button';

/**
 * La barre du dictionnaire : ajouter à gauche, rechercher à droite.
 *
 * @remarks
 * ⚠️ L'action passe devant la recherche : on vient ici pour ajouter un mot, et une recherche
 * pleine largeur posée en tête promet qu'on y écrit des phrases.
 * ⚠️ Le champ de recherche reste déplié, contrairement à celui de l'historique : chercher est le
 * premier geste de qui vient corriger une entrée, et un champ replié coûterait un clic.
 */
@Component({
  selector: 'app-dictionary-toolbar',
  imports: [Icon, Button],
  templateUrl: './dictionary-toolbar.html',
  styleUrl: './dictionary-toolbar.scss',
})
export class DictionaryToolbar {
  /** Ce que le champ de recherche affiche. */
  readonly query = input('');

  /** La recherche a changé. */
  readonly search = output<string>();

  /** L'utilisateur veut ajouter un mot. */
  readonly add = output<void>();

  /** Remonte la frappe du champ de recherche. */
  protected onInput(event: Event): void {
    this.search.emit((event.target as HTMLInputElement).value);
  }
}
