import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Icon } from '../../shared/components/icon/icon';
import { DictationHistory } from './components/dictation-history/dictation-history';
import { PanelStore } from '../../core/store/panel/panel.store';
import { DicteeControls } from './components/dictee-controls/dictee-controls';
import { DicteeStore } from '../../core/store/dictee/dictee.store';
import { DictationHistoryStore } from '../../core/store/dictation-history/dictation-history.store';
import { Dictation } from '../../core/services/dictation/dictation';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { toAppError } from '../../core/models/app-error';
import type {
  DictationMode,
  Language,
  RephrasingMode,
  TranslationTarget,
} from '../../core/models/settings';
import { PROMPT_WRITE_DELAY_MS } from '../../core/models/timing';
import { drainErrors } from '../../core/services/snackbar/drain-errors';
import { subscriptions } from '../../core/services/bridge/subscriptions';

/**
 * Où mène la dernière ligne de chacun des deux menus de langue.
 *
 * @remarks
 * ⚠️ Chacun vers sa liste, jamais vers `/options/langues` : cette page ne fait qu'annoncer les
 * deux listes, et y aboutir redemanderait laquelle on voulait.
 */
const LANGUAGE_OPTIONS_ROUTES = {
  spoken: '/options/langues/parlees',
  translation: '/options/langues/traduction',
} as const;

/**
 * L'écran Dictée — l'accueil de l'application.
 *
 * @remarks
 * - ⚠️ Aucune gestion de langues ici : marquage des langues absentes, confirmation
 *   d'installation et progression vivent à l'onboarding et dans Options ▸ Langues.
 * - ⚠️ Le mode de dictée ne s'écrit pas ici : {@link DicteeStore.setMode} fait les deux moitiés
 *   du geste — le réglage **et** le raccourci en cours d'exécution. Les séparer laisserait
 *   basculer sans que ⌃⌥ change de comportement.
 */
@Component({
  selector: 'app-dictee',
  imports: [Icon, DicteeControls, DictationHistory],
  templateUrl: './dictee.html',
  styleUrl: './dictee.scss',
})
export class Dictee {
  protected readonly store = inject(DicteeStore);
  /** Le repli du panneau d'historique — partagé avec la largeur de la fenêtre. */
  protected readonly panel = inject(PanelStore);
  protected readonly settings = inject(SettingsStore);
  private readonly dictation = inject(Dictation);
  /** L'historique, lu par l'écran lui-même : le bouton de dépli en dépend, panneau replié. */
  protected readonly history = inject(DictationHistoryStore);
  private readonly router = inject(Router);
  private readonly snackbar = inject(Snackbar);

  private readonly subs = subscriptions();

  /** La langue parlée retenue pour la prochaine dictée. */
  protected readonly language = computed(() => this.settings.settings().dictationLanguage);

  /** Les langues parlées activées — tout ce que le menu « Langue parlée » propose. */
  protected readonly spokenLanguages = computed(() => this.settings.settings().spokenLanguages);

  /** Les langues de traduction activées. */
  protected readonly translationLanguages = computed(
    () => this.settings.settings().translationLanguages,
  );

  /** Vers quelle langue traduire, ou « aucune ». */
  protected readonly translationTarget = computed(() => this.settings.settings().translationTarget);

  /** Le style de reformulation demandé au LLM local. */
  protected readonly rephrasingMode = computed(() => this.settings.settings().rephrasingMode);

  /** Le mode de déclenchement : maintenir ⌃⌥, ou basculer. */
  protected readonly mode = computed(() => this.settings.settings().dictationMode);

  /**
   * Le prompt de reformulation personnalisé, tel que le champ l'affiche.
   *
   * @remarks
   * ⚠️ Il ne passe jamais par les réglages non sensibles, qui sont un JSON en clair : c'est du
   * texte écrit par l'utilisateur, qui peut nommer son métier, son employeur ou un client. Il
   * vit dans la base chiffrée.
   */
  protected readonly customPrompt = signal('');

  /**
   * L'écriture différée du prompt : le minuteur en cours, et la valeur qu'il doit écrire.
   *
   * @remarks
   * ⚠️ Sans ce report, chaque frappe ouvrirait une transaction SQLCipher. L'écriture en attente
   * est poussée à la destruction du composant, jamais abandonnée.
   */
  private promptWrite: ReturnType<typeof setTimeout> | null = null;
  private pendingPrompt: string | null = null;

