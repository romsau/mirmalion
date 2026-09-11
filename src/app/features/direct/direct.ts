import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Icon } from '../../shared/components/icon/icon';
import { DirectConfig } from './components/direct-config/direct-config';
import { DirectHistory } from './components/direct-history/direct-history';
import { PanelStore } from '../../core/store/panel/panel.store';
import { DirectStore } from '../../core/store/direct/direct.store';
import { LiveHistoryStore } from '../../core/store/live-history/live-history.store';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { Live, NO_MICROPHONE } from '../../core/services/live/live';
import { liveClock } from '../../core/services/live/live-clock';
import { RecordingSound } from '../../core/services/overlay/recording-sound';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { toAppError } from '../../core/models/app-error';
import { Translation } from '../../core/services/translation/translation';
import type { Language, TranslationTarget } from '../../core/models/settings';
import { drainErrors } from '../../core/services/snackbar/drain-errors';

/**
 * Où mène la dernière ligne du menu de langue parlée.
 *
 * @remarks
 * ⚠️ Vers la liste elle-même, jamais vers `/options/langues` : cette page ne fait qu'annoncer
 * les deux listes, et y aboutir redemande ce que l'utilisateur venait de dire.
 */
const SPOKEN_LANGUAGES_ROUTE = '/options/langues/parlees';

/** L'autre liste : celle des langues vers lesquelles on peut traduire. */
const TRANSLATION_LANGUAGES_ROUTE = '/options/langues/traduction';

/**
 * L'écran déclencheur du Direct : le formulaire, le bouton qui bascule, un minuteur, l'historique.
 * Le transcript en direct vit dans la fenêtre-session, qui **est** la session.
 *
 * @remarks
 * - ⚠️ Fermer cette fenêtre n'arrête rien — l'inverse de la fenêtre-session.
 * - ⚠️ Ni coupure de la dictée ni affichage de la pilule ici : `start_live_capture` et
 *   `stop_live_capture` s'en chargent, la fenêtre pouvant être fermée en pleine capture.
 * - ⚠️ La source audio repart de zéro à chaque ouverture : rejouer le dernier choix ferait
 *   enregistrer Zoom pendant qu'on parle sur Teams. Elle vit dans `DirectStore`, pas en réglage.
 */
@Component({
  selector: 'app-direct',
  imports: [Icon, DirectConfig, DirectHistory],
  templateUrl: './direct.html',
  styleUrl: './direct.scss',
})
export class Direct {
  protected readonly store = inject(DirectStore);
  /** Le repli du panneau d'historique — partagé avec la largeur de la fenêtre. */
  protected readonly panel = inject(PanelStore);
  /**
   * L'historique, pour savoir s'il y a quelque chose à ouvrir — et rien d'autre. C'est
   * `DirectHistory` qui l'affiche ; il n'est ici que pour le bouton de repli, qui doit
   * disparaître quand le panneau n'a rien à montrer.
   */
  protected readonly history = inject(LiveHistoryStore);
  protected readonly settings = inject(SettingsStore);

  private readonly live = inject(Live);
  private readonly sound = inject(RecordingSound);
  private readonly router = inject(Router);
  private readonly translation = inject(Translation);
  private readonly snackbar = inject(Snackbar);

  /** Le minuteur de la session, partagé avec la fenêtre-session. */
  private readonly clock = liveClock(() => this.store.startedAtMs());

  /**
   * Le temps écoulé depuis le démarrage, en secondes.
   *
   * @remarks
   * ⚠️ Déduit de l'instant de départ, jamais incrémenté : un compteur ne survivrait ni à un
   * aller-retour vers les Options, ni à la fermeture de cette fenêtre.
   */
  protected readonly elapsedSeconds = this.clock.elapsedSeconds;

  private unlistenStopped: (() => void) | null = null;
  private unlistenFinalised: (() => void) | null = null;

  /** Les langues parlées activées — tout ce que le menu propose. */
  protected readonly spokenLanguages = computed(() => this.settings.settings().spokenLanguages);

  /** La langue parlée retenue pour la prochaine session. */
  protected readonly language = computed(() => this.settings.settings().liveLanguage);

  /** Faut-il mêler la voix de l'utilisateur au son capté ? */
  protected readonly includeMicrophone = computed(
    () => this.settings.settings().liveIncludeMicrophone,
  );

  /** Les langues de traduction activées. */
  protected readonly translationLanguages = computed(
    () => this.settings.settings().translationLanguages,
  );

  /** Vers quelle langue suivre la session, ou « aucune ». */
  protected readonly translationTarget = computed(
    () => this.settings.settings().liveTranslationTarget,
  );

