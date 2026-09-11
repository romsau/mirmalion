import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SubscreenHeader } from '../../components/subscreen-header/subscreen-header';
import { LanguageList } from '../../../../shared/components/language-list/language-list';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { Translation } from '../../../../core/services/translation/translation';
import type { Language } from '../../../../core/models/settings';

/**
 * Le sous-écran Langues de traduction — les cibles proposées dans les écrans de travail. Une
 * seule question posée : vers quelles langues traduire.
 *
 * @remarks
 * - ⚠️ Ni icône d'état, ni modale à nous : Apple raisonne par paires ordonnées (fr→ja), si bien
 *   qu'une icône par langue vaudrait pour N états et changerait rétroactivement. C'est Apple qui
 *   présente sa feuille, et l'interrupteur est le geste qui la déclenche.
 * - ⚠️ Le clic active **puis** prépare, dans cet ordre : refermer la feuille sans télécharger
 *   laisse la langue cochée, ce qui est bien ce qui a été demandé.
 */
@Component({
  selector: 'app-options-langues-traduction',
  imports: [SubscreenHeader, LanguageList],
  templateUrl: './options-langues-traduction.html',
  styleUrl: './options-langues-traduction.scss',
})
export class OptionsLanguesTraduction {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  private readonly translation = inject(Translation);

  /** Les cibles de traduction activées. */
  protected readonly targets = computed(() => this.settings.settings().translationLanguages);

  /** Remonte à l'accueil des langues. */
  protected back(): void {
    void this.router.navigate(['/options', 'langues']);
  }

  /**
   * Allume ou éteint une cible de traduction. Éteindre ne prépare rien et ne désinstalle rien.
   *
   * @remarks
   * ⚠️ Aucune règle de minimum ici, contrairement aux langues parlées : ne traduire vers rien est
   * un choix valable, et c'est même le défaut.
   */
  protected toggle(language: Language): void {
    const targets = this.targets();
    if (targets.includes(language)) {
      void this.settings.update({
        translationLanguages: targets.filter((kept) => kept !== language),
      });
      return;
    }
    void this.settings.update({ translationLanguages: [...targets, language] });
    // ⚠️ C'est ce clic-ci, et lui seul, qui peut faire surgir une feuille système : aucun
    // chargement d'écran ne doit atteindre cette ligne.
    void this.translation.offerDownload(language, this.settings.settings().spokenLanguages);
  }
}
