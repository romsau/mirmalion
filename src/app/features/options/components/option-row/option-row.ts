import { Component, booleanAttribute, input, output } from '@angular/core';
import { Icon } from '../../../../shared/components/icon/icon';

/**
 * Une ligne de réglage — libellé à gauche, contrôle à droite, toute la ligne cliquable.
 *
 * Deux formes : la ligne « drill-in », dont le bouton de fin s'étire par un `::after` et n'a rien
 * à câbler ; la ligne à contrôle, qui émet {@link OptionRow.activate} sans arrêt de tabulation.
 *
 * @remarks
 * - ⚠️ La ligne ne peut pas être un bouton dès qu'elle contient un contrôle : imbriquer deux
 *   éléments interactifs est invalide, et un lecteur d'écran n'en annonce plus qu'un.
 * - ⚠️ Ne pas rendre cliquable une ligne à menu déroulant : aucun navigateur n'ouvre une liste
 *   déroulante par programme.
 */
@Component({
  selector: 'app-option-row',
  imports: [Icon],
  templateUrl: './option-row.html',
  styleUrl: './option-row.scss',
  host: {
    '[class.is-drill-in]': 'drillIn()',
    '[class.is-disabled]': 'disabled()',
    '[class.is-in-section]': 'inSection()',
    '[class.is-top]': 'alignTop()',
    '[class.is-passive]': 'passive()',
  },
})
export class OptionRow {
  /** Le libellé de gauche. */
  readonly label = input.required<string>();

  /** La précision sous le libellé. Absente, la ligne se réduit à une seule ligne de texte. */
  readonly sublabel = input<string>();

  /**
   * Ouvre un sous-écran plutôt que de porter un contrôle.
   *
   * @remarks
   * ⚠️ `booleanAttribute` pour qu'il s'écrive nu — `<app-option-row drillIn …>` : sans lui,
   * l'attribut nu passe la chaîne vide et le gabarit ne compile pas.
   */
  readonly drillIn = input(false, { transform: booleanAttribute });

  /** L'indication de fin de ligne d'un « drill-in » — « 14 termes », « Gérer ». */
  readonly hint = input<string>();

  /** La ligne ne répond plus. */
  readonly disabled = input(false);

  /**
   * Cette ligne vit dans une section titrée, qui porte déjà son filet : un seul filet par
   * section, sous son titre, et aucun entre les rangées.
   *
   * @remarks
   * - ⚠️ Ne vaut que là où il y a des sections : les familles sans titre n'en ont pas, et leur
   *   retirer les filets de rangée ne laisserait plus aucune séparation.
   * - ⚠️ Une entrée, et non une règle du parent : le filet est posé sur `.row`, hors d'atteinte
   *   d'une feuille d'hôte. Le remonter le sortirait de la zone de survol, qui déborde.
   */
  readonly inSection = input(false, { transform: booleanAttribute });

  /**
   * La ligne aligne son texte en haut plutôt qu'au centre.
   *
   * @remarks
   * ⚠️ Pour les lignes dont le contrôle en cache un second — le type de compte rendu ouvre une
   * zone de prompt sous son sélecteur, et un alignement centré ferait flotter le libellé.
   */
  readonly alignTop = input(false, { transform: booleanAttribute });

  /**
   * La ligne n'a pas d'action propre : elle ne s'allume pas au survol et garde le curseur
   * flèche.
   *
   * @remarks
   * ⚠️ C'est le cas de toute ligne à menu déroulant — aucun navigateur n'ouvre une liste par
   * programme, et une ligne qui s'allume sans rien faire promet une action qui n'arrivera pas.
   * L'entrée dit dans le balisage ce que la règle disait en commentaire.
   * ⚠️ Distincte de `disabled` : la ligne reste vivante, c'est son **contrôle** qui agit.
   */
  readonly passive = input(false, { transform: booleanAttribute });

  /** Le clic sur la ligne. L'appelant décide de ce qu'il en fait. */
  readonly activate = output<void>();

  /**
   * Traite le clic sur la ligne elle-même.
   *
   * @remarks
   * ⚠️ Deux gardes, chacune contre un double envoi : en « drill-in » le bouton étiré a déjà émis,
   * et un clic sur le contrôle projeté remonte lui aussi — sans elle, le segmenté du thème
   * passait en sombre puis la ligne le rebasculait en clair.
   * ⚠️ `passive` en est une troisième, d'une autre nature : elle n'évite pas un doublon, elle
   * dit que cette ligne-là n'a rien à émettre.
   */
  protected onRowClick(event: Event): void {
    if (this.drillIn() || this.disabled() || this.passive()) {
      return;
    }
    // `event.target` est toujours un élément : l'écouteur est posé sur un nœud du DOM, et seul
    // un descendant peut avoir été cliqué. Le traiter comme incertain ajouterait une branche
    // que rien ne peut atteindre.
    if ((event.target as Element).closest('.control') !== null) {
      return;
    }
    this.activate.emit();
  }
}
