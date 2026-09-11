import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Update, type AvailableUpdate } from '../../services/update/update';
import { toAppError } from '../../models/app-error';
import type { UpdateState } from '../../../shared/components/update-modal/update-modal';

/**
 * Où en est la mise à jour, du point de vue de l'application.
 *
 * `UpdateState` vient du composant plutôt que d'être redéfini ici : deux vérités pour trois mots
 * finiraient par diverger.
 *
 * @remarks
 * ⚠️ `idle` n'existe pas dans la barre : celle-ci ne dessine que ce qu'elle a à proposer, et
 * « rien à proposer » est son absence, pas une de ses variantes. Le magasin, lui, en part et y
 * revient, donc il doit le nommer.
 */
export type UpdatePhase = 'idle' | UpdateState;

/** Ce que la barre de mise à jour a besoin de savoir. */
interface UpdateStoreState {
  /** L'étape courante, `idle` quand il n'y a rien à proposer. */
  readonly phase: UpdatePhase;
  /** La version proposée. Vide hors des trois états visibles. */
  readonly version: string;
  /** L'avancement du téléchargement, de 0 à 1. */
  readonly percent: number;
  /**
   * Le message d'un échec demandé par l'utilisateur, à afficher une fois puis à oublier.
   *
   * @remarks
   * ⚠️ Un contrôle qui échoue ne le remplit pas : sur une application dont l'argument est de
   * marcher sans réseau, annoncer « impossible de vérifier les mises à jour » à chaque lancement
   * hors ligne reprocherait à l'utilisateur ce que le produit lui promet. Seuls le téléchargement
   * et l'installation parlent — ceux-là, il les a demandés.
   */
  readonly error: string | null;
}

/**
 * Le temps minimum entre deux questions au serveur.
 *
 * @remarks
 * ⚠️ C'est ce délai qui tient le seul appel réseau récurrent de l'application, et il est
 * volontairement large : la coquille bat toutes les cinq minutes, sans lui elle demanderait
 * deux cent quatre-vingt-huit fois par jour.
 */
const BETWEEN_CHECKS_MS = 6 * 60 * 60 * 1000;

/**
 * Le temps pendant lequel une version refusée n'est plus proposée.
 *
 * @remarks
 * ⚠️ Il porte sur UNE version, pas sur les mises à jour : celle qui sortira après continuera
 * d'être proposée aussitôt. Refuser une version n'est pas refuser la suivante.
 */
const POSTPONED_FOR_MS = 24 * 60 * 60 * 1000;

const initialState: UpdateStoreState = {
  phase: 'idle',
  version: '',
  percent: 0,
  error: null,
};

/**
 * L'état de la mise à jour de l'application.
 *
 * Il ne connaît ni le plugin, ni le réseau, ni le manifeste : {@link Update} parle au backend,
 * le magasin tient l'état.
 *
 * @remarks
 * ⚠️ À n'injecter que depuis la fenêtre principale : chaque fenêtre porte sa propre instance
 * d'Angular, donc son propre magasin, et le brancher ailleurs ferait autant de contrôles réseau
 * et de barres que de fenêtres ouvertes. `capabilities/updates.json` verrouille la même règle
 * côté Rust, en n'accordant les permissions qu'à la fenêtre « main ».
 */
