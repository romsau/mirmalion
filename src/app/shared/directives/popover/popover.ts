import {
  DestroyRef,
  Directive,
  ElementRef,
  Injector,
  ViewContainerRef,
  inject,
  input,
  output,
  signal,
  type TemplateRef,
} from '@angular/core';
import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

/**
 * Ce qu'un panneau offre au clavier, dans l'ordre du DOM.
 *
 * @remarks
 * ⚠️ Les exclusions font tout le travail : `focus()` sur une ligne désactivée ou sortie de la
 * tabulation est un non-évènement, et le focus resterait sur le déclencheur — le panneau
 * s'ouvrirait sans que le clavier y entre. Le cas est courant, une langue non installée ouvrant
 * un menu dont la première ligne est éteinte.
 */
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(', ');

/**
 * Ouvre un panneau ancré au déclencheur sur lequel elle est posée.
 *
 * Elle porte l'ancrage, la largeur alignée sur le déclencheur, la hauteur bornée à l'espace
 * réel — d'où un défilement interne plutôt qu'un débordement —, la fermeture sur Échap et sur
 * un clic dehors et sur rien d'autre, `aria-expanded` sur le déclencheur, et le retour du focus.
 *
 * @remarks
 * ⚠️ Le positionnement ne se teste pas en jsdom : aucun élément n'y a de géométrie, le CDK
 * calcule tout à partir de zéros. Ici se testent l'ouverture, la fermeture, les attributs et le
 * focus ; le rendu du panneau se vérifie à l'œil.
 */
@Directive({
  selector: '[appPopover]',
  // Référençable dans le gabarit (`#pop="appPopover"`) : c'est ce qui évite aux composants
  // d'aller la chercher par `viewChild`, et donc de porter une assertion générée qu'aucun test
  // ne peut atteindre.
  exportAs: 'appPopover',
  host: {
    '[attr.aria-expanded]': 'isOpen()',
    '(click)': 'toggle()',
  },
})
export class Popover {
  private readonly overlay = inject(Overlay);
  private readonly trigger = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly injector = inject(Injector);

  /** Le gabarit à monter dans le panneau. */
  readonly panel = input.required<TemplateRef<unknown>>({ alias: 'appPopover' });

  /**
   * La largeur minimale du panneau, en pixels.
   *
   * @remarks
   * ⚠️ Zéro par défaut : le panneau fait la largeur de son déclencheur, ni plus ni moins. Un
   * plancher fixe débordait des champs étroits — « Langue parlée » en fait 188. C'est à
   * l'appelant dont le déclencheur est minuscule, un bouton d'icône, d'en déclarer un.
   */
  readonly minWidth = input(0);

  /**
   * La hauteur maximale du panneau, en pixels. Le défaut vaut quatre lignes : 4 × 34 px
   * d'option, plus les 12 px de marge du panneau. Au-delà, on défile, comme un menu natif.
   *
   * @remarks
   * ⚠️ Une hauteur trop généreuse ne fait pas grandir le panneau : `withFlexibleDimensions` le
   * réduit à la place réelle, et c'est le défilement interne qui prend le relais. Un appelant
   * dont les lignes sont plus hautes passe la sienne.
   */
  readonly maxHeight = input(148);

  /**
   * De quel côté du déclencheur le panneau s'ouvre.
   *
   * @remarks
   * - ⚠️ C'est une déclaration, pas un repli : l'appelant désigne le côté une fois pour toutes,
   *   là où un CDK libre de choisir ferait sauter le panneau par-dessus le champ qui l'ouvre.
   * - ⚠️ `'above'` ne se pose que là où le déclencheur vit en bas d'une fenêtre à hauteur fixe,
   *   et où l'ouverture vers le bas ne laisserait voir que deux lignes.
   */
  readonly placement = input<'below' | 'above'>('below');

  /**
   * Déplacer le focus dans le panneau à l'ouverture.
   *
   * @remarks
   * ⚠️ Faux par défaut : un menu de type combobox garde le focus sur son déclencheur et désigne
   * l'option active par `aria-activedescendant`, et l'y déplacer casserait le motif. Seuls les
   * panneaux dont les lignes portent de vrais contrôles ont besoin de le recevoir.
   */
  readonly autoFocus = input(false);