  constructor() {
    void this.store.load();
    // ⚠️ Cette fenêtre peut être fermée puis rouverte en pleine session, et son magasin repart
    // alors de zéro : sans cette relecture, elle afficherait « Démarrer » sur un enregistrement
    // en cours, et un second clic ouvrirait une capture concurrente.
    void this.store.sync();
    // ⚠️ L'historique se lit ici, et pas seulement dans son panneau : replié, le panneau n'est
    // pas monté, et le bouton « Historique » s'afficherait sur du vide.
    void this.history.load();
    void this.listenToStop();

    drainErrors(this.store);

    // ⚠️ Le battement suit l'état, il n'est pas déclenché par le clic : c'est ce qui fait qu'un
    // retour sur l'écran en pleine session retrouve un minuteur qui avance.
    effect(() => {
      if (this.store.recording()) {
        this.clock.start();
      } else {
        this.clock.stop();
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.unlistenStopped?.();
      this.unlistenFinalised?.();
    });
  }

  /** Retient la source captée pour la prochaine session. */
  protected pickSource(sourceId: string | null): void {
    this.store.select(sourceId);
  }

  /**
   * Retient la langue parlée de la prochaine session, et lâche la traduction qu'elle rend
   * impossible.
   *
   * @remarks
   * ⚠️ La cible tombe dans le **même** patch que la langue : deux écritures successives feraient
   * passer l'écran par l'état que le menu ne propose plus — traduire une langue vers elle-même.
   */
  protected setLanguage(language: Language): void {
    void this.settings.update(
      this.translationTarget() === language
        ? { liveLanguage: language, liveTranslationTarget: 'none' }
        : { liveLanguage: language },
    );
  }

  /** Retient s'il faut mêler la voix de l'utilisateur au son capté. */
  protected setIncludeMicrophone(liveIncludeMicrophone: boolean): void {
    void this.settings.update({ liveIncludeMicrophone });
  }

  /**
   * Retient la cible de traduction, et propose la paire au téléchargement dans la foulée.
   *
   * @remarks
   * - ⚠️ C'est le seul endroit d'où la paire peut s'installer : Apple présente sa propre feuille,
   *   qui exige une fenêtre visible — impossible à placer une fois la session lancée.
   * - ⚠️ N'appeler qu'au choix explicite de l'utilisateur, jamais au chargement d'un écran :
   *   c'est ce qui garde l'unique appel réseau derrière un geste.
   * - ⚠️ `offerDownload` ne promet rien — feuille refermée, installation en arrière-plan. On
   *   n'attend pas et on ne bloque pas Démarrer : sans paire, les paragraphes restent en l'état.
   */
  protected setTranslationTarget(liveTranslationTarget: TranslationTarget): void {
    void this.settings.update({ liveTranslationTarget });
    if (liveTranslationTarget !== 'none') {
      void this.translation.offerDownload(liveTranslationTarget, [this.language()]);
    }
  }

  /**
   * Ouvre la liste où la famille de langues demandée se compose.
   *
   * @remarks
   * ⚠️ C'est une commande, pas une valeur : elle navigue et laisse le champ sur sa langue.
   */
  protected openLanguageOptions(list: 'spoken' | 'translation'): void {
    void this.router.navigateByUrl(
      list === 'spoken' ? SPOKEN_LANGUAGES_ROUTE : TRANSLATION_LANGUAGES_ROUTE,
    );
  }

  /**
   * Démarre l'enregistrement. La fenêtre-session s'ouvre avec lui, côté backend.
   *
   * @remarks
   * - ⚠️ Le son n'arrive qu'au succès : faire sonner le départ d'une session qui n'a pas commencé
   *   affirmerait le contraire de ce qui s'est passé.
   * - ⚠️ Aucun abonnement au transcript ici : c'est la fenêtre-session qui le porte, et elle
   *   s'abonne avant de lire son document — le moteur émet dès le démarrage et ne rejoue rien.
   */
  protected async start(): Promise<void> {
    // ⚠️ C'est ici que les deux réglages se rejoignent : l'appareil vient de `microphoneId`
    // (Options ▸ Général, partagé avec la dictée), le refus de sa propre voix vient de cet
    // écran. Le backend, lui, ne connaît qu'une valeur.
    const microphone = this.includeMicrophone()
      ? this.settings.settings().microphoneId
      : NO_MICROPHONE;
    // ⚠️ `'none'` devient `null` ici : le réglage dit « pas de traduction » avec une valeur, le
    // backend avec son absence. Les confondre ferait traduire vers une langue nommée « none ».
    const target = this.translationTarget();
    if (await this.store.start(microphone, this.language(), target === 'none' ? null : target)) {
      this.chime('start');
    }
  }

  /**
   * Arrête l'enregistrement. Ce bouton et celui de la fenêtre-session font la même chose : la
   * fenêtre principale reste utilisable pendant la session.
   *
   * @remarks
   * ⚠️ Le minuteur ne s'arrête pas ici : il suit `store.recording()`, que `stop()` fait retomber
   * même quand la fermeture échoue. Le couper en plus ferait deux sources de vérité.
   */
  protected async stop(): Promise<void> {
    await this.store.stop();
    this.chime('stop');
  }

  /**
   * Joue le son de départ ou d'arrêt. Le Direct l'appelle lui-même : le service ne s'abonne
   * qu'au raccourci de dictée. C'est lui qui consulte le réglage « Sons ».
   */
  private chime(action: 'start' | 'stop'): void {
    this.sound.play(action);
  }

  /**
   * Écoute l'arrêt de la session, d'où qu'il vienne.
   *
   * @remarks
   * ⚠️ Sans lui, arrêter depuis la fenêtre-session laisserait cet écran figé sur un formulaire
   * inactif et un minuteur qui court, pour une session déjà close.
   */
  private async listenToStop(): Promise<void> {
    try {
      this.unlistenStopped = await this.live.onStopped(() => this.store.stopped());
      // ⚠️ L'historique se relit à la consolidation, pas à l'arrêt : une session n'est archivée
      // qu'une fois consolidée, et relire sur `stopped` chercherait une ligne qui n'existe pas
      // encore — le panneau resterait en retard d'une session.
      this.unlistenFinalised = await this.live.onFinalised(() => void this.history.load());
    } catch (error) {
      this.snackbar.error(toAppError(error).message);
    }
  }
}
