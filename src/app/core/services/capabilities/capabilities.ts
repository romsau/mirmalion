import { Service, inject } from '@angular/core';
import type { Capability, SystemCapabilities } from '../bridge/system/system.bridge';
import { SystemBridge } from '../bridge/system/system.bridge';

/**
 * Interroge le backend sur les briques natives disponibles.
 *
 * Seul point du domaine qui connaisse {@link Tauri} : le magasin, lui, ignore qu'un backend
 * existe. Les capacités ne changent pas pendant une session — rien à rafraîchir, rien à
 * invalider.
 */
@Service()
export class Capabilities {
  private readonly system = inject(SystemBridge);

  /**
   * Lit les capacités de la machine. Une seule fois, au démarrage.
   *
   * @returns `null` hors contexte Tauri (navigateur).
   * @throws un `AppError` typé si le backend échoue.
   */
  async load(): Promise<SystemCapabilities | null> {
    return this.system.getSystemCapabilities();
  }
}

/**
 * Vrai si la brique est utilisable tout de suite.
 *
 * @remarks
 * ⚠️ `needsDownload` rend faux : présente mais sans son modèle, une brique ne rend aucun
 * service. Cet état appelle une proposition de téléchargement, jamais une tentative d'usage.
 */
export function isUsable(capability: Capability | undefined): boolean {
  return capability?.status === 'ready';
}
