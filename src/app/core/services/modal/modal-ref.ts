import { InjectionToken } from '@angular/core';

/**
 * La poignée rendue par `Modal.open()`, et injectée dans le composant monté.
 *
 * C'est le composant monté qui décide quand se fermer et avec quoi : le service ne connaît pas
 * son contenu. Une modale qui n'a rien à rendre se ferme sans résultat ; un éditeur rend sa
 * valeur.
 */
export class ModalRef<Result = void> {
  /**
   * Résolue à la fermeture, avec ce que le composant monté a rendu.
   *
   * @remarks
   * ⚠️ `undefined` veut dire annulé — Échap, clic sur le fond ou bouton de fermeture. Ne pas
   * l'écarter du cas nominal, c'est prendre « il est parti » pour « il a validé ».
   */
  readonly closed: Promise<Result | undefined>;

  private settle!: (result: Result | undefined) => void;
  private done = false;

  constructor(private readonly dispose: () => void) {
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Ferme la modale. Rejouer l'appel ne fait rien : une modale ne se ferme qu'une fois. */
  close(result?: Result): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.dispose();
    this.settle(result);
  }
}

/**
 * Les données passées au composant monté.
 *
 * Un jeton plutôt qu'une entrée : `open()` accepte n'importe quel composant, y compris un
 * composant qui n'a pas été écrit pour être monté en modale.
 */
export const MODAL_DATA = new InjectionToken<unknown>('MODAL_DATA');
