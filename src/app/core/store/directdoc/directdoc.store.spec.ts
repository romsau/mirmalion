import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DirectdocStore } from './directdoc.store';
import { Live } from '../../services/live/live';
import type { LiveDocument } from '../../services/bridge/live/live.bridge';

const STARTED_AT = new Date(2026, 7, 4, 14, 30).getTime();

function session(overrides: Partial<LiveDocument> = {}): LiveDocument {
  return {
    id: 'live-3',
    title: 'Session produit hebdo',
    sourceName: 'Microsoft Teams',
    startedAtMs: STARTED_AT,
    endedAtMs: STARTED_AT + 3_600_000,
    transcript: { language: 'fr', paragraphs: [] },
    report: [],
    translationTarget: null,
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const live = {
    document: vi.fn().mockResolvedValue(session()),
    rename: vi.fn().mockResolvedValue(session({ title: 'Autre titre' })),
    generateReport: vi.fn().mockResolvedValue(session({ report: [] })),
    translateTranscript: vi.fn().mockResolvedValue({ kind: 'translated', paragraphs: [] }),
    translateReport: vi.fn().mockResolvedValue({ kind: 'translated', sections: [] }),
    cancelTranslation: vi.fn().mockResolvedValue(undefined),
    cancelReport: vi.fn().mockResolvedValue(undefined),
    copyDocument: vi.fn().mockResolvedValue(undefined),
    exportDocument: vi.fn().mockResolvedValue(undefined),
    chooseExportPath: vi.fn().mockResolvedValue(true),
    closeDocument: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: Live, useValue: live }] });
  return { live, store: TestBed.inject(DirectdocStore) };
}

/** Un travail qu'on fait durer, pour observer la fenêtre pendant qu'elle est occupée. */
function hanging() {
  let settle: () => void = () => {};
  const pending = new Promise<LiveDocument | null>((resolve) => {
    settle = () => resolve(null);
  });
  return { pending, settle };
}

describe('DirectdocStore', () => {
  it('reads its document, and says whether that session is still recording', async () => {
    const { store } = harness({
      document: vi.fn().mockResolvedValue(session({ endedAtMs: null })),
    });
    await store.open('live-3');

    expect(store.document()?.id).toBe('live-3');
    expect(store.recording()).toBe(true);
  });

  it('turns a failed read into an error to say once, and stays readable', async () => {
    const { store } = harness({ document: vi.fn().mockRejectedValue(new Error('base fermée')) });
    await store.open('live-3');

    expect(store.error()?.message).toContain('base fermée');
    store.clearError();
    expect(store.error()).toBeNull();
  });

  /**
   * ⚠️ **Le magasin est construit avec la fenêtre, longtemps avant que son document soit lu.**
   * Sans ces gardes, un geste parti pendant la lecture — la croix de la fenêtre, un raccourci —
   * atteindrait le backend avec un identifiant absent.
   */
  it('does nothing at all before a document has been opened', async () => {
    const { store, live } = harness();

    store.cancel();
    await store.rename('Titre');
    await store.close();
    await store.generate('summary', null);

    expect(await store.copy('transcript', 'Titre')).toBe(false);
    expect(await store.exportTo('transcript', 'plainText', 'Titre', '4 août 2026')).toBe(false);
    expect(await store.translate('transcript', 'en')).toBeNull();

    expect(live.cancelReport).not.toHaveBeenCalled();
    expect(live.rename).not.toHaveBeenCalled();
    expect(live.closeDocument).not.toHaveBeenCalled();
    expect(live.generateReport).not.toHaveBeenCalled();
    expect(live.copyDocument).not.toHaveBeenCalled();
    expect(live.chooseExportPath).not.toHaveBeenCalled();
    expect(live.translateTranscript).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **Une opération à la fois par fenêtre.** Le refus est silencieux : les contrôles sont
   * désactivés pendant le travail, donc y arriver quand même est un accident de course.
   */
  it('refuses a second operation while the window is already working', async () => {
    const { pending, settle } = hanging();
    const { store, live } = harness({ generateReport: vi.fn().mockReturnValue(pending) });
    await store.open('live-3');

    const generating = store.generate('summary', null);
    expect(store.working()).toBe(true);

    expect(await store.copy('transcript', 'Titre')).toBe(false);
    expect(await store.exportTo('transcript', 'plainText', 'Titre', '4 août 2026')).toBe(false);
    expect(await store.translate('transcript', 'en')).toBeNull();
    expect(live.copyDocument).not.toHaveBeenCalled();
    expect(live.chooseExportPath).not.toHaveBeenCalled();

    settle();
    await generating;
    expect(store.working()).toBe(false);
  });

  it('closes the document it was given', async () => {
    const { store, live } = harness();
    await store.open('live-3');
    await store.close();

    expect(live.closeDocument).toHaveBeenCalledExactlyOnceWith('live-3');
  });

  /**
   * ⚠️ **Le sélecteur revient à ce qu'il montrait quand la traduction n'aboutit pas** : le texte
   * n'a pas bougé, et un menu resté sur la langue demandée mentirait sur ce qui est à l'écran.
   */
  it('gives the selector back its previous language when the pair is missing', async () => {
    const { store } = harness({
      translateTranscript: vi.fn().mockResolvedValue({ kind: 'pairMissing' }),
    });
    await store.open('live-3');

    expect(await store.translate('transcript', 'en')).toBe('pairMissing');
    expect(store.transcriptTarget()).toBe('none');
    expect(store.transcriptTranslation()).toBeNull();
  });

  it('comes back to the original view without asking anyone', async () => {
    const { store, live } = harness();
    await store.open('live-3');
    await store.translate('report', 'en');
    expect(store.reportTarget()).toBe('en');

    expect(await store.translate('report', 'none')).toBeNull();

    expect(store.reportTarget()).toBe('none');
    expect(store.reportTranslation()).toBeNull();
    expect(live.translateReport).toHaveBeenCalledOnce();
  });

  it('ignores the events of the neighbouring windows', async () => {
    const { store } = harness();
    await store.open('live-3');

    expect(store.stopped('live-9')).toBe(false);
    store.progressed({ documentId: 'live-9', step: 'weaving', done: 1, total: 3 });
    store.finalised(session({ id: 'live-9' }));

    expect(store.finalising()).toBe(false);
    expect(store.step()).toBeNull();
  });
});
