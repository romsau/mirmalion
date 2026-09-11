import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { Settings } from '../../services/settings/settings';
import { toAppError, type AppError } from '../../models/app-error';
import { DEFAULT_SETTINGS, type AppSettings } from '../../models/settings';

/**
 * Les réglages tels que l'interface les lit.
 *
 * @remarks
 * ⚠️ L'état part des valeurs par défaut, jamais de `null` : un composant qui lit un réglage
 * avant la fin du chargement obtient une valeur utilisable, sans que chaque appelant ait à
 * écrire son propre repli.
 */
interface SettingsState {
  /** Les réglages courants, défauts compris tant que le disque n'a pas répondu. */
  readonly settings: AppSettings;
  /** Les réglages ont-ils été relus du disque, ou sont-ce encore les défauts ? */
  readonly loaded: boolean;
  /** Renseigné quand le disque a refusé de répondre — l'interface reste utilisable. */
  readonly error: AppError | null;
}

const initialState: SettingsState = {
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: null,
};

/** La source de vérité des réglages pour toute l'interface. */
export const SettingsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ settings, error }) => ({
    /** Le thème retenu — clair, sombre ou celui du système. */
    theme: computed(() => settings().theme),
    /** La langue de l'interface. */
    interfaceLanguage: computed(() => settings().interfaceLanguage),
    /**
     * Vrai quand les réglages affichés sont les défauts, faute d'avoir pu lire le disque.
     *
     * @remarks
     * ⚠️ À dire en snackbar, jamais à taire : l'interface fonctionne, mais rien de ce que
     * l'utilisateur change ne sera relu au prochain démarrage.
     */
    isDegraded: computed(() => error() !== null),
  })),
  withMethods((store, service = inject(Settings)) => ({
    /**
     * Relit les réglages du disque. Ne rejette jamais : un disque muet laisse les défauts en
     * place et renseigne `error`.
     *
     * @remarks
     * ⚠️ Au tout premier lancement, thème et langue sont détectés depuis le système puis
     * écrits. Sans cette écriture ils seraient redétectés à chaque démarrage, écrasant le
     * choix de l'utilisateur.
     */
    async load(): Promise<void> {
      try {
        const { settings, isFirstLaunch } = await service.load();
        if (!isFirstLaunch) {
          patchState(store, { settings, loaded: true, error: null });
          return;
        }
        const detected = await service.detectInitialSettings();
        patchState(store, {
          settings: { ...settings, ...detected },
          loaded: true,
          error: null,
        });
        await service.save(detected);
      } catch (error) {
        patchState(store, { loaded: true, error: toAppError(error) });
      }
    },

    /**
     * Change un ou plusieurs réglages : en mémoire d'abord, sur disque ensuite.
     *
     * L'interface réagit immédiatement, et une écriture en échec est signalée sans annuler le
     * changement affiché.
     */
    async update(patch: Partial<AppSettings>): Promise<void> {
      patchState(store, { settings: { ...store.settings(), ...patch }, error: null });
      try {
        await service.save(patch);
      } catch (error) {
        patchState(store, { error: toAppError(error) });
      }
    },
  })),
);
