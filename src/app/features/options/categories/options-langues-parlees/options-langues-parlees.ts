import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SubscreenHeader } from '../../components/subscreen-header/subscreen-header';
import { LanguageList } from '../../../../shared/components/language-list/language-list';
import {
  LanguageInstall,
  type LanguageInstallData,
} from '../../../../shared/components/language-install/language-install';
import { Modal } from '../../../../core/services/modal/modal';
import type { ModalRef } from '../../../../core/services/modal/modal-ref';
import { LanguagesStore } from '../../../../core/store/languages/languages.store';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import {
  LAST_SPOKEN_LANGUAGE_REASON,
  installConfirmHeading,
  lockedSpokenLanguage,
} from '../../../../core/models/language';
import { LANGUAGES, type Language } from '../../../../core/models/settings';

/** La largeur que la maquette fixe pour cette boîte : elle ne porte qu'un titre et une barre. */
const INSTALL_MODAL_WIDTH = 380;

/**
 * Le paramètre de requête qui ouvre l'installation d'une langue dès l'arrivée sur l'écran :
 * `?installer=en`.
 */
const INSTALL_PARAM = 'installer';

/**
 * Le sous-écran Langues parlées — celles proposées à la dictée et à la session. Ni icône d'état,
 * ni compteur, ni note sous la liste : le plafond existe mais ne se manifeste qu'au moment où la
 * place manque, dans `LanguagesStore.requestInstall`.
 *
 * @remarks
 * - ⚠️ C'est ici, et à l'onboarding, que les langues s'installent. L'interrupteur demande, il
 *   n'installe pas : seul « Installer » engage plusieurs centaines de mégaoctets.
 * - ⚠️ Refuser ou annuler laisse l'interrupteur éteint, et seule l'arrivée des ressources
 *   l'allume : une langue activée sans ses ressources promettrait une dictée impossible.
 */
@Component({
  selector: 'app-options-langues-parlees',
  imports: [SubscreenHeader, LanguageList],
  templateUrl: './options-langues-parlees.html',
  styleUrl: './options-langues-parlees.scss',
})
export class OptionsLanguesParlees {
  private readonly router = inject(Router);
  private readonly modal = inject(Modal);
  private readonly languages = inject(LanguagesStore);
  private readonly settings = inject(SettingsStore);
  private readonly snackbar = inject(Snackbar);

  /** Les langues activées, celles que les menus proposent. */
  protected readonly spoken = computed(() => this.settings.settings().spokenLanguages);

  /** Les langues dont les ressources sont présentes sur la machine. */
  protected readonly installed = computed(() => this.languages.installedLanguages());

  /** La langue dont on attend l'installation, le temps que la modale est ouverte. */
  private readonly awaiting = signal<Language | null>(null);

  /** La modale d'installation ouverte, s'il y en a une. */
  private ref: ModalRef<boolean> | null = null;

  /**
   * La langue que l'URL demande d'installer, `undefined` sans paramètre comme sur un code
   * inconnu — les deux ne demandent rien.
   */
  private readonly urlInstall = LANGUAGES.find(
    (code) => code === inject(ActivatedRoute).snapshot.queryParamMap.get(INSTALL_PARAM),
  );

  /**
   * La dernière langue allumée, dont l'interrupteur se fige : une application de dictée sans
   * langue ne dicte rien.
   *
   * @remarks
   * ⚠️ C'est la seule règle qui fige un interrupteur — le quota, lui, se manifeste au moment
   * d'installer, jamais en désactivant un contrôle d'avance.
   */
  protected readonly locked = computed(() => lockedSpokenLanguage(this.spoken()));

  /** Ce que la liste dit de l'interrupteur figé. */
  protected readonly lockedReason = LAST_SPOKEN_LANGUAGE_REASON;

  constructor() {
    void this.languages.watch();
    void this.languages.load();

    // ⚠️ C'est l'arrivée des ressources qui allume l'interrupteur, pas le clic sur « Installer » :
    // le téléchargement est asynchrone, et le retour de la commande ne prouve rien.
    effect(() => {
      const wanted = this.awaiting();
      if (wanted === null || !this.installed().includes(wanted)) {
        return;
      }
      // ⚠️ Désarmer avant d'écrire : cet effet lit `spoken()` et l'écrit, si bien que sans cela
      // l'écriture le réveille, la condition tient toujours, et il rajoute la langue à chaque
      // tour jusqu'à épuiser le tas.
      this.awaiting.set(null);
      this.ref?.close(true);
      void this.settings.update({ spokenLanguages: [...this.spoken(), wanted] });
    });
  }

