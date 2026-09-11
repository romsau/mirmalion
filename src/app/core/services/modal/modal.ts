import { Injector, Service, inject, signal, type Type } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { ModalContainer } from '../../../shared/components/modal-container/modal-container';
import {
  ConfirmDialog,
  type ConfirmChoice,
  type ConfirmData,
} from '../../../shared/components/confirm-dialog/confirm-dialog';
import { MODAL_DATA, ModalRef } from './modal-ref';

/** Ce qu'une modale a besoin de savoir à l'ouverture. */
export interface ModalConfig<Data = unknown> {
  /**
   * Le titre affiché en en-tête, et le nom accessible de la boîte de dialogue.
   *
   * @remarks
   * ⚠️ Obligatoire pour cette seconde raison : sans lui, un lecteur d'écran n'annonce que
   * « dialogue ».
   */
  readonly heading: string;
  /** Ce que le composant monté reçoit par `MODAL_DATA`. */
  readonly data?: Data;
  /** 1, 2 ou 3 colonnes. Figée à l'ouverture — voir la feuille du conteneur. */
  readonly columns?: 1 | 2 | 3;
  /**
   * Une largeur propre, en pixels, quand les paliers de `columns` ne conviennent pas.
   *
   * Pour les boîtes plus étroites que la normale : une confirmation de deux lignes n'a pas à
   * occuper la largeur d'une modale de recherche. C'est la valeur de la maquette qui se passe ici.
   *
   * @remarks
   * ⚠️ Elle l'emporte sur `columns`, et la feuille du conteneur la borne à la fenêtre : une
   * largeur demandée n'est jamais une autorisation de déborder.
   */
  readonly width?: number;
  /**
   * La boîte prend toute la hauteur qu'on lui laisse, et son corps devient une colonne.
   *
   * L'équivalent du `h-fill` de la maquette, pour un contenu dont un enfant doit s'étirer — le
   * champ d'un prompt, qui remplit la modale.
   *
   * @remarks
   * ⚠️ Opt-in : le corps reste un bloc partout ailleurs, et une modale qui ne le demande pas ne
   * bouge pas d'un pixel. Sans les deux à la fois — la hauteur ET la colonne —, un enfant
   * `flex: 1` du contenu monté retombe sur sa hauteur minimale.
   */
  readonly fill?: boolean;
  /** Un bouton de fermeture en en-tête. Faux pour une confirmation, qui a déjà ses deux issues. */
  readonly dismissible?: boolean;
  /**
   * Aucun en-tête : le titre devient le nom accessible au lieu d'être affiché.
   *
   * Pour une modale dont le contenu porte déjà son propre titre — le bloc de progression, par
   * exemple, qui affiche son libellé. Sans cela il serait écrit deux fois.
   */
  readonly bare?: boolean;
  /**
   * La modale ne se ferme que par son contenu : ni Échap, ni clic sur le fond.
   *
   * @remarks
   * - ⚠️ Réservé à ce qui continue en tâche de fond : un téléchargement escamoté d'un clic à
   *   côté poursuit son travail sans que rien ne le montre ni ne permette de l'arrêter.
   * - ⚠️ Rien d'autre : une modale qu'on ne peut pas fuir est une impasse dès que son contenu
   *   ne propose pas d'issue.
   */
  readonly blocking?: boolean;
}

/**
 * Le point d'entrée unique de toutes les modales et overlays de l'application.
 *
 * Il gère le voile, le centrage, Échap, le clic sur le fond et le blocage du défilement
 * derrière. Le rôle ARIA, le nom accessible et le piège de focus vivent dans `ModalContainer`.
 *
 * @remarks
 * - ⚠️ L'overlay est borné à sa fenêtre, pas à un viewport global : chaque fenêtre est son
 *   propre webview, donc sa propre modale.
 * - ⚠️ Une seule modale à la fois : ouvrir en referme une autre. Deux voiles superposés
 *   empileraient deux pièges de focus qui se disputent le clavier.
 */
@Service()
export class Modal {
  private readonly overlay = inject(Overlay);
  private readonly injector = inject(Injector);

  private current: { close: () => void } | null = null;

  private readonly mounted = signal(false);

  /**
   * Vrai tant qu'une modale est montée, par quelque chemin qu'elle le soit.
   *
   * @remarks
   * ⚠️ **C'est ce qui neutralise la navigation du header**, qui dépasse du voile : celui-ci
   * s'arrête sous la barre de titre pour lui rendre sa zone de déplacement, et laisse donc les
   * trois entrées cliquables. Le piège de focus ne couvre que le clavier ; sans ce signal, une
   * modale `blocking` — un téléchargement de modèle — se contourne à la souris et reste posée
   * sur l'écran suivant.
   */
  readonly isOpen = this.mounted.asReadonly();

