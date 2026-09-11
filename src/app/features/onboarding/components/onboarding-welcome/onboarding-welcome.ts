import { Component, output } from '@angular/core';
import { Button } from '../../../../shared/components/button/button';
import { Icon } from '../../../../shared/components/icon/icon';
import type { IconName } from '../../../../shared/components/icon/icons';

/** Un des trois usages présentés à l'arrivée. */
interface Use {
  readonly icon: IconName;
  readonly title: string;
  readonly description: string;
}

/**
 * La première étape du premier lancement : ce que fait Mirmalion, en trois blocs.
 *
 * Trois niveaux de texte sans redite : le titre est l'accroche, le sous-titre la promesse — le
 * « 100 % local » y remonte, c'est le différenciateur —, les trois blocs les trois usages.
 *
 * @remarks
 * ⚠️ Trois blocs, jamais quatre : ne pas y ajouter le dictionnaire, l'historique ou les réglages,
 * qui allongeraient un écran fait pour se lire d'un trait.
 */
@Component({
  selector: 'app-onboarding-welcome',
  imports: [Button, Icon],
  templateUrl: './onboarding-welcome.html',
  styleUrl: './onboarding-welcome.scss',
})
export class OnboardingWelcome {
  /** L'utilisateur a cliqué « Commencer ». La coquille décide de la suite. */
  readonly start = output<void>();

  /**
   * Les trois usages, dans l'ordre de la maquette.
   *
   * En données plutôt qu'en trois blocs recopiés dans le gabarit : les trois ont exactement la
   * même structure, et seul leur contenu les distingue.
   */
  protected readonly uses: readonly Use[] = [
    {
      icon: 'mic',
      title: $localize`:@@screen.dictee:Dictée`,
      description: $localize`:@@onboarding.use.dictation.desc:Un raccourci, vous parlez, le texte s'insère au curseur.`,
    },
    {
      icon: 'screen-wave',
      title: $localize`:@@screen.direct:Direct`,
      description: $localize`:@@onboarding.use.live.desc:Enregistrez le son de votre Mac, obtenez un transcript et un compte rendu.`,
    },
    {
      icon: 'file-lines',
      title: $localize`:@@screen.fichiers:Fichiers`,
      description: $localize`:@@onboarding.use.files.desc:Importez un audio ou une vidéo, récupérez le texte.`,
    },
  ];
}