  /**
   * Ouvre l'installation demandée par l'URL, une fois seulement, et aux conditions du clic :
   * une langue déjà présente ne se propose pas.
   *
   * @remarks
   * - ⚠️ Attend `loaded` : avant la réponse de la machine, la liste des langues installées est
   *   vide, et le paramètre proposerait d'installer ce qui est déjà là.
   * - ⚠️ Se désarme dès qu'il a tranché. L'effet lit les langues installées : sans cela,
   *   l'arrivée d'une autre langue le réveillerait et reposerait une question déjà refusée.
   */
  private readonly urlInstallWatch = effect(() => {
    if (this.urlInstall === undefined || !this.languages.loaded()) {
      return;
    }
    this.urlInstallWatch.destroy();
    if (!this.installed().includes(this.urlInstall)) {
      this.askToInstall(this.urlInstall);
    }
  });

  /** Remonte à l'accueil des langues. */
  protected back(): void {
    void this.router.navigate(['/options', 'langues']);
  }

  /**
   * Dit que le quota d'installation est plein, et referme la modale.
   *
   * @remarks
   * ⚠️ Ce n'est pas une panne mais un arbitrage à proposer : d'où une snackbar d'information, et
   * un texte qui dit quoi faire. Le plafond d'Apple ne compte que les langues installées par
   * nous — les langues système n'en consomment aucune, d'où un total parfois supérieur. Et
   * l'interrupteur reste éteint : rien n'a été installé.
   */
  private readonly quotaWatch = effect(() => {
    if (!this.languages.quotaFull()) {
      return;
    }
    this.snackbar.info(
      $localize`:@@options.languages.quotaFull:Pour ajouter une langue, éteignez-en une autre d'abord : cette machine ne peut en garder que ${this.languages.reservationCeiling()}:count: installées à la fois.`,
    );
    this.languages.clearQuotaFull();
    this.ref?.close(false);
  });

  /**
   * Dit qu'une installation a échoué, et referme la modale.
   *
   * @remarks
   * - ⚠️ Sans cette lecture, un échec vide la file, referme `install`, et la modale retombe sur
   *   son premier temps : cliquer « Installer » n'a alors, à l'œil, aucun effet.
   * - ⚠️ On ferme la modale plutôt que de la laisser rejouer sa question, et le message reste
   *   générique : la cause d'Apple est une chaîne anglaise, qui part au journal, pas à l'écran.
   */
  private readonly errorWatch = effect(() => {
    if (this.languages.error() === null) {
      return;
    }
    this.languages.clearError();
    this.snackbar.error(
      $localize`:@@options.languages.installFailed:Le téléchargement n'a pas abouti. Vérifiez votre connexion, puis réessayez.`,
    );
    this.ref?.close(false);
  });

  /** Allume ou éteint une langue. Une langue absente passe d'abord par la modale d'installation. */
  protected toggle(language: Language): void {
    const spoken = this.spoken();
    if (spoken.includes(language)) {
      // ⚠️ Éteindre ne fait que retirer des menus : les ressources restent sur le Mac, la
      // réactiver est immédiat, et il n'y a donc rien à confirmer.
      void this.settings.update({
        spokenLanguages: spoken.filter((kept) => kept !== language),
      });
      return;
    }
    if (this.installed().includes(language)) {
      void this.settings.update({ spokenLanguages: [...spoken, language] });
      return;
    }
    this.askToInstall(language);
  }

  /**
   * Ouvre les deux temps de l'installation : la confirmation, puis la barre.
   *
   * @remarks
   * - ⚠️ `blocking` : ni Échap ni clic sur le fond. Un téléchargement escamoté continuerait sans
   *   rien qui le montre, ni moyen d'y revenir. « Annuler » est la seule sortie.
   * - ⚠️ `bare`, le contenu portant déjà son titre aux deux temps. Le titre passé ici reste le
   *   nom accessible de la boîte, sans quoi un lecteur d'écran n'annoncerait que « dialogue ».
   */
  private askToInstall(language: Language): void {
    const running = computed(() => {
      const install = this.languages.install();
      return install?.language === language ? install : null;
    });

    this.awaiting.set(language);
    this.ref = this.modal.open<boolean, LanguageInstallData>(LanguageInstall, {
      heading: installConfirmHeading(language),
      data: {
        language,
        progress: computed(() => running()?.progress ?? null),
        indeterminate: computed(() => running() !== null),
        accept: () => void this.languages.requestInstall(language),
        cancel: () => {
          void this.languages.cancelInstall();
          this.ref?.close(false);
        },
      },
      bare: true,
      blocking: true,
      dismissible: false,
      width: INSTALL_MODAL_WIDTH,
    });

    void this.ref.closed.then(() => {
      this.awaiting.set(null);
      this.ref = null;
    });
  }
}
