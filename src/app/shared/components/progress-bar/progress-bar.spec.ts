import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CANCEL_DELAY, ProgressBar } from './progress-bar';
import { expectNoAxeViolations } from '../../../../testing/axe';

interface Inputs {
  label?: string;
  progress?: number | null;
  detail?: string;
  cancellable?: boolean;
  cancelDelay?: number;
}

function render(inputs: Inputs = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(ProgressBar);
  fixture.componentRef.setInput('label', inputs.label ?? 'interview-podcast-ep12.mp3');
  for (const key of ['progress', 'detail', 'cancellable', 'cancelDelay'] as const) {
    if (inputs[key] !== undefined) {
      fixture.componentRef.setInput(key, inputs[key]);
    }
  }
  let cancellations = 0;
  fixture.componentInstance.cancelled.subscribe(() => {
    cancellations += 1;
  });
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    cancellations: () => cancellations,
    bar: () => element.querySelector('[role="progressbar"]'),
    cancel: () => element.querySelector<HTMLButtonElement>('app-button button'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('ProgressBar', () => {
  it('owns no box of its own — that is the whole point', () => {
    const { element } = render({ progress: 62 });

    // Ni titre de section, ni conteneur décoratif : seulement le contenu du bloc.
    expect(element.querySelector('h1, h2, h3, h4, header, section')).toBeNull();
    expect(element.querySelector('.label')?.textContent).toBe('interview-podcast-ep12.mp3');
  });

  it('fills the bar and shows the percentage when the duration is known', () => {
    const { element, bar } = render({ progress: 62 });

    expect(bar()?.getAttribute('aria-valuenow')).toBe('62');
    expect(bar()?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar()?.getAttribute('aria-valuemax')).toBe('100');
    expect(element.querySelector('.percent')?.textContent?.replace(/\s/g, '')).toBe('62%');
    // Le remplissage passe par une propriété personnalisée, pas par une largeur en ligne :
    // celle-ci l'emporterait sur la règle du mode indéterminé.
    expect(element.querySelector<HTMLElement>('.bar')?.style.getPropertyValue('--fill')).toBe(
      '62%',
    );
  });

  it('says "in progress, duration unknown" rather than "0 %" when indeterminate', () => {
    const { element, bar } = render({ progress: null });

    // Omettre `aria-valuenow` est ce qui distingue « on ne sait pas » de « rien n'est fait ».
    expect(bar()?.getAttribute('aria-valuenow')).toBeNull();
    expect(bar()?.className).toContain('indeterminate');
    expect(element.querySelector('.percent'), 'aucun pourcentage à afficher').toBeNull();
  });

  it('clamps a progress that would overflow the bar', () => {
    expect(render({ progress: 140 }).bar()?.getAttribute('aria-valuenow')).toBe('100');
    expect(render({ progress: -20 }).bar()?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('never shows a time remaining', () => {
    // Pas d'ETA, jamais : la vitesse sur l'appareil dépend du matériel, une estimation serait
    // fausse et tenue pour vraie.
    const { element } = render({ progress: 62, detail: '1,6 Go sur 4,3 Go' });

    expect(element.textContent).not.toMatch(/restant|remaining|ETA|min\b/i);
    expect(element.querySelector('.detail')?.textContent).toBe('1,6 Go sur 4,3 Go');
  });

  it('holds the cancel button back until the work has lasted long enough', () => {
    const { fixture, cancel } = render({ progress: 10 });

    expect(cancel(), 'un bouton qui clignote sur une opération brève ne sert personne').toBeNull();

    vi.advanceTimersByTime(CANCEL_DELAY - 1);
    fixture.detectChanges();
    expect(cancel()).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(cancel()).not.toBeNull();
  });

  it('offers cancellation immediately when the delay is zero', () => {
    // Le cas du téléchargement de modèle : plusieurs gigaoctets ne sont jamais une opération
    // courte, et faire attendre 2,5 s avant d'offrir la sortie n'aurait aucun sens.
    const { cancel } = render({ progress: 3, cancelDelay: 0 });

    expect(cancel()).not.toBeNull();
  });

  it('offers no cancellation at all when the work cannot be interrupted', () => {
    const { fixture, cancel } = render({ progress: 10, cancellable: false });

    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();
    expect(cancel()).toBeNull();
  });

  it('signals the intent to cancel, and stops there', () => {
    const { fixture, cancel, cancellations } = render({ progress: 10, cancelDelay: 0 });

    cancel()?.click();

    expect(cancellations()).toBe(1);
    // Il n'interrompt rien lui-même : la barre est toujours là, c'est à l'appelant d'agir.
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('restarts the countdown when the delay changes', () => {
    const { fixture, cancel } = render({ progress: 10 });

    vi.advanceTimersByTime(CANCEL_DELAY);
    fixture.detectChanges();
    expect(cancel()).not.toBeNull();

    fixture.componentRef.setInput('cancellable', false);
    fixture.detectChanges();
    expect(cancel()).toBeNull();
  });

  it('has no accessibility violation, determinate or not', async () => {
    vi.useRealTimers();
    await expectNoAxeViolations(render({ progress: 62 }).element);
    await expectNoAxeViolations(render({ progress: null }).element);
  });
});
