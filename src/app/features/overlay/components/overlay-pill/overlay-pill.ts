import { Component, computed, inject, input, LOCALE_ID } from '@angular/core';
import { Icon } from '../../../../shared/components/icon/icon';
import type { IconName } from '../../../../shared/components/icon/icons';
import type { OverlayState } from '../../../../core/services/bridge/overlay/overlay.bridge';
import { METER_BARS } from '../../../../core/models/timing';

/**
 * L'icône de chaque état. « Écoute » n'y figure pas : son égaliseur est **animé**, donc
 * dessiné par le gabarit et non tiré du registre d'icônes.
 */
const ICONS: Readonly<Record<Exclude<OverlayState, 'listening'>, IconName>> = {
  preparing: 'spinner',
  translating: 'translate',
  done: 'status-success',
  error: 'status-error',
  // ⚠️ Avertissement, pas erreur : rien n'a échoué, la dictée est simplement indisponible le
  // temps de la session. La maquette lui donne l'icône `--warning`, pas `--danger`.
  suspended: 'status-warning',
};

/**
 * Le libellé de chaque état. Des fonctions et non des constantes : cela évite d'évaluer tous les
 * textes au chargement du module alors qu'un seul sera affiché.
 */
const LABELS: Readonly<Record<OverlayState, () => string>> = {
  listening: () => $localize`:@@overlay.state.listening:Écoute`,
  preparing: () => $localize`:@@overlay.state.preparing:Préparation`,
  translating: () => $localize`:@@overlay.state.translating:Traduction`,
  done: () => $localize`:@@overlay.state.done:Terminé !`,
  error: () => $localize`:@@overlay.state.error:Erreur`,
  suspended: () => $localize`:@@overlay.state.suspended:Dictée suspendue`,
};

/**
 * La pilule flottante qui accompagne tout enregistrement — dictée comme session. Le chrono est
 * tout ce qui distingue les deux cas. `role="status"` sur l'hôte annonce chaque changement
 * d'état une fois ; le chrono, lui, est masqué aux technologies d'assistance.
 *
 * @remarks
 * - ⚠️ Purement informative : aucun bouton, aucune cible de focus. La fenêtre qui la porte ne
 *   prend jamais le focus, et un contrôle inatteignable au clavier serait une faute d'a11y.
 * - ⚠️ Aucun niveau audio : l'égaliseur est décoratif et tourne à cadence fixe. Le brancher
 *   ferait remonter des échantillons au webview soixante fois par seconde, pour une animation.
 */
@Component({
  selector: 'app-overlay-pill',
  imports: [Icon],
  templateUrl: './overlay-pill.html',
  styleUrl: './overlay-pill.scss',
  host: {
    role: 'status',
    'aria-live': 'polite',
    '[attr.data-state]': 'state()',
  },
})
export class OverlayPill {
  /** L'état à afficher. */
  readonly state = input.required<OverlayState>();

  /**
   * Le temps écoulé depuis le début de l'enregistrement, ou `null` pour n'afficher aucun
   * chrono — le cas de la dictée, où « Écoute » ne dure que quelques secondes.
   */
  readonly elapsedSeconds = input<number | null>(null);

  private readonly locale = inject(LOCALE_ID);

  /** Les barres de l'égaliseur, rendues par le gabarit. */
  protected readonly bars = METER_BARS;

  /** L'icône de l'état, ou `null` en « Écoute », que l'égaliseur animé occupe. */
  protected readonly icon = computed<IconName | null>(() => {
    const state = this.state();
    return state === 'listening' ? null : ICONS[state];
  });

  /** Le libellé de l'état, dans la langue de l'interface. */
  protected readonly label = computed(() => LABELS[this.state()]());

  /**
   * Le chrono, en `m:ss`, ou `null` s'il n'y a rien à afficher. Les minutes ne sont pas
   * plafonnées à 59 : une session de deux heures affiche `120:00`.
   *
   * @remarks
   * ⚠️ Il ne survit pas à l'état « Écoute » : l'enregistrement fini, sa durée n'apprend plus rien
   * et occuperait la place du verdict.
   */
  protected readonly elapsed = computed(() => {
    const seconds = this.elapsedSeconds();
    if (seconds === null || this.state() !== 'listening') {
      return null;
    }
    const safe = Math.max(0, Math.floor(seconds));
    return `${this.format(Math.floor(safe / 60), 1)}:${this.format(safe % 60, 2)}`;
  });

  /** Un nombre du chrono, dans les chiffres de la langue de l'interface. */
  private format(value: number, digits: number): string {
    return new Intl.NumberFormat(this.locale, {
      minimumIntegerDigits: digits,
      useGrouping: false,
    }).format(value);
  }
}
