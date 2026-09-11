import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FiledocStore } from './filedoc.store';
import { Transcription } from '../../services/transcription/transcription';
import type { FileDocument, TranscriptTranslation } from '../../services/bridge/media/media.bridge';

/**
 * Ce que ce fichier éprouve : **l'état d'une fenêtre-document** — la lecture initiale, la règle
 * « une opération à la fois », ce qui décide qu'il y a quelque chose à perdre, et les chemins
 * d'échec, qui doivent laisser le document affiché intact.
 */
function documentWith(
  paragraphs: FileDocument['transcript']['paragraphs'] = [],
  title = 'plateau.mp4',
): FileDocument {
  return {
    id: 'filedoc-0',
    title,
    fileName: 'plateau.mp4',
    path: '/Users/moi/Films/plateau.mp4',
    language: 'fr',
    durationMs: 370_149,
    transcript: { language: 'fr', paragraphs },
  };
}

const PARAGRAPH = { words: [{ text: 'Bonjour', startMs: 0, endMs: 400 }] };
const EMPTY = documentWith([]);
const FULL = documentWith([PARAGRAPH]);

const TRANSLATED: TranscriptTranslation = {
  kind: 'translated',
  paragraphs: [{ startMs: 0, endMs: 400, text: 'Guten Tag' }],
};

interface Overrides {
  readonly document?: () => Promise<FileDocument | null>;
  readonly rename?: () => Promise<FileDocument | null>;
  readonly close?: () => Promise<void>;
  readonly translate?: () => Promise<TranscriptTranslation | null>;
  readonly cancelTranslation?: () => Promise<void>;
  readonly chooseExportPath?: () => Promise<boolean>;
  readonly exportDocument?: () => Promise<void>;
  readonly copy?: () => Promise<void>;
}

function harness(overrides: Overrides = {}) {
  const transcription = {
    document: vi.fn(overrides.document ?? (() => Promise.resolve(FULL))),
    rename: vi.fn(overrides.rename ?? (() => Promise.resolve(FULL))),
    close: vi.fn(overrides.close ?? (() => Promise.resolve())),
    translate: vi.fn(overrides.translate ?? (() => Promise.resolve(TRANSLATED))),
    cancelTranslation: vi.fn(overrides.cancelTranslation ?? (() => Promise.resolve())),
    chooseExportPath: vi.fn(overrides.chooseExportPath ?? (() => Promise.resolve(true))),
    export: vi.fn(overrides.exportDocument ?? (() => Promise.resolve())),
    copy: vi.fn(overrides.copy ?? (() => Promise.resolve())),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: Transcription, useValue: transcription }],
  });
  return { transcription, store: TestBed.inject(FiledocStore) };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
});

