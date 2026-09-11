import { afterEach, describe, expect, it } from 'vitest';
import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Modal } from '../../../core/services/modal/modal';
import type { ModalRef } from '../../../core/services/modal/modal-ref';
import { Header, type ScreenId } from '../header/header';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — dans un VRAI navigateur. Voir `history-panel.layout.spec.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce qui se garde ici : la bande que le voile et la boîte laissent libre en haut de la fenêtre,
 * et ce qui devient cliquable dans cette bande.
 *
 * ⚠️ **Ces assertions ne peuvent pas vivre dans `modal-container.spec.ts`** : jsdom ne calcule
 * aucune géométrie, tout y mesure zéro, et ni un voile reparti de zéro ni un clic qui rate sa
 * cible n'y feraient rougir quoi que ce soit.
 */

/**
 * Un contenu plus haut que la fenêtre : c'est le seul qui pousse la boîte contre sa borne de
 * hauteur, donc le seul qui puisse la faire remonter par-dessus la barre de titre.
 */
@Component({ template: '<div style="height: 2000px"></div>' })
class Content {}

/** Le header réel, monté comme dans la coquille — c'est lui qui dépasse du voile. */
@Component({
  imports: [Header],
  template: '<app-header [current]="current()" (navigate)="demandes.push($event)" />',
})
class Host {
  readonly current = signal<ScreenId>('dictee');
  readonly demandes: ScreenId[] = [];
}

let ref: ModalRef<void> | null = null;
let racine: HTMLElement | null = null;

/**
 * Ouvre une vraie modale par le service : c'est l'attachement qui fait exister le voile.
 *
 * ⚠️ **L'attente n'est pas une précaution.** Le CDK applique sa stratégie de position après le
 * rendu : mesurée dans la foulée, la boîte est encore collée en haut à gauche, `position:
 * absolute` et `align-items: normal`. Un centrage cassé s'y lirait comme un centrage correct.
 */
async function ouvrir(options: { header?: boolean } = {}) {
  TestBed.resetTestingModule();
  const fixture = options.header === true ? TestBed.createComponent(Host) : null;
  if (fixture !== null) {
    racine = fixture.nativeElement as HTMLElement;
    document.body.appendChild(racine);
    fixture.detectChanges();
  }
  ref = TestBed.inject(Modal).open(Content, { heading: 'Participants', blocking: true });
  fixture?.detectChanges();
  TestBed.inject(ApplicationRef).tick();
  await new Promise((resolve) => {
    requestAnimationFrame(() => resolve(null));
  });

  return {
    fixture,
    veil: document.querySelector<HTMLElement>('.cdk-overlay-backdrop.modal-veil')!,
    boite: document.querySelector<HTMLElement>('.pmodal')!,
  };
}

/**
 * Ce que le curseur touche réellement au centre de `cible`.
 *
 * ⚠️ **Le détour par `elementFromPoint` est le test**, et `cible.click()` ne le remplace pas : un
 * appel direct dispatche l'évènement sur l'élément quoi qu'il ait devant lui, `inert` compris. Il
 * dirait vert sur une navigation parfaitement atteignable à la souris.
 */
function sousLeCurseur(cible: HTMLElement): Element {
  const rect = cible.getBoundingClientRect();
  return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)!;
}

/** Un clic de souris ordinaire, là où le curseur est vraiment tombé. */
function cliquer(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

afterEach(() => {
  ref?.close();
  ref = null;
  racine?.remove();
  racine = null;
});

describe('ModalContainer — mise en page réelle', () => {
  // ⚠️ La barre de titre porte toute la zone de déplacement de la fenêtre : voilée, la fenêtre
  // ne se déplace plus. Une modale bloque l'application, pas la fenêtre du système.
  it('ne couvre jamais la barre de titre', async () => {
    const { veil } = await ouvrir();

    // 50 px de barre, `HEADER_HEIGHT` côté natif, plus le filet qui la souligne.
    expect(veil.getBoundingClientRect().top).toBeGreaterThanOrEqual(51);
  });

  /**
   * ⚠️ Le voile épargné ne suffit pas : la boîte est centrée par le CDK, et sans la marge haute
   * comme sans la borne de hauteur elle remonte par-dessus la barre au travers du trou qu'on
   * vient d'y ouvrir. L'invariant tenu est celui de la bande : la boîte y tient entièrement, et
   * s'y centre — les deux gardes sont égales. Une seule des deux règles retirée le rompt
   * franchement, quand un seuil en pixels ne s'en écartait que d'un demi.
   */
  it('centre la boîte dans la bande que le voile épargne', async () => {
    const { veil, boite } = await ouvrir();
    const bande = veil.getBoundingClientRect();
    const rect = boite.getBoundingClientRect();

    // Les gardes d'abord : c'est l'égalité qui s'écarte franchement — de 51 px — dès qu'une des
    // deux règles manque, quand la seule appartenance à la bande ne se joue qu'à 1,5 px près.
    expect(rect.top - bande.top).toBeCloseTo(bande.bottom - rect.bottom, 0);
    expect(rect.top).toBeGreaterThanOrEqual(bande.top);
    expect(rect.bottom).toBeLessThanOrEqual(bande.bottom);
  });

  /**
   * ⚠️ **La régression que le voile raccourci a introduite.** Les entrées du header dépassent du
   * voile et rien ne les neutralisait : une modale `blocking` — le téléchargement d'un modèle,
   * pensé pour être infuyable — se contournait à la souris, et restait posée sur l'écran suivant.
   * Le piège de focus ne couvre que le clavier.
   */
  it('rend la navigation du header inopérante pendant une modale', async () => {
    const { fixture } = await ouvrir({ header: true });
    const entree = document.querySelector<HTMLElement>('.tb-right button')!;

    // Le survol ne descend plus dans la navigation : c'est ce que `pointer-events` seul ne
    // donnerait pas, et c'est aussi ce qui garde la zone de déplacement sous le curseur.
    const sous = sousLeCurseur(entree);
    expect(sous.closest('.tb-right')).toBeNull();
    expect(sous.closest('[data-tauri-drag-region]')).not.toBeNull();

    cliquer(sous);
    expect(fixture!.componentInstance.demandes).toEqual([]);
  });

  // ⚠️ La contrepartie, et elle vaut pour les trois sorties : Échap, le clic sur le fond et la
  // croix passent tous par `ModalRef.close`. Une navigation qui resterait morte après coup
  // enfermerait la fenêtre sur son écran.
  it('rend la navigation à la fermeture de la modale', async () => {
    const { fixture } = await ouvrir({ header: true });

    ref?.close();
    ref = null;
    fixture!.detectChanges();

    const sous = sousLeCurseur(document.querySelector<HTMLElement>('.tb-right button')!);
    expect(sous.closest('.tb-right')).not.toBeNull();

    cliquer(sous);
    expect(fixture!.componentInstance.demandes).toEqual(['direct']);
  });
});
