import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { elapsedSecondsSince } from './live';
import { TICK_INTERVAL_MS } from '../../models/timing';

/** Un chrono de session : les secondes écoulées, et de quoi le mettre en route ou le couper. */
export interface LiveClock {
  /** Les secondes écoulées depuis l'instant de départ. `0` chrono coupé. */
  readonly elapsedSeconds: Signal<number>;
  /** Met en route, ou remet en route. Idempotent. */
  start(): void;
  /** Coupe et remet à zéro. Sans effet s'il ne tourne pas. */
  stop(): void;
}

/**
 * Le chrono que partagent l'écran Direct et la fenêtre-session. À appeler depuis un contexte
 * d'injection : l'intervalle se coupe avec le composant.
 *
 * @param startedAtMs - L'instant de départ retenu par le magasin, ou `null` hors session.
 *
 * @remarks
 * ⚠️ Il ne compte pas, il relit : la durée se recalcule depuis l'instant de départ, si bien qu'un
 * intervalle en retard ne décale rien et qu'un retour en pleine session tombe juste.
 */
export function liveClock(startedAtMs: () => number | null): LiveClock {
  const elapsedSeconds = signal(0);
  let ticker: ReturnType<typeof setInterval> | null = null;

  const read = (): void => {
    elapsedSeconds.set(elapsedSecondsSince(startedAtMs(), Date.now()));
  };

  const stop = (): void => {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    elapsedSeconds.set(0);
  };

  inject(DestroyRef).onDestroy(stop);

  return {
    elapsedSeconds: elapsedSeconds.asReadonly(),
    start(): void {
      // ⚠️ On coupe d'abord : l'effet qui appelle peut se rejouer, et deux intervalles pour un
      // même écran feraient deux relectures par seconde.
      stop();
      read();
      ticker = setInterval(read, TICK_INTERVAL_MS);
    },
    stop,
  };
}
