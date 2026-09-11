import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Modal } from './modal';
import { MODAL_DATA, ModalRef } from './modal-ref';
import { expectNoAxeViolations } from '../../../../testing/axe';

/** Un composant qui n'a **pas** été écrit pour la modale : il ne fait que lire ce qu'on lui donne. */
@Component({
  template: `
    <p>{{ data }}</p>
    <button type="button" (click)="ref.close('validé')">Valider</button>
    <button type="button">Autre chose</button>
  `,
})
class Content {
  protected readonly data = inject<string>(MODAL_DATA);
  readonly ref = inject<ModalRef<string>>(ModalRef);
}

let trigger: HTMLButtonElement;

function service(): Modal {
  return TestBed.inject(Modal);
}

/** Ce que l'overlay a réellement produit dans le document. */
function overlay() {
  return {
    dialog: document.querySelector<HTMLElement>('[role="dialog"]'),
    veil: document.querySelector('.modal-veil'),
    panels: document.querySelectorAll('[role="dialog"]').length,
  };
}

function press(key: string) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

/**
 * Donne une géométrie aux éléments, le temps du fichier.
 *
 * ⚠️ **Sans cela, le piège de focus ne capture rien — et pas à cause d'un défaut du code.**
 * jsdom ne calcule aucune mise en page : `offsetWidth`, `offsetHeight` et `getClientRects()`
 * valent zéro pour **tout** élément. Or le CDK décide qu'un élément est focalisable en
 * regardant précisément cela (`InteractivityChecker.isVisible`). Il en conclut que rien ne
 * l'est, et le piège se tait.
 *
 * On rend donc une géométrie plausible. Ce qui est vérifié ensuite est le **vrai**
 * comportement du piège — il appelle réellement `focus()` — et non une imitation.
 */
const realClientRects = Element.prototype.getClientRects;

