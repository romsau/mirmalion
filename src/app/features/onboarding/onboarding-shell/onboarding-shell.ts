import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Header } from '../../../shared/components/header/header';
import { OnboardingWelcome } from '../components/onboarding-welcome/onboarding-welcome';
import { OnboardingPermissions } from '../components/onboarding-permissions/onboarding-permissions';
import { OnboardingSpoken } from '../components/onboarding-spoken/onboarding-spoken';
import { OnboardingDownload } from '../components/onboarding-download/onboarding-download';
import { OnboardingTranslation } from '../components/onboarding-translation/onboarding-translation';
import type { PermissionKey } from '../components/permission-row/permission-row';
import { Permissions } from '../../../core/services/permissions/permissions';
import { Snackbar } from '../../../core/services/snackbar/snackbar';
import { SettingsStore } from '../../../core/store/settings/settings.store';
import { LanguagesStore } from '../../../core/store/languages/languages.store';
import { Translation } from '../../../core/services/translation/translation';
import { installProgressLabel } from '../../../core/models/language';
import type { Language } from '../../../core/models/settings';
import { SystemBridge } from '../../../core/services/bridge/system/system.bridge';

/** Les cinq étapes du parcours, dans l'ordre. */
type Step = 'welcome' | 'permissions' | 'spoken' | 'download' | 'translation';

/**
 * Intervalle de surveillance des autorisations, en millisecondes : assez court pour que le retour
 * des Réglages Système paraisse instantané, assez long pour que le pont ne pèse rien.
 *
 * @remarks
 * ⚠️ Sonder en boucle n'est licite que parce que lire ne demande rien, et c'est indispensable :
 * l'Accessibilité s'accorde hors de l'application, sans que rien ne l'en avertisse. Sans cette
 * surveillance, l'utilisateur revient devant une ligne inchangée et doit deviner « Revérifier ».
 */
const WATCH_INTERVAL_MS = 1_500;

/**
 * La fenêtre du premier lancement : sa barre de titre, l'étape affichée, et la sortie.
 *
 * Fenêtre Tauri à part — portrait et dédiée là où la principale est paysage —, d'où une route
 * sœur de `''`, hors de la coquille de l'application. Le `Header` y va sans navigation : ses
 * entrées mènent à des écrans que cette fenêtre n'a pas.
 *
 * @remarks
 * ⚠️ Seul composant du parcours qui agit — les cinq étapes rendent ce qu'on leur donne et
 * émettent ce qu'on leur demande. C'est ce qui rend vérifiable, sur un seul fichier, qu'aucun
 * pop-up macOS ni octet téléchargé ne part sans clic.
 */
@Component({
  selector: 'app-onboarding-shell',
  imports: [
    Header,
    OnboardingWelcome,
    OnboardingPermissions,
    OnboardingSpoken,
    OnboardingDownload,
    OnboardingTranslation,
  ],
  templateUrl: './onboarding-shell.html',
  styleUrl: './onboarding-shell.scss',
})
export class OnboardingShell {
  private readonly permissions = inject(Permissions);
  private readonly settings = inject(SettingsStore);
  private readonly snackbar = inject(Snackbar);
  private readonly system = inject(SystemBridge);

  private readonly languages = inject(LanguagesStore);
  private readonly translation = inject(Translation);

  /** L'étape à l'écran. */
  protected readonly step = signal<Step>('welcome');

  /** L'autorisation dont la demande est en vol, `null` s'il n'y en a pas. */
  protected readonly pending = signal<PermissionKey | null>(null);

  /** L'état lu par le service — jamais recopié ici, sans quoi il y aurait deux vérités. */
  protected readonly status = this.permissions.status;

  /**
   * Les langues parlées cochées, en mémoire seulement jusqu'à la sortie de l'étape.
   *
   * @remarks
   * ⚠️ Part sur la langue détectée au premier lancement (repli anglais) : c'est celle du système,
   * donc celle dont les ressources sont là, et la seule qu'on puisse pré-cocher sans rien
   * promettre.
   */
  protected readonly spokenChoice = signal<readonly Language[]>(
    this.settings.settings().spokenLanguages,
  );

