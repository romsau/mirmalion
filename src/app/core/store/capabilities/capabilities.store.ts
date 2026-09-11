import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Capabilities, isUsable } from '../../services/capabilities/capabilities';
import { toAppError, type AppError } from '../../models/app-error';
import type { SystemCapabilities } from '../../services/bridge/system/system.bridge';

/** Ce que la machine sait faire côté briques natives, et où en est sa lecture. */
interface CapabilitiesState {
  readonly capabilities: SystemCapabilities | null;
  readonly error: AppError | null;
  readonly loading: boolean;
}

const initialState: CapabilitiesState = {
  capabilities: null,
  error: null,
  loading: false,
};

/**
 * Ce dont la machine dispose côté briques natives, lu une fois et partagé par toute l'app.
 *
 * @remarks
 * ⚠️ Décider à partir de ces drapeaux, jamais d'`osVersion` : le jour où Apple déplace, retire
 * ou renomme une brique, il n'y a qu'un endroit à corriger au lieu d'autant qu'il y a de
 * conditions dans l'application.
 */
export const CapabilitiesStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ capabilities }) => ({
    /** Le moteur de transcription d'Apple est-il présent et prêt à servir ? */
    canTranscribeNatively: computed(() => isUsable(capabilities()?.speechTranscriber)),
    /** Le LLM local d'Apple est-il présent et prêt à servir ? */
    canSummariseNatively: computed(() => isUsable(capabilities()?.foundationModels)),
    /** La traduction native d'Apple est-elle présente et prête à servir ? */
    canTranslateNatively: computed(() => isUsable(capabilities()?.translation)),
    /**
     * Vrai quand ni la transcription ni le LLM d'Apple ne sont utilisables : la machine doit
     * télécharger ses propres moteurs. Faux tant que les capacités n'ont pas été lues.
     */
    needsDownloadedEngines: computed(() => {
      const current = capabilities();
      return (
        current !== null &&
        !isUsable(current.speechTranscriber) &&
        !isUsable(current.foundationModels)
      );
    }),
  })),
  withMethods((store, service = inject(Capabilities)) => ({
    /** Charge les capacités. Idempotent : un second appel ne relance rien. */
    async load(): Promise<void> {
      if (store.loading() || store.capabilities() !== null) {
        return;
      }
      patchState(store, { loading: true, error: null });
      try {
        patchState(store, { capabilities: await service.load(), loading: false });
      } catch (error) {
        patchState(store, { error: toAppError(error), loading: false });
      }
    },
  })),
);
