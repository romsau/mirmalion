import { describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OverlayPill } from './overlay-pill';
import type { OverlayState } from '../../../../core/services/bridge/overlay/overlay.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';

async function render(
  state: OverlayState,
  elapsedSeconds: number | null = null,
): Promise<ComponentFixture<OverlayPill>> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(OverlayPill);
  fixture.componentRef.setInput('state', state);
  fixture.componentRef.setInput('elapsedSeconds', elapsedSeconds);
  await fixture.whenStable();
  return fixture;
}

/** `fixture.nativeElement` est `any` : on le type une fois, ici. */
function rootOf(fixture: ComponentFixture<OverlayPill>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function labelOf(fixture: ComponentFixture<OverlayPill>): string {
  return rootOf(fixture).querySelector('.ro-label')?.textContent?.trim() ?? '';
}

function timerOf(fixture: ComponentFixture<OverlayPill>): Element | null {
  return rootOf(fixture).querySelector('.ro-timer');
}

describe('OverlayPill', () => {
  it('names each of the six states', async () => {
    // Les six sont construits dès maintenant, y compris ceux que la phase 2 n'atteindra pas :
    // « Traduction » attend son branchement, et le chrono la phase 4.
    const expected: ReadonlyArray<readonly [OverlayState, string]> = [
      ['listening', 'Écoute'],
      ['preparing', 'Préparation'],
      ['translating', 'Traduction'],
      ['done', 'Terminé !'],
      ['error', 'Erreur'],
    ];

    for (const [state, label] of expected) {
      expect(labelOf(await render(state))).toBe(label);
    }
  });

  it('animates an equaliser while listening, and an icon everywhere else', async () => {
    // ⚠️ L'égaliseur est **décoratif** : aucun niveau audio ne le pilote.
    const listening = rootOf(await render('listening'));
    expect(listening.querySelectorAll('.ro-wave i')).toHaveLength(5);
    expect(listening.querySelector('app-icon')).toBeNull();

    const done = rootOf(await render('done'));
    expect(done.querySelector('.ro-wave')).toBeNull();
    expect(done.querySelector('app-icon')).not.toBeNull();
  });

  it('carries no control at all — it is purely informative', async () => {
    // On arrête la dictée par le raccourci, la session depuis sa fenêtre. Un contrôle
    // ici serait inatteignable au clavier, la fenêtre ne prenant jamais le focus.
    for (const state of ['listening', 'done', 'error'] as const) {
      const root = rootOf(await render(state));
      expect(root.querySelector('button, a, input, [tabindex]')).toBeNull();
    }
  });

  it('announces itself as a live region', async () => {
    const host = rootOf(await render('preparing'));
    expect(host.getAttribute('role')).toBe('status');
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(host.getAttribute('data-state')).toBe('preparing');
  });

  it('shows no chrono in dictation — « Écoute » y est brève', async () => {
    // Le chrono est **la seule** différence entre dictée et session.
    expect(timerOf(await render('listening'))).toBeNull();
  });

  it('shows the chrono in live, in minutes and padded seconds', async () => {
    expect(timerOf(await render('listening', 0))?.textContent).toBe('0:00');
    expect(timerOf(await render('listening', 65))?.textContent).toBe('1:05');
  });

  it('does not wrap the minutes at an hour — a two-hour live reads 120:00', async () => {
    // Repartir de zéro ferait croire à un enregistrement qui recommence.
    expect(timerOf(await render('listening', 7_200))?.textContent).toBe('120:00');
  });

  it('drops the chrono as soon as listening ends', async () => {
    // Le temps qu'a duré l'enregistrement n'apprend plus rien, et occuperait la place du
    // verdict.
    expect(timerOf(await render('preparing', 42))).toBeNull();
    expect(timerOf(await render('done', 42))).toBeNull();
  });

  it('never shows a negative or fractional chrono', async () => {
    // Un compteur venu d'ailleurs peut valoir n'importe quoi ; la pilule doit rester lisible.
    expect(timerOf(await render('listening', -5))?.textContent).toBe('0:00');
    expect(timerOf(await render('listening', 9.7))?.textContent).toBe('0:09');
  });

  it('hides the chrono from assistive technology', async () => {
    // Sans cela, la région live annoncerait la seconde qui passe, indéfiniment.
    expect(timerOf(await render('listening', 3))?.getAttribute('aria-hidden')).toBe('true');
  });

  it('has no AXE violation, in every state', async () => {
    for (const state of ['listening', 'preparing', 'translating', 'done', 'error'] as const) {
      const fixture = await render(state, 12);
      await expectNoAxeViolations(fixture.nativeElement);
    }
  });
});
