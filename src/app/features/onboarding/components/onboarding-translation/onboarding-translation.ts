import { Component, input, output } from '@angular/core';
import { Button } from '../../../../shared/components/button/button';
import { LanguageList } from '../../../../shared/components/language-list/language-list';
import type { Language } from '../../../../core/models/settings';

/**
 * L'étape Traduction, la dernière du premier lancement : vers quelles langues traduire, et rien
 * d'autre. Le bouton du pied dit « Terminer », toujours — rien n'oblige à traduire.
 *
 * @remarks
 * ⚠️ Cet écran ne parle ni de paires, ni de téléchargement : pas d'icône ⤓ sur les rangées, pas
 * de suffixe « à télécharger ». Apple installe des paires ordonnées (fr→ja), pas des langues, si
 * bien qu'une icône par langue vaudrait pour N états — et changerait rétroactivement dès qu'une
 * langue parlée s'ajoute.
 */
@Component({
  selector: 'app-onboarding-translation',
  imports: [Button, LanguageList],
  templateUrl: './onboarding-translation.html',
  styleUrl: './onboarding-translation.scss',
})
export class OnboardingTranslation {
  /**
   * Les cibles de traduction cochées.
   *
   * @remarks
   * ⚠️ Une case pré-cochée est un choix enregistré, jamais un geste : elle ne déclenche aucune
   * préparation, sans quoi une feuille système surgirait à l'ouverture de l'écran.
   */
  readonly selected = input.required<readonly Language[]>();

  /**
   * Une cible vient d'être cochée ou décochée.
   *
   * @remarks
   * ⚠️ L'interrupteur est le geste de téléchargement, et c'est Apple qui présente sa propre
   * feuille au clic. On n'en dessine aucune, on n'en explique rien.
   */
  readonly toggled = output<Language>();

  /** « Terminer » : l'onboarding est fait. */
  readonly finish = output<void>();
}
