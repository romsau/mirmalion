/**
 * La pilule flottante : son état, sa taille, son effacement.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';

/**
 * Les six états que traverse un enregistrement.
 *
 * @remarks
 * ⚠️ Il n'y a pas d'état « Reformulation » : « Préparation » couvre le nettoyage et la
 * reformulation — deux passes du même LLM, indiscernables pour qui attend.
 *
 * Miroir d'`OverlayState` (`src-tauri/src/commands/overlay.rs`).
 */
export type OverlayState =
  | 'listening'
  | 'preparing'
  | 'translating'
  | 'done'
  | 'error'
  /**
   * ⌃⌥ pressé pendant une session, où la dictée est coupée.
   *
   * @remarks
   * ⚠️ Fugace, et session uniquement : il interrompt la pilule ~2 s puis rend la main au
   * chrono. Le backend s'en charge seul — le frontend ne fait que l'afficher.
   */
  | 'suspended';

/** Ce que la pilule flottante doit afficher. */
export interface OverlayPayload {
  readonly state: OverlayState;
  /**
   * Faut-il afficher le chrono ?
   *
   * @remarks
   * ⚠️ C'est la seule différence entre dictée et session : en session « Écoute » dure la
   * séance, en dictée quelques secondes.
   */
  readonly chrono: boolean;
}

/** Le nom de l'évènement Tauri qui porte les changements d'état de l'overlay. */
export const OVERLAY_EVENT = 'overlay-state';

/** La pilule flottante : son état, sa taille, son effacement. */
@Service()
export class OverlayBridge {
  private readonly core = inject(Invoke);

  /**
   * Affiche l'overlay, ou met à jour ce qu'il affiche. Idempotent.
   *
   * La fenêtre est créée au premier appel. `chrono` distingue la session de la dictée : lui
   * seul change entre les deux modes.
   */
  async showOverlay(state: OverlayState, chrono: boolean): Promise<void> {
    await this.core.call<null>('show_overlay', { state, chrono });
  }

  /** Retire l'overlay. Sans effet s'il n'y en a pas. */
  async hideOverlay(): Promise<void> {
    await this.core.call<null>('hide_overlay');
  }

  /**
   * Ce que l'overlay doit afficher maintenant, ou `null` si rien n'est en cours.
   *
   * @remarks
   * ⚠️ À lire au démarrage de la fenêtre flottante : son webview met quelques dizaines de
   * millisecondes à monter, et un évènement émis pendant ce temps n'a personne pour l'entendre.
   */
  async getOverlayState(): Promise<OverlayPayload | null> {
    return this.core.call<OverlayPayload | null>('get_overlay_state');
  }

  /**
   * Taille la fenêtre de l'overlay sur la pilule qu'elle contient.
   *
   * @remarks
   * ⚠️ La fenêtre est la pilule : pas de transparence, qui exigerait des API privées d'Apple.
   * Sa largeur suit donc le texte, que seul le webview peut mesurer. Le backend borne ce qu'on
   * lui envoie — il ne fait pas confiance à cette mesure.
   */
  async resizeOverlay(width: number, height: number): Promise<void> {
    await this.core.call<null>('resize_overlay', { width, height });
  }
}
