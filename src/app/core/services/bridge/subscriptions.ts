import { DestroyRef, inject } from '@angular/core';

/**
 * Les abonnements d'une fenêtre aux évènements du backend, et leur libération.
 *
 * ⚠️ S'abonner passe par une promesse : entre l'appel et son aboutissement, la fenêtre peut avoir
 * été détruite. Retenir soi-même les désabonnements dans un tableau ne suffit donc pas — il faut
 * aussi rattraper ceux qui arrivent trop tard, ce que {@link Subscriptions.keep} fait.
 */
export interface Subscriptions {
  /**
   * La fenêtre vit-elle encore ? À consulter avant de reprendre un travail après une attente.
   */
  alive(): boolean;

  /**
   * Retient le désabonnement d'un abonnement en vol, ou l'exécute aussitôt si la fenêtre est déjà
   * morte.
   *
   * @remarks
   * ⚠️ Ne rattrape aucun échec : un abonnement qui ne se pose pas prive du direct et se dit à
   * l'utilisateur, ce que seul l'appelant sait formuler.
   */
  keep(pending: Promise<() => void>): Promise<void>;
}

/**
 * Ouvre le suivi des abonnements de la fenêtre courante. À appeler dans un contexte d'injection ;
 * la destruction libère tout ce qui a été retenu, dans l'ordre où il l'a été.
 */
export function subscriptions(): Subscriptions {
  const stops: (() => void)[] = [];
  let destroyed = false;

  inject(DestroyRef).onDestroy(() => {
    destroyed = true;
    for (const stop of stops) {
      stop();
    }
    stops.length = 0;
  });

  return {
    alive: () => !destroyed,
    async keep(pending: Promise<() => void>): Promise<void> {
      const stop = await pending;
      if (destroyed) {
        stop();
        return;
      }
      stops.push(stop);
    },
  };
}
