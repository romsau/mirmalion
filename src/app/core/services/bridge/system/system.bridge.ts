/**
 * La fenêtre, la machine et les réglages que macOS détient lui-même.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';

/** Le nom, la version et le socle de l'application. */
export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  platform: string;
}

/**
 * L'état d'une brique native.
 *
 * @remarks
 * ⚠️ « Présente » et « utilisable » sont deux choses différentes : un framework peut être là
 * sans que son modèle soit téléchargé.
 *
 * Miroir de `CapabilityStatus` (`src-tauri/src/commands/system.rs`).
 */
export type CapabilityStatus = 'unavailable' | 'needsDownload' | 'ready';

/** L'état d'une brique native, et de quoi l'expliquer. */
export interface Capability {
  readonly status: CapabilityStatus;
  /** De quoi expliquer la situation à l'utilisateur. `null` quand tout va bien. */
  readonly detail: string | null;
}

/**
 * Ce dont la machine dispose.
 *
 * @remarks
 * ⚠️ Le reste de l'app consomme ces drapeaux, jamais `osVersion` : c'est ce qui laisse un seul
 * endroit à corriger le jour où Apple rétroporte, retire ou renomme une brique.
 */
export interface SystemCapabilities {
  readonly osVersion: string;
  readonly architecture: string;
  /** Audio → texte natif. Absent → Whisper prend le relais. */
  readonly speechTranscriber: Capability;
  /** LLM local d'Apple. Absent → LLM MLX prend le relais. */
  readonly foundationModels: Capability;
  /** Framework `Translation`, natif depuis macOS 14.4 : présent sur tout notre socle. */
  readonly translation: Capability;
}

/**
 * L'état de la base chiffrée.
 *
 * @remarks
 * ⚠️ Volontairement pauvre : ni chemin, ni clé, ni accès SQL. Le WebView est traité comme non
 * fiable — les lectures et écritures passent par des commandes de domaine, chacune avec ses
 * arguments validés côté Rust.
 */
export interface DatabaseStatus {
  /** La version du schéma appliquée au fichier. */
  readonly schemaVersion: number;
  /** La version que cette build sait produire. */
  readonly expectedSchemaVersion: number;
}

/** La fenêtre, la machine et les réglages que macOS détient lui-même. */
@Service()
export class SystemBridge {
  private readonly core = inject(Invoke);

  /** Le nom, la version et le socle de l'application. */
  async getAppInfo(): Promise<AppInfo | null> {
    return this.core.call<AppInfo>('get_app_info');
  }

  /** Ce dont la machine dispose côté briques natives. */
  async getSystemCapabilities(): Promise<SystemCapabilities | null> {
    return this.core.call<SystemCapabilities>('get_system_capabilities');
  }

  /** La version du schéma appliquée à la base, et celle que cette build sait produire. */
  async getDatabaseStatus(): Promise<DatabaseStatus | null> {
    return this.core.call<DatabaseStatus>('get_database_status');
  }

  /**
   * Accorde l'apparence native des fenêtres au thème de l'application. S'applique à toutes les
   * fenêtres : le thème est un réglage global.
   *
   * @remarks
   * ⚠️ Peindre le document ne suffit pas : `data-theme="dark"` ne dit rien à macOS, qui continue
   * de dessiner son cadre en clair — un liseré blanc d'un pixel en haut d'une fenêtre sombre.
   * C'est le seul point du thème qui doive traverser le pont.
   */
  async setWindowTheme(dark: boolean): Promise<void> {
    await this.core.call<null>('set_window_theme', { dark });
  }

  /**
   * Passe la fenêtre en disposition étroite (historique replié) ou large.
   *
   * @remarks
   * ⚠️ On envoie un mode, pas une largeur : les deux nombres vivent dans
   * `src-tauri/src/commands/window.rs`, avec la hauteur. Le backend n'a pas à faire confiance à
   * un nombre venu du WebView.
   */
  async setWindowCompact(compact: boolean): Promise<void> {
    await this.core.call<null>('set_window_compact', { compact });
  }

  /**
   * Ramène la fenêtre au premier plan.
   *
   * @remarks
   * ⚠️ À appeler au retour d'un prompt système, et seulement là : l'application n'est pas dans
   * le Dock, et macOS rend alors le premier plan à l'application précédente. Ne pas l'appeler
   * après avoir ouvert les Réglages Système — on y a envoyé l'utilisateur pour qu'il y fasse
   * quelque chose.
   */
  async focusWindow(): Promise<void> {
    await this.core.call<null>('focus_window');
  }

