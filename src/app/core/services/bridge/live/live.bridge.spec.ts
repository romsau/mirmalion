import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { LiveBridge } from './live.bridge';
import {
  LIVE_FINALISED_EVENT,
  LIVE_PROMPT_EVENT,
  LIVE_LEVEL_EVENT,
  LIVE_PROGRESS_EVENT,
  LIVE_STOPPED_EVENT,
  LIVE_TRANSCRIPT_EVENT,
} from './live.bridge';
import type { AudioSource, ReportTranslation } from './live.bridge';
import type { TranscriptTranslation } from '../media/media.bridge';
import { Invoke } from '../invoke/invoke';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): LiveBridge {
  return TestBed.inject(LiveBridge);
}

describe('LiveBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('listAudioSources() resolves to null outside a Tauri context', async () => {
    await expect(bridge().listAudioSources()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('listAudioSources() names what emits, with the whole system in front', async () => {
    const sources: readonly AudioSource[] = [
      { id: 'system', name: 'Tout le système', isSystem: true },
      { id: '4212', name: 'Microsoft Teams', isSystem: false },
    ];
    vi.mocked(invoke).mockResolvedValue(sources);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().listAudioSources()).resolves.toEqual(sources);
    expect(invoke).toHaveBeenCalledWith('list_audio_sources', undefined);
  });

  it('startLiveCapture() resolves to null outside a Tauri context', async () => {
    await expect(bridge().startLiveCapture('system', 'default', 'fr', null)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('startLiveCapture() passes the microphone choice through untouched', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().startLiveCapture('4212', 'default', 'fr', 'en');
    expect(invoke).toHaveBeenCalledWith('start_live_capture', {
      sourceId: '4212',
      microphoneDeviceId: 'default',
      language: 'fr',
      translationTarget: 'en',
    });

    // ⚠️ **`null` sur la langue veut dire « enregistre sans transcrire »**, et ce n'est pas une
    // erreur : les fichiers sont écrits, et tout se refait depuis eux.
    await bridge().startLiveCapture('system', null, null, null);
    expect(invoke).toHaveBeenCalledWith('start_live_capture', {
      sourceId: 'system',
      microphoneDeviceId: null,
      language: null,
      translationTarget: null,
    });
  });

  it('onLiveTranscript() subscribes to the live channel, not the dictation one', async () => {
    const service = bridge();
    const listen = vi.spyOn(TestBed.inject(Invoke), 'listen').mockResolvedValue(() => undefined);
    const handler = vi.fn();

    await service.onLiveTranscript(handler);
    expect(listen).toHaveBeenCalledExactlyOnceWith(LIVE_TRANSCRIPT_EVENT, handler);
    expect(LIVE_TRANSCRIPT_EVENT).not.toBe('transcription');
  });

  it('stopLiveCapture() does nothing outside a Tauri context', async () => {
    await expect(bridge().stopLiveCapture()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stopLiveCapture() closes the capture', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().stopLiveCapture();
    expect(invoke).toHaveBeenCalledWith('stop_live_capture', undefined);
  });

  it('onLiveStopped() and onLiveFinalised() are two distinct channels', async () => {
    const service = bridge();
    const listen = vi.spyOn(TestBed.inject(Invoke), 'listen').mockResolvedValue(() => undefined);
    const stopped = vi.fn();
    const finalised = vi.fn();

    await service.onLiveStopped(stopped);
    await service.onLiveFinalised(finalised);

    expect(listen).toHaveBeenNthCalledWith(1, LIVE_STOPPED_EVENT, stopped);
    expect(listen).toHaveBeenNthCalledWith(2, LIVE_FINALISED_EVENT, finalised);
    expect(LIVE_STOPPED_EVENT).not.toBe(LIVE_FINALISED_EVENT);
  });

  /**
   * ⚠️ **L'évènement ne porte pas le prompt** : c'est du contenu utilisateur, il reste dans la
   * base chiffrée. Le pont jette donc la charge utile et n'appelle le gestionnaire qu'à vide.
   */
  it('onLivePromptChanged() carries no payload to its handler', async () => {
    const service = bridge();
    let emit: ((payload: unknown) => void) | null = null;
    vi.spyOn(TestBed.inject(Invoke), 'listen').mockImplementation(
      async (event: string, handler: (payload: never) => void) => {
        expect(event).toBe(LIVE_PROMPT_EVENT);
        emit = handler as (payload: unknown) => void;
        return () => undefined;
      },
    );
    const handler = vi.fn();

    await service.onLivePromptChanged(handler);
    emit!('Décisions et tâches');

    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });

  it('onLiveProgress() listens on its own channel', async () => {
    const service = bridge();
    const listen = vi.spyOn(TestBed.inject(Invoke), 'listen').mockResolvedValue(() => undefined);
    const handler = vi.fn();

    await service.onLiveProgress(handler);

    expect(listen).toHaveBeenCalledExactlyOnceWith(LIVE_PROGRESS_EVENT, handler);
    expect([LIVE_STOPPED_EVENT, LIVE_FINALISED_EVENT]).not.toContain(LIVE_PROGRESS_EVENT);
  });

  /**
   * ⚠️ Le pont déballe la charge utile : le canal porte un objet, le VU-mètre un nombre. Passer
   * l'objet tel quel obligerait chaque fenêtre à connaître la forme de l'évènement.
   */
  it('onLiveLevel() hands over the level alone, not the payload around it', async () => {
    const service = bridge();
    let emit: ((payload: { level: number }) => void) | undefined;
    const listen = vi
      .spyOn(TestBed.inject(Invoke), 'listen')
      .mockImplementation(async (_event, handler) => {
        emit = handler as (payload: { level: number }) => void;
        return () => undefined;
      });
    const seen: number[] = [];

    await service.onLiveLevel((level) => seen.push(level));
    emit?.({ level: 0.42 });

    expect(listen.mock.calls[0]?.[0]).toBe(LIVE_LEVEL_EVENT);
    expect(seen).toEqual([0.42]);
  });

  it('getLiveSession() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getLiveSession()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getLiveSession() says where the running session is', async () => {
    const running = {
      phase: 'recording',
      documentId: 'directdoc-0',
      startedAtMs: 1_754_300_000_000,
      sourceName: 'Microsoft Teams',
      withMicrophone: true,
    };
    vi.mocked(invoke).mockResolvedValue(running);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getLiveSession()).resolves.toEqual(running);
    expect(invoke).toHaveBeenCalledWith('get_live_session', undefined);
  });

  it('getLiveDocument() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getLiveDocument('directdoc-0')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getLiveDocument() reads the live a window was opened for', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().getLiveDocument('directdoc-0');
    expect(invoke).toHaveBeenCalledWith('get_live_document', { id: 'directdoc-0' });
  });

  it('renameLiveDocument() resolves to null outside a Tauri context', async () => {
    await expect(bridge().renameLiveDocument('directdoc-0', 'x')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('renameLiveDocument() renames the live', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().renameLiveDocument('directdoc-0', 'Point client');
    expect(invoke).toHaveBeenCalledWith('rename_live_document', {
      id: 'directdoc-0',
      title: 'Point client',
    });
  });

  it('closeLiveDocument() does nothing outside a Tauri context', async () => {
    await expect(bridge().closeLiveDocument('directdoc-0')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('closeLiveDocument() closes the live and its window', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().closeLiveDocument('directdoc-0');
    expect(invoke).toHaveBeenCalledWith('close_live_document', { id: 'directdoc-0' });
  });

  it('generateLiveReport() resolves to null outside a Tauri context', async () => {
    await expect(bridge().generateLiveReport('directdoc-0', 'team', null)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('generateLiveReport() asks for the report of the chosen kind', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().generateLiveReport('directdoc-0', 'custom', 'Décisions et tâches');
    expect(invoke).toHaveBeenCalledWith('generate_live_report', {
      id: 'directdoc-0',
      kind: 'custom',
      prompt: 'Décisions et tâches',
    });
  });

  it('listLiveSessions() reads the archived history', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().listLiveSessions()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('list_live_sessions', undefined);
  });

  it('openLiveSession() reopens an archived session', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().openLiveSession(7);
    expect(invoke).toHaveBeenCalledWith('open_live_session', { id: 7 });
  });

  it('deleteLiveSession() removes one session', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().deleteLiveSession(7);
    expect(invoke).toHaveBeenCalledWith('delete_live_session', { id: 7 });
  });

  it('clearLiveSessions() empties the history and says how many went', async () => {
    vi.mocked(invoke).mockResolvedValue(3);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().clearLiveSessions()).resolves.toBe(3);
    expect(invoke).toHaveBeenCalledWith('clear_live_sessions', undefined);
  });

  it('copyLiveSession() reads the text the backend composed', async () => {
    vi.mocked(invoke).mockResolvedValue('Résumé');
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().copyLiveSession(7)).resolves.toBe('Résumé');
    expect(invoke).toHaveBeenCalledWith('copy_live_session', { id: 7 });
  });

  it('chooseLiveExportPath() sends the resolved title and date, and nothing else', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    window.__TAURI_INTERNALS__ = {};
    await expect(
      bridge().chooseLiveExportPath('directdoc-0', 'Session du 5 août', '5 août 2026', 'markdown'),
    ).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('choose_live_export_path', {
      id: 'directdoc-0',
      title: 'Session du 5 août',
      date: '5 août 2026',
      format: 'markdown',
    });
  });

  it('chooseLiveExportPath() opens nothing outside a Tauri context', async () => {
    await expect(bridge().chooseLiveExportPath('directdoc-0', 'T', 'd', 'markdown')).resolves.toBe(
      false,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exportLiveDocument() writes the content the window shows, at no named path', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    const request = {
      id: 'directdoc-0',
      content: 'report',
      format: 'docx',
      title: 'Point client',
    } as const;
    await bridge().exportLiveDocument(request);
    expect(invoke).toHaveBeenCalledWith('export_live_document', { request });
    expect(request).not.toHaveProperty('path');
  });

  it('copyLiveDocument() copies the content the window shows', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    const request = { id: 'directdoc-0', content: 'transcript', title: 'Point' } as const;
    await bridge().copyLiveDocument(request);
    expect(invoke).toHaveBeenCalledWith('copy_live_document', { request });
  });

  it('cancelLiveReport() asks the backend to give up the generation', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().cancelLiveReport('directdoc-0');
    expect(invoke).toHaveBeenCalledWith('cancel_live_report', { id: 'directdoc-0' });
  });

  it('translateLiveTranscript() and translateLiveReport() reach their own commands', async () => {
    await expect(bridge().translateLiveTranscript('directdoc-0', 'en')).resolves.toBeNull();
    await expect(bridge().translateLiveReport('directdoc-0', 'en')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    window.__TAURI_INTERNALS__ = {};
    const tauri = bridge();

    const transcript: TranscriptTranslation = {
      kind: 'translated',
      paragraphs: [{ startMs: 0, endMs: 900, text: 'Good morning.' }],
    };
    vi.mocked(invoke).mockResolvedValue(transcript);
    await expect(tauri.translateLiveTranscript('directdoc-0', 'en')).resolves.toEqual(transcript);
    expect(invoke).toHaveBeenLastCalledWith('translate_live_transcript', {
      id: 'directdoc-0',
      target: 'en',
    });

    // ⚠️ **Les intitulés font partie de ce qui revient** : le modèle les a écrits dans la langue
    // du transcript, ils ne sortent d'aucune table de l'interface.
    const report: ReportTranslation = {
      kind: 'translated',
      sections: [{ heading: 'Summary', lines: ['Two points.'], bullets: false }],
    };
    vi.mocked(invoke).mockResolvedValue(report);
    await expect(tauri.translateLiveReport('directdoc-0', 'en')).resolves.toEqual(report);
    expect(invoke).toHaveBeenLastCalledWith('translate_live_report', {
      id: 'directdoc-0',
      target: 'en',
    });
  });

  it('listReportPrompts() reads the list from the encrypted database', async () => {
    // ⚠️ Pas du fichier de réglages : un titre de prompt nomme un client autant que son texte.
    vi.mocked(invoke).mockResolvedValue([{ id: 3, title: 'Client', prompt: 'Décisions.' }]);
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().listReportPrompts()).resolves.toEqual([
      { id: 3, title: 'Client', prompt: 'Décisions.' },
    ]);
    expect(invoke).toHaveBeenCalledWith('list_report_prompts', undefined);
  });

  it('listReportPrompts() rend une liste VIDE hors contexte Tauri', async () => {
    // ⚠️ Jamais `null` : l'écran affiche une liste, et un troisième cas entre « vide » et
    // « remplie » serait une branche que personne ne couvrirait.
    await expect(bridge().listReportPrompts()).resolves.toEqual([]);
  });

  it('createReportPrompt() envoie le titre et le texte tels quels', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 4, title: 'Veille', prompt: 'Ce qui bouge.' });
    window.__TAURI_INTERNALS__ = {};

    await bridge().createReportPrompt('Veille', 'Ce qui bouge.');
    expect(invoke).toHaveBeenCalledWith('create_report_prompt', {
      title: 'Veille',
      prompt: 'Ce qui bouge.',
    });
  });

  it('updateReportPrompt() porte le numéro, qui ne change jamais', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 4, title: 'Veille', prompt: 'Autre chose.' });
    window.__TAURI_INTERNALS__ = {};

    await bridge().updateReportPrompt(4, 'Veille', 'Autre chose.');
    expect(invoke).toHaveBeenCalledWith('update_report_prompt', {
      id: 4,
      title: 'Veille',
      prompt: 'Autre chose.',
    });
  });

  it('deleteReportPrompt() ne rend rien, et n’a rien à rendre', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().deleteReportPrompt(4)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('delete_report_prompt', { id: 4 });
  });

  it('adoptLegacyLivePrompt() rend faux hors contexte Tauri, où il n’y a rien à reprendre', async () => {
    await expect(bridge().adoptLegacyLivePrompt('Mon prompt personnalisé')).resolves.toBe(false);
  });
});
