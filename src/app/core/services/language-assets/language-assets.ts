import { Service, inject } from '@angular/core';
import { ASSET_EVENT } from '../bridge/languages/languages.bridge';
import type { AssetInstallEvent, EngineCapabilities } from '../bridge/languages/languages.bridge';
import { LANGUAGES, type Language } from '../../models/settings';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';
import { Invoke } from '../bridge/invoke/invoke';

/**
 * Les ressources de transcription : savoir lesquelles sont là, télécharger celles qui manquent.
 *
 * Séparé du service de dictée : l'onboarding installe des langues sans rien savoir de la dictée.
 *
 * @remarks
 * - ⚠️ Mesuré : 2 des 6 langues seulement ont leurs ressources sur un Mac ordinaire. Une langue
 *   absente ne transcrit rien — le moteur démarre et reste muet, sans rien signaler.
 * - ⚠️ {@link LanguageAssets.install} est la seule opération réseau de la dictée, et elle ne part
 *   que sur un geste explicite. Savoir ce qui est installé reste local et gratuit.
 */
@Service()
export class LanguageAssets {
  private readonly bridge = inject(LanguagesBridge);
  private readonly core = inject(Invoke);

  /**
   * Les langues du périmètre dont les ressources sont réellement présentes.
   *
   * Hors contexte Tauri, rend la liste complète : un navigateur n'a aucun moteur, et faire
   * croire que tout manque afficherait un avertissement sur chacune des six langues.
   *
   * @remarks
   * ⚠️ À ne pas confondre avec les langues couvertes : le moteur en couvre six, il n'en a
   * presque jamais six d'installées.
   */
  async installedLanguages(): Promise<readonly Language[]> {
    const capabilities = await this.bridge.getSttCapabilities();
    return capabilities ? known(capabilities) : LANGUAGES;
  }

  /**
   * Lance le téléchargement. Rend la main immédiatement — la suite arrive par
   * {@link LanguageAssets.observe}.
   */
  async install(language: Language): Promise<void> {
    await this.bridge.installLanguage(language);
  }

  /**
   * Les langues dont l'application détient la réservation, et le plafond de la machine.
   *
   * Hors contexte Tauri, rend un plafond nul et aucune réservation : l'écran se comporte comme
   * si rien n'était installé, ce qui est vrai dans un navigateur.
   *
   * @remarks
   * ⚠️ Rendues en codes à deux lettres, quand le pont rend des identifiants complets (`es-US`,
   * `de-AT`). Comparer par égalité fait refuser une langue pourtant installée.
   */
  async reservations(): Promise<{ held: readonly Language[]; maximum: number }> {
    const raw = await this.bridge.getLocaleReservations();
    if (!raw) {
      return { held: [], maximum: 0 };
    }
    return {
      held: LANGUAGES.filter((language) =>
        raw.reserved.some((identifier) => identifier.toLowerCase().startsWith(language)),
      ),
      maximum: raw.maximum,
    };
  }

  /**
   * Rend la réservation d'une langue, et donc son pack.
   *
   * @remarks
   * ⚠️ Ce n'est pas « désactiver » : après cet appel, la langue devra être retéléchargée. Le
   * seul appelant est celui qui libère un créneau pour en installer une autre.
   */
  async release(language: Language): Promise<void> {
    await this.bridge.releaseLanguage(language);
  }

  /** Abandonne le téléchargement en cours. Sans effet s'il n'y en a pas. */
  async cancel(): Promise<void> {
    await this.bridge.cancelLanguageInstall();
  }

  /**
   * La langue dont l'installation est en cours, ou `null`.
   *
   * @remarks
   * ⚠️ À lire à l'ouverture de l'écran : la fenêtre peut être fermée puis rouverte pendant un
   * téléchargement, qui lui continue. Sans cette lecture, l'écran proposerait de relancer ce
   * qui tourne déjà.
   */
  async inFlight(): Promise<Language | null> {
    const language = await this.bridge.getLanguageInstallInFlight();
    return language !== null && isLanguage(language) ? language : null;
  }

  /** S'abonne à la progression. Rend la fonction de désabonnement. */
  async observe(handler: (event: AssetInstallEvent) => void): Promise<() => void> {
    return this.core.listen<AssetInstallEvent>(ASSET_EVENT, handler);
  }
}

/** Vrai si l'étiquette est l'une des six langues du périmètre. */
function isLanguage(candidate: string): candidate is Language {
  return (LANGUAGES as readonly string[]).includes(candidate);
}

/**
 * Ramène ce que le backend annonce aux six langues du périmètre.
 *
 * Le backend ne rend déjà que des étiquettes connues ; on revalide quand même, parce qu'un
 * contrat vérifié à un seul bout n'est vérifié nulle part.
 */
function known(capabilities: EngineCapabilities): readonly Language[] {
  return capabilities.installedLocales.filter(isLanguage);
}