  /** Les langues dont les ressources sont réellement présentes sur la machine. */
  protected readonly installed = computed(() => this.languages.installedLanguages());

  /** Les cibles de traduction cochées, écrites à la sortie du parcours. */
  protected readonly translationChoice = signal<readonly Language[]>([]);

  /**
   * La file d'installation est en train d'être remplie — l'étape ne peut pas encore juger qu'elle
   * est vide.
   *
   * @remarks
   * ⚠️ Un compteur à zéro ne dit pas « terminé » mais « rien en cours », et les deux ne se
   * distinguent qu'en sachant si le travail a commencé. Sans ce drapeau, l'effet de sortie voit
   * une file pas encore née, conclut « tout est fini » et saute l'étape : les langues
   * s'installent en arrière-plan, mais plus personne ne les active.
   */
  private readonly filling = signal(false);

  /** Le libellé de l'étape d'installation — les langues qu'elle va chercher. */
  protected readonly downloadLabel = signal('');

  /** L'avancement de l'installation en cours, `null` quand il n'y en a pas. */
  protected readonly downloadProgress = computed(() => this.languages.install()?.progress ?? null);

  constructor() {
    // Le minuteur tourne dès la construction et ne fait rien tant que l'étape Autorisations
    // n'est pas à l'écran : un garde dans `watch` coûte moins qu'un démarrage et un arrêt à
    // tenir synchronisés avec l'étape courante.
    const timer = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    void this.languages.watch();
    void this.languages.load();

    // ⚠️ C'est la file qui décide de la sortie de l'étape d'installation, pas un compteur tenu
    // ici : elle se vide de trois façons — tout installé, tout échoué, ou annulé — et les trois
    // se voient au même endroit.
    effect(() => {
      // ⚠️ `filling()` d'abord : tant que la file se remplit, un compteur à zéro ne dit rien.
      if (this.step() !== 'download' || this.filling() || this.languages.remaining() > 0) {
        return;
      }
      // ⚠️ Un échec ramène au choix des langues, il n'enchaîne pas : l'utilisateur y décoche la
      // langue fautive et repart, ou réessaie. Rien ne le bloque.
      if (this.languages.error() !== null) {
        this.languages.clearError();
        this.snackbar.error(
          $localize`:@@onboarding.spoken.downloadFailed:Le téléchargement n'a pas abouti. Réessayez, ou décochez cette langue pour continuer.`,
        );
        this.step.set('spoken');
        return;
      }
      this.enterTranslation();
    });
  }

  /**
   * « Commencer » : on passe aux autorisations, et on lit leur état dans la foulée.
   *
   * @remarks
   * ⚠️ Lire ne fait surgir aucun pop-up, d'où cet appel à l'arrivée sur l'étape — sans lui, la
   * première chose que l'utilisateur voit est trois lignes sans état.
   */
  protected next(): void {
    this.step.set('permissions');
    void this.recheck();
  }

  /** Les autorisations sont passées : on passe à la composition des langues. */
  protected toSpoken(): void {
    this.step.set('spoken');
  }

  /**
   * Coche ou décoche une langue parlée, et rien de plus : aucun octet ne part d'ici.
   *
   * La dernière langue allumée ne s'éteint pas — la liste fige son interrupteur et n'émet donc
   * jamais pour elle.
   */
  protected toggleSpoken(language: Language): void {
    this.spokenChoice.update((chosen) =>
      chosen.includes(language)
        ? chosen.filter((kept) => kept !== language)
        : [...chosen, language],
    );
  }

