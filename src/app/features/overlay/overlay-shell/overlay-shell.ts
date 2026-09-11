import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { OverlayPill } from '../components/overlay-pill/overlay-pill';
import { OVERLAY_EVENT } from '../../../core/services/bridge/overlay/overlay.bridge';
import type {
  OverlayPayload,
  OverlayState,
} from '../../../core/services/bridge/overlay/overlay.bridge';
import { TICK_INTERVAL_MS } from '../../../core/models/timing';
import { OverlayBridge } from '../../../core/services/bridge/overlay/overlay.bridge';
import { Invoke } from '../../../core/services/bridge/invoke/invoke';
import { subscriptions } from '../../../core/services/bridge/subscriptions';

/**
 * Combien de temps un état terminal reste affiché avant de s'effacer.
 *
 * Deux secondes : assez pour être vu du coin de l'œil, assez court pour ne pas rester dans le
 * champ de vision pendant qu'on relit le texte qui vient d'être inséré.
 */
const TERMINAL_DISMISS_MS = 2_000;

/** Les états qui s'effacent seuls. Les autres attendent la suite du pipeline. */
const TERMINAL_STATES: readonly OverlayState[] = ['done', 'error'];

/**
 * Tous les états, pour mesurer le pire cas.
 *
 * @remarks
 * ⚠️ La liste doit rester complète : la largeur est celle du pire état, mesurée une fois. En
 * omettre un ferait grandir la fenêtre en pleine session, puis rétrécir — un sursaut au-dessus
 * de toutes les applications.
 */
const ALL_STATES: readonly OverlayState[] = [
  'listening',
  'preparing',
  'translating',
  'done',
  'error',
  'suspended',
];

/**
 * Le chrono le plus large qu'une session puisse afficher : `599:59`, six caractères.
 *
 * @remarks
 * ⚠️ N'entre dans la mesure que si le chrono est demandé — donc jamais en dictée, où il
 * élargirait la pilule d'un tiers pour un nombre qui ne s'affiche pas.
 */
const WIDEST_ELAPSED_SECONDS = 599 * 60 + 59;

/**
 * La fenêtre flottante de l'overlay : elle rend l'état que le backend détient
 * (`commands/overlay.rs`), et ne décide que de son propre effacement et de son chrono — les deux
 * seules choses qui dépendent du temps qui passe.
 *
 * @remarks
 * - ⚠️ Elle lit l'état courant au démarrage : son webview met quelques dizaines de millisecondes
 *   à monter, et un évènement émis pendant ce temps n'a personne pour l'entendre.
 * - ⚠️ La fenêtre **est** la pilule — pas de transparence, qui exigerait des API privées d'Apple.
 *   Sa largeur suit donc le texte, que seul le webview peut mesurer ; le backend la borne.
 */
@Component({
  selector: 'app-overlay-shell',
  imports: [OverlayPill],
  templateUrl: './overlay-shell.html',
  styleUrl: './overlay-shell.scss',
})
export class OverlayShell {
  private readonly bridge = inject(OverlayBridge);
  private readonly core = inject(Invoke);

  /** Ce que la pilule doit afficher, `null` tant que rien n'est arrivé. */
  protected readonly payload = signal<OverlayPayload | null>(null);

  /** Le chrono en secondes, `null` quand il n'y a pas de chrono à montrer. */
  protected readonly elapsedSeconds = signal<number | null>(null);

  /** Tous les états, rendus une fois en gabarit fantôme pour mesurer le pire cas. */
  protected readonly states = ALL_STATES;

  /** Le gabarit de mesure est-il encore nécessaire ? Voir {@link OverlayShell.fitWindow}. */
  protected readonly measuring = signal(true);

  /** Le chrono à réserver dans la mesure : celui d'une longue session, ou aucun. */
  protected readonly widestElapsed = computed(() =>
    this.payload()?.chrono === true ? WIDEST_ELAPSED_SECONDS : null,
  );

  /**
   * L'élément de la coquille, d'où l'on retrouve la pilule pour la mesurer.
   *
   * @remarks
   * ⚠️ Pas une requête de vue : une variable de gabarit posée sur un composant désigne son
   * instance, pas son élément, et l'option `read: ElementRef` qui corrige cela laisse dans le
   * code produit une fonction que rien n'appelle — un trou de couverture inatteignable.
   */
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Le compte à rebours d'effacement en cours, s'il y en a un. */
  private dismissal: ReturnType<typeof setTimeout> | null = null;

  /** Le battement du chrono, s'il tourne. */
  private ticker: ReturnType<typeof setInterval> | null = null;

  /** La dernière taille demandée, pour ne pas rappeler le backend à chaque rendu. */
  private lastSize = '';

  /** La largeur du pire état, mesurée une fois pour toutes. */
  private widest = 0;

  /** L'abonnement à l'état de l'overlay, libéré à la fermeture de la fenêtre. */
  private readonly subs = subscriptions();

  constructor() {
    void this.start();

    // Après chaque rendu : la pilule a sa taille définitive, la fenêtre peut s'y ajuster.
    afterRenderEffect(() => {
      this.payload();
      this.elapsedSeconds();
      void this.fitWindow();
    });

    inject(DestroyRef).onDestroy(() => {
      this.stopDismissal();
      this.stopTicker();
    });
  }