export const UpdateStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ phase }) => ({
    /**
     * L'état à donner à la barre, ou `null` quand il n'y a rien à montrer.
     *
     * Le gabarit s'en sert en `@if (banner(); as state)` : sans lui, il faudrait comparer à
     * `'idle'` puis convaincre le typeur que les trois autres cas restent.
     */
    banner: computed<UpdateState | null>(() =>
      phase() === 'idle' ? null : (phase() as UpdateState),
    ),
  })),
  withMethods((store, service = inject(Update)) => {
    /**
     * La mise à jour trouvée, tenue hors des signaux.
     *
     * @remarks
     * ⚠️ Ce n'est pas de l'état d'interface : rien ne l'affiche, et elle porte des fonctions. La
     * ranger dans `withState` la rendrait observable pour rien et obligerait à la comparer.
     */
    let pending: AvailableUpdate | null = null;

    /**
     * L'utilisateur a-t-il renoncé pendant le téléchargement ?
     *
     * @remarks
     * ⚠️ Le téléchargement ne s'interrompt pas (voir `AvailableUpdate.download`) : ce drapeau ne
     * coupe pas les octets, il empêche l'installation qui aurait suivi. C'est tout ce qu'« Annuler »
     * peut vouloir dire honnêtement ici.
     */
    let cancelled = false;

    /**
     * L'heure du dernier contrôle, `null` tant qu'il n'y en a pas eu.
     *
     * @remarks
     * ⚠️ Hors des signaux, comme `pending` : rien ne l'affiche. ⚠️ C'est l'HORLOGE qui est lue, et
     * non un minuteur qui compterait — un Mac qui dort et une fenêtre cachée étirent les minuteurs
     * sans prévenir, et un réveil au bout de huit heures doit redemander au premier battement.
     */
    let lastCheckAt: number | null = null;

    /** La version que l'utilisateur a repoussée, et l'heure jusqu'à laquelle on se tait. */
    let postponedVersion: string | null = null;
    let postponedUntil = 0;

    /** Renonce : plus rien d'affiché, et la ressource du backend est rendue. */
    async function discard(): Promise<void> {
      const found = pending;
      pending = null;
      patchState(store, { phase: 'idle', version: '', percent: 0 });
      if (found !== null) {
        // Un `dispose` en échec ne laisse rien à réparer côté utilisateur, et il n'a rien
        // demandé : le signaler ferait du bruit pour une ressource qu'il ne voit pas.
        await found.dispose().catch(() => undefined);
      }
    }

    return {
      /**
       * Demande au serveur s'il y a mieux. Silencieux en cas d'échec — voir `error`.
       *
       * Idempotent : un second appel pendant qu'une mise à jour est déjà proposée ne relance rien.
       */
      async check(): Promise<void> {
        if (pending !== null || store.phase() !== 'idle') {
          return;
        }
        const now = Date.now();
        if (lastCheckAt !== null && now - lastCheckAt < BETWEEN_CHECKS_MS) {
          return;
        }
        // ⚠️ Posée AVANT l'appel, et pas après : un contrôle qui traîne ou qui échoue ne doit pas
        // laisser le battement suivant en relancer un second par-dessus.
        lastCheckAt = now;
        try {
          const found = await service.check();
          if (found === null) {
            return;
          }
          // ⚠️ La ressource est rendue avant de se taire : la garder ouverte la ferait fuir à
          // chaque contrôle silencieux, soit toutes les six heures pendant une journée.
          if (found.version === postponedVersion && now < postponedUntil) {
            await found.dispose().catch(() => undefined);
            return;
          }
          pending = found;
          patchState(store, { phase: 'available', version: found.version });
        } catch {
          // Hors ligne, serveur muet, manifeste illisible : rien à dire à l'utilisateur.
        }
      },

      /** Télécharge, sans installer. Mène à `ready`, où l'utilisateur décide de redémarrer. */
      async install(): Promise<void> {
        const found = pending;
        if (found === null || store.phase() !== 'available') {
          return;
        }
        cancelled = false;
        patchState(store, { phase: 'downloading', percent: 0 });
        try {
          await found.download((ratio) => {
            if (!cancelled) {
              patchState(store, { percent: ratio });
            }
          });
          if (cancelled) {
            return;
          }
          patchState(store, { phase: 'ready' });
        } catch (error) {
          patchState(store, { error: toAppError(error).message });
          await discard();
        }
      },

      /** Remplace le bundle, puis redémarre. En cas d'échec, on retombe à zéro en le disant. */
      async restart(): Promise<void> {
        const found = pending;
        if (found === null || store.phase() !== 'ready') {
          return;
        }
        try {
          await found.install();
          await service.relaunch();
        } catch (error) {
          patchState(store, { error: toAppError(error).message });
          await discard();
        }
      },

      /**
       * Renonce à la mise à jour : « Plus tard » et « Annuler » sont le même geste.
       *
       * Avant le téléchargement, pendant, ou une fois prêt, l'effet est le même : ne rien
       * installer et ne plus rien afficher.
       *
       * @remarks
       * ⚠️ La version refusée est retenue, et c'est ce qui rend le contrôle périodique
       * supportable : sans elle, la barre reviendrait toutes les six heures proposer ce que
       * l'utilisateur vient d'écarter.
       */
      async dismiss(): Promise<void> {
        cancelled = true;
        if (pending !== null) {
          postponedVersion = pending.version;
          postponedUntil = Date.now() + POSTPONED_FOR_MS;
        }
        await discard();
      },

      /** L'hôte a montré l'erreur. Elle ne doit pas être montrée deux fois. */
      clearError(): void {
        patchState(store, { error: null });
      },
    };
  }),
);
