import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LiveHistoryStore } from './live-history.store';
import { Live } from '../../services/live/live';
import type { SessionSummary } from '../../services/bridge/live/live.bridge';

const STARTED_AT_MS = Date.UTC(2026, 7, 5, 14, 30);

function session(id: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: null,
    sourceName: 'Microsoft Teams',
    startedAtMs: STARTED_AT_MS,
    endedAtMs: STARTED_AT_MS + 60_000,
    preview: '',
    hasReport: false,
    ...overrides,
  };
}

function harness(overrides: Partial<Record<keyof Live, unknown>> = {}) {
  const live = {
    sessions: vi.fn().mockResolvedValue([session(1), session(2)]),
    openSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    clearSessions: vi.fn().mockResolvedValue(undefined),
    sessionText: vi.fn().mockResolvedValue('Le compte rendu.'),
    ...overrides,
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: Live, useValue: live }] });
  return { live, store: TestBed.inject(LiveHistoryStore) };
}

afterEach(() => TestBed.resetTestingModule());

describe('LiveHistoryStore', () => {
  it('reads the history and stops being "not read yet"', async () => {
    const { store } = harness();
    expect(store.empty()).toBe(false);

    await store.load();

    expect(store.entries()).toHaveLength(2);
    expect(store.empty()).toBe(false);
  });

  /**
   * ⚠️ **« Vide » n'est vrai qu'APRÈS la lecture** : le dire avant ferait clignoter l'invitation
   * de l'état vide à chaque ouverture de l'écran.
   */
  it('is empty only once it has read and found nothing', async () => {
    const { store } = harness({ sessions: vi.fn().mockResolvedValue([]) });
    await store.load();
    expect(store.empty()).toBe(true);
  });

  it('keeps the panel usable when the history refuses to be read', async () => {
    const { store } = harness({ sessions: vi.fn().mockRejectedValue(new Error('base fermée')) });
    await store.load();

    expect(store.error()?.message).toBe('base fermée');
    expect(store.entries()).toHaveLength(0);
    expect(store.empty()).toBe(true);
  });

  /**
   * ⚠️⚠️ **LE FILTRE PORTE SUR LE TITRE ET SUR L'APERÇU**, sans accents et sans casse — et **pas**
   * sur la source : « Microsoft Teams » ne s'affiche nulle part dans la liste, et faire remonter
   * une ligne sur un mot qu'on n'y voit pas donne un résultat qui a l'air faux.
   */
  it('filters on the title and the excerpt, never on the source', async () => {
    const { store } = harness({
      sessions: vi
        .fn()
        .mockResolvedValue([
          session(1, { title: 'Comité produit' }),
          session(2, { preview: 'on parle du budget Q3' }),
          session(3, { title: 'Rétro sprint' }),
        ]),
    });
    await store.load();

    store.setSearch('  COMITE ');
    expect(store.filtered().map((entry) => entry.id)).toEqual([1]);

    store.setSearch('budget');
    expect(store.filtered().map((entry) => entry.id)).toEqual([2]);

    store.setSearch('Teams');
    expect(store.filtered()).toHaveLength(0);

    store.setSearch('');
    expect(store.filtered()).toHaveLength(3);
  });

  it('opens a session through the domain service', async () => {
    const { store, live } = harness();
    await store.open(7);
    expect(live.openSession).toHaveBeenCalledWith(7);
  });

  /** ⚠️ **Le seul geste sans effet visible quand il rate** : sans message, on reclique. */
  it('says so when a session refuses to open', async () => {
    const { store } = harness({
      openSession: vi.fn().mockRejectedValue(new Error('session purgée')),
    });
    await store.open(7);
    expect(store.error()?.message).toBe('session purgée');
  });

  it('copies the text the backend composed', async () => {
    const { store } = harness();
    await store.copy(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Le compte rendu.');
  });

  it('says so when the clipboard refuses', async () => {
    const { store } = harness();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('refusé')) },
    });
    await store.copy(1);
    expect(store.error()?.message).toBe('refusé');
  });

  /** La ligne part **avant** l'aller-retour : le panneau répond au clic, pas au disque. */
  it('removes a session at once', async () => {
    const { store, live } = harness();
    await store.load();
    await store.remove(1);

    expect(live.deleteSession).toHaveBeenCalledWith(1);
    expect(store.entries().map((entry) => entry.id)).toEqual([2]);
  });

  it('puts a session back when its deletion fails', async () => {
    const { store } = harness({
      deleteSession: vi.fn().mockRejectedValue(new Error('base fermée')),
    });
    await store.load();
    await store.remove(1);

    expect(store.entries()).toHaveLength(2);
    expect(store.error()?.message).toBe('base fermée');
  });

  it('empties the whole history', async () => {
    const { store, live } = harness();
    await store.load();
    await store.clear();

    expect(live.clearSessions).toHaveBeenCalledOnce();
    expect(store.entries()).toHaveLength(0);
  });

  it('puts everything back when emptying fails', async () => {
    const { store } = harness({
      clearSessions: vi.fn().mockRejectedValue(new Error('base fermée')),
    });
    await store.load();
    await store.clear();

    expect(store.entries()).toHaveLength(2);
    expect(store.error()?.message).toBe('base fermée');
  });

  it('forgets an error once it has been said', async () => {
    const { store } = harness({ sessions: vi.fn().mockRejectedValue(new Error('base fermée')) });
    await store.load();
    store.clearError();
    expect(store.error()).toBeNull();
  });
});
