import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  DOCUMENT_TRANSLATION_EVENT,
  FILE_TRANSCRIPTION_EVENT,
  Transcription,
} from './transcription';
import type {
  FileDocument,
  TranscriptTranslation,
  TranscriptionRequest,
} from '../bridge/media/media.bridge';
import { Invoke } from '../bridge/invoke/invoke';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';
import { MediaBridge } from '../bridge/media/media.bridge';
import { SystemBridge } from '../bridge/system/system.bridge';

/**
 * Ce que ce fichier éprouve : **la traduction du domaine vers le pont**, et les deux points où
 * ce service fait plus que déléguer — l'abonnement à la progression et l'interception de la
 * fermeture de fenêtre.
 */
const DOCUMENT: FileDocument = {
  id: 'filedoc-0',
  title: 'plateau',
  fileName: 'plateau.mp4',
  path: '/Users/moi/Films/plateau.mp4',
  language: 'fr',
  durationMs: 370_149,
  transcript: { language: 'fr', paragraphs: [] },
};

const TRANSLATED: TranscriptTranslation = {
  kind: 'translated',
  paragraphs: [{ startMs: 0, endMs: 900, text: 'Guten Tag.' }],
};

const REQUEST: TranscriptionRequest = {
  path: DOCUMENT.path,
  fileName: DOCUMENT.fileName,
  language: 'fr',
};

type Listen = (
  event: string,
  handler: (payload: { documentId?: string; percent: number }) => void,
) => Promise<() => void>;

interface Overrides {
  readonly isTauri?: () => boolean;
  readonly listen?: Listen;
  readonly onCloseRequested?: (handler: () => void) => Promise<() => void>;
}

function harness(overrides: Overrides = {}) {
  const tauri = {
    isTauri: vi.fn(overrides.isTauri ?? (() => true)),
    listen: vi.fn<Listen>(overrides.listen ?? (() => Promise.resolve(() => undefined))),
    onCloseRequested: vi.fn(overrides.onCloseRequested ?? (() => Promise.resolve(() => undefined))),
    transcribeMedia: vi.fn(() => Promise.resolve(DOCUMENT)),
    cancelMediaTranscription: vi.fn(() => Promise.resolve()),
    cancelDocumentTranslation: vi.fn(() => Promise.resolve()),
    getFileDocument: vi.fn(() => Promise.resolve(DOCUMENT)),
    renameFileDocument: vi.fn(() => Promise.resolve(DOCUMENT)),
    closeFileDocument: vi.fn(() => Promise.resolve()),
    translateDocument: vi.fn(() => Promise.resolve(TRANSLATED)),
    chooseExportPath: vi.fn(() => Promise.resolve(true)),
    exportDocument: vi.fn(() => Promise.resolve()),
    copyDocument: vi.fn(() => Promise.resolve()),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Invoke, useValue: tauri },
      { provide: LanguagesBridge, useValue: tauri },
      { provide: MediaBridge, useValue: tauri },
      { provide: SystemBridge, useValue: tauri },
    ],
  });
  return { tauri, service: TestBed.inject(Transcription) };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
});

