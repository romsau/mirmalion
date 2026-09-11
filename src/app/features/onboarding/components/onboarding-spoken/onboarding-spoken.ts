import { Component, computed, input, output } from '@angular/core';
import { Button } from '../../../../shared/components/button/button';
import { LanguageList } from '../../../../shared/components/language-list/language-list';
import {
  LAST_SPOKEN_LANGUAGE_REASON,
  lockedSpokenLanguage,
} from '../../../../core/models/language';
import type { Language } from '../../../../core/models/settings';

/**
 * L'étape Langues parlées du premier lancement : on compose sa liste, le bouton du pied engage
 * le téléchargement. Rien sous la liste — c'est le bouton qui annonce ce qui va être obtenu.
 *
 * @remarks
 * - ⚠️ Cocher est gratuit ici, contrairement aux Options : rien ne s'installe au clic. C'est ce
 *   qui distingue les deux hôtes du même composant de liste.
 * - ⚠️ Le libellé dit ce que le bouton va faire, et sa destination le suit : annoncer un
 *   téléchargement puis sauter par-dessus l'installation serait un mensonge.
 */
@Component({
  selector: 'app-onboarding-spoken',
  imports: [Button, LanguageList],
  templateUrl: './onboarding-spoken.html',
  styleUrl: './onboarding-spoken.scss',
})
export class OnboardingSpoken {
  /** Les langues cochées, installées ou non. */
  readonly selected = input.required<readonly Language[]>();

  /** Les langues dont les ressources sont déjà présentes sur la machine. */
  readonly installed = input.required<readonly Language[]>();

  /** Une langue vient d'être cochée ou décochée. */
  readonly toggled = output<Language>();

  /** « Continuer » ou « Télécharger (n) » — la coquille décide où cela mène. */
  readonly act = output<void>();

  /** Les langues cochées dont les ressources manquent : ce que le bouton va obtenir. */
  protected readonly pending = computed(() =>
    this.selected().filter((language) => !this.installed().includes(language)),
  );

  /** La dernière langue allumée : son interrupteur se fige, une dictée sans langue ne dicte rien. */
  protected readonly locked = computed(() => lockedSpokenLanguage(this.selected()));

  /** Ce que la liste dit de l'interrupteur figé. */
  protected readonly lockedReason = LAST_SPOKEN_LANGUAGE_REASON;

  /** « Continuer » tant que rien de neuf n'est coché, « Télécharger (n) » sinon. */
  protected readonly actionLabel = computed(() => {
    const count = this.pending().length;
    return count === 0
      ? $localize`:@@common.continue:Continuer`
      : $localize`:@@onboarding.spoken.download:Télécharger (${count}:count:)`;
  });
}