  constructor() {
    void this.store.load();
    // ⚠️ L'historique se lit ici, et pas seulement dans son panneau : replié, le panneau n'est
    // pas monté, et le bouton « Historique » s'afficherait sur du vide.
    void this.history.load();
    void this.listen();

    drainErrors(this.store);

    void this.loadPrompt();

    inject(DestroyRef).onDestroy(() => {
      // ⚠️ Pousser, et non annuler : fermer la fenêtre pendant la frappe perdrait la saisie.
      void this.flushPrompt();
    });
  }

  /**
   * Applique le choix de langue parlée, et lâche la traduction qu'il rend impossible.
   *
   * Le menu ne propose que des langues activées : il n'y a rien à vérifier ni à installer ici.
   * Une langue activée dont le pack a disparu se re-propose au démarrage, pas au choix.
   *
   * @remarks
   * ⚠️ La cible tombe dans le **même** patch que la langue : deux écritures successives feraient
   * passer l'écran par l'état que le menu ne propose plus — traduire le français en français.
   */
  protected async pickLanguage(language: Language): Promise<void> {
    await this.settings.update(
      this.translationTarget() === language
        ? { dictationLanguage: language, translationTarget: 'none' }
        : { dictationLanguage: language },
    );
  }

  /**
   * Ouvre la liste où la famille de langues demandée se compose.
   *
   * @remarks
   * ⚠️ Ne touche pas au champ : la ligne qui mène ici est une commande, pas une valeur — le
   * sélecteur n'écrit rien avant d'émettre.
   */
  protected async openLanguageOptions(list: 'spoken' | 'translation'): Promise<void> {
    await this.router.navigateByUrl(LANGUAGE_OPTIONS_ROUTES[list]);
  }

  /** Change le mode de déclenchement — réglage et raccourci en cours d'exécution ensemble. */
  protected async setMode(mode: DictationMode): Promise<void> {
    await this.store.setMode(mode);
  }

  /** Choisit la langue vers laquelle les dictées seront traduites. */
  protected async setTranslation(translationTarget: TranslationTarget): Promise<void> {
    await this.settings.update({ translationTarget });
  }

  /** Choisit le style de reformulation appliqué aux dictées. */
  protected async setRephrasing(rephrasingMode: RephrasingMode): Promise<void> {
    await this.settings.update({ rephrasingMode });
  }

  /**
   * Note la frappe et programme son enregistrement, sans l'écrire tout de suite. L'affichage,
   * lui, suit immédiatement.
   */
  protected setCustomPrompt(customPrompt: string): void {
    this.customPrompt.set(customPrompt);
    this.pendingPrompt = customPrompt;
    if (this.promptWrite !== null) {
      clearTimeout(this.promptWrite);
    }
    this.promptWrite = setTimeout(() => void this.flushPrompt(), PROMPT_WRITE_DELAY_MS);
  }

  /**
   * Lit le prompt enregistré et le pose dans le champ.
   *
   * @remarks
   * ⚠️ N'écrase pas ce que l'utilisateur a déjà tapé : la base se déverrouille et se lit de
   * façon asynchrone, et la réponse peut arriver après les premières frappes.
   */
  private async loadPrompt(): Promise<void> {
    try {
      const stored = await this.dictation.rephrasingPrompt();
      if (this.subs.alive() && this.pendingPrompt === null) {
        this.customPrompt.set(stored);
      }
    } catch (error) {
      this.snackbar.error(toAppError(error).message);
    }
  }

  /** Écrit le prompt en attente, s'il y en a un. Sans effet sinon. */
  private async flushPrompt(): Promise<void> {
    if (this.promptWrite !== null) {
      clearTimeout(this.promptWrite);
      this.promptWrite = null;
    }
    const pending = this.pendingPrompt;
    if (pending === null) {
      return;
    }
    this.pendingPrompt = null;
    try {
      await this.dictation.saveRephrasingPrompt(pending);
    } catch (error) {
      this.snackbar.error(toAppError(error).message);
    }
  }

  /** Se branche sur les dictées enregistrées, et se débranche avec l'écran. */
  private async listen(): Promise<void> {
    // ⚠️ La dictée aboutit fenêtre cachée, et la fenêtre n'est jamais détruite : sans cet
    // abonnement, une fenêtre rouverte montrerait l'historique qu'elle avait au chargement.
    await this.subs.keep(
      this.dictation.observeRecorded(() => {
        void this.history.load();
      }),
    );
  }
}
