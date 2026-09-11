import { Component, computed, inject } from '@angular/core';
import { OptionRow } from '../../components/option-row/option-row';
import { Select } from '../../../../shared/components/forms/select/select';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import {
  DICTATION_RETENTIONS,
  type DictationRetention,
  type LiveRetention,
} from '../../../../core/models/settings';
import type { FormOption } from '../../../../shared/components/forms/form-option';
import { DictationBridge } from '../../../../core/services/bridge/dictation/dictation.bridge';

/**
 * La catégorie de réglages Historique : deux rétentions, et elles ne se comptent pas pareil — les
 * dictées par nombre, une dictée étant une phrase qu'on répète vingt fois par jour ; les sessions
 * par durée, une session étant une heure de réunion.
 *
 * @remarks
 * ⚠️ Les deux purges ne se déclenchent pas pareil : celle des sessions est continue et
 * rétroactive — au lancement, puis avant chaque lecture de l'historique (`live::history`) —,
 * quand le plafond des dictées se force depuis cet écran. Voir
 * {@link OptionsHistorique.pickRetention}.
 */
@Component({
  selector: 'app-options-historique',
  imports: [OptionRow, Select],
  templateUrl: './options-historique.html',
  styleUrl: './options-historique.scss',
})
export class OptionsHistorique {
  private readonly settings = inject(SettingsStore);
  private readonly dictation = inject(DictationBridge);
  private readonly snackbar = inject(Snackbar);

  /**
   * Les plafonds proposés pour l'historique de dictée.
   *
   * @remarks
   * ⚠️ Des chaînes, un `<select>` n'en transportant pas d'autres. La conversion en nombre se fait
   * au bord, dans {@link OptionsHistorique.pickRetention} : laisser fuir `"200"` dans les
   * réglages ferait échouer `sanitiseSettings` à la relecture, et le choix serait perdu.
   */
  protected readonly retentions: readonly FormOption[] = DICTATION_RETENTIONS.map((count) => ({
    value: String(count),
    label: String(count),
  }));

  /** Le plafond retenu, en chaîne pour le `<select>`. */
  protected readonly retention = computed(() =>
    String(this.settings.settings().dictationRetention),
  );

  /**
   * Retient le plafond de dictées, puis force la purge.
   *
   * @remarks
   * - ⚠️ Le second geste n'est pas optionnel : écrire le réglage ne vaut que pour les dictées à
   *   venir, et passer de 500 à 50 laisserait 450 entrées visibles — le réglage paraîtrait inerte.
   * - ⚠️ On applique même en augmentant le plafond : la purge est idempotente, et une condition
   *   ne serait qu'une occasion de se tromper de signe.
   */
  protected async pickRetention(value: string): Promise<void> {
    const count = Number(value) as DictationRetention;
    await this.settings.update({ dictationRetention: count });
    try {
      await this.dictation.applyDictationRetention();
    } catch {
      // ⚠️ Cet échec doit se dire, et dire ses deux moitiés : le réglage est écrit et vaudra pour
      // les dictées à venir, mais la purge n'a pas eu lieu. Muet, l'utilisateur voit 500 entrées
      // après avoir choisi 50, conclut que le réglage est inerte, et le rejoue en vain.
      this.snackbar.error(
        $localize`:@@options.retention.purgeFailed:Le plafond est enregistré, mais les dictées en trop n'ont pas pu être supprimées.`,
      );
    }
  }

  /**
   * Les durées de conservation d'une session.
   *
   * @remarks
   * ⚠️ « Illimité » en dernier, jamais en tête : c'est une réponse valable, mais la proposer
   * d'abord ferait de l'accumulation le choix évident, sur des heures d'audio transcrit.
   */
  protected readonly liveRetentions: readonly FormOption[] = [
    { value: '30d', label: $localize`:@@options.liveRetention.30d:30 jours` },
    { value: '3m', label: $localize`:@@options.liveRetention.3m:3 mois` },
    { value: '6m', label: $localize`:@@options.liveRetention.6m:6 mois` },
    { value: '1y', label: $localize`:@@options.liveRetention.1y:1 an` },
    { value: 'unlimited', label: $localize`:@@options.liveRetention.unlimited:Illimité` },
  ];

  /** La durée de conservation retenue pour les sessions. */
  protected readonly liveRetention = computed(() => this.settings.settings().liveRetention);

  /**
   * Retient la durée de conservation des sessions.
   *
   * @remarks
   * ⚠️ Un seul geste ici, contrairement aux dictées : la purge des sessions est continue — au
   * lancement, puis avant chaque lecture de l'historique. Un appel explicite ferait doublon.
   */
  protected pickLiveRetention(value: string): void {
    void this.settings.update({ liveRetention: value as LiveRetention });
  }
}
