import { Component, computed, effect, input, output, signal } from '@angular/core';
import { PercentPipe } from '@angular/common';
import { Button } from '../button/button';

/** 2,5 s : en deçà, le bouton clignoterait sur des opérations trop courtes pour être annulées. */
export const CANCEL_DELAY = 2500;

/**
 * Le bloc de progression unique : libellé, barre, pourcentage, et « Annuler ».
 *
 * Ni titre, ni fond, ni bordure propres, et la largeur vient du conteneur : c'est ce qui lui
 * permet d'entrer aussi bien dans un écran plein que dans une modale ou un voile. Il
 * n'interrompt rien — {@link ProgressBar.cancelled} signale l'intention, l'appelant arrête.
 *
 * @remarks
 * ⚠️ Jamais de temps restant : la vitesse d'un traitement local dépend du matériel, une
 * estimation serait fausse et, pire, tenue pour vraie.
 */
@Component({
  selector: 'app-progress-bar',
  imports: [Button, PercentPipe],
  templateUrl: './progress-bar.html',
  styleUrl: './progress-bar.scss',
})
export class ProgressBar {
  /** Ce que l'opération en cours annonce. */
  readonly label = input.required<string>();

  /** `0` à `100`, ou `null` pour une durée inconnue — la barre passe alors en indéterminé. */
  readonly progress = input<number | null>(null);

  /** Une précision optionnelle sous la barre, par exemple « 1,6 Go sur 4,3 Go ». */
  readonly detail = input<string>();

  /** Le bouton d'arrêt peut apparaître. */
  readonly cancellable = input(true);

  /**
   * Le délai avant que « Annuler » apparaisse.
   *
   * @remarks
   * ⚠️ `0` pour un téléchargement de modèle : plusieurs gigaoctets ne sont jamais une opération
   * courte, et faire attendre 2,5 s avant d'offrir la sortie n'a aucun sens. Ailleurs, le délai
   * évite un bouton qui clignote sur les traitements brefs.
   */
  readonly cancelDelay = input(CANCEL_DELAY);

  /** L'utilisateur demande l'arrêt. Le composant, lui, ne fait rien de plus. */
  readonly cancelled = output<void>();

  /** La barre est-elle indéterminée ? */
  protected readonly indeterminate = computed(() => this.progress() === null);

  /** Le remplissage, de 0 à 1. ⚠️ Borné : hors bornes, la progression déborderait la barre. */
  protected readonly ratio = computed(() => Math.min(100, Math.max(0, this.progress() ?? 0)) / 100);

  /** Le bouton d'arrêt a-t-il passé son délai ? */
  protected readonly cancelVisible = signal(false);

  /** Fait paraître « Annuler » passé {@link ProgressBar.cancelDelay}, et le retire sinon. */
  constructor() {
    effect((onCleanup) => {
      if (!this.cancellable()) {
        this.cancelVisible.set(false);
        return;
      }
      const delay = this.cancelDelay();
      if (delay <= 0) {
        this.cancelVisible.set(true);
        return;
      }
      this.cancelVisible.set(false);
      const timer = setTimeout(() => {
        this.cancelVisible.set(true);
      }, delay);
      onCleanup(() => {
        clearTimeout(timer);
      });
    });
  }
}
