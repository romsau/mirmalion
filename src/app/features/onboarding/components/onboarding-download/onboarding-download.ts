import { Component, input, output } from '@angular/core';
import { ProgressBar } from '../../../../shared/components/progress-bar/progress-bar';

/**
 * L'étape Installation des langues parlées : le libellé de la progression y tient lieu de titre,
 * d'où sa taille, et « Annuler » y est la seule sortie.
 *
 * @remarks
 * - ⚠️ Une étape et non une modale, contrairement aux Options : l'utilisateur vient d'en composer
 *   plusieurs et n'a rien d'autre à faire pendant ce temps.
 * - ⚠️ Aucun titre d'étape et aucun bouton de pied : un second titre reléguerait le seul qui dise
 *   ce qui se passe, et « Continuer » laisserait une barre courir sans rien qui la montre.
 */
@Component({
  selector: 'app-onboarding-download',
  imports: [ProgressBar],
  templateUrl: './onboarding-download.html',
  styleUrl: './onboarding-download.scss',
  // ⚠️ Le nom accessible de l'écran est porté par l'hôte, et c'est la seule étape où il le faut :
  // les quatre autres ont un `<h1>`, celle-ci n'a que le libellé de la progression, qui reste un
  // `<p>` — le composant générique le porte, et lui donner un niveau de titre le rendrait faux
  // dans ses autres emplois.
  host: {
    role: 'group',
    '[attr.aria-label]': 'screenLabel',
  },
})
export class OnboardingDownload {
  /** Le nom accessible de l'écran, faute de `<h1>`. */
  protected readonly screenLabel = $localize`:@@onboarding.download.title:Installation des langues parlées`;

  /** Ce que la barre annonce : les langues en cours d'installation. */
  readonly label = input.required<string>();
  /** `null` tant qu'aucun pourcentage n'est arrivé — la barre est alors indéterminée. */
  readonly progress = input<number | null>(null);
  /** Interrompt vraiment le téléchargement, et ramène au choix des langues. */
  readonly cancelled = output<void>();
}