  /** Le panneau vient de s'ouvrir. */
  readonly opened = output<void>();

  /** Le panneau vient de se fermer, quelle qu'en soit la cause. */
  readonly dismissed = output<void>();

  /** Le panneau est-il ouvert ? C'est lui qui porte l'`aria-expanded` du déclencheur. */
  readonly isOpen = signal(false);

  private overlayRef: OverlayRef | null = null;

  /** Referme le panneau si la directive est détruite alors qu'il est ouvert. */
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.close({ restoreFocus: false });
    });
  }

  /** Ouvre le panneau, ou le referme s'il l'était déjà. */
  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Ouvre le panneau et l'ancre au déclencheur. Sans effet s'il est déjà ouvert. */
  open(): void {
    if (this.isOpen()) {
      return;
    }

    const element = this.trigger.nativeElement;
    const overlayRef = this.overlay.create({
      // ⚠️ Un voile transparent, et non un écouteur sur le document : c'est ce qui garantit
      // qu'un clic dehors ferme le panneau avant d'atteindre ce qu'il y a dessous.
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
      panelClass: 'popover-panel',
      // La largeur est imposée, pas seulement minorée : le panneau colle au déclencheur.
      width: Math.max(element.getBoundingClientRect().width, this.minWidth()),
      maxHeight: this.maxHeight(),
      // ⚠️ Le défilement repositionne, il ne ferme pas : avec la stratégie `close()`, arrivé en
      // butée de la liste, le défilement se propageait à la page, qui émettait un `scroll`, et
      // le panneau disparaissait sous le doigt de l'utilisateur. Il ne se ferme que sur choix,
      // clic dehors ou Échap.
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      positionStrategy: this.overlay
        .position()
        .flexibleConnectedTo(element)
        .withFlexibleDimensions(true)
        .withViewportMargin(10)
        .withGrowAfterOpen(false)
        // ⚠️ `false` : on ne déplace pas le panneau pour le faire tenir, on le réduit. Avec
        // `true`, le CDK le remontait par-dessus son déclencheur dès que la place manquait en
        // dessous.
        .withPush(false)
        // ⚠️ Toujours une seule entrée dans ce tableau : c'est ce qui interdit au CDK de
        // choisir, et `placement` dit laquelle. Avec une position de repli, le panneau sautait
        // par-dessus le champ qui l'avait ouvert dès que la hauteur ne tenait plus en dessous ;
        // seul, `withFlexibleDimensions` le réduit à la place disponible et l'on défile dedans.
        .withPositions([
          this.placement() === 'above'
            ? {
                originX: 'start',
                originY: 'top',
                overlayX: 'start',
                overlayY: 'bottom',
                offsetY: -6,
              }
            : {
                originX: 'start',
                originY: 'bottom',
                overlayX: 'start',
                overlayY: 'top',
                offsetY: 6,
              },
        ]),
    });

    overlayRef.attach(
      new TemplatePortal(this.panel(), this.viewContainerRef, undefined, this.injector),
    );
    overlayRef.backdropClick().subscribe(() => {
      this.close();
    });
    overlayRef.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    overlayRef.detachments().subscribe(() => {
      // ⚠️ Un détachement venu du CDK plutôt que de `close()` : l'état doit suivre quoi qu'il
      // arrive, sinon le déclencheur reste marqué ouvert et le clic suivant ne rouvre rien.
      this.close();
    });

    this.overlayRef = overlayRef;
    this.isOpen.set(true);
    if (this.autoFocus()) {
      overlayRef.overlayElement.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
    this.opened.emit();
  }

  /**
   * Ferme le panneau et rend le focus au déclencheur. Sans effet s'il est déjà fermé.
   *
   * @param options - `restoreFocus: false` à la destruction seulement.
   * @remarks
   * ⚠️ Rendre le focus à un élément qui disparaît le renverrait au `<body>`, et la page
   * perdrait sa position.
   */
  close(options: { restoreFocus?: boolean } = {}): void {
    if (!this.isOpen()) {
      return;
    }
    this.isOpen.set(false);
    this.overlayRef?.dispose();
    this.overlayRef = null;
    if (options.restoreFocus !== false) {
      this.trigger.nativeElement.focus();
    }
    this.dismissed.emit();
  }
}
