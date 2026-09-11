/**
 * Les langues : ce qui est installé, ce qui se télécharge, et ce que la traduction sait faire.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';

/**
 * Ce que le moteur de transcription déclare savoir faire.
 *
 * @remarks
 * ⚠️ `locales` liste ce que le moteur couvre, `installedLocales` ce qui est réellement présent
 * sur la machine. L'écart est la règle — mesuré : 2 des 6 langues seulement. Une langue absente
 * d'`installedLocales` ne transcrit rien : le moteur démarre et reste muet.
 *
 * Miroir d'`EngineCapabilities` (`src-tauri/src/stt/mod.rs`).
 */
export interface EngineCapabilities {
  /** `apple`, plus tard `whisper`, `cohere`. */
  readonly id: string;
  /** Rend-il des partiels au fil de l'eau ? Faux pour Whisper et Cohere, qui sont batch. */
  readonly streaming: boolean;
  readonly locales: readonly string[];
  readonly installedLocales: readonly string[];
  /** Ce qui empêche de l'utiliser tout de suite, quand quelque chose l'empêche. */
  readonly detail: string | null;
}

/**
 * Ce qu'une installation de langue raconte au fil de l'eau.
 *
 * @remarks
 * ⚠️ `cancelled` n'est pas `failed` : un abandon volontaire affiché comme une panne ferait
 * douter l'utilisateur de son propre geste.
 *
 * Miroir d'`AssetInstallEvent` (`src-tauri/src/commands/assets.rs`).
 */
export type AssetInstallEvent =
  | { readonly kind: 'progress'; readonly language: string; readonly progress: number }
  | { readonly kind: 'installed'; readonly language: string }
  | { readonly kind: 'cancelled'; readonly language: string }
  | { readonly kind: 'failed'; readonly language: string; readonly message: string }
  /**
   * Le quota de réservations est plein.
   *
   * @remarks
   * ⚠️ Un `kind` à part et non un `failed` : ce n'est pas une panne mais un arbitrage — retirer
   * une langue pour en ajouter une. Et c'est ce qui permet de le dire dans la langue de
   * l'utilisateur : le message d'Apple, lui, est en anglais.
   */
  | { readonly kind: 'full'; readonly language: string };

/**
 * Les réservations de locales détenues par l'application, et le plafond de la machine.
 *
 * @remarks
 * ⚠️ `reserved` porte des identifiants complets — `es-US`, `de-AT`… — et non des codes à deux
 * lettres : une langue s'y reconnaît par son préfixe, jamais par égalité.
 *
 * Miroir de ce que rend `AssetInventory` côté Swift.
 */
export interface LocaleReservations {
  readonly reserved: readonly string[];
  readonly maximum: number;
}

/** Le nom de l'évènement Tauri qui porte la progression d'une installation de langue. */
export const ASSET_EVENT = 'language-install';

/** L'état d'une paire ordonnée de langues, tel que le framework d'Apple le rend. */
export type PairStatus = 'installed' | 'supported' | 'unsupported';

/**
 * Une paire ordonnée de langues et son état.
 *
 * @remarks
 * ⚠️ L'ordre compte : `fr → ja` et `ja → fr` sont deux paires distinctes, chacune avec son
 * propre état. C'est ce qui interdit de parler d'une « langue installée » côté traduction, où
 * un état par langue serait faux.
 *
 * Miroir de `PairAvailability` (`src-tauri/src/translation/mod.rs`).
 */
export interface PairAvailability {
  readonly source: string;
  readonly target: string;
  readonly status: PairStatus;
}

/** Ce que la traduction sait faire sur cette machine, ici et maintenant. */
export interface TranslationAvailability {
  readonly languages: readonly string[];
  readonly pairs: readonly PairAvailability[];
}

/**
 * Ce que rend une demande de traduction.
 *
 * @remarks
 * ⚠️ Un type somme et non une chaîne nullable : « je n'ai pas traduit » doit être impossible à
 * confondre avec « voici la traduction », et les deux raisons de ne pas traduire ne se traitent
 * pas pareil — l'une se propose au téléchargement, l'autre s'affiche *Indisponible*.
 *
 * Miroir de `TranslationOutcome` (`src-tauri/src/translation/mod.rs`).
 */
export type TranslationOutcome =
  | { readonly kind: 'translated'; readonly text: string }
  | { readonly kind: 'pairMissing'; readonly source: string; readonly target: string }
  | { readonly kind: 'pairUnsupported'; readonly source: string; readonly target: string };

/** Les langues : ce qui est installé, ce qui se télécharge, et ce que la traduction sait faire. */
@Service()
export class LanguagesBridge {
  private readonly core = inject(Invoke);

  /**
   * Ce que le moteur de transcription sait faire, et ce qui est réellement installé.
   *
   * Ne démarre aucune session, n'ouvre aucun micro et ne consomme aucune réservation — c'est ce
   * qui la distingue de {@link installLanguage}, et c'est elle qu'on appelle pour savoir quelles
   * langues sont utilisables.
   */
  async getSttCapabilities(): Promise<EngineCapabilities | null> {
    return this.core.call<EngineCapabilities>('get_stt_capabilities');
  }