describe('Transcription', () => {
  it('est un singleton de la racine', () => {
    const { service } = harness();

    expect(service).toBeInstanceOf(Transcription);
    expect(TestBed.inject(Transcription)).toBe(service);
  });

  describe('la progression', () => {
    it('écoute l’évènement que Rust émet, et n’en déballe que le pourcentage', async () => {
      // ⚠️ Le nom doit rester identique à `TRANSCRIPTION_EVENT` côté Rust : rien ne le vérifie
      // à la compilation, et une divergence donnerait une barre qui n'avance jamais.
      const { tauri, service } = harness();
      const handler = vi.fn();

      await service.observeProgress(handler);
      expect(tauri.listen).toHaveBeenCalledOnce();
      expect(tauri.listen.mock.calls[0]?.[0]).toBe(FILE_TRANSCRIPTION_EVENT);
      expect(FILE_TRANSCRIPTION_EVENT).toBe('file-transcription');

      tauri.listen.mock.calls[0]?.[1]({ percent: 62 });
      expect(handler).toHaveBeenCalledExactlyOnceWith(62);
    });

    it('rend le désabonnement du pont, tel quel', async () => {
      const stop = () => undefined;
      const { service } = harness({ listen: vi.fn(() => Promise.resolve(stop)) });

      await expect(service.observeProgress(vi.fn())).resolves.toBe(stop);
    });
  });

  describe('la progression d’une traduction', () => {
    it('écoute l’évènement que Rust émet pour les documents', async () => {
      const { tauri, service } = harness();
      const handler = vi.fn();

      await service.observeTranslationProgress('filedoc-0', handler);

      expect(tauri.listen.mock.calls[0]?.[0]).toBe(DOCUMENT_TRANSLATION_EVENT);
      expect(DOCUMENT_TRANSLATION_EVENT).toBe('document-translation');

      tauri.listen.mock.calls[0]?.[1]({ documentId: 'filedoc-0', percent: 42 });
      expect(handler).toHaveBeenCalledExactlyOnceWith(42);
    });

    /**
     * ⚠️⚠️ **UN ÉVÈNEMENT TAURI EST DIFFUSÉ À TOUTES LES FENÊTRES**, et deux fenêtres-documents
     * peuvent traduire en même temps. Sans ce tri, chacune afficherait l'avancée de l'autre.
     */
    it('ignore l’avancée d’un autre document', async () => {
      const { tauri, service } = harness();
      const handler = vi.fn();

      await service.observeTranslationProgress('filedoc-0', handler);
      tauri.listen.mock.calls[0]?.[1]({ documentId: 'filedoc-7', percent: 99 });

      expect(handler).not.toHaveBeenCalled();
    });

    it('rend le désabonnement du pont, tel quel', async () => {
      const stop = () => undefined;
      const { service } = harness({ listen: vi.fn(() => Promise.resolve(stop)) });

      await expect(service.observeTranslationProgress('filedoc-0', vi.fn())).resolves.toBe(stop);
    });
  });

  describe('les commandes', () => {
    it('transcrit avec la requête qu’on lui donne, sans la remanier', async () => {
      const { tauri, service } = harness();

      await expect(service.transcribe(REQUEST)).resolves.toBe(DOCUMENT);
      expect(tauri.transcribeMedia).toHaveBeenCalledExactlyOnceWith(REQUEST);
    });

    it('annule, lit, renomme et ferme', async () => {
      const { tauri, service } = harness();

      await service.cancel();
      await expect(service.document('filedoc-0')).resolves.toBe(DOCUMENT);
      await expect(service.rename('filedoc-0', 'Plateau télé')).resolves.toBe(DOCUMENT);
      await service.close('filedoc-0');

      expect(tauri.cancelMediaTranscription).toHaveBeenCalledOnce();
      expect(tauri.getFileDocument).toHaveBeenCalledExactlyOnceWith('filedoc-0');
      expect(tauri.renameFileDocument).toHaveBeenCalledExactlyOnceWith('filedoc-0', 'Plateau télé');
      expect(tauri.closeFileDocument).toHaveBeenCalledExactlyOnceWith('filedoc-0');
    });

    it('traduit, propose une cible, ouvre la boîte, écrit et copie', async () => {
      const { tauri, service } = harness();
      const request = {
        id: 'filedoc-0',
        format: 'markdown' as const,
      };

      await expect(service.translate('filedoc-0', 'de')).resolves.toBe(TRANSLATED);
      await expect(service.chooseExportPath('filedoc-0', '3 août 2026', 'markdown')).resolves.toBe(
        true,
      );
      await service.export(request);
      await service.copy({ id: 'filedoc-0' });

      expect(tauri.translateDocument).toHaveBeenCalledExactlyOnceWith('filedoc-0', 'de');
      expect(tauri.chooseExportPath).toHaveBeenCalledExactlyOnceWith(
        'filedoc-0',
        '3 août 2026',
        'markdown',
      );
      expect(tauri.exportDocument).toHaveBeenCalledExactlyOnceWith(request);
      expect(tauri.copyDocument).toHaveBeenCalledExactlyOnceWith({ id: 'filedoc-0' });
    });

    it('annule une traduction EN LA NOMMANT, là où la transcription n’a rien à désambiguïser', async () => {
      // ⚠️ Le backend ne tient qu'une transcription à la fois, mais autant de traductions que de
      // fenêtres-documents ouvertes : sans l'identifiant, on arrêterait le travail de la voisine.
      const { tauri, service } = harness();

      await service.cancelTranslation('filedoc-2');

      expect(tauri.cancelDocumentTranslation).toHaveBeenCalledExactlyOnceWith('filedoc-2');
    });
  });

  /**
   * ⚠️ **L'interception elle-même vit dans le pont depuis P4-18**, parce que les **deux**
   * fenêtres-documents l'emploient et que c'est au pont d'envelopper `@tauri-apps/api`. Ce qui
   * s'éprouve ici est donc la délégation ; le comportement — `preventDefault` compris — est
   * éprouvé dans `tauri.spec.ts`.
   */
  describe('l’interception de la fermeture', () => {
    it('délègue au pont, sans rien réécrire au passage', async () => {
      const stop = () => undefined;
      const { tauri, service } = harness({
        onCloseRequested: vi.fn(() => Promise.resolve(stop)),
      });
      const handler = vi.fn();

      await expect(service.observeCloseRequest(handler)).resolves.toBe(stop);
      expect(tauri.onCloseRequested).toHaveBeenCalledExactlyOnceWith(handler);
    });
  });
});
