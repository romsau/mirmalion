import { Service, inject } from '@angular/core';
import type { Update as PluginUpdate } from '@tauri-apps/plugin-updater';
import { Invoke } from '../bridge/invoke/invoke';

/**
 * Une mise à jour trouvée sur le serveur, réduite à ce dont le magasin a besoin.
 *
 * @remarks
 * - ⚠️ Télécharger et installer restent deux gestes : « Mise à jour prête à être installée » est
 *   un état du produit, et le `downloadAndInstall` d'un bloc laisserait « Annuler » remplacer le
 *   bundle dans le dos de l'utilisateur. `capabilities/updates.json` refuse sa permission.
 * - ⚠️ Aucun type du plugin ne franchit cette frontière : le magasin ne sait pas qu'un plugin
 *   existe, comme il ne sait pas qu'un backend existe.
 */
export interface AvailableUpdate {
  /** La version proposée, telle qu'elle s'écrit — « 0.9.1 ». */
  readonly version: string;

  /**
   * Télécharge la mise à jour sans rien installer, en rapportant l'avancement de 0 à 1.
   *
   * @remarks
   * ⚠️ Le téléchargement ne s'interrompt pas, le plugin n'offrant aucune annulation : le
   * « Annuler » du produit veut dire « ne pas installer », pas « arrêter les octets ».
   */
  download(onProgress: (ratio: number) => void): Promise<void>;

  /** Remplace le bundle par ce qui a été téléchargé. Le redémarrage suit, à part. */
  install(): Promise<void>;

  /** Libère la ressource côté Rust. À appeler dès qu'on renonce. */
  dispose(): Promise<void>;
}

/**
 * Rapporte l'avancement d'un téléchargement, de 0 à 1.
 *
 * @remarks
 * ⚠️ Rien n'est rapporté tant que la taille totale est inconnue, et la barre reste à zéro : un
 * ratio calculé sur un total nul vaudrait `Infinity` ou `NaN`. Le cas est défensif — notre
 * hébergement renvoie toujours un `Content-Length`.
 */
async function downloadReporting(
  update: PluginUpdate,
  onProgress: (ratio: number) => void,
): Promise<void> {
  let total = 0;
  let received = 0;
  await update.download((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
      if (total > 0) {
        onProgress(received / total);
      }
    } else {
      onProgress(1);
    }
  });
}

/**
 * Le seul endroit du frontend qui connaisse le plugin de mise à jour.
 *
 * Hors contexte Tauri, tout rend `null` ou ne fait rien : `npm run start:web` doit rester
 * utilisable, comme pour le reste du pont.
 *
 * @remarks
 * ⚠️ Le contrôle est un `GET` sur un fichier statique et n'envoie rien — ni identifiant, ni
 * version installée, ni compteur. La comparaison se fait ici, après lecture du manifeste : c'est
 * ce qui permet à ce service d'exister dans une application dont rien ne sort.
 */
@Service()
export class Update {
  private readonly core = inject(Invoke);

  /**
   * Demande au serveur s'il y a mieux que la version installée.
   *
   * @returns `null` quand l'application est à jour, ou hors contexte Tauri.
   * @throws quand le serveur est injoignable ou le manifeste illisible. L'appelant décide d'en
   *   parler ou non, et ne doit pas en parler au démarrage : sans réseau, une application hors
   *   ligne par construction n'a rien à signaler.
   */
  async check(): Promise<AvailableUpdate | null> {
    if (!this.core.isTauri()) {
      return null;
    }
    const { check } = await import('@tauri-apps/plugin-updater');
    const found = await check();
    if (found === null) {
      return null;
    }
    return {
      version: found.version,
      download: (onProgress) => downloadReporting(found, onProgress),
      install: () => found.install(),
      dispose: () => found.close(),
    };
  }

  /**
   * Redémarre l'application sur la version installée.
   *
   * @remarks
   * ⚠️ `process`, et non une fenêtre qu'on rouvrirait : le bundle vient d'être remplacé sur le
   * disque, mais le processus en cours exécute toujours l'ancien code, chargé en mémoire.
   */
  async relaunch(): Promise<void> {
    if (!this.core.isTauri()) {
      return;
    }
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }
}