  /**
   * Télécharge les ressources de transcription d'une langue. Rend la main immédiatement : la
   * suite arrive par {@link ASSET_EVENT}.
   *
   * @remarks
   * ⚠️ C'est la seule opération réseau de la dictée. Elle ne s'appelle que sur un geste
   * explicite de l'utilisateur — jamais au chargement d'un écran.
   */
  async installLanguage(language: string): Promise<void> {
    await this.core.call<null>('install_language', { language });
  }

  /**
   * Les langues dont nous détenons la réservation, et le plafond de la machine.
   *
   * @remarks
   * - ⚠️ La réservation est ce qui fait tenir le pack : la libérer laisse macOS reprendre les
   *   ressources. Ce quota est un plafond de langues installées, pas de téléchargements en cours.
   * - ⚠️ Les langues système n'y figurent pas et n'en consomment rien : la couverture
   *   atteignable est *système + plafond*, jamais le plafond seul.
   */
  async getLocaleReservations(): Promise<LocaleReservations | null> {
    return this.core.call<LocaleReservations>('get_locale_reservations');
  }

  /**
   * Rend la réservation d'une langue — et donc son pack. Sans effet sur une langue système.
   *
   * @remarks
   * ⚠️ Après cet appel, la langue doit être retéléchargée pour redevenir dictable. Le seul
   * appelant légitime est celui qui a besoin d'un créneau pour en installer une autre, et
   * l'utilisateur doit l'avoir su.
   */
  async releaseLanguage(language: string): Promise<void> {
    await this.core.call<null>('release_language', { language });
  }

  /** Abandonne l'installation en cours. Sans effet s'il n'y en a pas. */
  async cancelLanguageInstall(): Promise<void> {
    await this.core.call<null>('cancel_language_install');
  }

  /**
   * La langue dont l'installation est en cours, ou `null`.
   *
   * @remarks
   * ⚠️ À lire à l'ouverture de l'écran : la fenêtre principale peut être fermée puis rouverte
   * pendant un téléchargement. Sans cette lecture, elle réafficherait « non installée » avec un
   * bouton qui relancerait tout.
   */
  async getLanguageInstallInFlight(): Promise<string | null> {
    return this.core.call<string | null>('get_language_install_in_flight');
  }

  /**
   * L'état de chaque paire de langues, sans rien traduire ni télécharger.
   *
   * @remarks
   * ⚠️ Lecture sans effet de bord, et c'est mesuré : contrairement aux ressources de
   * transcription — où sonder consomme une réservation —, interroger la disponibilité d'une
   * paire n'épuise rien. On peut donc l'appeler à l'ouverture d'un écran.
   */
  async getTranslationAvailability(): Promise<TranslationAvailability | null> {
    return this.core.call<TranslationAvailability>('get_translation_availability');
  }

  /**
   * Fait présenter à Apple sa feuille de téléchargement pour une langue cible.
   *
   * @remarks
   * - ⚠️ Seul appel de traduction qui touche au réseau, et il ne part qu'à un clic.
   * - ⚠️ On passe une langue cible et les langues parlées, jamais une paire : le choix de la
   *   paire appartient au backend, qui retient une paire représentative — la feuille d'Apple
   *   liste des langues, et une session par paire empilerait les feuilles.
   * - ⚠️ Le retour ne promet rien du téléchargement, asynchrone : il dit que la demande est
   *   partie. Rien n'est mis en cache — le pipeline relit la disponibilité à chaque emploi.
   */
  async prepareTranslation(target: string, spoken: readonly string[]): Promise<void> {
    await this.core.call<null>('prepare_translation', { target, spoken });
  }

  /**
   * Traduit un texte de `source` vers `target`.
   *
   * @remarks
   * ⚠️ Rien ne se perd quand la paire manque : l'issue est un type somme, jamais une exception.
   * `pairMissing` se propose au téléchargement, `pairUnsupported` s'affiche *Indisponible*, et
   * l'appelant garde son texte source dans les deux cas.
   */
  async translateText(
    source: string,
    target: string,
    text: string,
  ): Promise<TranslationOutcome | null> {
    return this.core.call<TranslationOutcome>('translate_text', { source, target, text });
  }

  /**
   * Demande l'arrêt de la traduction du document `id`.
   *
   * @remarks
   * ⚠️ Sans échec et idempotente : annuler ce qui vient de finir n'est pas une erreur. L'arrêt
   * n'est pas immédiat — il est constaté au prochain cran de progression, et c'est le
   * `cancelled` de {@link translateDocument} qui dit qu'il a eu lieu.
   */
  async cancelDocumentTranslation(id: string): Promise<void> {
    await this.core.call<null>('cancel_document_translation', { id });
  }
}
