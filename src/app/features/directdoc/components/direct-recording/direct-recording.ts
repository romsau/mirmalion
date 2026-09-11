import { Component, computed, input, output, signal } from '@angular/core';
import { InlineTitle } from '../../../../shared/components/inline-title/inline-title';
import { Switch } from '../../../../shared/components/forms/switch/switch';
import { DirectLive } from '../direct-live/direct-live';
import { DirectTranscript } from '../direct-transcript/direct-transcript';
import type { Language } from '../../../../core/models/settings';
import type { LiveLine } from '../../../../core/services/live/live';
import type { PendingSpeech } from '../../../../core/store/direct/direct.store';
import {
  SESSION_RENAME_LABEL,
  SESSION_TITLE_FIELD_LABEL,
} from '../../../../core/services/live/live';

/**
 * Le panneau enregistrement de la fenêtre-session : la tête, la ligne d'enregistrement, le
 * transcript au fil de l'eau. Le titre s'y renomme pendant que la session tourne.
 *
 * ```html
 * <app-direct-recording [title]="…" [meta]="…" [lines]="…" [pending]="…" (stop)="…" />
 * ```
 *
 * @remarks
 * ⚠️ Même squelette que `DirectDocument`, aux mêmes endroits : ce qui change à l'arrêt est ce que
 * la barre porte, jamais où elle est — la fenêtre ne doit pas se réorganiser sous les yeux.
 */
@Component({
  selector: 'app-direct-recording',
  imports: [InlineTitle, Switch, DirectLive, DirectTranscript],
  templateUrl: './direct-recording.html',
  styleUrl: './direct-recording.scss',
})
export class DirectRecording {
  /** Le titre de la session, tel que l'en-tête l'affiche. */
  readonly title = input.required<string>();
  /** « Microsoft Teams · + mon micro » — ce qui est capté, composé par la coquille. */
  readonly meta = input.required<string>();
  /** Depuis combien de temps la session enregistre. */
  readonly elapsedSeconds = input.required<number>();
  /** L'énergie RMS combinée des deux flux, de 0 à 1 — ce que le VU-mètre affiche. */
  readonly level = input.required<number>();
  /** L'arrêt est-il en vol ? Le bouton refuse alors un second clic. */
  readonly stopping = input(false);
  /** Les segments acquis, dans leur ordre d'arrivée. */
  readonly lines = input.required<readonly LiveLine[]>();
  /** Ce qui est en train d'être dit, par flux. */
  readonly pending = input.required<PendingSpeech>();
  /** La traduction de chaque segment acquis, par identifiant. Vide sans traduction. */
  readonly translations = input<Readonly<Record<number, string>>>({});
  /** La langue parlée de cette session. */
  readonly sourceLanguage = input<Language | null>(null);
  /** La langue de suivi, `null` quand la session n'en a pas demandé. */
  readonly targetLanguage = input<Language | null>(null);

  /** L'utilisateur demande l'arrêt de la session. */
  readonly stop = output<void>();
  /** L'utilisateur vient de donner un nouveau titre à la session. */
  readonly renamed = output<string>();

  /**
   * La colonne d'original est-elle ouverte ? Un état de vue, qui vit donc dans la vue.
   *
   * @remarks
   * ⚠️ Ce n'est pas un réglage : le persister ferait rouvrir la colonne sur la session suivante,
   * dans une autre langue et sans qu'on l'ait demandé.
   */
  protected readonly showOriginal = signal(false);

  /** Cette session est-elle suivie dans une autre langue ? Sinon, pas d'interrupteur. */
  protected readonly translated = computed(() => this.targetLanguage() !== null);

  protected readonly renameLabel = SESSION_RENAME_LABEL;
  protected readonly fieldLabel = SESSION_TITLE_FIELD_LABEL;
}
