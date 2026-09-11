import { Service, inject } from '@angular/core';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';
import type { Language } from '../../models/settings';

/**
 * Le seul geste de l'interface qui puisse engager un téléchargement de traduction.
 *
 * @remarks
 * - ⚠️ Il ne connaît qu'une langue, jamais une paire ordonnée. Aucun écran ne peut afficher
 *   « italien installé » : avec trois langues parlées, une cible dépend de trois paires.
 * - ⚠️ On ne télécharge rien, on le demande à Apple, qui présente sa feuille : l'interrupteur
 *   est le premier consentement, la feuille le second.
 * - ⚠️ Rien n'est mis en cache : le téléchargement se poursuit en arrière-plan, donc un état
 *   mémorisé serait périmé sans qu'on sache quand. Le pipeline interroge à chaque emploi.
 */
@Service()
export class Translation {
  private readonly bridge = inject(LanguagesBridge);

  /**
   * Demande la préparation de `target`, en partant des langues que l'utilisateur parle.
   *
   * Ne promet rien, et son type le dit : le backend ne fait rien s'il ne manque aucune paire,
   * la feuille d'Apple peut être refermée sans rien prendre, et une installation acceptée se
   * poursuit en arrière-plan. « La demande est partie » est tout ce qu'on peut affirmer.
   *
   * @remarks
   * ⚠️ À n'appeler que sur un clic : une feuille système qui surgirait à l'ouverture d'une page
   * violerait la règle du consentement explicite.
   */
  async offerDownload(target: Language, spoken: readonly Language[]): Promise<void> {
    await this.bridge.prepareTranslation(target, spoken);
  }
}
