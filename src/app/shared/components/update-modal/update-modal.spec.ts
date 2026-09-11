import { describe, expect, it } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  UpdateModal,
  type UpdateAction,
  type UpdateModalData,
  type UpdateState,
} from './update-modal';
import { MODAL_DATA } from '../../../core/services/modal/modal-ref';
import { expectNoAxeViolations } from '../../../../testing/axe';

interface Harness {
  readonly fixture: ComponentFixture<UpdateModal>;
  readonly element: HTMLElement;
  readonly state: WritableSignal<UpdateState>;
  readonly actions: UpdateAction[];
  readonly message: () => string | undefined;
  readonly buttons: () => HTMLButtonElement[];
  readonly labels: () => (string | undefined)[];
  readonly variants: () => (string | null)[];
  readonly bar: () => HTMLElement | null;
  readonly fill: () => string | undefined;
  readonly setState: (state: UpdateState) => Promise<void>;
}

async function render(
  initial: { state?: UpdateState; version?: string; percent?: number } = {},
): Promise<Harness> {
  const state = signal<UpdateState>(initial.state ?? 'available');
  const version = signal(initial.version ?? '1.1.0');
  const percent = signal(initial.percent ?? 0);
  const actions: UpdateAction[] = [];
  const data: UpdateModalData = {
    state,
    version,
    percent,
    action: (action) => actions.push(action),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: MODAL_DATA, useValue: data }] });
  const fixture = TestBed.createComponent(UpdateModal);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;

  return {
    fixture,
    element,
    state,
    actions,
    message: () => element.querySelector('.up-msg')?.textContent?.trim(),
    buttons: () => [...element.querySelectorAll('button')],
    labels: () => [...element.querySelectorAll('button')].map((b) => b.textContent?.trim()),
    variants: () =>
      [...element.querySelectorAll('app-button')].map(
        (b) => [...b.classList].find((name) => name.startsWith('variant-')) ?? null,
      ),
    bar: () => element.querySelector<HTMLElement>('[role="progressbar"]'),
    fill: () =>
      element.querySelector<HTMLElement>('[role="progressbar"]')?.style.getPropertyValue('--fill'),
    setState: async (next: UpdateState) => {
      state.set(next);
      await fixture.whenStable();
    },
  };
}

