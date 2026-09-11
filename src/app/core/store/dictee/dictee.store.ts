import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { Dictation } from '../../services/dictation/dictation';
import { SettingsStore } from '../settings/settings.store';
import { toAppError, type AppError } from '../../models/app-error';
import type { DictationMode } from '../../models/settings';
import type { InputDevice } from '../../services/bridge/dictation/dictation.bridge';

/**
 * Ce que l'écran Dictée sait de la machine — les faits, jamais les réglages.
 *
 * @remarks
 * ⚠️ La frontière avec {@link SettingsStore} est portante : ici les faits, quels micros
 * existent ; là-bas les choix de l'utilisateur. Un fait ne se persiste pas — le relire est
 * toujours plus juste que l'avoir mémorisé.
 */
interface DicteeState {
  /** Les entrées audio de la machine, telles que la dernière lecture les a vues. */
  readonly microphones: readonly InputDevice[];
  /** La machine a-t-elle déjà été interrogée ? */
  readonly loaded: boolean;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

const initialState: DicteeState = {
  microphones: [],
  loaded: false,
  error: null,
};

/** L'écran Dictée : ce que la machine offre, et le mode de déclenchement. */
export const DicteeStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, dictation = inject(Dictation), settings = inject(SettingsStore)) => ({
    /**
     * Lit les entrées audio de la machine.
     *
     * @remarks
     * ⚠️ Ne rejette jamais : un backend muet laisse l'écran utilisable, et sans micro listé on
     * retombe sur le micro système.
     */
    async load(): Promise<void> {
      try {
        patchState(store, {
          microphones: await dictation.inputDevices(),
          loaded: true,
        });
      } catch (error) {
        patchState(store, { loaded: true, error: toAppError(error) });
      }
    },

    /**
     * Change le mode de déclenchement : le réglage et le raccourci, ensemble.
     *
     * @remarks
     * ⚠️ Écrire le réglage ne suffit pas — le backend ne relit `dictationMode` qu'au démarrage,
     * pour que le raccourci réponde fenêtre fermée. Les deux appels tiennent dans cette méthode
     * pour qu'aucun appelant ne puisse n'en faire que la moitié.
     */
    async setMode(mode: DictationMode): Promise<void> {
      await settings.update({ dictationMode: mode });
      try {
        await dictation.applyMode(mode);
      } catch (error) {
        patchState(store, { error: toAppError(error) });
      }
    },

    /** Oublie la dernière erreur, une fois qu'elle a été dite. */
    clearError(): void {
      patchState(store, { error: null });
    },
  })),
);
