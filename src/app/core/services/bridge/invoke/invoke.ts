/**
 * Le cœur du pont : appeler une commande du backend, s'abonner à un évènement, savoir dans
 * quelle fenêtre on s'exécute.
 *
 * Les huit bridges de domaine l'injectent et n'en connaissent rien d'autre. C'est le seul
 * endroit qui importe `@tauri-apps/api`, et le seul qui sache que l'application peut tourner
 * hors de Tauri.
 */

import { Service } from '@angular/core';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { toAppError, type AppError } from '../../../models/app-error';

/**
 * L'étiquette de la fenêtre principale. Miroir de `MAIN_WINDOW` (`src-tauri/src/lifecycle.rs`).
 *
 * @remarks
 * ⚠️ Elle sert à savoir qui doit agir : l'application Angular est montée dans chaque fenêtre
 * ouverte, et un évènement diffusé les atteint toutes. Un effet global — jouer un son, par
 * exemple — doit se limiter à une seule.
 */
export const MAIN_WINDOW = 'main';

/**
 * Le passage vers le backend Rust.
 *
 * Hors contexte Tauri (`npm run start:web`), tout appel renvoie `null` et tout abonnement est
 * muet : le frontend reste utilisable dans un navigateur. Dans l'app, un échec rejette toujours
 * avec un {@link AppError} typé — jamais une chaîne opaque.
 */
@Service()
export class Invoke {
  /** Sommes-nous dans l'application, ou dans un simple navigateur ? */
  isTauri(): boolean {
    return '__TAURI_INTERNALS__' in window;
  }

  /**
   * Appelle une commande Tauri.
   *
   * @returns le résultat de la commande, ou `null` hors contexte Tauri.
   * @throws {AppError} normalisé, quelle que soit la forme du rejet d'origine.
   */
  async call<T>(command: string, args?: InvokeArgs): Promise<T | null> {
    if (!this.isTauri()) {
      return null;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      throw toAppError(error);
    }
  }

  /**
   * S'abonne à un évènement du backend. Rend la fonction de désabonnement.
   *
   * Hors contexte Tauri, l'abonnement n'existe pas et le désabonnement ne fait rien : le
   * frontend reste utilisable dans un navigateur, simplement muet.
   */
  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!this.isTauri()) {
      return () => undefined;
    }
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, ({ payload }) => handler(payload));
  }

  /**
   * L'étiquette de la fenêtre qui exécute ce code — `main`, `overlay`, `onboarding`.
   *
   * Rend `null` hors contexte Tauri. Ne passe par aucune commande : l'étiquette est posée dans
   * la page par le runtime, sa lecture ne coûte rien et n'exige aucune permission.
   */
  async windowLabel(): Promise<string | null> {
    if (!this.isTauri()) {
      return null;
    }
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label;
  }
}
