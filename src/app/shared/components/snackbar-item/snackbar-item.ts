import { Component, effect, input, output, signal } from '@angular/core';
import { Icon } from '../icon/icon';
import type { IconName } from '../icon/icons';

/**
 * Le ton de la notification.
 *
 * `error` d'abord, parce que c'est le premier usage : toute erreur de l'application passe par
 * là, il n'y a ni page d'erreur dédiée, ni message ad hoc.
 */
export type SnackbarTone = 'error' | 'info' | 'success';

/** ~6 s : le temps de lire une phrase, pas celui de s'en agacer. */
export const SNACKBAR_DURATION = 6000;

const ICONS: Readonly<Record<SnackbarTone, IconName | null>> = {
  error: 'alert-triangle',
  success: 'check',
  info: null,
};

/**
 * La notification transitoire de l'application — il n'y en a pas d'autre.
 *
 * Toute la barre est cliquable, sans croix : c'est un `<button>`, donc focalisable et
 * actionnable à Entrée. Elle disparaît d'elle-même après ~6 s, en pause tant que la souris ou
 * le focus reste dessus, et le compte à rebours repart de zéro à la sortie.
 *
 * @remarks
 * ⚠️ Le focus suspend le délai autant que la souris : sans cela, un utilisateur au clavier n'a
 * aucun moyen de retenir le compte à rebours pour lire un message long.
 */
@Component({
  selector: 'app-snackbar-item',
  imports: [Icon],
  templateUrl: './snackbar-item.html',
  styleUrl: './snackbar-item.scss',
  host: {
    '[class]': '"tone-" + tone()',
  },
})
export class SnackbarItem {
  /** Ce que la notification dit. */
  readonly message = input.required<string>();

  /** Le ton, qui décide de la couleur et de l'icône. */
  readonly tone = input<SnackbarTone>('info');

  /**
   * Le délai avant disparition. Paramétrable pour les tests, pas pour les appelants : une
   * notification qui dure plus qu'une autre est une notification qu'on n'a pas su écrire.
   */
  readonly duration = input(SNACKBAR_DURATION);

  /** Émis à la disparition, quelle qu'en soit la cause — clic, clavier, ou fin du délai. */
  readonly dismissed = output<void>();

  /** L'icône du ton courant, `null` pour `info`. */
  protected readonly icon = signal<IconName | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Suit le ton et le message : chaque nouveau message relance le compte à rebours. */
  constructor() {
    effect(() => {
      this.icon.set(ICONS[this.tone()]);
      // ⚠️ Lu pour la dépendance : c'est le message affiché qui doit durer 6 s, pas le
      // composant, qui est réutilisé d'un message à l'autre.
      this.message();
      this.resume();
    });
  }

  /** Suspend le compte à rebours : le survol et le focus l'appellent tous les deux. */
  protected pause(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Relance le compte à rebours depuis zéro. */
  protected resume(): void {
    this.pause();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dismissed.emit();
    }, this.duration());
  }

  /** Referme la notification sur demande de l'utilisateur. */
  protected dismiss(): void {
    this.pause();
    this.dismissed.emit();
  }
}