  /**
   * Coche une cible de traduction, et demande sa préparation à Apple — qui présente alors sa
   * propre feuille de téléchargement.
   *
   * @remarks
   * ⚠️ Seul un clic passe par ici : la case pré-cochée de la langue détectée est posée
   * directement sur le signal par {@link OnboardingShell.enterTranslation}, sans quoi une feuille
   * système surgirait à l'ouverture de l'écran.
   */
  protected toggleTranslation(language: Language): void {
    const chosen = this.translationChoice();
    if (chosen.includes(language)) {
      this.translationChoice.set(chosen.filter((kept) => kept !== language));
      return;
    }
    this.translationChoice.set([...chosen, language]);
    void this.translation.offerDownload(language, this.settings.settings().spokenLanguages);
  }

  /**
   * Le bouton de l'étape des langues — « Continuer » ou « Télécharger (n) », sa destination
   * suivant son libellé. Sauter par-dessus une installation annoncée serait un mensonge ; s'y
   * arrêter sans rien à obtenir serait un écran vide.
   */
  protected async actOnSpoken(): Promise<void> {
    const missing = this.spokenChoice().filter((language) => !this.installed().includes(language));
    if (missing.length === 0) {
      this.enterTranslation();
      return;
    }
    this.downloadLabel.set(installProgressLabel(missing));
    // ⚠️ `filling` se lève avant le changement d'étape et se baisse quand tout est en file : les
    // deux écritures encadrent la seule fenêtre où l'effet de sortie verrait une file vide qui
    // n'a pas encore commencé à exister.
    this.filling.set(true);
    this.step.set('download');
    try {
      for (const language of missing) {
        // ⚠️ Annuler pendant le remplissage doit arrêter le remplissage : `cancelDownload` vide
        // la file et quitte l'étape, mais cette boucle tourne encore — sans ce garde, elle
        // remettrait en file les langues suivantes juste après que l'utilisateur a dit non.
        if (this.step() !== 'download') {
          break;
        }
        await this.languages.requestInstall(language);
      }
    } finally {
      // ⚠️ `finally` : si le remplissage s'interrompt, l'étape doit redevenir jugeable, sinon
      // elle reste ouverte pour toujours sur une barre qui n'avancera jamais.
      this.filling.set(false);
    }
  }

  /**
   * « Annuler » : on interrompt vraiment, et on revient composer ses langues.
   *
   * @remarks
   * ⚠️ On quitte l'étape avant d'annuler : vider la file réveille l'effet de sortie, qui verrait
   * une file vide sur l'étape d'installation et enchaînerait sur la traduction.
   */
  protected async cancelDownload(): Promise<void> {
    this.step.set('spoken');
    await this.languages.cancelInstall();
  }

  /**
   * Entre dans l'étape Traduction, en enregistrant d'abord les langues parlées.
   *
   * @remarks
   * - ⚠️ Filtrées sur ce qui est installé : une langue cochée dont le téléchargement a été annulé
   *   ou a échoué ne doit pas se retrouver activée. Si le filtre ne laisse rien, la valeur en
   *   place est gardée — `spokenLanguages` vide, c'est une dictée sans langue.
   * - ⚠️ La case pré-cochée est un choix enregistré, jamais un geste : aucune préparation n'est
   *   déclenchée, sans quoi une feuille système surgirait à l'ouverture de l'écran.
   */
  private enterTranslation(): void {
    const kept = this.spokenChoice().filter((language) => this.installed().includes(language));
    const spokenLanguages = kept.length > 0 ? kept : this.settings.settings().spokenLanguages;
    void this.settings.update({ spokenLanguages });

    // ⚠️ La langue détectée, et non la première de la liste : `dictationLanguage` porte ce que
    // macOS a annoncé au premier lancement. Et rien n'est coché si l'utilisateur ne parle qu'une
    // langue — « dicter en français, traduire vers le français » ne ferait rien.
    const detected = this.settings.settings().dictationLanguage;
    this.translationChoice.set(spokenLanguages.length > 1 ? [detected] : []);
    this.step.set('translation');
  }

  /**
   * « Revérifier » : re-scanne tout, y compris ce qui coûte cher.
   *
   * Le bouton reste alors que l'écran surveille déjà, la surveillance ne retentant pas
   * l'enregistrement audio — voir {@link Permissions.recheck}.
   */
  protected async recheck(): Promise<void> {
    try {
      await this.permissions.recheck();
    } catch {
      this.snackbar.error(
        $localize`:@@onboarding.permissions.readFailed:L'état des autorisations n'a pas pu être lu.`,
      );
    }
  }

