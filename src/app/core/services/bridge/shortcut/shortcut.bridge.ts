/**
 * Le raccourci global ⌃⌥, et ce qu'il insère au curseur.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';
import type { DictationMode } from '../../../models/settings';

/**
 * Ce que le raccourci global demande.
 *
 * @remarks
 * ⚠️ Ce ne sont pas des fronts de touche : en mode bascule, `stop` naît d'un appui, pas d'un
 * relâchement.
 *
 * Miroir de `ShortcutAction` (`src-tauri/src/shortcut/mod.rs`).
 */
export type ShortcutAction = 'start' | 'stop';

/**
 * Le nom de l'évènement Tauri qui porte les actions du raccourci.
 *
 * @remarks
 * ⚠️ Un seul canal pour les deux actions, parce qu'elles sont ordonnées : deux canaux distincts
 * n'offriraient aucune garantie d'ordre entre eux.
 */
export const SHORTCUT_EVENT = 'shortcut';

/**
 * L'état du raccourci global.
 *
 * @remarks
 * ⚠️ `trusted` dit que l'Accessibilité est accordée, `listening` que le tap clavier est en
 * place. Autorisation cochée après le démarrage, tap jamais réinstallé : la case est verte et
 * ⌃⌥ ne répond toujours pas. C'est ce que {@link Tauri.startShortcut} corrige.
 *
 * Miroir de `ShortcutStatus` (`src-tauri/src/commands/shortcut.rs`).
 */
export interface ShortcutStatus {
  readonly listening: boolean;
  readonly trusted: boolean;
  /**
   * La combinaison enfoncée à l'instant de la lecture, `null` s'il n'y en a aucune.
   *
   * @remarks
   * ⚠️ `spoken` est ⌃⌥, `translated` est ⌃⌥⌘ — les deux écritures viennent de `Combo`
   * (`src-tauri/src/shortcut/mod.rs`) et ne se devinent pas.
   */
  readonly combo: 'spoken' | 'translated' | null;
  readonly mode: DictationMode;
  /** Le raccourci répond-il ? Coupé pendant une session. */
  readonly enabled: boolean;
  /** Une dictée est-elle en cours **du point de vue du raccourci** ? */
  readonly recording: boolean;
  /** De quoi expliquer un `listening` faux. `null` quand tout va bien. */
  readonly detail: string | null;
}

/**
 * Ce qu'il est advenu d'une demande d'insertion au curseur.
 *
 * @remarks
 * ⚠️ `noEditableField` n'est pas un échec : personne n'attendait de texte, la dictée part à
 * l'historique, rien n'est collé et le presse-papiers n'a pas été touché.
 *
 * Miroir de `InjectionOutcome` (`src-tauri/src/commands/injection.rs`).
 */
export type InjectionOutcome = 'inserted' | 'noEditableField';

/**
 * Ce que l'application au premier plan dit de son champ focalisé.
 *
 * @remarks
 * ⚠️ `unknown` est le cas le plus fréquent, pas une exception : Chrome — et tout ce qui est
 * bâti sur Chromium — n'expose aucun élément focalisé. L'interface ne doit donc jamais en
 * déduire qu'il n'y a rien où écrire.
 */
export type FocusVerdict = 'editable' | 'notEditable' | 'unknown';

/** Le raccourci global ⌃⌥, et ce qu'il insère au curseur. */
@Service()
export class ShortcutBridge {
  private readonly core = inject(Invoke);

  /**
   * L'état du raccourci global. N'installe rien et ne demande aucune autorisation.
   */
  async getShortcutStatus(): Promise<ShortcutStatus | null> {
    return this.core.call<ShortcutStatus>('get_shortcut_status');
  }

  /**
   * (Re)met le tap clavier à l'écoute. Idempotent.
   *
   * @remarks
   * ⚠️ À appeler dès que l'Accessibilité vient d'être accordée : l'autorisation se coche dans
   * les Réglages Système, hors de l'application, et sans cet appel ⌃⌥ resterait muet jusqu'au
   * prochain lancement alors que la case est verte.
   */
  async startShortcut(): Promise<void> {
    await this.core.call<null>('start_shortcut');
  }

  /** Retire le tap clavier et referme une dictée en cours. Idempotent. */
  async stopShortcut(): Promise<void> {
    await this.core.call<null>('stop_shortcut');
  }

  /**
   * Applique le mode de déclenchement à chaud, sans redémarrage.
   *
   * @remarks
   * ⚠️ Une dictée en cours s'arrête : passer de « maintenir » à « bascule » la touche enfoncée
   * laisserait un enregistrement dont plus aucun geste ne peut sortir.
   */
  async setShortcutMode(mode: DictationMode): Promise<void> {
    await this.core.call<null>('set_shortcut_mode', { mode });
  }

  /**
   * Insère le texte à l'endroit où l'utilisateur travaille, puis lui rend son presse-papiers.
   *
   * @remarks
   * - ⚠️ Prend ~150 ms — le temps laissé à l'application cible pour consommer le collage.
   * - ⚠️ Le presse-papiers est rendu même si le collage échoue : le texte dicté est récupérable
   *   dans l'historique, ce que l'utilisateur avait copié ne l'est pas.
   */
  async insertAtCursor(text: string): Promise<InjectionOutcome | null> {
    return this.core.call<InjectionOutcome>('insert_at_cursor', { text });
  }

  /**
   * Ce que l'application au premier plan dit de son champ focalisé.
   *
   * Ne touche à rien : ni presse-papiers, ni évènement clavier.
   */
  async getFocusVerdict(): Promise<FocusVerdict | null> {
    return this.core.call<FocusVerdict>('get_focus_verdict');
  }
}
