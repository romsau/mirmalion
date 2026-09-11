import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TestBed } from '@angular/core/testing';
import { MediaBridge } from './media.bridge';
import type {
  CopyRequest,
  ExportRequest,
  LanguageDetection,
  MediaInspection,
  TranscriptTranslation,
} from './media.bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Le bridge résolu par l'injecteur : il reçoit le vrai `Invoke`, dont l'IPC est doublé. */
function bridge(): MediaBridge {
  return TestBed.inject(MediaBridge);
}

describe('MediaBridge', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('supportedMediaExtensions() resolves to null outside a Tauri context', async () => {
    await expect(bridge().supportedMediaExtensions()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('supportedMediaExtensions() lets the backend dictate the browse filter', async () => {
    // ⚠️ La liste ne se recopie jamais côté frontend : le filtre du sélecteur et la validation
    // réelle doivent parler du même périmètre.
    vi.mocked(invoke).mockResolvedValue(['mp3', 'mp4']);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().supportedMediaExtensions()).resolves.toEqual(['mp3', 'mp4']);
    expect(invoke).toHaveBeenCalledWith('supported_media_extensions', undefined);
  });

  it('inspectMedia() resolves to null outside a Tauri context', async () => {
    await expect(bridge().inspectMedia(['/tmp/a.mp3'])).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('inspectMedia() carries a refusal as a SUCCESS, not a rejection', async () => {
    // ⚠️ La distinction qui compte : un mauvais fichier n'est pas une panne du pont natif.
    const verdict: MediaInspection = { status: 'rejected', problem: 'noAudioTrack' };
    vi.mocked(invoke).mockResolvedValue(verdict);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().inspectMedia(['/tmp/muet.mp4'])).resolves.toEqual(verdict);
    expect(invoke).toHaveBeenCalledWith('inspect_media', { paths: ['/tmp/muet.mp4'] });
  });

  it('detectMediaLanguage() resolves to null outside a Tauri context', async () => {
    await expect(bridge().detectMediaLanguage('/tmp/a.mp3')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('detectMediaLanguage() carries an undecided verdict as a SUCCESS, not a rejection', async () => {
    // ⚠️ Même distinction que pour l'inspection : un média dont on ne sait pas dire la langue
    // n'est pas une panne du pont natif.
    const verdict: LanguageDetection = { status: 'undecided', problem: 'unsupportedLanguage' };
    vi.mocked(invoke).mockResolvedValue(verdict);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().detectMediaLanguage('/tmp/podcast.mp3')).resolves.toEqual(verdict);
    expect(invoke).toHaveBeenCalledWith('detect_media_language', { path: '/tmp/podcast.mp3' });
  });

  it('transcribeMedia() resolves to null outside a Tauri context', async () => {
    const media = { path: '/tmp/a.mp4', fileName: 'a.mp4', language: 'fr' };
    await expect(bridge().transcribeMedia(media)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('transcribeMedia() passes its request as ONE object', async () => {
    // ⚠️ Quatre paramètres positionnels se permutent en silence : deux chaînes échangées
    // donneraient un document dont le titre est une langue, sans erreur de compilation.
    const media = { path: '/tmp/a.mp4', fileName: 'a.mp4', language: 'fr' };
    vi.mocked(invoke).mockResolvedValue({ id: 'filedoc-0' });
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().transcribeMedia(media)).resolves.toEqual({ id: 'filedoc-0' });
    expect(invoke).toHaveBeenCalledWith('transcribe_media', { media });
  });

  it('cancelMediaTranscription() stays silent outside a Tauri context', async () => {
    await expect(bridge().cancelMediaTranscription()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancelMediaTranscription() asks the backend to stop', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().cancelMediaTranscription();
    expect(invoke).toHaveBeenCalledWith('cancel_media_transcription', {});
  });

  it('getFileDocument() resolves to null outside a Tauri context', async () => {
    await expect(bridge().getFileDocument('filedoc-0')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('getFileDocument() reads a document by its identifier', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 'filedoc-0', title: 'a.mp4' });
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().getFileDocument('filedoc-0')).resolves.toEqual({
      id: 'filedoc-0',
      title: 'a.mp4',
    });
    expect(invoke).toHaveBeenCalledWith('get_file_document', { id: 'filedoc-0' });
  });

  it('renameFileDocument() resolves to null outside a Tauri context', async () => {
    await expect(bridge().renameFileDocument('filedoc-0', 'Entretien')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('renameFileDocument() sends the title untouched, emptiness included', async () => {
    // ⚠️ C'est le BACKEND qui décide du repli sur le nom du fichier : nettoyer ici mettrait
    // deux règles en concurrence pour la même décision.
    vi.mocked(invoke).mockResolvedValue({ id: 'filedoc-0', title: 'a.mp4' });
    window.__TAURI_INTERNALS__ = {};
    await bridge().renameFileDocument('filedoc-0', '   ');
    expect(invoke).toHaveBeenCalledWith('rename_file_document', { id: 'filedoc-0', title: '   ' });
  });

  it('closeFileDocument() stays silent outside a Tauri context', async () => {
    await expect(bridge().closeFileDocument('filedoc-0')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('closeFileDocument() frees the document and its window', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};
    await bridge().closeFileDocument('filedoc-0');
    expect(invoke).toHaveBeenCalledWith('close_file_document', { id: 'filedoc-0' });
  });

  it('translateDocument() resolves to null outside a Tauri context', async () => {
    await expect(bridge().translateDocument('filedoc-0', 'de')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('translateDocument() hands back the outcome as-is — a missing pair is NOT a failure', async () => {
    // ⚠️⚠️ Les trois issues arrivent en succès. Traiter `pairMissing` comme une panne ferait
    // afficher un message de dépannage là où il faut une information.
    const translated: TranscriptTranslation = {
      kind: 'translated',
      paragraphs: [{ startMs: 0, endMs: 900, text: 'Guten Tag.' }],
    };
    vi.mocked(invoke).mockResolvedValue(translated);
    window.__TAURI_INTERNALS__ = {};
    const tauri = bridge();

    await expect(tauri.translateDocument('filedoc-0', 'de')).resolves.toEqual(translated);
    expect(invoke).toHaveBeenLastCalledWith('translate_document', {
      id: 'filedoc-0',
      target: 'de',
    });

    const missing: TranscriptTranslation = { kind: 'pairMissing', source: 'fr', target: 'de' };
    vi.mocked(invoke).mockResolvedValue(missing);
    await expect(tauri.translateDocument('filedoc-0', 'de')).resolves.toEqual(missing);

    // ⚠️ Une annulation aussi : elle arrive en succès, et **sans un seul tour**.
    const cancelled: TranscriptTranslation = { kind: 'cancelled' };
    vi.mocked(invoke).mockResolvedValue(cancelled);
    await expect(tauri.translateDocument('filedoc-0', 'de')).resolves.toEqual(cancelled);
  });

  it('chooseExportPath() opens nothing outside a Tauri context', async () => {
    await expect(bridge().chooseExportPath('filedoc-0', '3 août 2026', 'csv')).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('chooseExportPath() sends the date ALREADY formatted — Rust owns no calendar', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().chooseExportPath('filedoc-0', '3 août 2026', 'csv')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('choose_export_path', {
      id: 'filedoc-0',
      date: '3 août 2026',
      format: 'csv',
    });
  });

  it('chooseExportPath() reports a cancellation as a refusal, not as an error', async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    window.__TAURI_INTERNALS__ = {};
    await expect(bridge().chooseExportPath('filedoc-0', '3 août 2026', 'csv')).resolves.toBe(false);
  });

  it('exportDocument() stays silent outside a Tauri context', async () => {
    await expect(
      bridge().exportDocument({ id: 'filedoc-0', format: 'pdf' }),
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exportDocument() names a document and NEVER a file to write', async () => {
    const request: ExportRequest = {
      id: 'filedoc-0',
      format: 'docx',
    };
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().exportDocument(request);
    expect(invoke).toHaveBeenCalledWith('export_document', { request });
    expect(request).not.toHaveProperty('path');
  });

  it('copyDocument() stays silent outside a Tauri context', async () => {
    await expect(bridge().copyDocument({ id: 'filedoc-0' })).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('copyDocument() carries what the window displays', async () => {
    const request: CopyRequest = {
      id: 'filedoc-0',
      paragraphs: [{ startMs: 0, endMs: 900, text: 'Guten Tag.' }],
    };
    vi.mocked(invoke).mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = {};

    await bridge().copyDocument(request);
    expect(invoke).toHaveBeenCalledWith('copy_document', { request });
  });

  it('pickMediaFile() opens nothing outside a Tauri context', async () => {
    await expect(bridge().pickMediaFile(['mp3'])).resolves.toBeNull();
  });

  it('pickMediaFile() filters the native picker with the extensions it is given', async () => {
    const open = vi.fn().mockResolvedValue('/Users/moi/plateau.mp4');
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ open }));
    window.__TAURI_INTERNALS__ = {};

    await expect(bridge().pickMediaFile(['mp3', 'mp4'])).resolves.toBe('/Users/moi/plateau.mp4');
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: 'media', extensions: ['mp3', 'mp4'] }],
    });
    vi.doUnmock('@tauri-apps/plugin-dialog');
  });

  it('onFileDrop() hands back a no-op unsubscribe outside a Tauri context', async () => {
    const handler = vi.fn();
    const unlisten = await bridge().onFileDrop(handler);
    expect(unlisten()).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('onFileDrop() translates what wry delivers, and drops what is useless', async () => {
    // ⚠️⚠️ C'est LA source des chemins : les évènements HTML5 de glisser n'atteignent jamais la
    // page sur macOS, et un `File` n'expose aucun chemin absolu.
    const stop = vi.fn();
    let deliver: (event: { payload: unknown }) => void = () => undefined;
    const onDragDropEvent = vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      deliver = handler;
      return stop;
    });
    vi.doMock('@tauri-apps/api/webview', () => ({
      getCurrentWebview: () => ({ onDragDropEvent }),
    }));
    window.__TAURI_INTERNALS__ = {};

    const handler = vi.fn();
    await expect(bridge().onFileDrop(handler)).resolves.toBe(stop);

    deliver({ payload: { type: 'enter', paths: ['/tmp/a.mp3'], position: { x: 0, y: 0 } } });
    deliver({ payload: { type: 'over', position: { x: 0, y: 0 } } });
    deliver({ payload: { type: 'drop', paths: ['/tmp/a.mp3'], position: { x: 0, y: 0 } } });
    deliver({ payload: { type: 'leave' } });

    // `over` arrive à chaque image et ne porte que des coordonnées : il ne remonte pas.
    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'enter' },
      { kind: 'drop', paths: ['/tmp/a.mp3'] },
      { kind: 'leave' },
    ]);
    vi.doUnmock('@tauri-apps/api/webview');
  });

  it('is providable via Angular DI as a root singleton', () => {
    const service = TestBed.inject(MediaBridge);
    expect(service).toBeInstanceOf(MediaBridge);
    expect(TestBed.inject(MediaBridge)).toBe(TestBed.inject(MediaBridge));
  });
});