describe('FiledocStore', () => {
  it('n’a ni document, ni erreur, ni opération avant d’avoir ouvert quoi que ce soit', () => {
    const { store } = harness();

    expect(store.document()).toBeNull();
    expect(store.loaded()).toBe(false);
    expect(store.busy()).toBe(false);
    expect(store.error()).toBeNull();
  });

  describe('l’ouverture', () => {
    it('lit le document par son identifiant complet, jamais par le segment d’URL', async () => {
      const { transcription, store } = harness();

      await store.open('filedoc-0');

      expect(transcription.document).toHaveBeenCalledExactlyOnceWith('filedoc-0');
      expect(store.document()).toBe(FULL);
      expect(store.loaded()).toBe(true);
      expect(store.busy()).toBe(false);
    });

    it('se déclare lu même quand le pont ne rend rien — hors contexte Tauri', async () => {
      // ⚠️ « Pas encore lu » et « rien à montrer » ne se confondent pas : sans `loaded`, la
      // fenêtre attendrait indéfiniment un document qui n'arrivera jamais.
      const { store } = harness({ document: () => Promise.resolve(null) });

      await store.open('filedoc-0');

      expect(store.document()).toBeNull();
      expect(store.loaded()).toBe(true);
    });

    it('retient l’échec sans rester occupée', async () => {
      const { store } = harness({
        document: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });

      await store.open('filedoc-0');

      expect(store.error()?.message).toBe('boum');
      expect(store.loaded()).toBe(true);
      expect(store.busy()).toBe(false);
    });

    it('oublie une erreur une fois qu’elle a été dite', async () => {
      const { store } = harness({
        document: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      await store.open('filedoc-0');

      store.clearError();

      expect(store.error()).toBeNull();
    });
  });

  describe('ce qu’il y a à perdre', () => {
    it('ne voit rien à exporter dans un transcript sans le moindre paragraphe', async () => {
      const { store } = harness({ document: () => Promise.resolve(documentWith([])) });
      await store.open('filedoc-0');

      expect(store.hasContent()).toBe(false);
    });

    it('reconnaît un transcript qui porte du texte', async () => {
      const { store } = harness();
      await store.open('filedoc-0');

      expect(store.hasContent()).toBe(true);
    });

    it('ne voit rien à perdre quand la lecture a échoué', async () => {
      const { store } = harness({ document: () => Promise.resolve(null) });
      await store.open('filedoc-0');

      expect(store.hasContent()).toBe(false);
    });
  });

  describe('le renommage', () => {
    it('remplace le document par celui que Rust rend', async () => {
      const renamed = documentWith([PARAGRAPH], 'Plateau télé');
      const { transcription, store } = harness({ rename: () => Promise.resolve(renamed) });
      await store.open('filedoc-0');

      await store.rename('Plateau télé');

      expect(transcription.rename).toHaveBeenCalledExactlyOnceWith('filedoc-0', 'Plateau télé');
      expect(store.document()).toBe(renamed);
    });

    it('n’occupe jamais la fenêtre : renommer n’est pas un travail', async () => {
      // ⚠️ Un voile qui clignote à chaque validation de titre donnerait l'image d'un outil qui
      // peine sur un mot.
      let settle: (document: FileDocument) => void = () => undefined;
      const { store } = harness({
        rename: () => new Promise<FileDocument>((resolve) => (settle = resolve)),
      });
      await store.open('filedoc-0');

      const pending = store.rename('Plateau télé');
      expect(store.busy()).toBe(false);
      settle(FULL);
      await pending;
    });

    it('garde le titre affiché quand le pont ne rend rien', async () => {
      const { store } = harness({ rename: () => Promise.resolve(null) });
      await store.open('filedoc-0');

      await store.rename('Plateau télé');

      expect(store.document()).toBe(FULL);
    });

    it('ne renomme rien tant qu’aucun document n’est ouvert', async () => {
      const { transcription, store } = harness();

      await store.rename('Plateau télé');

      expect(transcription.rename).not.toHaveBeenCalled();
    });

    it('retient un échec de renommage sans effacer le document', async () => {
      const { store } = harness({
        rename: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      await store.open('filedoc-0');

      await store.rename('Plateau télé');

      expect(store.error()?.message).toBe('boum');
      expect(store.document()).toBe(FULL);
    });
  });

  describe('la traduction', () => {
    it('range les paragraphes traduits sans toucher au document d’origine', async () => {
      // ⚠️⚠️ C'est une VUE, pas un remplacement : l'original doit rester intact, sinon revenir à
      // la langue d'origine exigerait une nouvelle transcription — la traduction ayant détruit
      // l'horodatage au mot.
      const { transcription, store } = harness();
      await store.open('filedoc-0');

      await expect(store.translate('de')).resolves.toBe('translated');

      expect(transcription.translate).toHaveBeenCalledExactlyOnceWith('filedoc-0', 'de');
      expect(store.document()).toBe(FULL);
      expect(store.translation()).toEqual([{ startMs: 0, endMs: 400, text: 'Guten Tag' }]);
    });

    it('occupe la fenêtre le temps du travail', async () => {
      let settle: (outcome: TranscriptTranslation) => void = () => undefined;
      const { store } = harness({
        translate: () => new Promise<TranscriptTranslation>((resolve) => (settle = resolve)),
      });
      await store.open('filedoc-0');

      const pending = store.translate('de');
      expect(store.operation()).toBe('translating');

      settle(TRANSLATED);
      await pending;
      expect(store.operation()).toBeNull();
    });

    it('n’affiche rien et n’appelle rien une panne quand la paire manque', async () => {
      // ⚠️⚠️ `pairMissing` arrive en SUCCÈS côté Rust : c'est un arbitrage à proposer, pas une
      // panne. L'afficher comme une erreur ferait douter l'utilisateur de sa machine.
      const { store } = harness({
        translate: () => Promise.resolve({ kind: 'pairMissing', source: 'fr', target: 'de' }),
      });
      await store.open('filedoc-0');

      await expect(store.translate('de')).resolves.toBe('pairMissing');

      expect(store.translation()).toBeNull();
      expect(store.error()).toBeNull();
    });

    it('rend le genre d’une paire non supportée, sans rien changer non plus', async () => {
      const { store } = harness({
        translate: () => Promise.resolve({ kind: 'pairUnsupported', source: 'fr', target: 'de' }),
      });
      await store.open('filedoc-0');

      await expect(store.translate('de')).resolves.toBe('pairUnsupported');
      expect(store.translation()).toBeNull();
    });

    it('rend `null` hors contexte Tauri, sans se déclarer en échec', async () => {
      const { store } = harness({ translate: () => Promise.resolve(null) });
      await store.open('filedoc-0');

      await expect(store.translate('de')).resolves.toBeNull();
      expect(store.error()).toBeNull();
    });

    it('retient l’échec et laisse le transcript d’origine à l’écran', async () => {
      const { store } = harness({
        translate: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      await store.open('filedoc-0');

      await expect(store.translate('de')).resolves.toBeNull();
      expect(store.error()?.message).toBe('boum');
      expect(store.translation()).toBeNull();
      expect(store.document()).toBe(FULL);
    });

    it('ne traduit rien tant qu’aucun document n’est ouvert', async () => {
      const { transcription, store } = harness();

      await expect(store.translate('de')).resolves.toBeNull();
      expect(transcription.translate).not.toHaveBeenCalled();
    });

    it('revient à la langue d’origine sans appeler personne', async () => {
      const { transcription, store } = harness();
      await store.open('filedoc-0');
      await store.translate('de');
      transcription.translate.mockClear();

      store.clearTranslation();

      expect(store.translation()).toBeNull();
      expect(transcription.translate).not.toHaveBeenCalled();
    });
  });

  describe('l’annulation d’une traduction', () => {
    it('rend le genre `cancelled` sans afficher de traduction ni la moindre erreur', async () => {
      // ⚠️⚠️ Annuler n'est PAS un échec : l'utilisateur a demandé l'arrêt, il l'a obtenu. Et le
      // document garde ce qu'il affichait — un demi-transcript traduit serait pire que rien.
      const { store } = harness({ translate: () => Promise.resolve({ kind: 'cancelled' }) });
      await store.open('filedoc-0');

      await expect(store.translate('de')).resolves.toBe('cancelled');

      expect(store.translation()).toBeNull();
      expect(store.error()).toBeNull();
      expect(store.operation()).toBeNull();
    });

    it('laisse à l’écran la traduction précédente, plutôt qu’un demi-transcript', async () => {
      // Une annulation ne remplace rien : ce qui était affiché avant l'était pour de bon.
      const outcomes: TranscriptTranslation[] = [TRANSLATED, { kind: 'cancelled' }];
      const { store } = harness({
        translate: () => Promise.resolve(outcomes.shift() ?? TRANSLATED),
      });
      await store.open('filedoc-0');
      await store.translate('de');

      await expect(store.translate('it')).resolves.toBe('cancelled');

      expect(store.translation()).toEqual(
        TRANSLATED.kind === 'translated' ? TRANSLATED.paragraphs : [],
      );
    });

    it('demande l’arrêt du document affiché, et de lui seul', async () => {
      const { transcription, store } = harness({
        translate: () => new Promise<TranscriptTranslation>(() => undefined),
      });
      await store.open('filedoc-0');
      void store.translate('de');

      await store.cancelTranslation();

      expect(transcription.cancelTranslation).toHaveBeenCalledExactlyOnceWith('filedoc-0');
    });

    it('ne demande rien quand aucune traduction ne tourne', async () => {
      // ⚠️ Ni au repos, ni pendant une AUTRE opération : le drapeau viserait un travail qui
      // n'existe pas.
      const { transcription, store } = harness({
        exportDocument: () => new Promise<void>(() => undefined),
      });
      await store.open('filedoc-0');

      await store.cancelTranslation();
      void store.exportTo('markdown', '3 août 2026');
      await store.cancelTranslation();

      expect(transcription.cancelTranslation).not.toHaveBeenCalled();
    });

    it('ne demande rien tant qu’aucun document n’est ouvert', async () => {
      const { transcription, store } = harness();

      await store.cancelTranslation();

      expect(transcription.cancelTranslation).not.toHaveBeenCalled();
    });

    it('n’inscrit aucune erreur quand le pont refuse l’arrêt', async () => {
      // ⚠️ Une snackbar rouge sur un geste d'abandon ferait croire à une panne. La traduction ira
      // au bout, ce qui reste une issue acceptable.
      const { store } = harness({
        translate: () => new Promise<TranscriptTranslation>(() => undefined),
        cancelTranslation: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      await store.open('filedoc-0');
      void store.translate('de');

      await store.cancelTranslation();

      expect(store.error()).toBeNull();
      expect(store.operation()).toBe('translating');
    });
  });

  describe('l’export', () => {
    it('ouvre la boîte, puis écrit — sans jamais nommer de fichier', async () => {
      const { transcription, store } = harness();
      await store.open('filedoc-0');

      await expect(store.exportTo('markdown', '3 août 2026')).resolves.toBe(true);

      expect(transcription.chooseExportPath).toHaveBeenCalledExactlyOnceWith(
        'filedoc-0',
        '3 août 2026',
        'markdown',
      );
      // ⚠️ Aucun `path` : c'est Rust qui tient l'emplacement choisi, et ce magasin ne le voit
      // jamais. Le webview désigne un document, pas un fichier à écrire.
      expect(transcription.export).toHaveBeenCalledExactlyOnceWith({
        id: 'filedoc-0',
        format: 'markdown',
        paragraphs: undefined,
      });
    });

    it('n’envoie AUCUN paragraphe tant qu’aucune traduction n’est affichée', async () => {
      // ⚠️ `undefined` veut dire « relis le transcript », et c'est ce qui garde à l'export JSON
      // ses mots horodatés. Envoyer les tours d'origine les lui ferait perdre en silence.
      const { transcription, store } = harness();
      await store.open('filedoc-0');

      await store.exportTo('json', '3 août 2026');

      expect(transcription.export).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ paragraphs: undefined }),
      );
    });

    it('envoie la traduction AFFICHÉE, pour que le fichier ressemble à l’écran', async () => {
      // ⚠️⚠️ Le défaut que cela répare : l'écran montrait de l'allemand, le `.docx` sortait en
      // français — la traduction vit ici, le backend ne connaît que le transcript d'origine.
      const { transcription, store } = harness();
      await store.open('filedoc-0');
      await store.translate('de');

      await store.exportTo('docx', '3 août 2026');

      expect(transcription.export).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          paragraphs: TRANSLATED.kind === 'translated' ? TRANSLATED.paragraphs : [],
        }),
      );
    });

    it('cesse d’envoyer des paragraphes dès le retour à la langue d’origine', async () => {
      const { transcription, store } = harness();
      await store.open('filedoc-0');
      await store.translate('de');
      store.clearTranslation();

      await store.exportTo('markdown', '3 août 2026');

      expect(transcription.export).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ paragraphs: undefined }),
      );
    });

    it('n’occupe la fenêtre qu’à partir de l’écriture, jamais pendant la boîte', async () => {
      // ⚠️⚠️ Personne ne peut décider combien de temps l'utilisateur a le droit de choisir son
      // dossier, et un voile de travail par-dessus un panneau système annoncerait un travail qui
      // n'a pas commencé.
      let choose: (chosen: boolean) => void = () => undefined;
      const { store } = harness({
        chooseExportPath: () => new Promise<boolean>((resolve) => (choose = resolve)),
      });
      await store.open('filedoc-0');

      const pending = store.exportTo('markdown', '3 août 2026');
      await Promise.resolve();
      expect(store.busy()).toBe(false);

      choose(true);
      await pending;
      expect(store.operation()).toBeNull();
    });

    it('renoncer dans la boîte n’est pas un échec — rien n’est écrit, rien n’est dit', async () => {
      const { transcription, store } = harness({ chooseExportPath: () => Promise.resolve(false) });
      await store.open('filedoc-0');

      await expect(store.exportTo('pdf', '3 août 2026')).resolves.toBe(false);

      expect(transcription.export).not.toHaveBeenCalled();
      expect(store.error()).toBeNull();
    });

    it('retient un échec de la boîte elle-même, avant toute écriture', async () => {
      const { store } = harness({
        chooseExportPath: () => Promise.reject({ kind: 'io', message: 'dossier introuvable' }),
      });
      await store.open('filedoc-0');

      await expect(store.exportTo('csv', '3 août 2026')).resolves.toBe(false);
      expect(store.error()?.message).toBe('dossier introuvable');
      expect(store.busy()).toBe(false);
    });

    it('retient un échec d’écriture et rend la fenêtre', async () => {
      const { store } = harness({
        exportDocument: () => Promise.reject({ kind: 'io', message: 'disque plein' }),
      });
      await store.open('filedoc-0');

      await expect(store.exportTo('json', '3 août 2026')).resolves.toBe(false);
      expect(store.error()?.message).toBe('disque plein');
      expect(store.operation()).toBeNull();
    });

    it('n’exporte rien sans document ouvert, ni pendant une autre opération', async () => {
      const { transcription, store } = harness();
      await expect(store.exportTo('csv', '3 août 2026')).resolves.toBe(false);
      expect(transcription.chooseExportPath).not.toHaveBeenCalled();

      let settle: () => void = () => undefined;
      const busy = harness({ copy: () => new Promise<void>((resolve) => (settle = resolve)) });
      await busy.store.open('filedoc-0');
      const pending = busy.store.copy();

      await expect(busy.store.exportTo('csv', '3 août 2026')).resolves.toBe(false);
      expect(busy.transcription.chooseExportPath).not.toHaveBeenCalled();

      settle();
      await pending;
    });
  });

  describe('la copie', () => {
    it('copie ce que la fenêtre affiche, et le dit', async () => {
      const { transcription, store } = harness();
      await store.open('filedoc-0');

      await expect(store.copy()).resolves.toBe(true);

      expect(transcription.copy).toHaveBeenCalledExactlyOnceWith({
        id: 'filedoc-0',
        paragraphs: undefined,
      });
    });

    it('copie ce qui est AFFICHÉ, traduction comprise', async () => {
      const { transcription, store } = harness();
      await store.open('filedoc-0');
      await store.translate('de');

      await expect(store.copy()).resolves.toBe(true);

      expect(transcription.copy).toHaveBeenCalledExactlyOnceWith({
        id: 'filedoc-0',
        paragraphs: TRANSLATED.kind === 'translated' ? TRANSLATED.paragraphs : [],
      });
    });

    it('occupe la fenêtre, malgré sa brièveté', async () => {
      let settle: () => void = () => undefined;
      const { store } = harness({ copy: () => new Promise<void>((resolve) => (settle = resolve)) });
      await store.open('filedoc-0');

      const pending = store.copy();
      expect(store.operation()).toBe('copying');

      settle();
      await pending;
      expect(store.operation()).toBeNull();
    });

    it('retient un échec et rend faux', async () => {
      const { store } = harness({
        copy: () => Promise.reject({ kind: 'native', message: 'presse-papiers refusé' }),
      });
      await store.open('filedoc-0');

      await expect(store.copy()).resolves.toBe(false);
      expect(store.error()?.message).toBe('presse-papiers refusé');
    });

    it('ne copie rien tant qu’aucun document n’est ouvert', async () => {
      const { transcription, store } = harness();

      await expect(store.copy()).resolves.toBe(false);
      expect(transcription.copy).not.toHaveBeenCalled();
    });
  });

  describe('la fermeture', () => {
    it('libère le document par son identifiant', async () => {
      const { transcription, store } = harness();
      await store.open('filedoc-0');

      await store.close();

      expect(transcription.close).toHaveBeenCalledExactlyOnceWith('filedoc-0');
    });

    it('reste occupée après un succès : la fenêtre disparaît dans la foulée', async () => {
      // ⚠️ Relâcher rouvrirait les contrôles d'un document qui n'existe plus, le temps que
      // macOS finisse de fermer.
      const { store } = harness();
      await store.open('filedoc-0');

      await store.close();

      expect(store.operation()).toBe('closing');
    });

    it('rend la fenêtre à son propriétaire quand la fermeture échoue', async () => {
      const { store } = harness({ close: () => Promise.reject({ kind: 'io', message: 'boum' }) });
      await store.open('filedoc-0');

      await store.close();

      expect(store.operation()).toBeNull();
      expect(store.error()?.message).toBe('boum');
    });

    it('ne ferme rien tant qu’aucun document n’est ouvert, ni pendant une autre opération', async () => {
      const { transcription, store } = harness();
      await store.close();
      expect(transcription.close).not.toHaveBeenCalled();

      let settle: () => void = () => undefined;
      const busy = harness({ copy: () => new Promise<void>((resolve) => (settle = resolve)) });
      await busy.store.open('filedoc-0');
      const pending = busy.store.copy();

      await busy.store.close();
      expect(busy.transcription.close).not.toHaveBeenCalled();

      settle();
      await pending;
    });
  });
});
