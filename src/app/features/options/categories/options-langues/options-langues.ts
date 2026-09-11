import { Component, LOCALE_ID, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { OptionRow } from '../../components/option-row/option-row';
import { Select } from '../../../../shared/components/forms/select/select';
import { rememberRouteAcrossLocaleChange } from '../../../../app.routes';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import {
  LANGUAGE_NAMES,
  interfaceLanguageOptions,
  languageCount,
} from '../../../../core/models/language';
import type { Language } from '../../../../core/models/settings';
import { SystemBridge } from '../../../../core/services/bridge/system/system.bridge';

/**
 * La catégorie de réglages Langues : l'interface, ce qu'on dicte, ce vers quoi on traduit. Deux
 * sous-écrans plutôt que deux listes dépliées — six lignes à interrupteur ne tiennent pas dans
 * une colonne d'options, et ce sont exactement les listes de l'onboarding.
 *
 * @remarks
 * ⚠️ Tout ce qui touche aux langues vit ici : ni dans les familles par fonctionnalité, ni dans
 * l'écran de dictée, où la gestion des packs encombrait un écran ouvert vingt fois par jour.
 */
@Component({
  selector: 'app-options-langues',
  imports: [OptionRow, Select],
  templateUrl: './options-langues.html',
  styleUrl: './options-langues.scss',
})
export class OptionsLangues {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  private readonly system = inject(SystemBridge);

  /** La langue dans laquelle l'interface est écrite. */
  protected readonly interfaceLanguage = computed(() => this.settings.settings().interfaceLanguage);

  /**
   * Les six langues d'interface.
   *
   * @remarks
   * ⚠️ Chaque nom est doublé de son équivalent anglais — « Allemand (German) ». C'est le seul
   * contrôle de l'application qui le fasse : un mauvais choix ici rend toute l'interface
   * illisible, et l'anglais est le point d'appui qui permet d'en revenir.
   */
  protected readonly interfaceOptions = interfaceLanguageOptions(inject(LOCALE_ID));

  /** Les langues parlées activées. */
  protected readonly spoken = computed(() => this.settings.settings().spokenLanguages);

  /** Les cibles de traduction activées. */
  protected readonly targets = computed(() => this.settings.settings().translationLanguages);

  /** Les langues parlées, nommées sous leur ligne. */
  protected readonly spokenSummary = computed(() => this.summarise(this.spoken()));

  /** Les cibles de traduction, nommées sous leur ligne. */
  protected readonly translationSummary = computed(() => this.summarise(this.targets()));

  /**
   * Change la langue de l'interface, ce qui recharge la fenêtre sur un autre bundle.
   *
   * @remarks
   * ⚠️ Ce geste détruit cet écran, et l'ordre des trois lignes est contraint : retenir la route,
   * puis écrire le réglage **et l'attendre** — c'est le fichier que relit la fenêtre qui renaît
   * —, puis demander la bascule. Rien ne s'enchaîne après : ce webview n'existera plus.
   */
  protected async setInterfaceLanguage(language: Language): Promise<void> {
    rememberRouteAcrossLocaleChange(this.router.url);
    await this.settings.update({ interfaceLanguage: language });
    await this.system.setInterfaceLanguage(language);
  }

  /** Ouvre l'un des deux sous-écrans de listes. */
  protected open(subscreen: 'parlees' | 'traduction'): void {
    void this.router.navigate(['/options', 'langues', subscreen]);
  }

  /** Le compte de bout de ligne — « Aucune », « 1 langue », « 3 langues ». */
  protected count(languages: readonly Language[]): string {
    return languageCount(languages.length);
  }

  /**
   * Le sous-libellé d'une ligne « drill-in » : les langues activées, dans l'ordre où elles ont
   * été choisies. Rien de plus que les noms : la ligne porte déjà son compte à droite.
   */
  private summarise(languages: readonly Language[]): string {
    return languages.map((language) => LANGUAGE_NAMES[language]).join(', ');
  }
}
