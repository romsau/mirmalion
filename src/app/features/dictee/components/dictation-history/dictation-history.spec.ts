import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { HistoryPanel } from '../../../../shared/components/history-panel/history-panel';
import { DictationHistory } from './dictation-history';
import { DictationHistoryStore } from '../../../../core/store/dictation-history/dictation-history.store';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import type { DictationRecord } from '../../../../core/services/bridge/dictation/dictation.bridge';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { DEFAULT_SETTINGS } from '../../../../core/models/settings';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import { DictationBridge } from '../../../../core/services/bridge/dictation/dictation.bridge';

function record(id: number, overrides: Partial<DictationRecord> = {}): DictationRecord {
  return {
    id,
    language: 'fr',
    rawText: `brut ${id}`,
    cleanedText: null,
    rephrasedText: null,
    translatedText: null,
    translatedLanguage: null,
    ...overrides,
  };
}

function harness(
  overrides: {
    entries?: DictationRecord[];
    confirm?: boolean;
    clipboard?: () => Promise<void>;
  } = {},
) {
  const tauri = {
    listDictations: vi.fn().mockResolvedValue(overrides.entries ?? [record(1), record(2)]),
    deleteDictation: vi.fn().mockResolvedValue(undefined),
    clearDictations: vi.fn().mockResolvedValue(undefined),
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
      { provide: DictationBridge, useValue: tauri },
      { provide: Modal, useValue: modal },
      { provide: Snackbar, useValue: snackbar },
      { provide: SettingsStore, useValue: { settings: () => DEFAULT_SETTINGS } },
    ],
  });
  return { tauri, modal, snackbar, store: TestBed.inject(DictationHistoryStore) };
}

async function render(overrides: Parameters<typeof harness>[0] = {}) {
  const doubles = harness(overrides);
  const fixture = TestBed.createComponent(DictationHistory);
  await fixture.whenStable();
  fixture.detectChanges();
  return { ...doubles, fixture, root: fixture.nativeElement as HTMLElement };
}

afterEach(() => TestBed.resetTestingModule());

describe('DictationHistory', () => {
  it('shows the text that was inserted at the cursor, not the raw one', async () => {
    // ⚠️ Le brut est un texte que l'utilisateur n'a jamais vu.
    const { root } = await render({
      entries: [record(1, { cleanedText: 'Le rapport est prêt.' })],
    });
    expect(root.querySelector('.txt')?.textContent?.trim()).toBe('Le rapport est prêt.');
  });

  it('copies the displayed text on demand', async () => {
    const { root, fixture } = await render({
      entries: [record(1, { translatedText: 'The report is ready.' })],
    });
    root.querySelector<HTMLButtonElement>('.h-act.copy')?.click();
    await fixture.whenStable();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('The report is ready.');
  });

  it('says so when the clipboard refuses', async () => {
    const { root, fixture, snackbar } = await render({
      clipboard: () => Promise.reject(new Error('refusé')),
    });
    root.querySelector<HTMLButtonElement>('.h-act.copy')?.click();
    await fixture.whenStable();

    expect(snackbar.error).toHaveBeenCalled();
  });

  it('copies nothing when the entry vanished between display and click', async () => {
    // ⚠️ Course réelle : la suppression retire l'entrée de la liste avant l'aller-retour, et
    // le clic de copie peut arriver juste après. Écrire « undefined » au presse-papiers
    // écraserait ce que l'utilisateur y avait mis.
    const { fixture } = await render();
    const panel = fixture.debugElement.query(By.directive(HistoryPanel));
    panel.componentInstance.copy.emit(404);
    await fixture.whenStable();

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('deletes a single entry WITHOUT asking', async () => {
    // Une entrée supprimée par erreur se redicte en quelques secondes.
    const { root, fixture, modal, tauri } = await render();
    root.querySelector<HTMLButtonElement>('.h-act.del')?.click();
    await fixture.whenStable();

    expect(modal.confirm).not.toHaveBeenCalled();
    expect(tauri.deleteDictation).toHaveBeenCalledWith(1);
  });

  it('ALWAYS asks before emptying the whole history', async () => {
    // L'asymétrie est le sujet : un historique entier ne se retrouve pas.
    const { root, fixture, modal, tauri } = await render();
    root.querySelector<HTMLButtonElement>('.clear-all')?.click();
    await fixture.whenStable();

    expect(modal.confirm).toHaveBeenCalledOnce();
    expect(tauri.clearDictations).toHaveBeenCalledOnce();
  });

  it('empties nothing when the confirmation is declined', async () => {
    const { root, fixture, tauri } = await render({ confirm: false });
    root.querySelector<HTMLButtonElement>('.clear-all')?.click();
    await fixture.whenStable();

    expect(tauri.clearDictations).not.toHaveBeenCalled();
  });

  it('filters on what is typed, tolerating accents and case', async () => {
    const { root, fixture } = await render({
      entries: [
        record(1, { cleanedText: 'Compte rendu détaillé' }),
        record(2, { cleanedText: 'Autre chose' }),
      ],
    });
    // Le champ est masqué tant que la loupe ne l'a pas déplié (2026-07-30).
    root.querySelector<HTMLButtonElement>('.search-toggle button')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const input = root.querySelector<HTMLInputElement>('.hist-search-input');
    // ⚠️ **Sans accent ET en majuscules** : le mot cherché doit éprouver les deux tolérances à
    // la fois, sinon l'une des deux peut tomber sans que le test bronche.
    input!.value = 'DETAILLE';
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(root.querySelectorAll('.hist-item')).toHaveLength(1);
  });

  it('invites the user to dictate when nothing was ever dictated', async () => {
    const { root } = await render({ entries: [] });
    expect(root.querySelector('.hist-empty')?.textContent).toContain('Aucune dictée');
  });

  it('reports a store failure once, then forgets it', async () => {
    const doubles = harness();
    doubles.tauri.listDictations = vi.fn().mockRejectedValue(new Error('base fermée'));
    const fixture = TestBed.createComponent(DictationHistory);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(doubles.snackbar.error).toHaveBeenCalledOnce();
    expect(doubles.store.error()).toBeNull();
  });

  it('has no AXE violation', async () => {
    const { fixture } = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