  /**
   * Monte n'importe quel composant dans l'overlay.
   *
   * Le composant reçoit `MODAL_DATA` et son `ModalRef` par injection — il n'a donc pas besoin
   * d'avoir été écrit pour cet usage, ni d'hériter de quoi que ce soit.
   */
  open<Result = void, Data = unknown>(
    component: Type<unknown>,
    config: ModalConfig<Data>,
  ): ModalRef<Result> {
    this.current?.close();

    const overlayRef = this.overlay.create({
      hasBackdrop: true,
      backdropClass: 'modal-veil',
      panelClass: 'modal-panel',
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    // ⚠️ `attach()`, et non une création de composant dans `overlayElement` : c'est
    // l'attachement qui fait exister le voile, enregistre l'overlay auprès du répartiteur
    // clavier et applique la stratégie de position. Sans lui la boîte s'affiche quand même,
    // mais ni Échap, ni le clic sur le fond, ni le piège de focus ne répondent.
    const containerRef = overlayRef.attach(
      new ComponentPortal(ModalContainer, null, this.injector),
    );

    const modalRef = new ModalRef<Result>(() => {
      overlayRef.dispose();
      this.current = null;
      this.mounted.set(false);
    });
    this.current = modalRef;
    // Posé après la fermeture de la précédente, dont le `dispose` vient de le remettre à faux.
    this.mounted.set(true);

    containerRef.setInput('heading', config.heading);
    containerRef.setInput('columns', config.columns ?? 1);
    containerRef.setInput('width', config.width ?? null);
    containerRef.setInput('bare', config.bare ?? false);
    containerRef.setInput('fill', config.fill ?? false);
    // ⚠️ Une modale bloquante n'a pas non plus de croix : ce serait une troisième sortie, quand
    // les deux autres viennent d'être fermées.
    containerRef.setInput('dismissible', (config.dismissible ?? true) && !config.blocking);
    containerRef.instance.dismissed.subscribe(() => {
      modalRef.close();
    });
    containerRef.changeDetectorRef.detectChanges();

    containerRef.instance.mount(
      component,
      Injector.create({
        parent: this.injector,
        providers: [
          { provide: MODAL_DATA, useValue: config.data },
          { provide: ModalRef, useValue: modalRef },
        ],
      }),
    );
    containerRef.changeDetectorRef.detectChanges();

    // Échap et clic-fond ferment sans résultat : ce sont des abandons, pas des validations.
    //
    // ⚠️ Une modale bloquante n'a ni l'un ni l'autre, et l'abonnement y serait faux : ce
    // qu'elle couvre continue en tâche de fond, escamoté sans rien pour le montrer ni l'arrêter.
    if (config.blocking !== true) {
      overlayRef.backdropClick().subscribe(() => {
        modalRef.close();
      });
      overlayRef.keydownEvents().subscribe((event) => {
        // ⚠️ `event.key`, et non `keyCode` : ce dernier est déprécié, absent des évènements
        // synthétiques, et vaut 0 sur plusieurs dispositions clavier.
        if (event.key === 'Escape') {
          event.preventDefault();
          modalRef.close();
        }
      });
    }

    return modalRef;
  }

  /**
   * Pose la question et rend le bouton pressé, tel quel.
   *
   * Forme brute, dont {@link Modal.confirm} est la lecture en oui/non ; elle porte le jour où
   * une boîte aura plus de deux issues.
   *
   * @returns le bouton pressé. Échap et le clic sur le fond rendent `'cancel'`, comme le bouton
   *   d'abandon : un abandon est un abandon, quelle qu'en soit la forme.
   */
  async ask(data: ConfirmData): Promise<ConfirmChoice> {
    const ref = this.open<ConfirmChoice, ConfirmData>(ConfirmDialog, {
      heading: data.heading,
      data,
      dismissible: false,
    });
    return (await ref.closed) ?? 'cancel';
  }

  /**
   * Le raccourci de confirmation : {@link Modal.open} avec `ConfirmDialog`.
   *
   * Méthode de commodité du même service, pas un second service — le jour où la confirmation
   * change d'allure, il y a un seul endroit à toucher.
   *
   * @returns `true` si l'utilisateur a confirmé. Échap, clic-fond et « Annuler » rendent tous
   *   `false` — seul `'confirm'` est un oui.
   */
  async confirm(data: ConfirmData): Promise<boolean> {
    return (await this.ask(data)) === 'confirm';
  }
}