  /**
   * S'abonne aux changements, puis lit l'état courant.
   *
   * @remarks
   * ⚠️ Dans cet ordre : l'inverse laisserait passer un évènement émis entre la lecture et
   * l'abonnement — justement le plus récent, donc celui qui compte.
   */
  private async start(): Promise<void> {
    await this.subs.keep(
      this.core.listen<OverlayPayload>(OVERLAY_EVENT, (payload) => this.apply(payload)),
    );
    if (!this.subs.alive()) {
      return;
    }

    const current = await this.bridge.getOverlayState();
    // ⚠️ Un évènement déjà reçu gagne sur la lecture initiale : il est plus récent, et l'écraser
    // ferait reculer la pilule d'un cran.
    if (current && this.payload() === null) {
      this.apply(current);
    }
  }

  /** Prend en compte un nouvel état : le chrono et l'effacement en découlent. */
  private apply(payload: OverlayPayload): void {
    this.payload.set(payload);
    this.restartTicker(payload);
    this.scheduleDismissal(payload.state);
  }

  /**
   * (Re)démarre le chrono, ou l'arrête.
   *
   * @remarks
   * ⚠️ Il repart de zéro à l'entrée en écoute, et seulement là : recevoir deux fois le même état
   * — le pipeline republie sans changement — ne doit pas remettre le compteur à zéro.
   */
  private restartTicker(payload: OverlayPayload): void {
    const counting = payload.state === 'listening' && payload.chrono;
    if (!counting) {
      this.stopTicker();
      this.elapsedSeconds.set(null);
      return;
    }
    if (this.ticker !== null) {
      return;
    }
    // Le compte vit ici et non dans le signal : celui-ci peut valoir `null` — il porte aussi
    // « pas de chrono » —, et lui ajouter 1 demanderait un repli qu'aucun chemin n'emprunte.
    let seconds = 0;
    this.elapsedSeconds.set(seconds);
    this.ticker = setInterval(() => {
      seconds += 1;
      this.elapsedSeconds.set(seconds);
    }, TICK_INTERVAL_MS);
  }

  /** Programme l'effacement d'un état terminal, ou annule celui qui était en cours. */
  private scheduleDismissal(state: OverlayState): void {
    this.stopDismissal();
    if (!TERMINAL_STATES.includes(state)) {
      return;
    }
    this.dismissal = setTimeout(() => {
      this.dismissal = null;
      // ⚠️ Oublier la taille est ce qui fait revenir la pilule : le backend la révèle au moment
      // où on lui demande sa géométrie, et `fitWindow` court-circuite quand la taille n'a pas
      // bougé. Sans cette remise à zéro, la deuxième dictée d'affilée resterait invisible. La
      // fenêtre n'est pas détruite : la recréer volerait le focus au champ en cours de saisie.
      this.lastSize = '';
      void this.bridge.hideOverlay();
    }, TERMINAL_DISMISS_MS);
  }

  /**
   * Demande au backend de tailler la fenêtre. La hauteur suit la pilule affichée, qui ne dépend
   * pas du libellé ; le backend élargit encore jusqu'à l'encoche de l'écran s'il y en a une.
   *
   * @remarks
   * - ⚠️ La largeur est celle du pire état, pas de l'état courant : « Écoute » fait 158 px et
   *   « Indisponible » 214 px, et suivre l'état ferait grandir puis rétrécir la pilule à chaque
   *   étape, sous les yeux de qui attend son texte.
   * - ⚠️ Court-circuité si la taille n'a pas bougé : le rendu se déclenche à chaque seconde du
   *   chrono, et redemander la même géométrie ferait clignoter la fenêtre pour rien.
   */
  private async fitWindow(): Promise<void> {
    const element = this.host.nativeElement.querySelector('app-overlay-pill');
    if (!element) {
      return;
    }
    if (this.measuring()) {
      this.widest = this.measureWidest();
      // Le gabarit a servi : on le retire du DOM, avec ses six animations.
      this.measuring.set(false);
    }
    // ⚠️ Un seul relevé pour les deux dimensions : `getBoundingClientRect` force un reflux, et
    // ce chemin s'exécute à chaque seconde du chrono.
    const box = element.getBoundingClientRect();
    const height = box.height;
    const width = Math.max(this.widest, Math.ceil(box.width));
    const size = `${width}×${Math.ceil(height)}`;
    if (size === this.lastSize) {
      return;
    }
    this.lastSize = size;
    await this.bridge.resizeOverlay(width, Math.ceil(height));
  }

  /**
   * La largeur du plus large des états, telle que le gabarit fantôme vient de la rendre.
   *
   * @returns `0` si le gabarit n'est pas là — hors navigateur avec mise en page, toutes les
   * mesures valent zéro, et `fitWindow` retombe alors sur la pilule affichée.
   */
  private measureWidest(): number {
    const ghosts = this.host.nativeElement.querySelectorAll('.overlay-measure app-overlay-pill');
    let widest = 0;
    for (const ghost of Array.from(ghosts)) {
      widest = Math.max(widest, Math.ceil(ghost.getBoundingClientRect().width));
    }
    return widest;
  }

  /** Annule l'effacement programmé. Sans effet s'il n'y en a pas. */
  private stopDismissal(): void {
    if (this.dismissal !== null) {
      clearTimeout(this.dismissal);
      this.dismissal = null;
    }
  }

  /** Coupe le chrono. Sans effet s'il ne tourne pas. */
  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
