import { Component, LOCALE_ID, computed, inject, input, output } from '@angular/core';
import { formatElapsed } from '../../../../core/services/live/live';
import { METER_BARS } from '../../../../core/models/timing';

/**
 * Le plancher du VU-mètre, en décibels. En dessous, les barres sont à zéro.
 *
 * @remarks
 * ⚠️ Une échelle linéaire en amplitude ne bougerait pas : mesuré sur une capture réelle, le RMS
 * combiné va de 0,017 à 0,251 — un quart de la course en linéaire, les deux tiers en décibels.
 */
const METER_FLOOR_DB = -60;

/**
 * Traduit une énergie RMS (0 à 1) en hauteur de barre (0 à 1). Exportée pour être éprouvée seule.
 *
 * @remarks
 * ⚠️ `!(rms > 0)` et non `rms <= 0` : la première forme attrape aussi `NaN`, qu'un flux sans le
 * moindre tampon peut produire côté natif. Un `NaN` propagé jusqu'au `transform` ferait
 * disparaître les barres au lieu de les coucher.
 */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) {
    return 0;
  }
  const decibels = 20 * Math.log10(Math.min(1, rms));
  return Math.max(0, Math.min(1, 1 - decibels / METER_FLOOR_DB));
}

/**
 * La ligne d'enregistrement de la fenêtre-session : depuis quand, à quel niveau, et le bouton qui
 * arrête. Le chrono est en `hh:mm:ss` — une session dépasse l'heure.
 *
 * @example
 * ```html
 * <app-direct-live [elapsedSeconds]="…" [level]="…" [stopping]="…" (stop)="…" />
 * ```
 *
 * @remarks
 * - ⚠️ Les cinq barres bougent ensemble : on n'a qu'un seul nombre, l'énergie combinée des deux
 *   flux. Les faire varier entre elles inventerait quatre mesures qu'on n'a pas.
 * - ⚠️ Mètre et chrono restent `aria-hidden` : ce qui change dix fois par seconde ne se restitue
 *   pas à la voix. Ce qu'il faut annoncer l'est par la méta de l'en-tête.
 */
@Component({
  selector: 'app-direct-live',
  imports: [],
  templateUrl: './direct-live.html',
  styleUrl: './direct-live.scss',
})
export class DirectLive {
  /** Depuis combien de temps la session enregistre. */
  readonly elapsedSeconds = input.required<number>();
  /**
   * L'énergie RMS combinée des deux flux, de 0 à 1, telle que le natif la mesure.
   *
   * @remarks
   * ⚠️ Du RMS brut, jamais une hauteur de barre : la conversion en décibels est le travail du
   * mètre, et elle doit rester d'un seul côté de la frontière.
   */
  readonly level = input.required<number>();
  /**
   * L'arrêt est-il en cours ?
   *
   * @remarks
   * ⚠️ Fermer les fichiers et rendre la main prend un instant : sans cet état, un second clic
   * partirait sur un enregistrement déjà en train de se clore.
   */
  readonly stopping = input(false);

  /** L'utilisateur demande l'arrêt de la session. */
  readonly stop = output<void>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly bars = METER_BARS;

  /**
   * La hauteur des barres, de 0 à 1, telle que le style la consomme.
   *
   * @remarks
   * ⚠️ Jamais tout à fait zéro : un mètre qui disparaît au silence se lit comme un mètre cassé,
   * quand le sixième de course qui reste dit « on écoute, et il n'y a rien à entendre ».
   */
  protected readonly meter = computed(() => Math.max(0.06, meterLevel(this.level())));

  /**
   * Le temps écoulé, en `hh:mm:ss`.
   *
   * @remarks
   * ⚠️ Le formatage vit dans `live.ts` : le déclencheur affiche le même minuteur, et deux mises
   * en forme divergeraient au premier arrondi.
   */
  protected readonly elapsed = computed(() => formatElapsed(this.elapsedSeconds(), this.locale));
}