  /**
   * Un tour de surveillance : relit l'état, sans rien demander et sans rien dire.
   *
   * @remarks
   * - ⚠️ Ne surveille pas pendant qu'un prompt est ouvert : une lecture qui atterrirait après la
   *   réponse de l'utilisateur, mais avec un état d'avant, l'écraserait.
   * - ⚠️ Un échec ne produit aucune snackbar : répétée toutes les secondes et demie, elle
   *   deviendrait du harcèlement. « Revérifier », lui, répond explicitement.
   */
  private watch(): void {
    if (this.step() !== 'permissions' || this.pending() !== null) {
      return;
    }
    void this.permissions.refresh().catch(() => undefined);
  }

  /**
   * Le geste demandé par une ligne — un par autorisation, et ils ne se ressemblent pas : le micro
   * ouvre un prompt standard, l'Accessibilité ouvre les Réglages Système faute de prompt, et
   * l'enregistrement audio n'a d'autre déclencheur qu'un tap audio aussitôt détruit.
   *
   * @remarks
   * ⚠️ Rien ne s'échappe d'ici : appelée depuis le gabarit, une promesse rejetée finirait en
   * rejet non traité, muet pour l'utilisateur. `pending` retombe dans un `finally`, sans quoi un
   * refus laisserait le bouton désactivé pour toujours.
   */
  protected async act(key: PermissionKey): Promise<void> {
    this.pending.set(key);
    try {
      if (key === 'accessibility') {
        // ⚠️ Et on ne reprend pas le premier plan : l'utilisateur vient d'être envoyé dans les
        // Réglages Système pour y cocher une case, lui repasser devant l'en empêcherait.
        await this.permissions.requestAccessibility();
        return;
      }
      if (key === 'microphone') {
        await this.permissions.requestMicrophone();
      } else {
        await this.permissions.requestAudioCapture();
      }
      // ⚠️ Reprendre le premier plan après un prompt : l'application n'est pas dans le Dock, et
      // macOS rend la main à l'application précédente — la fenêtre d'onboarding disparaît
      // derrière les autres alors qu'on vient d'y cliquer. No-op si elle est déjà devant.
      await this.system.focusWindow();
    } catch {
      this.snackbar.error(
        $localize`:@@onboarding.permissions.askFailed:L'autorisation n'a pas pu être demandée. Réessayez, ou accordez-la dans les Réglages Système.`,
      );
    } finally {
      this.pending.set(null);
    }
  }

  /**
   * « Continuer » : l'onboarding est fait, l'application s'ouvre.
   *
   * @remarks
   * - ⚠️ L'ordre des trois gestes est contraint : écrire le drapeau, dire si l'écriture a échoué,
   *   fermer en dernier. Cette fenêtre est celle que le troisième détruit, et une écriture encore
   *   en vol mourrait avec elle — l'onboarding se rejouerait au lancement suivant.
   * - ⚠️ Rien ne peut être enchaîné après : en succès, la promesse ne se résout pas, sa réponse
   *   partant vers un webview détruit. Seul l'échec revient, et il laisse la fenêtre ouverte.
   */
  protected async finish(): Promise<void> {
    await this.settings.update({
      translationLanguages: this.translationChoice(),
      onboardingCompleted: true,
    });
    if (this.settings.isDegraded()) {
      this.snackbar.error(
        $localize`:@@onboarding.permissions.saveFailed:Vos réglages n'ont pas pu être enregistrés : la bienvenue se rejouera au prochain démarrage.`,
      );
    }
    try {
      await this.system.finishOnboarding();
    } catch {
      this.snackbar.error(
        $localize`:@@onboarding.permissions.exitFailed:L'application n'a pas pu s'ouvrir. Réessayez, ou passez par l'icône de la barre des menus.`,
      );
    }
  }
}
