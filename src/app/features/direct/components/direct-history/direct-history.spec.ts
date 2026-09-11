import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { By } from '@angular/platform-browser';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { HistoryPanel } from '../../../../shared/components/history-panel/history-panel';
import { DirectHistory } from './direct-history';
import { LiveHistoryStore } from '../../../../core/store/live-history/live-history.store';
import { Live } from '../../../../core/services/live/live';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import type { SessionSummary } from '../../../../core/services/bridge/live/live.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';

/** Le 5 août 2026 à 14:30 UTC. */
const STARTED_AT_MS = Date.UTC(2026, 7, 5, 14, 30);

function session(id: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: null,
    sourceName: 'Microsoft Teams',
    startedAtMs: STARTED_AT_MS,
    endedAtMs: STARTED_AT_MS + 48 * 60_000,
    preview: `ouverture ${id}`,
    hasReport: false,
    ...overrides,
  };
}

function harness(
  overrides: {
    entries?: SessionSummary[];
    confirm?: boolean;
    text?: string;
    sessions?: () => Promise<readonly SessionSummary[]>;
    clipboard?: () => Promise<void>;
  } = {},
) {
  const live = {
    sessions: vi.fn(
      overrides.sessions ?? (() => Promise.resolve(overrides.entries ?? [session(1)])),
    ),
    openSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    clearSessions: vi.fn().mockResolvedValue(undefined),
    sessionText: vi.fn().mockResolvedValue(overrides.text ?? 'Le compte rendu.'),
  };
  const modal = { confirm: vi.fn().mockResolvedValue(overrides.confirm ?? true) };
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(overrides.clipboard ?? (() => Promise.resolve())) },
  });

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Live, useValue: live },
      { provide: Modal, useValue: modal },
      { provide: Snackbar, useValue: snackbar },
      { provide: LOCALE_ID, useValue: 'fr' },
    ],
  });
  return { live, modal, snackbar, store: TestBed.inject(LiveHistoryStore) };
}

async function render(overrides: Parameters<typeof harness>[0] = {}) {
  const doubles = harness(overrides);
  const fixture = TestBed.createComponent(DirectHistory);
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { ...doubles, fixture, root: fixture.nativeElement as HTMLElement };
}

