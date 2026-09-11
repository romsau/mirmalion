import { Component } from '@angular/core';

/**
 * La catégorie de réglages Moteurs & modèles, vide : choisir son moteur n'a de sens qu'une fois
 * qu'il en existe un second, ce qui part en v2.
 *
 * @remarks
 * - ⚠️ `ui.html` en dessine pourtant un panneau complet : c'est une ébauche de v2, et l'écart
 *   avec ce composant vide n'est pas une divergence à corriger par la revue pixel.
 * - ⚠️ Sa rangée « Identification des voix » est morte : la diarisation ne sert plus qu'à écarter
 *   l'écho et n'affiche rien. Le noter avant de porter le panneau tel quel.
 */
@Component({
  selector: 'app-options-moteurs',
  imports: [],
  templateUrl: './options-moteurs.html',
  styleUrl: './options-moteurs.scss',
})
export class OptionsMoteurs {}