  /**
   * Agrandit la fenêtre à l'écran, ou la ramène à sa taille précédente.
   *
   * @remarks
   * ⚠️ Sans effet sur une fenêtre non redimensionnable, et le backend s'en charge : l'appelant
   * n'a pas à savoir dans quelle fenêtre il tourne. Seules les fenêtres-documents s'agrandissent.
   */
  async toggleWindowZoom(): Promise<void> {
    await this.core.call<null>('toggle_window_zoom');
  }

  /**
   * Termine le premier lancement : la fenêtre principale s'ouvre, celle d'onboarding se ferme.
   *
   * @remarks
   * - ⚠️ N'enregistre rien : le drapeau `onboardingCompleted` s'écrit dans les réglages avant
   *   cet appel, car plus rien de ce webview ne s'exécute une fois la fenêtre fermée.
   * - ⚠️ La promesse ne se résout jamais dans l'app : la réponse du backend part vers un webview
   *   détruit. L'appelant ne doit rien enchaîner derrière.
   */
  async finishOnboarding(): Promise<void> {
    await this.core.call<null>('finish_onboarding');
  }

  /**
   * La langue de l'interface, telle que le backend l'a résolue au démarrage.
   *
   * C'est elle qui a décidé quel bundle localisé la fenêtre a chargé : le frontend la lit
   * plutôt que de la redéduire, sinon les deux finiraient par diverger.
   */
  async getInterfaceLocale(): Promise<string | null> {
    return this.core.call<string>('get_interface_locale');
  }

  /**
   * Change la langue de l'interface maintenant.
   *
   * @remarks
   * - ⚠️ Cet appel détruit l'appelant : la localisation est faite au build, changer de langue
   *   fait charger un autre bundle. La promesse ne se résout jamais dans la fenêtre qui appelle.
   * - ⚠️ Le réglage doit être écrit avant d'appeler : la fenêtre repart de zéro et relit le
   *   fichier. Appeler d'abord perdrait le choix qu'on vient de faire.
   */
  async setInterfaceLanguage(locale: string): Promise<void> {
    await this.core.call<null>('set_interface_language', { locale });
  }

  /**
   * Place l'application dans le Dock, ou l'en retire. Prend effet aussitôt.
   *
   * @remarks
   * ⚠️ N'écrit rien : la persistance passe par le magasin de réglages, comme le reste. Cette
   * commande n'applique que pour la session en cours.
   */
  async setDockVisible(visible: boolean): Promise<void> {
    await this.core.call<null>('set_dock_visible', { visible });
  }

  /**
   * L'application s'ouvre-t-elle à la session ? Lu de macOS, jamais des réglages. Rend `null`
   * hors contexte Tauri — l'interrupteur s'affiche alors éteint.
   *
   * @remarks
   * ⚠️ C'est le seul réglage qui ne soit pas dans le fichier de réglages : il vit dans un élément
   * d'ouverture de session, que l'utilisateur peut retirer depuis Réglages Système sans nous
   * prévenir. L'écrire aussi chez nous donnerait deux vérités pour un booléen.
   */
  async getLaunchAtLogin(): Promise<boolean | null> {
    return this.core.call<boolean>('get_launch_at_login');
  }

  /** Inscrit l'application aux ouvertures de session, ou l'en retire. Prend effet aussitôt. */
  async setLaunchAtLogin(enabled: boolean): Promise<void> {
    await this.core.call<null>('set_launch_at_login', { enabled });
  }

  /**
   * Intercepte toutes les demandes de fermeture de la fenêtre courante. Rend le désabonnement.
   *
   * @remarks
   * - ⚠️ Seule voie qui les attrape toutes : la pastille rouge, ⌘W et le menu Fichier ▸ Fermer
   *   produisent le même `CloseRequested`, et le backend ne pose aucun `prevent_close` sur une
   *   fenêtre-document (`lifecycle.rs`).
   * - ⚠️ La fermeture est empêchée à chaque fois : c'est la commande de fermeture du domaine qui
   *   ferme la fenêtre, après avoir libéré le document — sinon il fuit côté Rust.
   */
  async onCloseRequested(handler: () => void): Promise<() => void> {
    if (!this.core.isTauri()) {
      return () => undefined;
    }
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      handler();
    });
  }
}
