/**
 * Les quatre autorisations macOS, et les trois qui se demandent.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';

/**
 * L'état d'une autorisation macOS (TCC).
 *
 * @remarks
 * ⚠️ `unknown` n'est pas du remplissage : macOS ne permet pas de connaître l'état sans
 * déclencher l'opération elle-même, cas de l'enregistrement audio. L'afficher « refusé »
 * accuserait l'utilisateur ; « à autoriser » promettrait un pop-up qui ne viendra pas.
 *
 * Miroir de `PermissionStatus` (`src-tauri/src/commands/permissions.rs`).
 */
export type PermissionStatus = 'granted' | 'denied' | 'notDetermined' | 'unknown';

/** L'état d'une autorisation, et de quoi l'expliquer. */
export interface Permission {
  readonly status: PermissionStatus;
  /** De quoi expliquer la situation à l'utilisateur. `null` quand il n'y a rien à dire. */
  readonly detail: string | null;
}

/**
 * Les quatre autorisations dont l'application dépend.
 *
 * @remarks
 * ⚠️ `audioCapture` n'est pas l'enregistrement de l'écran : c'est une catégorie TCC distincte,
 * et Mirmalion ne demande jamais l'accès à l'écran. Écrire « écran » dans un texte qui la
 * concerne enverrait l'utilisateur dans le mauvais volet des Réglages Système.
 */
export interface PermissionsStatus {
  /** Capter la voix pour la dictée. */
  readonly microphone: Permission;
  /**
   * Détecter le raccourci global.
   *
   * @remarks
   * ⚠️ Attachée à la signature de code : une mise à jour peut la faire réapparaître comme non
   * accordée alors qu'elle l'avait été.
   */
  readonly accessibility: Permission;
  /** Piloter System Events — voie éprouvée du collage au curseur. Hors onboarding. */
  readonly automation: Permission;
  /** Capter l'audio des sessions. */
  readonly audioCapture: Permission;
}

/** Les quatre autorisations macOS, et les trois qui se demandent. */
@Service()
export class PermissionsBridge {
  private readonly core = inject(Invoke);

  /**
   * L'état des quatre autorisations macOS. Ne déclenche aucun pop-up système.
   *
   * À rappeler à chaque « Revérifier » : l'Accessibilité et l'enregistrement audio s'accordent
   * hors de l'application, donc un état lu au démarrage est faux dès que l'utilisateur bascule
   * un interrupteur dans les Réglages Système.
   */
  async getPermissionsStatus(): Promise<PermissionsStatus | null> {
    return this.core.call<PermissionsStatus>('get_permissions_status');
  }

  /**
   * Demande l'accès au micro et renvoie l'état obtenu.
   *
   * La promesse ne se résout qu'après la réponse de l'utilisateur, sans délai maximal :
   * l'appelant doit prévoir un état d'attente.
   *
   * @remarks
   * ⚠️ N'appeler qu'au clic explicite de l'utilisateur : c'est le seul appel du pont qui fait
   * surgir un pop-up macOS.
   */
  async requestMicrophone(): Promise<Permission | null> {
    return this.core.call<Permission>('request_microphone');
  }

  /**
   * Demande l'enregistrement audio et renvoie l'état obtenu. Une fois le choix fait, macOS ne
   * réaffiche rien : rappeler cette méthode rend le verdict sans importuner personne.
   *
   * @remarks
   * ⚠️ N'appeler qu'au clic explicite de l'utilisateur : cette catégorie TCC n'a aucune API de
   * préflight, la seule façon de la demander est de créer un tap audio. Le tap est détruit
   * immédiatement et ne capte rien.
   */
  async requestAudioCapture(): Promise<Permission | null> {
    return this.core.call<Permission>('request_audio_capture');
  }

  /**
   * Demande l'Accessibilité : inscrit l'application dans la liste, puis ouvre le volet. L'état
   * renvoyé est celui d'avant que l'utilisateur ne coche.
   *
   * @remarks
   * ⚠️ L'inscription est le point important, pas l'ouverture du volet : sans elle, l'utilisateur
   * ne trouve aucune ligne au nom de Mirmalion dans Réglages Système ▸ Confidentialité et
   * sécurité ▸ Accessibilité — rien à cocher, donc rien à constater.
   */
  async requestAccessibility(): Promise<Permission | null> {
    return this.core.call<Permission>('request_accessibility');
  }
}