describe('UpdateModal', () => {
  // ⚠️ Le voile, la boîte et l'ombre appartiennent au service `Modal` : ce composant n'est que
  // le contenu. Les redessiner ferait deux cartes l'une dans l'autre.
  it('ne dessine ni voile ni carte — la modale les porte déjà', async () => {
    const { element } = await render();

    expect(element.querySelector('.snackbar')).toBeNull();
    expect(element.querySelector('.snack')).toBeNull();
    expect(element.querySelector('[role="dialog"]')).toBeNull();
  });

  // ⚠️ Une modale s'annonce à l'ouverture, par son rôle et son nom : ce n'est pas une région
  // vivante. L'ancien `role="status" aria-live="polite"` de la barre n'a plus lieu d'être.
  it('n’est pas une région vivante', async () => {
    const { element } = await render();

    expect(element.querySelector('[role="status"]')).toBeNull();
    expect(element.querySelector('[aria-live]')).toBeNull();
  });

  describe('l’état « disponible »', () => {
    it('nomme la version proposée', async () => {
      expect((await render({ version: '2.4.1' })).message()).toBe(
        'Une nouvelle version est disponible (2.4.1).',
      );
    });

    it('offre de renoncer ou de lancer la mise à jour, dans cet ordre', async () => {
      const { labels, variants } = await render();

      expect(labels()).toEqual(['Plus tard', 'Mettre à jour']);
      expect(variants()).toEqual(['variant-neutral', 'variant-accent']);
    });

    it('n’affiche aucune progression — il n’y a rien en cours', async () => {
      expect((await render()).bar()).toBeNull();
    });

    it('porte l’icône de son état', async () => {
      expect((await render()).element.querySelector('.up-ico')).not.toBeNull();
    });

    it('émet ses deux intentions', async () => {
      const { buttons, actions } = await render();
      buttons()[0].click();
      buttons()[1].click();

      expect(actions).toEqual(['later', 'install']);
    });
  });

  describe('l’état « téléchargement »', () => {
    it('montre la progression', async () => {
      const { bar } = await render({ state: 'downloading', percent: 0.45 });

      expect(bar()?.getAttribute('aria-valuenow')).toBe('45');
    });

    // ⚠️ Le neutre n'existe que comme second d'une paire : seul, il se lit comme un bouton
    // éteint. « Annuler » est ici le seul bouton, il prend donc le bouton par défaut.
    it('ne propose que d’annuler, et ce bouton seul n’est pas neutre', async () => {
      const { labels, variants } = await render({ state: 'downloading' });

      expect(labels()).toEqual(['Annuler']);
      expect(variants()).toEqual(['variant-accent']);
    });

    it('fait tourner l’anneau, et lui seul', async () => {
      // La rotation est portée par le groupe SVG, jamais par l'hôte — voir `Icon`.
      const tournant = await render({ state: 'downloading' });
      const immobile = await render({ state: 'available' });

      expect(tournant.element.querySelector('svg > g.spin')).not.toBeNull();
      expect(immobile.element.querySelector('svg > g.spin')).toBeNull();
    });

    // ⚠️ La source est un compteur d'octets venu du réseau : une valeur hors bornes déborderait
    // la boîte. Le clamp est ici, pas chez l'appelant.
    it('borne une progression aberrante au lieu de déborder', async () => {
      const trop = await render({ state: 'downloading', percent: 4 });
      const negatif = await render({ state: 'downloading', percent: -1 });

      expect(trop.bar()?.getAttribute('aria-valuenow')).toBe('100');
      expect(trop.fill()).toBe('100%');
      expect(negatif.bar()?.getAttribute('aria-valuenow')).toBe('0');
      expect(negatif.fill()).toBe('0%');
    });

    it('émet son intention', async () => {
      const { buttons, actions } = await render({ state: 'downloading' });
      buttons()[0].click();

      expect(actions).toEqual(['cancel']);
    });
  });

  describe('l’état « prête »', () => {
    it('offre de renoncer ou de redémarrer, dans cet ordre', async () => {
      const { labels, message, variants } = await render({ state: 'ready' });

      expect(message()).toBe('Mise à jour prête à être installée.');
      expect(labels()).toEqual(['Plus tard', 'Redémarrer maintenant']);
      expect(variants()).toEqual(['variant-neutral', 'variant-accent']);
    });

    it('n’affiche plus de progression', async () => {
      expect((await render({ state: 'ready' })).bar()).toBeNull();
    });

    // ⚠️ Aucune icône, et pas non plus de gabarit vide : la flèche circulaire du redémarrage se
    // lisait « recharger », et un `<span>` conservé garderait la gouttière de la grille.
    it('ne porte aucune icône, le bouton disant déjà ce qu’on attend', async () => {
      const { element } = await render({ state: 'ready' });

      expect(element.querySelector('.up-ico')).toBeNull();
      expect(element.querySelector('app-icon')).toBeNull();
    });

    it('émet ses deux intentions', async () => {
      const { buttons, actions } = await render({ state: 'ready' });
      buttons()[0].click();
      buttons()[1].click();

      expect(actions).toEqual(['later', 'restart']);
    });
  });

  // ⚠️ « Plus tard » ne veut pas dire la même chose dans les deux états — renoncer au
  // téléchargement, ou renoncer au redémarrage. C'est l'hôte qui les distingue par l'état qu'il
  // a posé ; le composant, lui, n'émet qu'une intention.
  it('émet la même intention pour « Plus tard », quel que soit l’état', async () => {
    const { buttons, actions, setState } = await render();
    buttons()[0].click();
    await setState('ready');
    buttons()[0].click();

    expect(actions).toEqual(['later', 'later']);
  });

  it('n’a aucune cible cliquable hors de ses boutons', async () => {
    const { element, buttons } = await render();

    expect(buttons()).toHaveLength(2);
    expect(element.querySelectorAll('[role="button"]')).toHaveLength(0);
  });

  it('n’a aucune violation d’accessibilité, dans les trois états', async () => {
    for (const state of ['available', 'downloading', 'ready'] as const) {
      await expectNoAxeViolations((await render({ state, percent: 0.3 })).element);
    }
  });
});