beforeAll(() => {
  Element.prototype.getClientRects = function getClientRects() {
    return [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
  };
});

afterAll(() => {
  Element.prototype.getClientRects = realClientRects;
});

beforeEach(() => {
  TestBed.resetTestingModule();
  // Un déclencheur focalisé au départ : c'est à lui que le focus doit revenir.
  trigger = document.createElement('button');
  trigger.textContent = 'Ouvrir';
  document.body.append(trigger);
  trigger.focus();
});

afterEach(() => {
  TestBed.resetTestingModule();
  trigger.remove();
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('Modal', () => {
  it('mounts an arbitrary component and hands it its data', () => {
    service().open(Content, { heading: 'Un titre', data: 'la donnée' });

    expect(overlay().dialog?.textContent).toContain('la donnée');
    expect(overlay().dialog?.textContent).toContain('Un titre');
  });

  it('passes a requested width down to the box, and nothing when none is asked', () => {
    service().open(Content, { heading: 'Un titre', data: 'x', width: 380 });
    expect(overlay().dialog?.style.width).toBe('380px');

    service().open(Content, { heading: 'Un titre', data: 'x' });
    expect(overlay().dialog?.style.width, 'sans largeur demandée, le palier de la feuille').toBe(
      '',
    );
  });

  it('resolves with what the mounted component closed with', async () => {
    const ref = service().open<string>(Content, { heading: 'Un titre', data: 'x' });

    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.trim() === 'Valider')
      ?.click();

    await expect(ref.closed).resolves.toBe('validé');
    expect(overlay().dialog, 'la modale doit être retirée du document').toBeNull();
  });

  it('closes with no result on Escape — an abandon is not a validation', async () => {
    const ref = service().open<string>(Content, { heading: 'Un titre', data: 'x' });

    press('Escape');

    await expect(ref.closed).resolves.toBeUndefined();
    expect(overlay().dialog).toBeNull();
  });

  it('closes with no result on a backdrop click', async () => {
    const ref = service().open<string>(Content, { heading: 'Un titre', data: 'x' });

    document.querySelector<HTMLElement>('.modal-veil')?.click();

    await expect(ref.closed).resolves.toBeUndefined();
    expect(overlay().dialog).toBeNull();
  });

  it('closes with no result on the header close button', async () => {
    const ref = service().open<string>(Content, { heading: 'Un titre', data: 'x' });

    document.querySelector<HTMLButtonElement>('.pmodal-head button')?.click();

    await expect(ref.closed).resolves.toBeUndefined();
    expect(overlay().dialog).toBeNull();
  });

  it('offers no escape at all when the modal is blocking', () => {
    // ⚠️ **Pour ce qui continue en tâche de fond**, et pour cela seulement : un téléchargement
    // qu'on escamote d'un clic à côté poursuit son travail sans que rien ne le montre, et sans
    // que l'utilisateur ait le moindre moyen d'y revenir ou de l'arrêter.
    service().open<string>(Content, { heading: 'Un titre', data: 'x', blocking: true });

    press('Escape');
    document.querySelector<HTMLElement>('.modal-veil')?.click();

    expect(overlay().dialog, 'une modale bloquante ne se ferme que par son contenu').not.toBeNull();
    // La croix disparaît avec les deux autres sorties : la laisser en rouvrirait une troisième.
    expect(document.querySelector('.pmodal-head button')).toBeNull();
  });

  it('drops its header when asked, without losing its accessible name', () => {
    // Une modale dont le contenu porte déjà son titre l'écrirait deux fois. Le nom, lui, reste
    // indispensable : sans lui, un lecteur d'écran annonce « dialogue » et rien d'autre.
    service().open<string>(Content, { heading: 'Un titre', data: 'x', bare: true });
    const dialog = overlay().dialog;

    expect(document.querySelector('.pmodal-head')).toBeNull();
    expect(dialog?.getAttribute('aria-label')).toBe('Un titre');
    expect(dialog?.getAttribute('aria-labelledby')).toBeNull();
  });

  it('passes the full-height request down to its container, and nothing by default', () => {
    service().open<string>(Content, { heading: 'Un titre', data: 'x', fill: true });
    expect(overlay().dialog?.className).toContain('is-fill');

    service().open<string>(Content, { heading: 'Un titre', data: 'x' });
    expect(overlay().dialog?.className).not.toContain('is-fill');
  });

  it('ignores every key but Escape', () => {
    service().open<string>(Content, { heading: 'Un titre', data: 'x' });

    press('Enter');
    press('a');

    expect(overlay().dialog, 'seule Échap ferme une modale').not.toBeNull();
  });

  it('returns focus to whatever opened it', async () => {
    const ref = service().open(Content, { heading: 'Un titre', data: 'x' });

    // La capture du focus est **asynchrone** : le piège la programme via `afterNextRender`,
    // donc elle n'a lieu qu'au rendu suivant. Dans l'application c'est `ApplicationRef.tick()`
    // qui le déclenche ; ici il faut le provoquer, sinon on mesure un focus qui n'a pas encore
    // eu lieu.
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement, 'le focus doit entrer dans la modale').not.toBe(trigger);
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);

    ref.close();
    await ref.closed;

    expect(document.activeElement).toBe(trigger);
  });

  it('wraps the keyboard around: tabbing past either edge comes back inside', async () => {
    service().open(Content, { heading: 'Un titre', data: 'x' });
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dialog = document.querySelector('[role="dialog"]');
    const anchors = document.querySelectorAll<HTMLElement>('.cdk-focus-trap-anchor');
    expect(anchors, 'le piège pose une ancre de chaque côté').toHaveLength(2);

    // jsdom n'implémente pas la navigation séquentielle du focus : on ne peut pas « appuyer sur
    // Tab ». Mais c'est justement par ces ancres que le CDK la rattrape — les atteindre est
    // exactement ce que produit un Tab depuis le dernier élément, ou un Maj+Tab depuis le
    // premier. Les focaliser, c'est donc éprouver le mécanisme, pas le contourner.
    anchors[1]?.focus();
    expect(dialog?.contains(document.activeElement), 'Tab au-delà de la fin revient dedans').toBe(
      true,
    );

    anchors[0]?.focus();
    expect(dialog?.contains(document.activeElement), 'Maj+Tab avant le début revient dedans').toBe(
      true,
    );
  });

  it('keeps a single modal open — two focus traps would fight over the keyboard', async () => {
    const first = service().open(Content, { heading: 'Première', data: 'x' });
    service().open(Content, { heading: 'Seconde', data: 'y' });

    expect(overlay().panels).toBe(1);
    expect(overlay().dialog?.textContent).toContain('Seconde');
    await expect(
      first.closed,
      'la première doit être fermée, pas oubliée',
    ).resolves.toBeUndefined();
  });

  it('closes only once, however many times it is asked', async () => {
    const ref = service().open<string>(Content, { heading: 'Un titre', data: 'x' });

    ref.close('premier');
    ref.close('second');

    await expect(ref.closed).resolves.toBe('premier');
  });

  describe('confirm', () => {
    const data = {
      heading: 'Supprimer ?',
      message: 'Action irréversible.',
      confirmLabel: 'Supprimer',
      cancelLabel: 'Annuler',
    };

    it('is a shortcut of the same service, not a second one', async () => {
      const answer = service().confirm(data);

      const dialog = overlay().dialog;
      expect(dialog?.textContent).toContain('Supprimer ?');
      expect(dialog?.textContent).toContain('Action irréversible.');
      // Une confirmation n'a pas de bouton de fermeture : ses deux issues sont déjà explicites.
      expect(dialog?.querySelectorAll('button')).toHaveLength(2);

      dialog?.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
      await expect(answer).resolves.toBe(true);
    });

    it('answers false on cancel, and false on Escape — both are abandons', async () => {
      const cancelled = service().confirm(data);
      overlay().dialog?.querySelectorAll<HTMLButtonElement>('button')[0]?.click();
      await expect(cancelled).resolves.toBe(false);

      const escaped = service().confirm(data);
      press('Escape');
      await expect(escaped).resolves.toBe(false);
    });

    it('has no accessibility violation while open', async () => {
      service().confirm(data);
      const dialog = overlay().dialog;
      expect(dialog).not.toBeNull();
      await expectNoAxeViolations(dialog as Element);
    });
  });

  describe('ask', () => {
    // La forme brute, dont `confirm` est la lecture en oui/non. ⚠️ Une **troisième** issue a
    // existé ici — « Fermer sans exporter », pour la modale de fermeture d'une fenêtre-document
    // retirée le 2026-08-03 —, et elle est partie avec elle : voir `ConfirmChoice`.
    const data = {
      heading: 'Fermer cette transcription ?',
      message: 'Elle n’est enregistrée nulle part.',
      confirmLabel: 'Fermer',
      cancelLabel: 'Annuler',
    };

    it('opens a box with exactly two ways out', async () => {
      const answer = service().ask(data);
      const buttons = overlay().dialog?.querySelectorAll<HTMLButtonElement>('button');

      expect(buttons).toHaveLength(2);
      buttons?.[0]?.click();
      await expect(answer).resolves.toBe('cancel');
    });

    it('reads Escape as a plain abandon, like the cancel button', async () => {
      const escaped = service().ask(data);
      press('Escape');
      await expect(escaped).resolves.toBe('cancel');
    });

    it('answers `confirm` on the recommended action', async () => {
      const answer = service().ask(data);
      overlay().dialog?.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
      await expect(answer).resolves.toBe('confirm');
    });
  });
});
