import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Snackbar } from './snackbar';
import { SNACKBAR_DURATION } from '../../../shared/components/snackbar-item/snackbar-item';

const events = new Subject<NavigationStart>();

function service(): Snackbar {
  return TestBed.inject(Snackbar);
}

/** Ce que l'overlay a réellement produit dans le document. */
function bars() {
  return [...document.querySelectorAll('[role="alert"]')];
}

function message() {
  return document.querySelector('.snack-msg')?.textContent;
}

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: Router, useValue: { events } }],
  });
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('Snackbar', () => {
  it('shows an error — the use it exists for', () => {
    service().error('Le micro est indisponible.');

    expect(bars()).toHaveLength(1);
    expect(message()).toBe('Le micro est indisponible.');
    expect(document.querySelector('app-snackbar-item')?.className).toContain('tone-error');
  });

  it('shows info and success in their own tone', () => {
    service().info('Modèle téléchargé.');
    expect(document.querySelector('app-snackbar-item')?.className).toContain('tone-info');

    service().success('Dictionnaire importé.');
    expect(document.querySelector('app-snackbar-item')?.className).toContain('tone-success');
  });

  it('keeps a single bar — a new one replaces the previous', () => {
    service().error('Première');
    service().error('Seconde');

    expect(bars(), 'empiler des barres transforme une information en encombrement').toHaveLength(1);
    expect(message()).toBe('Seconde');
  });

  it('removes itself when the user navigates — an error belongs to its screen', () => {
    service().error('Le micro est indisponible.');
    expect(bars()).toHaveLength(1);

    events.next(new NavigationStart(1, '/direct'));

    expect(bars()).toHaveLength(0);
  });

  it('ignores router events that are not a navigation start', () => {
    service().error('Le micro est indisponible.');

    events.next({ id: 1, url: '/x' } as NavigationStart);

    expect(bars(), 'seul un départ de navigation retire la barre').toHaveLength(1);
  });

  it('disappears on its own, and cleans the overlay up', () => {
    vi.useFakeTimers();
    service().error('Le micro est indisponible.');

    vi.advanceTimersByTime(SNACKBAR_DURATION);

    expect(bars()).toHaveLength(0);
  });

  it('is dismissed by a click anywhere on the bar', () => {
    service().error('Le micro est indisponible.');

    document.querySelector<HTMLButtonElement>('.snack')?.click();

    expect(bars()).toHaveLength(0);
  });

  it('clears nothing when nothing is shown', () => {
    expect(() => {
      service().clear();
    }).not.toThrow();
    expect(bars()).toHaveLength(0);
  });
});