beforeEach(() => {
  // ⚠️⚠️ **JSDOM NE MET RIEN EN PAGE : SANS CELA, LE VIRTUAL SCROLL RENDRAIT ZÉRO LIGNE.** La
  // stratégie à taille fixe déduit la plage à afficher de la hauteur du viewport, que jsdom
  // rapporte à 0 — elle conclurait qu'aucune ligne n'est visible, et **tous** les tests de cette
  // liste vérifieraient du vide en croyant vérifier la liste.
  vi.spyOn(CdkVirtualScrollViewport.prototype, 'getViewportSize').mockReturnValue(600);
});

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('DirectHistory', () => {
  /**
   * ⚠️⚠️ **UNE SESSION SANS TITRE SE NOMME PAR SA DATE, ET C'EST LE CAS COURANT.** L'écrire en
   * base la figerait dans la langue du jour ; le repli se compose donc ici, avec `Intl`.
   */
  it('names an unnamed session by when it started, and dates it by its start', async () => {
    const { root } = await render();

    expect(root.querySelector('.rhist-title')?.textContent).toContain('Session du');
    // ⚠️ La méta dit **le début** et la durée, jamais la fin.
    // ⚠️ **Une classe d'espace, pas une espace** : `Intl` sépare le nombre de son unité par une
    // espace fine insécable (U+202F) en français. L'écrire en dur ferait échouer le test sur un
    // rendu parfaitement juste.
    expect(root.querySelector('.rhist-meta')?.textContent).toMatch(/48\s*min/u);
  });

  it('prefers the title the user wrote', async () => {
    const { root } = await render({ entries: [session(1, { title: 'Point client — Acme' })] });
    expect(root.querySelector('.rhist-title')?.textContent?.trim()).toBe('Point client — Acme');
  });

  /** ⚠️ **Les heures ne s'affichent qu'à partir d'une heure** — « 0 h 48 min » se lirait comme
   * une valeur manquante. */
  it('spells a long session in hours and minutes', async () => {
    const { root } = await render({
      entries: [session(1, { endedAtMs: STARTED_AT_MS + 65 * 60_000 })],
    });
    const meta = root.querySelector('.rhist-meta')?.textContent ?? '';
    expect(meta).toMatch(/1\s*h/u);
    expect(meta).toMatch(/5\s*min/u);
  });

  it('opens the session window on a click', async () => {
    const { root, fixture, live } = await render();
    root.querySelector<HTMLButtonElement>('.rhist-main')?.click();
    await fixture.whenStable();

    expect(live.openSession).toHaveBeenCalledWith(1);
  });

  it('copies the session text — the backend decides which text it is', async () => {
    const { root, fixture } = await render({ text: 'Résumé\nDeux points.' });
    root.querySelector<HTMLButtonElement>('.h-act.copy')?.click();
    await fixture.whenStable();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Résumé\nDeux points.');
  });

  it('says so when the clipboard refuses', async () => {
    const { root, fixture, snackbar } = await render({
      clipboard: () => Promise.reject(new Error('refusé')),
    });
    root.querySelector<HTMLButtonElement>('.h-act.copy')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(snackbar.error).toHaveBeenCalled();
  });

  it('deletes a single session WITHOUT asking', async () => {
    const { root, fixture, modal, live } = await render();
    root.querySelector<HTMLButtonElement>('.h-act.del')?.click();
    await fixture.whenStable();

    expect(modal.confirm).not.toHaveBeenCalled();
    expect(live.deleteSession).toHaveBeenCalledWith(1);
  });

  it('ALWAYS asks before emptying the whole history', async () => {
    // L'asymétrie est le sujet : un historique entier ne se retrouve pas.
    const { root, fixture, modal, live } = await render();
    root.querySelector<HTMLButtonElement>('.clear-all')?.click();
    await fixture.whenStable();

    expect(modal.confirm).toHaveBeenCalledOnce();
    expect(live.clearSessions).toHaveBeenCalledOnce();
  });

  it('empties nothing when the confirmation is declined', async () => {
    const { root, fixture, live } = await render({ confirm: false });
    root.querySelector<HTMLButtonElement>('.clear-all')?.click();
    await fixture.whenStable();

    expect(live.clearSessions).not.toHaveBeenCalled();
  });

  /**
   * ⚠️⚠️ **LA RECHERCHE PORTE SUR LE TITRE **ET** SUR LE DÉBUT DU TRANSCRIPT**, et elle tolère
   * les accents et la casse. Elle filtre la **source** du virtual scroll, jamais le DOM.
   */
  it('filters on the title and on the excerpt, tolerating accents and case', async () => {
    const { root, fixture } = await render({
      entries: [
        session(1, { title: 'Comité produit' }),
        session(2, { title: 'Autre chose', preview: 'on parle du budget' }),
        session(3, { title: 'Rétro sprint' }),
      ],
    });
    root.querySelector<HTMLButtonElement>('.search-toggle button')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const type = (value: string) => {
      const input = root.querySelector<HTMLInputElement>('.hist-search-input');
      input!.value = value;
      input!.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };

    // Sans accent ET en majuscules : les deux tolérances à la fois.
    type('COMITE');
    expect(root.querySelectorAll('.hist-item')).toHaveLength(1);

    type('budget');
    expect(root.querySelectorAll('.rhist-title')[0]?.textContent?.trim()).toBe('Autre chose');

    type('introuvable');
    expect(root.querySelector('.hist-noresult')?.textContent).toContain('Aucune session');
  });

  /**
   * ⚠️⚠️ **MILLE LIGNES, ET UNE POIGNÉE DE NŒUDS DANS LE DOM.** C'est la ligne de DoD de P4-11,
   * et elle ne se vérifie que par ce qui n'est **pas** rendu : sans recyclage, les mille
   * seraient là.
   */
  it('recycles the DOM instead of rendering a thousand rows', async () => {
    const many = Array.from({ length: 1_000 }, (_, index) => session(index + 1));
    const { root } = await render({ entries: many });

    const rendered = root.querySelectorAll('.hist-item').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(50);
  });

  it('invites the user to record when nothing was ever recorded', async () => {
    const { root } = await render({ entries: [] });
    expect(root.querySelector('.hist-empty')?.textContent).toContain('Aucune session');
  });

  it('reports a store failure once, then forgets it', async () => {
    const doubles = harness({ sessions: () => Promise.reject(new Error('base fermée')) });
    const fixture = TestBed.createComponent(DirectHistory);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(doubles.snackbar.error).toHaveBeenCalledOnce();
    expect(doubles.store.error()).toBeNull();
  });

  it('reports a failed open — nothing else would show it', async () => {
    const doubles = harness();
    doubles.live.openSession = vi.fn().mockRejectedValue(new Error('session purgée'));
    const fixture = TestBed.createComponent(DirectHistory);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.debugElement.query(By.directive(HistoryPanel)).componentInstance.open.emit(1);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(doubles.snackbar.error).toHaveBeenCalled();
  });

  it('puts a failed deletion back in the list', async () => {
    const doubles = harness();
    doubles.live.deleteSession = vi.fn().mockRejectedValue(new Error('base fermée'));
    const fixture = TestBed.createComponent(DirectHistory);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.debugElement.query(By.directive(HistoryPanel)).componentInstance.remove.emit(1);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(doubles.store.entries()).toHaveLength(1);
  });

  it('puts a failed clear back in the list', async () => {
    const doubles = harness();
    doubles.live.clearSessions = vi.fn().mockRejectedValue(new Error('base fermée'));
    const fixture = TestBed.createComponent(DirectHistory);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.debugElement.query(By.directive(HistoryPanel)).componentInstance.clearAll.emit();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(doubles.store.entries()).toHaveLength(1);
  });

  it('has no AXE violation', async () => {
    const { fixture } = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
