import { Service, inject } from '@angular/core';
import { Invoke } from '../bridge/invoke/invoke';
import { SystemBridge } from '../bridge/system/system.bridge';
import { toAppError } from '../../models/app-error';
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  sanitiseSettings,
  type Language,
  type AppSettings,
} from '../../models/settings';

/** Le fichier, dans `app_data_dir()`, à côté de la base chiffrée. */
export const SETTINGS_FILE = 'settings.json';

/** Ce que le disque a rendu, et ce qu'il faut en déduire. */
export interface StoredSettings {
  /** Les réglages relus, nettoyés, complétés par leurs défauts. */
  readonly settings: AppSettings;
  /**
   * Vrai quand le fichier n'existait pas, ou ne contenait rien : c'est le premier lancement.
   *
   * @remarks
   * ⚠️ Ce drapeau ne se déduit pas des valeurs — après nettoyage, un réglage absent est
   * indiscernable d'un réglage égal à son défaut. Sans lui, le thème du système serait
   * redétecté à chaque démarrage et écraserait le choix de l'utilisateur.
   */
  readonly isFirstLaunch: boolean;
}

/**
 * Lit et écrit les réglages non sensibles, via `tauri-plugin-store`.
 *
 * Une clé par réglage plutôt qu'un objet unique : une valeur abîmée n'emporte pas les autres,
 * et écrire un réglage ne réécrit pas les douze autres.
 *
 * Hors contexte Tauri (`npm run start:web`), tout se passe en mémoire sur les valeurs par
 * défaut : le frontend reste utilisable dans un navigateur.
 */
@Service()
export class Settings {
  private readonly core = inject(Invoke);
  private readonly system = inject(SystemBridge);

  /**
   * Lit les réglages du disque.
   *
   * Un fichier absent est le cas nominal du premier lancement : il donne les défauts, pas une
   * erreur. Un fichier illisible, lui, rejette — c'est au magasin de décider quoi en faire.
   *
   * @throws un `AppError` typé si le fichier existe mais ne peut pas être lu.
   */
  async load(): Promise<StoredSettings> {
    if (!this.core.isTauri()) {
      // En navigateur, rien n'est persisté : chaque ouverture est un premier lancement, et
      // suivre le thème du système est le comportement attendu.
      return { settings: DEFAULT_SETTINGS, isFirstLaunch: true };
    }
    try {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load(SETTINGS_FILE, { autoSave: false });
      const entries = await store.entries();
      return {
        settings: sanitiseSettings(Object.fromEntries(entries)),
        isFirstLaunch: entries.length === 0,
      };
    } catch (error) {
      throw toAppError(error);
    }
  }

  /**
   * Écrit les réglages fournis, et eux seuls.
   *
   * @throws un `AppError` typé si l'écriture échoue.
   */
  async save(patch: Partial<AppSettings>): Promise<void> {
    if (!this.core.isTauri()) {
      return;
    }
    try {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load(SETTINGS_FILE, { autoSave: false });
      for (const [key, value] of Object.entries(patch)) {
        await store.set(key, value);
      }
      await store.save();
    } catch (error) {
      throw toAppError(error);
    }
  }

  /**
   * Ce que vaut la machine au tout premier lancement.
   *
   * Le thème du système ne sert qu'ici : ensuite l'utilisateur choisit clair ou sombre.
   * `matchMedia` suffit, le thème ne conditionne aucun bundle.
   *
   * @remarks
   * ⚠️ La langue vient du backend et non du WebView : l'interface est localisée au build, Rust
   * a choisi le bundle chargé par la fenêtre, et une seconde détection ici finirait par en
   * désigner un autre. Repli anglais hors contexte Tauri.
   */
  async detectInitialSettings(): Promise<
    Pick<AppSettings, 'theme' | 'interfaceLanguage' | 'dictationLanguage'>
  > {
    const language = knownLanguage(await this.system.getInterfaceLocale());
    return {
      theme: prefersDark() ? 'dark' : 'light',
      interfaceLanguage: language,
      dictationLanguage: language,
    };
  }
}

/** Vrai si le système est réglé en sombre. */
function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/**
 * Ramène ce que le backend annonce à l'une des 6 langues traitées.
 *
 * Rust ne renvoie déjà que des valeurs connues ; on revalide quand même, parce qu'un contrat
 * vérifié à un seul bout n'est vérifié nulle part.
 */
function knownLanguage(candidate: string | null): Language {
  const primary = candidate?.split('-')[0]?.toLowerCase();
  return LANGUAGES.find((language) => language === primary) ?? DEFAULT_SETTINGS.interfaceLanguage;
}
