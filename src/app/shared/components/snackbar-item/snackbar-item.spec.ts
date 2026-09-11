import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SNACKBAR_DURATION, SnackbarItem, type SnackbarTone } from './snackbar-item';
import { expectNoAxeViolations } from '../../../../testing/axe';

function render(inputs: { message?: string; tone?: SnackbarTone; duration?: number } = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(SnackbarItem);
  fixture.componentRef.setInput('message', inputs.message ?? 'Micro indisponible');
  if (inputs.tone !== undefined) {
    fixture.componentRef.setInput('tone', inputs.tone);
  }
  if (inputs.duration !== undefined) {
    fixture.componentRef.setInput('duration', inputs.duration);
  }
  let dismissals = 0;
  fixture.componentInstance.dismissed.subscribe(() => {
    dismissals += 1;
  });
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const bar = element.querySelector('button');
  if (bar === null) {
    throw new Error('aucune barre rendue');
  }
  return { fixture, element, bar, dismissals: () => dismissals };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('SnackbarItem', () => {
  it('announces itself to assistive technology as soon as it appears', () => {
    const { element } = render();
    const live = element.querySelector('[role="alert"]');

    expect(live?.getAttribute('aria-live')).toBe('assertive');
    expect(element.querySelector('.snack-msg')?.textContent).toBe('Micro indisponible');
  });

  it('makes the whole bar the dismiss target — no separate close button', () => {
    const { element, bar, dismissals } = render();

    expect(element.querySelectorAll('button'), 'une seule cible, pas de croix').toHaveLength(1);
    expect(bar.getAttribute('aria-label')).toBe('Fermer la notification');

    bar.click();
    expect(dismissals()).toBe(1);
  });

  it('disappears on its own after about six seconds', () => {
    const { dismissals } = render();

    vi.advanceTimersByTime(SNACKBAR_DURATION - 1);
    expect(dismissals()).toBe(0);

    vi.advanceTimersByTime(1);
    expect(dismissals()).toBe(1);
  });

  it('holds still while the pointer is on it, and restarts on leaving', () => {
    const { bar, dismissals } = render();

    vi.advanceTimersByTime(5000);
    bar.dispatchEvent(new MouseEvent('mouseenter'));

    vi.advanceTimersByTime(60_000);
    expect(dismissals(), 'survolée, elle ne disparaît pas').toBe(0);

    bar.dispatchEvent(new MouseEvent('mouseleave'));
    // Le compte à rebours repart de zéro : punir celui qui a survolé à 5,9 s serait absurde.
    vi.advanceTimersByTime(SNACKBAR_DURATION - 1);
    expect(dismissals()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(dismissals()).toBe(1);
  });

  it('holds still on keyboard focus too — otherwise a long message cannot be read', () => {
    const { bar, dismissals } = render();

    bar.dispatchEvent(new FocusEvent('focus'));
    vi.advanceTimersByTime(60_000);
    expect(dismissals()).toBe(0);

    bar.dispatchEvent(new FocusEvent('blur'));
    vi.advanceTimersByTime(SNACKBAR_DURATION);
    expect(dismissals()).toBe(1);
  });

  it('restarts its countdown when the message changes', () => {
    const { fixture, dismissals } = render();

    vi.advanceTimersByTime(5000);
    fixture.componentRef.setInput('message', 'Un autre problème');
    fixture.detectChanges();

    vi.advanceTimersByTime(5000);
    expect(dismissals(), 'les 6 s valent pour le message affiché, pas pour le composant').toBe(0);
    vi.advanceTimersByTime(1000);
    expect(dismissals()).toBe(1);
  });

  it('carries an alert icon on error, a check on success, and none on info', () => {
    expect(render({ tone: 'error' }).element.querySelector('app-icon')).not.toBeNull();
    expect(render({ tone: 'success' }).element.querySelector('app-icon')).not.toBeNull();
    expect(render({ tone: 'info' }).element.querySelector('app-icon')).toBeNull();
  });

  it('carries its tone on the host, which is where the colours hang', () => {
    expect(render({ tone: 'error' }).element.className).toContain('tone-error');
    expect(render({ tone: 'success' }).element.className).toContain('tone-success');
    expect(render().element.className).toContain('tone-info');
  });

  it('has no accessibility violation, whatever its tone', async () => {
    // AXE s'appuie sur ses propres minuteries : avec des minuteries feintes, il ne rend jamais
    // la main.
    vi.useRealTimers();

    for (const tone of ['error', 'info', 'success'] as const) {
      await expectNoAxeViolations(render({ tone }).element);
    }
  });
});
