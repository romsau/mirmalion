import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DocOverlay } from './doc-overlay';
import { CANCEL_DELAY } from '../progress-bar/progress-bar';
import { expectNoAxeViolations } from '../../../../testing/axe';

interface Inputs {
  readonly label?: string;
  readonly progress?: number | null;
  readonly cancellable?: boolean;
}

function render(inputs: Inputs = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(DocOverlay);
  fixture.componentRef.setInput('label', inputs.label ?? 'Ré-analyse des locuteurs…');
  for (const key of ['progress', 'cancellable'] as const) {
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

describe('DocOverlay', () => {
  // ⚠️ Il n'apporte QUE la boîte : le voile, le centrage et la largeur. La barre, le
  // pourcentage et « Annuler » viennent de `ProgressBar` — la maquette en portait deux
  // écritures (`.fprog` et `.dl-*`), il n'en reste qu'une.
  it('confie la barre à `ProgressBar` plutôt que d’en redessiner une', () => {
    const { element, bar } = render({ progress: 42 });

    expect(element.querySelector('app-progress-bar')).not.toBeNull();
    expect(element.querySelectorAll('.bar')).toHaveLength(1);
    expect(bar()?.getAttribute('aria-valuenow')).toBe('42');
    expect(element.querySelector('.label')?.textContent?.trim()).toBe('Ré-analyse des locuteurs…');
  });

  // ⚠️ Il n'invente aucune progression : `null` veut dire « en cours, durée inconnue », et se
  // rend en barre indéterminée — surtout pas en « 0 % ».
  it('passe en indéterminé quand la durée est inconnue', () => {
    const { bar } = render({ progress: null });

    expect(bar()?.classList.contains('indeterminate')).toBe(true);
    expect(bar()?.getAttribute('aria-valuenow')).toBeNull();
  });

  it('signale l’annulation sans rien interrompre lui-même', () => {
    const { fixture, cancel, cancellations } = render({ progress: null });

    vi.advanceTimersByTime(CANCEL_DELAY);
    fixture.detectChanges();
    cancel()?.click();

    expect(cancellations()).toBe(1);
  });

  it('n’offre aucune sortie quand l’opération n’est pas interruptible', () => {
    const { fixture, cancel } = render({ progress: null, cancellable: false });

    vi.advanceTimersByTime(CANCEL_DELAY);
    fixture.detectChanges();

    expect(cancel()).toBeNull();
  });

  it('n’a aucune violation d’accessibilité', async () => {
    // ⚠️ AXE est asynchrone : les minuteurs simulés le feraient attendre indéfiniment.
    vi.useRealTimers();
    await expectNoAxeViolations(render({ progress: 42 }).element);
  });
});
