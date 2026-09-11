import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_ID, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Directdoc } from './directdoc';
import { DirectRecording } from './components/direct-recording/direct-recording';
import { DirectDocument } from './components/direct-document/direct-document';
import { DirectStore } from '../../core/store/direct/direct.store';
import { Live } from '../../core/services/live/live';
import { Modal } from '../../core/services/modal/modal';
import { RecordingSound } from '../../core/services/overlay/recording-sound';
import { ReportPromptsStore } from '../../core/store/report-prompts/report-prompts.store';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { expectNoAxeViolations } from '../../../testing/axe';
import { DEFAULT_SETTINGS } from '../../core/models/settings';
import type { LiveReportType } from '../../core/models/settings';
import type { AppError } from '../../core/models/app-error';
import type { LiveLine } from '../../core/services/live/live';
import type {
  LiveDocument,
  LiveProgress,
  LiveStep,
  LiveTranscriptEvent,
  ReportPrompt,
} from '../../core/services/bridge/live/live.bridge';

/** Une étape franchie, telle que le backend l'annonce. */
function crossed(step: LiveStep, done: number, total: number, id = 'directdoc-3'): LiveProgress {
  return { documentId: id, step, done, total };
}

/** Un paragraphe, écrit court — ces tests en alignent plusieurs. */
function paragraph(...texts: string[]) {
  return {
    words: texts.map((text, index) => ({
      text,
      startMs: index * 500,
      endMs: index * 500 + 400,
    })),
  };
}

function section(heading: string, lines: string[], bullets = false) {
  return { heading, lines, bullets };
}

/** Un prompt nommé, tel que les Options en écrivent. */
const CLIENT: ReportPrompt = { id: 7, title: 'Client', prompt: 'Décisions, tâches, risques.' };

const STARTED_AT = new Date(2026, 7, 4, 14, 30).getTime();
const ENDED_AT = STARTED_AT + 3_600_000;

/** Une session **terminée** — l'état dans lequel la plupart de ces tests la prennent. */
function finished(overrides: Partial<LiveDocument> = {}): LiveDocument {
  return {
    id: 'directdoc-3',
    title: 'Session produit hebdo',
    sourceName: 'Microsoft Teams',
    startedAtMs: STARTED_AT,
    endedAtMs: ENDED_AT,
    transcript: {
      language: 'fr',
      paragraphs: [paragraph('Bon,', 'on', 'commence', '?'), paragraph('Oui.')],
    },
    report: [],
    translationTarget: null,
    ...overrides,
  };
}

/**
 * Une session **qui enregistre**.
 *
 * ⚠️ **`endedAtMs: null` est TOUT ce qui la distingue** — un second champ booléen aurait pu
 * diverger du premier, il n'existe donc ni ici ni côté Rust.
 */
function recording(overrides: Partial<LiveDocument> = {}): LiveDocument {
  return finished({
    endedAtMs: null,
    title: null,
    transcript: { language: '', paragraphs: [] },
    ...overrides,
  });
}

/** Les rappels que la fenêtre a passés au service, retenus par le harnais. */
let transcriptHandler: ((event: LiveTranscriptEvent) => void) | null = null;
let stoppedHandler: ((documentId: string) => void) | null = null;
let finalisedHandler: ((document: LiveDocument) => void) | null = null;
let progressHandler: ((progress: LiveProgress) => void) | null = null;
let translationProgressHandler: ((percent: number) => void) | null = null;
let closeHandler: (() => void) | null = null;
let levelHandler: ((level: number) => void) | null = null;

interface Options {
  /** Ce que la fenêtre trouve à son ouverture. */
  readonly opens?: LiveDocument | null;
  readonly confirms?: boolean;
  readonly soundsEnabled?: boolean;
  readonly silentStreams?: { stream: 'system' | 'microphone'; reason: string }[];
  readonly subscribeFails?: boolean;
  /** Les prompts nommés que le magasin a chargés. */
  readonly prompts?: readonly ReportPrompt[];
  /** Ce que les réglages proposent comme forme de compte rendu. */
  readonly reportType?: LiveReportType;
  /** Le prompt nommé que les réglages désignent. */
  readonly reportPromptId?: number | null;
}

function harness(overrides: Record<string, unknown> = {}, options: Options = {}) {
  transcriptHandler = null;
  stoppedHandler = null;
  finalisedHandler = null;
  progressHandler = null;
  translationProgressHandler = null;
  closeHandler = null;
  levelHandler = null;

  const unlisten = vi.fn();
  const subscribe = <T>(keep: (handler: T) => void) =>
    vi.fn(async (handler: T) => {
      if (options.subscribeFails === true) {
        throw new Error('le pont ne répond pas');
      }
      keep(handler);
      return unlisten;
    });

  const live = {
    // ⚠️ `'opens' in options` et non `??` : un test veut précisément que la fenêtre ne trouve
    // **rien**, et `null ?? finished()` lui rendrait le document par défaut.
    document: vi.fn().mockResolvedValue('opens' in options ? options.opens : finished()),
    generateReport: vi.fn().mockResolvedValue(finished({ report: [] })),
    rename: vi
      .fn()
      .mockImplementation(async (_id: string, title: string) =>
        finished({ title: title.trim().length === 0 ? null : title.trim() }),
      ),
    closeDocument: vi.fn().mockResolvedValue(undefined),
    cancelReport: vi.fn().mockResolvedValue(undefined),
    translateTranscript: vi.fn().mockResolvedValue({
      kind: 'translated',
      paragraphs: [{ startMs: 0, endMs: 900, text: 'Shall we start with the roadmap?' }],
    }),
    translateReport: vi.fn().mockResolvedValue({
      kind: 'translated',
      sections: [{ heading: 'Summary', lines: ['Weekly product review.'], bullets: false }],
    }),
    cancelTranslation: vi.fn().mockResolvedValue(undefined),
    chooseExportPath: vi.fn().mockResolvedValue(true),
    exportDocument: vi.fn().mockResolvedValue(undefined),
    copyDocument: vi.fn().mockResolvedValue(undefined),
    translate: vi.fn(async (text: string) => `EN(${text})`),
    onTranscript: subscribe<(event: LiveTranscriptEvent) => void>((handler) => {
      transcriptHandler = handler;
    }),
    onStopped: subscribe<(documentId: string) => void>((handler) => {
      stoppedHandler = handler;
    }),
    onFinalised: subscribe<(document: LiveDocument) => void>((handler) => {
      finalisedHandler = handler;
    }),
    onProgress: subscribe<(progress: LiveProgress) => void>((handler) => {
      progressHandler = handler;
    }),
    onLevel: subscribe<(level: number) => void>((handler) => {
      levelHandler = handler;
    }),
    onTranslationProgress: vi.fn(async (_id: string, handler: (percent: number) => void) => {
      if (options.subscribeFails === true) {
        throw new Error('le pont ne répond pas');
      }
      translationProgressHandler = handler;
      return unlisten;
    }),
    onCloseRequest: subscribe<() => void>((handler) => {
      closeHandler = handler;
    }),
    ...overrides,
  };

  const error = signal<AppError | null>(null);
  const store = {
    transcript: signal<LiveLine[]>([]),
    pending: signal({ system: null, microphone: null }),
    silentStreams: signal(options.silentStreams ?? []),
    translations: signal<Record<number, string>>({}),
    translated: vi.fn((id: number, text: string) => {
      store.translations.update((known) => ({ ...known, [id]: text }));
    }),
    busy: signal(false),
    startedAtMs: signal<number | null>(STARTED_AT),
    recordingWithMicrophone: signal(true),
    error,
    sync: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    stopped: vi.fn(),
    applyTranscript: vi.fn(),
    dropPendingSpeech: vi.fn(),
    clearError: vi.fn(() => error.set(null)),
  };

  // ⚠️ `info` et non `error` pour une paire absente : ce n'est pas une panne, c'est une langue à
  // ajouter — même règle qu'en Fichiers.
  const snackbar = { error: vi.fn(), success: vi.fn(), info: vi.fn() };
  const modal = { confirm: vi.fn().mockResolvedValue(options.confirms ?? true) };
  const sound = { play: vi.fn() };
  const settings = {
    loaded: signal(true),
    settings: signal({
      ...DEFAULT_SETTINGS,
      soundsEnabled: options.soundsEnabled ?? true,
      liveReportType: options.reportType ?? DEFAULT_SETTINGS.liveReportType,
      liveReportPromptId: options.reportPromptId ?? null,
    }),
  };

  // ⚠️ Un faux magasin : le vrai injecte le pont, et cette fenêtre ne fait que le lire.
  const known = options.prompts ?? [];
  const promptsError = signal<AppError | null>(null);
  const prompts = {
    prompts: signal(known),
    loaded: signal(true),
    error: promptsError,
    byId: vi.fn((id: number | null) => known.find((entry) => entry.id === id)),
    load: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(() => promptsError.set(null)),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Live, useValue: live },
      { provide: DirectStore, useValue: store },
      { provide: SettingsStore, useValue: settings },
      { provide: ReportPromptsStore, useValue: prompts },
      { provide: Snackbar, useValue: snackbar },
      { provide: Modal, useValue: modal },
      { provide: RecordingSound, useValue: sound },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ id: '3' }) } },
      },
    ],
  });

  return { live, store, snackbar, modal, sound, settings, prompts, unlisten, error };
}

/**
 * Laisse la fenêtre se poser.
 *
 * ⚠️⚠️ **UN `setTimeout`, ET NON UN NOMBRE DE `whenStable`.** L'ouverture est une chaîne
 * d'attentes — s'abonner, se mettre à l'heure de la session, lire le document — et sans zone,
 * `whenStable` ne suit pas ces promesses-là : compter les tours revient à figer dans le test la
 * profondeur d'appel du code, et le moindre `await` de plus casse des tests qui n'ont rien à
 * voir. Un délai zéro s'exécute **après toute la file de micro-tâches**, quelle que soit sa
 * longueur ; `whenStable` ne sert plus qu'à repeindre.
 */
async function settle(fixture: ComponentFixture<Directdoc>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  fixture.detectChanges();
}

async function render(overrides: Record<string, unknown> = {}, options: Options = {}) {
  const tools = harness(overrides, options);
  const fixture = TestBed.createComponent(Directdoc);
  fixture.detectChanges();
  await settle(fixture);
  return { ...tools, fixture };
}

/** Monte la fenêtre **sur des timers factices** — voir la note de `direct.spec.ts`. */
async function renderTicking(options: Options = {}) {
  const tools = harness({}, options);
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Directdoc);
  fixture.detectChanges();
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();
  return { ...tools, fixture };
}

function panel(fixture: ComponentFixture<Directdoc>): DirectRecording {
  return fixture.debugElement.query(By.directive(DirectRecording)).componentInstance;
}

function done(fixture: ComponentFixture<Directdoc>): DirectDocument {
  return fixture.debugElement.query(By.directive(DirectDocument)).componentInstance;
}

/** Le voile, ou `null` s'il n'y en a pas. */
function veil(fixture: ComponentFixture<Directdoc>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector('app-doc-overlay');
}

/**
 * Un `Live` dont la génération **ne rend jamais la main** : c'est ce qui maintient le voile
 * ouvert le temps d'observer ce qu'il montre.
 */
function generating(): Record<string, unknown> {
  return { generateReport: vi.fn(() => new Promise<LiveDocument>(() => undefined)) };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.querySelector('.cdk-overlay-container')?.remove();
});

describe('Directdoc', () => {
  it('reads the session its window was opened for', async () => {
    const { live } = await render();
    expect(live.document).toHaveBeenCalledExactlyOnceWith('directdoc-3');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **L'ABONNEMENT AU TRANSCRIPT PRÉCÈDE LA LECTURE DU DOCUMENT.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Le moteur émet dès le démarrage de la capture et le produit ne rejoue rien : s'abonner après
   * l'aller-retour de lecture perdrait les premiers mots — ceux du « bon, on commence ».
   */
  it('subscribes before it asks for anything', async () => {
    const { live } = await render();
    const subscribed = live.onTranscript.mock.invocationCallOrder[0];
    const asked = live.document.mock.invocationCallOrder[0];
    expect(subscribed).toBeLessThan(asked);
  });

  it('mounts the recording panel while the session runs', async () => {
    const { fixture } = await render({}, { opens: recording() });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('app-direct-recording')).not.toBeNull();
    expect(root.querySelector('app-direct-document')).toBeNull();
  });

  it('mounts the document panel once the session is over', async () => {
    const { fixture } = await render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('app-direct-document')).not.toBeNull();
    expect(root.querySelector('app-direct-recording')).toBeNull();
  });

  /**
   * ⚠️⚠️ **LE TITRE PAR DÉFAUT EST DATÉ DU DÉBUT, JAMAIS DE LA FIN.** Il s'affiche **pendant**
   * l'enregistrement : daté de la fin, il changerait sous les yeux de l'utilisateur au moment de
   * l'arrêt, et une session nommée « du 14:30 » deviendrait « du 15:30 ».
   */
  it('dates an unnamed session by when it started', async () => {
    const { fixture } = await render({}, { opens: recording() });
    const shown = panel(fixture).title();
    // ⚠️⚠️ **ON FORMATE AVEC LA LOCALE QUE LE COMPOSANT INJECTE, PAS AVEC CELLE DE LA MACHINE.**
    // `Intl.DateTimeFormat(undefined)` lit l'ambiante, que le harnais ne contrôle pas : le test
    // passait seul et tombait dans la suite entière, selon ce qu'un spec précédent avait laissé
    // dans `$localize.locale`. Un test qui dépend de son rang d'exécution ne prouve rien.
    const locale = TestBed.inject(LOCALE_ID);
    const time = (at: number) =>
      new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(at));

    expect(shown).toContain(time(STARTED_AT));
    expect(shown).not.toContain(time(ENDED_AT));
  });

  it('keeps the title the model proposed', async () => {
    const { fixture } = await render();
    expect(done(fixture).title()).toBe('Session produit hebdo');
  });

  /**
   * ⚠️⚠️ **LA MÉTA NE DIT PAS LA MÊME CHOSE SELON L'ÉTAT, ET C'EST VOULU.** Pendant
   * l'enregistrement elle annonce le **micro** — sa seule trace visible, sans quoi une session
   * entière pourrait s'enregistrer sans la voix de l'utilisateur sans que rien ne le dise.
   * Après, elle annonce **quand** : la date d'une session en cours n'apprendrait rien, on la vit.
   */
  it('announces the microphone while recording, and the date afterwards', async () => {
    const { fixture } = await render({}, { opens: recording() });
    expect(panel(fixture).meta()).toContain('Microsoft Teams');
    expect(panel(fixture).meta()).toContain('micro');

    const after = await render();
    expect(done(after.fixture).meta()).toContain('Microsoft Teams');
    expect(done(after.fixture).meta()).not.toContain('micro');
  });

  it('says when the microphone was left out', async () => {
    const { fixture, store } = await render({}, { opens: recording() });
    store.recordingWithMicrophone.set(false);
    fixture.detectChanges();

    expect(panel(fixture).meta()).toContain('sans micro');
  });

  it('has nothing to show before the document arrives', async () => {
    const { fixture } = await render({}, { opens: null });
    expect(done(fixture).title()).toBe('');
    expect(done(fixture).meta()).toBe('');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **AUCUN COMPTE RENDU NE PART TOUT SEUL** *(porteur, 2026-08-06, décision 8)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * La fenêtre lançait la génération d'elle-même à l'ouverture, avec le type réglé avant
   * l'enregistrement. L'arrêt mène au **transcript**, et s'y arrête : le compte rendu est un
   * geste. ⚠️ **Ne pas rétablir** en trouvant le document nu — « ne rien demander » est une
   * réponse valable, et c'est celle par défaut.
   */
  it('never generates a report on its own', async () => {
    const { live } = await render();
    expect(live.generateReport).not.toHaveBeenCalled();
  });

  /**
   * ⚠️⚠️ **CHOISIR *EST* LE GESTE** *(décision 8)* : il n'y a plus de bouton « Générer ». Ce test
   * n'émet donc **que** le choix du type — ajouter un second geste ici masquerait une régression
   * où le choix ne déclencherait plus rien.
   */
  it('generates the report as soon as a type is chosen, and only then', async () => {
    const { fixture, live } = await render();
    done(fixture).kindChange.emit('lecture');
    await settle(fixture);

    expect(live.generateReport).toHaveBeenCalledExactlyOnceWith('directdoc-3', 'lecture', null);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UN PROMPT NOMMÉ SE CHOISIT COMME UN TYPE LIVRÉ, ET LANCE COMME LUI.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Le champ de prompt et son bouton ont disparu de cette fenêtre : les prompts sont nommés et se
   * gèrent dans les Options. Le menu porte leur titre, la fenêtre en résout le texte.
   */
  it('generates on a named prompt exactly as on a delivered type', async () => {
    const { fixture, live } = await render({}, { prompts: [CLIENT] });
    done(fixture).kindChange.emit(String(CLIENT.id));
    await settle(fixture);

    expect(live.generateReport).toHaveBeenCalledExactlyOnceWith(
      'directdoc-3',
      'custom',
      CLIENT.prompt,
    );
  });

  /**
   * ⚠️ **Le menu émet sur TOUTE sélection**, pas sur un changement de valeur : rechoisir le même
   * prompt relance, et c'est ce qui remplace le bouton disparu. Ne jamais y ajouter de
   * `distinctUntilChanged`.
   */
  it('relaunches when the same prompt is chosen again', async () => {
    const { fixture, live } = await render({}, { prompts: [CLIENT] });
    done(fixture).kindChange.emit(String(CLIENT.id));
    await settle(fixture);
    done(fixture).kindChange.emit(String(CLIENT.id));
    await settle(fixture);

    expect(live.generateReport).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠️ **Un prompt supprimé dans l'autre fenêtre entre l'ouverture du menu et le clic ne part pas
   * au backend** : son numéro ne désigne plus rien, et Rust le refuserait à la désérialisation.
   */
  it('asks the model nothing for a prompt that no longer exists', async () => {
    const { fixture, live } = await render({}, { prompts: [CLIENT] });
    done(fixture).kindChange.emit('404');
    await settle(fixture);

    expect(live.generateReport).not.toHaveBeenCalled();
  });

  /** ⚠️ Le menu part de ce que les Options proposent — un type livré, ou un prompt nommé. */
  it('opens on the report form the settings propose', async () => {
    const delivered = await render({}, { reportType: 'lecture' });
    expect(done(delivered.fixture).kind()).toBe('lecture');

    const named = await render(
      {},
      { reportType: 'custom', reportPromptId: CLIENT.id, prompts: [CLIENT] },
    );
    expect(done(named.fixture).kind()).toBe(String(CLIENT.id));
  });

  /**
   * ⚠️ Un identifiant qui ne désigne plus rien retombe sur « Pas de compte rendu » : le réglage
   * survit à la suppression du prompt dans l'autre fenêtre, et le menu montrerait sinon une
   * valeur absente de sa propre liste.
   */
  it('falls back to « no report » when the settings name a prompt that is gone', async () => {
    const { fixture } = await render({}, { reportType: 'custom', reportPromptId: 404 });
    expect(done(fixture).kind()).toBe('none');
  });

  /** ⚠️ Le menu compose la liste que le magasin porte : la fenêtre ne la recopie pas. */
  it('hands the menu the named prompts the store holds', async () => {
    const { fixture, prompts } = await render({}, { prompts: [CLIENT] });

    expect(prompts.load).toHaveBeenCalled();
    expect(done(fixture).kinds()).toContainEqual(
      expect.objectContaining({ value: String(CLIENT.id), label: CLIENT.title }),
    );
  });

  it('shows the sections the model produced', async () => {
    const written = finished({ report: [section('Résumé', ['Point hebdomadaire.'])] });
    const { fixture } = await render({ generateReport: vi.fn().mockResolvedValue(written) });
    done(fixture).kindChange.emit('team');
    await settle(fixture);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Point hebdomadaire.');
  });

  /** ⚠️ Un second clic pendant le travail ne relance rien : le voile est déjà là. */
  it('refuses a second generation while one is in flight', async () => {
    let release: (value: LiveDocument) => void = () => undefined;
    const generateReport = vi.fn(
      () =>
        new Promise<LiveDocument>((resolve) => {
          release = resolve;
        }),
    );
    const { fixture } = await render({ generateReport });

    done(fixture).kindChange.emit('team');
    done(fixture).kindChange.emit('client');
    release(finished());
    await settle(fixture);

    expect(generateReport).toHaveBeenCalledOnce();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **« PAS DE COMPTE RENDU » NE PART JAMAIS AU BACKEND** *(décision 8)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * « Ne rien produire » est une réponse de l'**interface**, pas un travail qu'on demande au
   * modèle : Rust le refuserait à la désérialisation, c'est-à-dire au pire moment. Et c'est le
   * défaut — donc le chemin le plus fréquent.
   */
  it('asks the model nothing when the type is « no report »', async () => {
    const { fixture, live } = await render();
    done(fixture).kindChange.emit('none');
    await settle(fixture);

    expect(live.generateReport).not.toHaveBeenCalled();
  });

  it('refuses a generation while the session is still recording', async () => {
    const { fixture, live } = await render({}, { opens: recording() });
    const instance = fixture.componentInstance as unknown as { chooseKind: (kind: string) => void };
    instance.chooseKind('team');
    await settle(fixture);

    expect(live.generateReport).not.toHaveBeenCalled();
  });

  it('keeps the window readable when the generation fails', async () => {
    const { fixture, snackbar } = await render({
      generateReport: vi.fn().mockRejectedValue(new Error('modèle indisponible')),
    });
    done(fixture).kindChange.emit('team');
    await settle(fixture);

    expect(snackbar.error).toHaveBeenCalledOnce();
  });

  it('keeps what it had when the generation gives nothing back', async () => {
    const { fixture } = await render({ generateReport: vi.fn().mockResolvedValue(null) });
    done(fixture).kindChange.emit('team');
    await settle(fixture);

    expect(done(fixture).title()).toBe('Session produit hebdo');
  });

  it('renames the session', async () => {
    const { fixture, live } = await render();
    done(fixture).renamed.emit('Point client');
    await settle(fixture);

    expect(live.rename).toHaveBeenCalledExactlyOnceWith('directdoc-3', 'Point client');
    expect(done(fixture).title()).toBe('Point client');
  });

  /**
   * ⚠️ **On renomme sa session PENDANT qu'elle enregistre** — c'est même le moment où l'on sait
   * de quoi elle parle.
   */
  it('renames a session that is still recording', async () => {
    const { fixture, live } = await render({}, { opens: recording() });
    panel(fixture).renamed.emit('Point client');
    await settle(fixture);

    expect(live.rename).toHaveBeenCalledExactlyOnceWith('directdoc-3', 'Point client');
  });

  it('keeps what it had when the rename gives nothing back', async () => {
    const { fixture } = await render({ rename: vi.fn().mockResolvedValue(null) });
    done(fixture).renamed.emit('Point client');
    await settle(fixture);

    expect(done(fixture).title()).toBe('Session produit hebdo');
  });

  it('says a rename failure without losing the document', async () => {
    const { fixture, snackbar } = await render({
      rename: vi.fn().mockRejectedValue(new Error('session introuvable')),
    });
    done(fixture).renamed.emit('Point client');
    await settle(fixture);

    expect(snackbar.error).toHaveBeenCalledOnce();
    expect(done(fixture).title()).toBe('Session produit hebdo');
  });

  it('says a failure to read the document without leaving a blank window', async () => {
    const { fixture, snackbar } = await render({
      document: vi.fn().mockRejectedValue(new Error('session introuvable')),
    });

    expect(snackbar.error).toHaveBeenCalledOnce();
    expect((fixture.nativeElement as HTMLElement).querySelector('app-header')).not.toBeNull();
  });

  it('records anyway when nothing can be subscribed to', async () => {
    const { snackbar } = await render({}, { subscribeFails: true });
    expect(snackbar.error).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Une fenêtre détruite pendant l'abonnement ne laisse rien derrière elle.** Les quatre
   * canaux se branchent par aller-retour ; fermer la fenêtre entre-temps laisserait des rappels
   * sans propriétaire, qui écriraient dans un composant mort.
   */
  it('unsubscribes at once when the window died while subscribing', async () => {
    const tools = harness();
    const fixture = TestBed.createComponent(Directdoc);
    fixture.detectChanges();
    fixture.destroy();
    await new Promise((resolve) => setTimeout(resolve));

    expect(tools.unlisten).toHaveBeenCalledTimes(7);
  });

  /**
   * ⚠️ **Une fenêtre sans identifiant de route n'est pas une erreur à faire remonter** : elle
   * demande un document vide, le backend répond qu'il ne le connaît pas, et l'écran le dit. Ce
   * qu'on éprouve ici est qu'aucun `undefined` ne parte dans le pont.
   */
  it('asks for an empty identifier rather than for undefined', async () => {
    harness();
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: { snapshot: { paramMap: convertToParamMap({}) } },
    });
    const fixture = TestBed.createComponent(Directdoc);
    fixture.detectChanges();
    await settle(fixture);

    expect(TestBed.inject(Live).document).toHaveBeenCalledExactlyOnceWith('directdoc-');
  });

  /* ── L'arrêt, et son voile ──────────────────────────────────────────────────────────── */

  it('stops the session from its own button, and chimes', async () => {
    const { fixture, store, sound } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);

    expect(store.stop).toHaveBeenCalledOnce();
    expect(store.dropPendingSpeech).toHaveBeenCalledOnce();
    expect(sound.play).toHaveBeenCalledExactlyOnceWith('stop');
  });

  // ⚠️ **Cette fenêtre ne lit plus le réglage** : le service le fait, et lui seul *(P6-04,
  // 2026-08-09)*. Le silence se vérifie dans `recording-sound.spec.ts` ; ce test-ci garde la
  // porte contre le retour du `if` qui relisait le même booléen une seconde fois.
  it('delegates the decision instead of reading the setting itself', async () => {
    const { fixture, sound } = await render({}, { opens: recording(), soundsEnabled: false });
    panel(fixture).stop.emit();
    await settle(fixture);

    expect(sound.play).toHaveBeenCalledExactlyOnceWith('stop');
  });

  it('refuses a second stop on a session already over', async () => {
    const { fixture, store } = await render();
    const instance = fixture.componentInstance as unknown as { stop: () => Promise<void> };
    await instance.stop();

    expect(store.stop).not.toHaveBeenCalled();
  });

  /**
   * ⚠️⚠️ **LE VOILE COUVRE LA CONSOLIDATION, ET IL DOIT LA NOMMER.** Un « Chargement… » unique
   * laisserait croire à un seul traitement, et l'attente d'une génération se lirait comme celle
   * d'une finalisation.
   */
  it('veils the window with the finalisation label until the document arrives', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);
    fixture.detectChanges();

    const veil = (fixture.nativeElement as HTMLElement).querySelector('app-doc-overlay');
    expect(veil).not.toBeNull();
    expect(veil?.textContent).toContain('Finalisation');

    finalisedHandler?.(finished());
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('app-doc-overlay')).toBeNull();
  });

  it('names the generation when that is what it is waiting for', async () => {
    let release: (value: LiveDocument) => void = () => undefined;
    const { fixture } = await render({
      generateReport: vi.fn(
        () =>
          new Promise<LiveDocument>((resolve) => {
            release = resolve;
          }),
      ),
    });
    done(fixture).kindChange.emit('team');
    fixture.detectChanges();

    const veil = (fixture.nativeElement as HTMLElement).querySelector('app-doc-overlay');
    expect(veil?.textContent).toContain('Compte rendu');

    release(finished());
    await settle(fixture);
  });

  /* ── Ce que le voile compte, et ce qu'il offre ──────────────────────────────────────── */

  /**
   * ⚠️⚠️ **LE PREMIER INSTANT EST INDÉTERMINÉ, ET IL DOIT L'ÊTRE.** Entre le lever du voile et le
   * premier évènement, la fenêtre ne sait rien : afficher « 0 % » prétendrait le contraire.
   * `aria-valuenow` est **absent** dans cet état — c'est ainsi qu'un lecteur d'écran dit « en
   * cours, durée inconnue » plutôt que « zéro pour cent ».
   */
  it('waits without pretending to know, until the first step is crossed', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);

    const bar = veil(fixture)?.querySelector('[role="progressbar"]');
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
    expect(veil(fixture)?.querySelector('.percent')).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA BARRE AVANCE À CHAQUE ÉTAPE, ET LE LIBELLÉ NOMME CELLE EN COURS** *(P4-19)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Une session **avec micro** en compte cinq. ⚠️ **L'étape annoncée est celle qui commence** :
   * au premier évènement la barre est à zéro et le libellé dit ce qui se fait, pas ce qui vient
   * d'être fait.
   */
  it('counts the five steps of a finalisation and names each one', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);

    const said: string[] = [];
    const filled: (string | null)[] = [];
    for (const [index, step] of (
      ['settling', 'voices', 'echo', 'weaving', 'erasing'] as const
    ).entries()) {
      progressHandler?.(crossed(step, index, 5));
      fixture.detectChanges();
      said.push(veil(fixture)?.querySelector('.label')?.textContent?.trim() ?? '');
      filled.push(
        veil(fixture)?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
      );
    }

    expect(filled).toEqual(['0', '20', '40', '60', '80']);
    // Chaque étape a son propre libellé : c'est tout l'objet de P4-19.
    expect(new Set(said).size).toBe(5);
    expect(said[0]).toContain('derniers mots');
    expect(said[4]).toContain('audio');
  });

  /**
   * ⚠️⚠️ **SANS MICRO, TROIS ÉTAPES ET NON CINQ** : il n'y a ni voix à rapprocher ni écho à
   * écarter. C'est le backend qui décide du total ; ce test dit que la fenêtre le **suit** au
   * lieu d'en tenir un à elle, qui laisserait la barre à 60 % au moment de disparaître.
   */
  it('follows the shorter plan of a session recorded without a microphone', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);

    progressHandler?.(crossed('weaving', 1, 3));
    fixture.detectChanges();

    expect(
      veil(fixture)?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('33');
  });

  /**
   * ⚠️ **Une session courte n'a qu'une tranche**, donc deux passes : la lecture puis la
   * rédaction. La barre y va de 0 à 50 — pas de cas particulier, pas de barre indéterminée.
   */
  it('counts the two passes of a report on a short session', async () => {
    const { fixture } = await render(generating());
    done(fixture).kindChange.emit('team');
    fixture.detectChanges();

    progressHandler?.(crossed('notes', 0, 2));
    fixture.detectChanges();
    expect(veil(fixture)?.querySelector('.label')?.textContent).toContain('Lecture');

    progressHandler?.(crossed('writing', 1, 2));
    fixture.detectChanges();
    expect(veil(fixture)?.querySelector('.label')?.textContent).toContain('Rédaction');
    expect(veil(fixture)?.querySelector('.percent')?.textContent).toContain('50');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **DEUX ATTENTES SE SUIVENT, ET LA SECONDE NE PART PAS DE LA FIN DE LA PREMIÈRE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * On finalise, puis on demande un compte rendu. Sans remise à zéro **au début** de chaque
   * attente, le voile du compte rendu s'ouvrirait sur « Suppression de l'audio… » à 80 %, le
   * temps d'un aller-retour — un travail terminé annoncé comme celui qui commence.
   */
  it('never opens a wait on the last step of the one before', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);
    progressHandler?.(crossed('erasing', 4, 5));
    finalisedHandler?.(finished());
    fixture.detectChanges();

    done(fixture).kindChange.emit('team');
    fixture.detectChanges();

    const bar = veil(fixture)?.querySelector('[role="progressbar"]');
    expect(veil(fixture)?.querySelector('.label')?.textContent).toContain('Compte rendu');
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
  });

  /**
   * ⚠️⚠️ **UN ÉVÈNEMENT TAURI EST DIFFUSÉ À TOUTES LES FENÊTRES.** Plusieurs fenêtres-sessions
   * peuvent être ouvertes, l'une finalisant pendant que l'autre génère son compte rendu : sans
   * ce tri, chacune afficherait l'avancée de la voisine.
   */
  it('ignores the progress of another session', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);

    progressHandler?.(crossed('echo', 2, 5, 'directdoc-9'));
    fixture.detectChanges();

    expect(veil(fixture)?.querySelector('.label')?.textContent).toContain('Finalisation');
  });

  /**
   * ⚠️⚠️ **NE JAMAIS AFFICHER DE TEMPS RESTANT** *(décision 3)*. Les étapes n'ont pas la même
   * durée — une analyse de voix et une suppression de fichier n'ont rien de comparable — et un
   * temps annoncé faux est pire qu'aucun temps : il est cru.
   */
  it('never shows a duration anywhere under the veil', async () => {
    const { fixture } = await render({}, { opens: recording() });
    panel(fixture).stop.emit();
    await settle(fixture);
    progressHandler?.(crossed('voices', 1, 5));
    fixture.detectChanges();

    const said = veil(fixture)?.textContent?.toLowerCase() ?? '';
    for (const promise of ['restant', 'seconde', 'minute', 'estim']) {
      expect(said).not.toContain(promise);
    }
  });

  /* ── « Annuler » : offert à la génération, jamais à la finalisation ──────────────────── */

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA FINALISATION N'OFFRE AUCUN ANNULER, MÊME AU-DELÀ DU SEUIL DE 2,5 s.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * L'audio est déjà capté, il n'y a plus rien à renoncer, et abandonner ne rendrait que le
   * transcript brut — moins bien pour le même prix. ⚠️ **Le bouton n'apparaît jamais, il n'est
   * pas seulement retardé** : c'est pourquoi ce test laisse passer le seuil au lieu de constater
   * son absence à l'instant zéro, ce qui n'aurait rien prouvé.
   */
  it('offers no way out of a finalisation, even long after the threshold', async () => {
    const { fixture } = await renderTicking({ opens: recording() });
    panel(fixture).stop.emit();
    await vi.advanceTimersByTimeAsync(10_000);
    fixture.detectChanges();

    expect(veil(fixture)).not.toBeNull();
    expect(veil(fixture)?.querySelector('button')).toBeNull();
  });

  /**
   * ⚠️ **Une génération est longue et se reprend** : renoncer y ramène exactement l'état
   * d'avant. Le bouton attend 2,5 s pour ne pas clignoter sur les sessions courtes.
   */
  it('offers to give up a generation, and asks the backend to stop', async () => {
    const { fixture, live } = await renderTicking();
    live.generateReport.mockReturnValue(new Promise<LiveDocument>(() => undefined));
    done(fixture).kindChange.emit('team');
    await vi.advanceTimersByTimeAsync(3_000);
    fixture.detectChanges();

    const button = veil(fixture)?.querySelector('button');
    expect(button?.textContent).toContain('Annuler');
    button?.click();

    expect(live.cancelReport).toHaveBeenCalledExactlyOnceWith('directdoc-3');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **RENONCER RAMÈNE L'ÉTAT D'AVANT, ET LE VOILE NE SE LÈVE PAS AU CLIC.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * L'arrêt se constate **entre deux passes** : le lever tout de suite rendrait la main sur un
   * document que le modèle est encore en train d'écrire. C'est le retour de la commande qui
   * conclut — et il rend le document **inchangé**, donc le compte rendu d'avant survit à une
   * régénération abandonnée.
   */
  it('keeps the veil until the generation actually gives up, and loses nothing', async () => {
    const before = finished({ report: [section('Résumé', ['Point hebdomadaire.'])] });
    let release: (value: LiveDocument) => void = () => undefined;
    const { fixture, live } = await render(
      {
        generateReport: vi.fn(
          () =>
            new Promise<LiveDocument>((resolve) => {
              release = resolve;
            }),
        ),
      },
      { opens: before },
    );
    done(fixture).kindChange.emit('team');
    fixture.detectChanges();

    (fixture.componentInstance as unknown as { cancel: () => void }).cancel();
    fixture.detectChanges();
    expect(veil(fixture)).not.toBeNull();

    // Le backend rend le document tel qu'il était : c'est cela, « l'état d'avant ».
    release(before);
    await settle(fixture);

    expect(live.cancelReport).toHaveBeenCalledOnce();
    expect(veil(fixture)).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Point hebdomadaire.');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UN ARRÊT VENU DE L'AUTRE FENÊTRE LÈVE LE VOILE ICI AUSSI** — ligne de DoD de P4-18.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it('follows a stop that came from the trigger screen', async () => {
    const { fixture, store } = await render({}, { opens: recording() });
    stoppedHandler?.('directdoc-3');
    fixture.detectChanges();

    expect(store.stopped).toHaveBeenCalledOnce();
    expect((fixture.nativeElement as HTMLElement).querySelector('app-doc-overlay')).not.toBeNull();
  });

  /**
   * ⚠️⚠️ **UN ÉVÈNEMENT TAURI EST DIFFUSÉ À TOUTES LES FENÊTRES**, et plusieurs fenêtres-sessions
   * terminées peuvent être ouvertes pendant qu'une autre enregistre. Sans ce tri, chacune
   * lèverait un voile sur un document qui ne bouge pas.
   */
  it('ignores the stop and the document of another session', async () => {
    const { fixture, store } = await render({}, { opens: recording() });

    stoppedHandler?.('directdoc-9');
    finalisedHandler?.(finished({ id: 'directdoc-9', title: 'Une autre' }));
    fixture.detectChanges();

    expect(store.stopped).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).querySelector('app-direct-recording')).not.toBe(
      null,
    );
  });

  /* ── La traduction en direct ────────────────────────────────────────────────────────── */

  /** Une session qui enregistre **et** qu'on suit dans une autre langue. */
  function following(): LiveDocument {
    return recording({
      transcript: { language: 'fr', paragraphs: [] },
      translationTarget: 'en',
    });
  }

  function line(id: number, text: string) {
    return { id, stream: 'system' as const, text, paragraph: false };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **ON TRADUIT LE SEGMENT ACQUIS, DE LA LANGUE DU DOCUMENT VERS LA SIENNE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ **La cible vient du DOCUMENT, pas des réglages** : `liveTranslationTarget` dit ce que le
   * formulaire *propose*, et le toucher pour préparer la session suivante changerait la langue
   * de celle qui tourne — les deux fenêtres partagent le même fichier de réglages.
   */
  it('translates each acquired segment, from the language of the session', async () => {
    const { fixture, live, store } = await render({}, { opens: following() });
    store.transcript.set([line(0, 'Bon, on commence ?')]);
    await settle(fixture);

    expect(live.translate).toHaveBeenCalledExactlyOnceWith('Bon, on commence ?', 'fr', 'en');
    expect(store.translated).toHaveBeenCalledExactlyOnceWith(0, 'EN(Bon, on commence ?)');
  });

  /**
   * ⚠️⚠️ **UNE FILE, PAS UNE RAFALE.** Le framework d'Apple n'aime pas les appels concurrents, et
   * sur une session animée les deux flux finalisent en même temps. La file les sérialise **et
   * garde l'ordre** : une colonne qui se remplirait dans le désordre serait illisible.
   */
  it('drains the queue one segment at a time, in order', async () => {
    const { fixture, live, store } = await render({}, { opens: following() });
    store.transcript.set([line(0, 'Un.'), line(1, 'Deux.'), line(2, 'Trois.')]);
    await settle(fixture);

    expect(live.translate.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'Un.',
      'Deux.',
      'Trois.',
    ]);
  });

  /** ⚠️ **Un segment acquis ne se retraduit jamais** : il ne change plus, sa traduction non plus. */
  it('never translates the same segment twice', async () => {
    const { fixture, live, store } = await render({}, { opens: following() });
    store.transcript.set([line(0, 'Un.')]);
    await settle(fixture);
    store.transcript.set([line(0, 'Un.'), line(1, 'Deux.')]);
    await settle(fixture);

    expect(live.translate).toHaveBeenCalledTimes(2);
  });

  /** Sans langue de suivi — le cas par défaut —, aucun aller-retour ne part. */
  it('translates nothing when the session asked for no translation', async () => {
    const { fixture, live, store } = await render({}, { opens: recording() });
    store.transcript.set([line(0, 'Bon, on commence ?')]);
    await settle(fixture);

    expect(live.translate).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **Une session enregistrée sans transcrire n'a pas de langue**, et il n'y a alors rien à
   * traduire *depuis*. Demander la traduction d'un texte sans source ferait répondre n'importe
   * quoi au framework.
   */
  it('translates nothing while the session has no spoken language', async () => {
    const { fixture, live, store } = await render(
      {},
      { opens: recording({ translationTarget: 'en' }) },
    );
    store.transcript.set([line(0, 'Bon, on commence ?')]);
    await settle(fixture);

    expect(live.translate).not.toHaveBeenCalled();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UN ÉCHEC NE SE DIT PAS EN SNACKBAR, ET IL NE BLOQUE PAS LA FILE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Une paire absente produirait un message **par segment** — un mur devant le transcript. Et
   * sans rien ranger, la file buterait pour toujours sur le même segment : c'est le texte
   * d'origine qui est rangé, ce qui laisse le paragraphe dans sa langue et fait avancer la suite.
   */
  it('keeps the original text and moves on when a segment cannot be translated', async () => {
    const { fixture, live, store, snackbar } = await render(
      { translate: vi.fn().mockResolvedValue(null) },
      { opens: following() },
    );
    store.transcript.set([line(0, 'Bon, on commence ?'), line(1, 'Oui.')]);
    await settle(fixture);

    expect(store.translated).toHaveBeenCalledWith(0, 'Bon, on commence ?');
    expect(live.translate).toHaveBeenCalledTimes(2);
    expect(snackbar.error).not.toHaveBeenCalled();
  });

  /** Même règle quand le pont lève : on se tait, et le prochain segment relancera la file. */
  it('says nothing when the bridge throws, and lets the next segment retry', async () => {
    const { fixture, snackbar, store } = await render(
      { translate: vi.fn().mockRejectedValue(new Error('moteur occupé')) },
      { opens: following() },
    );
    store.transcript.set([line(0, 'Bon, on commence ?')]);
    await settle(fixture);

    expect(snackbar.error).not.toHaveBeenCalled();
  });

  /* ── La fermeture ───────────────────────────────────────────────────────────────────── */

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **FERMER CETTE FENÊTRE ARRÊTE LA SESSION — D'OÙ LA QUESTION.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * C'est l'inverse de la fenêtre principale, dont la fermeture ne touche à rien. Comme rien à
   * l'écran ne distingue les deux croix, on demande — et la réponse de refus dit **ce qui
   * continue**, jamais « Annuler » : devant deux issues qui font toutes les deux quelque chose,
   * « Annuler » ne désigne rien.
   */
  it('asks before closing a session that is still recording', async () => {
    const { fixture, modal, store, live } = await render({}, { opens: recording() });
    closeHandler?.();
    await settle(fixture);

    expect(modal.confirm).toHaveBeenCalledOnce();
    const asked = modal.confirm.mock.calls[0]?.[0];
    expect(asked.cancelLabel).toContain('Continuer');
    expect(asked.message).toContain('conservé');
    expect(store.stop).toHaveBeenCalledOnce();
    expect(live.closeDocument).toHaveBeenCalledExactlyOnceWith('directdoc-3');
  });

  it('changes nothing when the user chooses to carry on', async () => {
    const { fixture, store, live } = await render({}, { opens: recording(), confirms: false });
    closeHandler?.();
    await settle(fixture);

    expect(store.stop).not.toHaveBeenCalled();
    expect(live.closeDocument).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **La question ne se pose QUE pendant l'enregistrement.** Après, la même croix ferme sans
   * rien demander : il n'y a plus rien à interrompre.
   */
  it('closes a finished session without asking anything', async () => {
    const { fixture, modal, live } = await render();
    closeHandler?.();
    await settle(fixture);

    expect(modal.confirm).not.toHaveBeenCalled();
    expect(live.closeDocument).toHaveBeenCalledExactlyOnceWith('directdoc-3');
  });

  /* ── Le direct : minuteur, niveau, transcript ───────────────────────────────────────── */

  it('feeds what the bridge sends straight into the store', async () => {
    const { store } = await render({}, { opens: recording() });
    const event = { kind: 'final', stream: 'system', text: 'Bonjour.' } as const;
    transcriptHandler?.(event);

    expect(store.applyTranscript).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('advances the clock while the session runs', async () => {
    const { fixture } = await renderTicking({ opens: recording() });
    await vi.advanceTimersByTimeAsync(3_000);
    fixture.detectChanges();

    expect(panel(fixture).elapsedSeconds()).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⚠️ **La fenêtre ne relève plus rien : elle écoute.** Le niveau est poussé par le backend, qui
   * bat la mesure et sait déjà distinguer un flux silencieux d'un flux arrêté — c'est
   * `system_audio.rs` qui porte ce piège, et ses tests avec lui.
   */
  it('shows the level the backend pushes', async () => {
    const { fixture } = await renderTicking({ opens: recording() });

    levelHandler?.(0.42);
    fixture.detectChanges();

    expect(panel(fixture).level()).toBeCloseTo(0.42);
  });

  /**
   * ⚠️ **Sept désabonnements, pas six** : le transcript, l'arrêt, la consolidation, la
   * progression des travaux, celle d'une traduction, la croix et le niveau des flux. En oublier
   * un laisserait un rappel sans propriétaire, qui écrirait dans un composant détruit.
   */
  it('stops the clock and unsubscribes when the window is destroyed', async () => {
    const { fixture, unlisten } = await renderTicking({ opens: recording() });
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();
    // ⚠️ **Le panneau se prend AVANT la destruction** : après, il n'est plus dans l'arbre, et
    // c'est justement lui qui porte la valeur qu'on veut voir figée.
    const mounted = panel(fixture);
    const seen = mounted.elapsedSeconds();

    fixture.destroy();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mounted.elapsedSeconds()).toBe(seen);
    expect(unlisten).toHaveBeenCalledTimes(7);
  });

  /* ── Ce qui se dit, et ce qui ne se dit pas ─────────────────────────────────────────── */

  /**
   * ⚠️⚠️ **UN FLUX MUET SE DIT EN SNACKBAR, ET IL DIT QUE L'ENREGISTREMENT CONTINUE.** Sans la
   * seconde moitié, l'utilisateur arrêterait sa session en croyant tout perdu.
   */
  it('says which stream stays silent, and that the recording goes on', async () => {
    const { snackbar } = await render(
      {},
      {
        opens: recording(),
        silentStreams: [{ stream: 'microphone', reason: 'ressources absentes' }],
      },
    );

    expect(snackbar.error).toHaveBeenCalledOnce();
    const said = snackbar.error.mock.calls[0]?.[0] as string;
    expect(said).toContain('ressources absentes');
    expect(said).toContain('continue');
  });

  it('says it for the live audio too', async () => {
    const { snackbar } = await render(
      {},
      {
        opens: recording(),
        silentStreams: [{ stream: 'system', reason: 'moteur indisponible' }],
      },
    );

    expect((snackbar.error.mock.calls[0]?.[0] as string) ?? '').toContain('moteur indisponible');
  });

  /** ⚠️ **Un flux ne se signale qu'UNE fois** : le moteur peut échouer plusieurs fois de suite. */
  it('announces each silent stream once, and only the new one', async () => {
    const { fixture, store, snackbar } = await render(
      {},
      {
        opens: recording(),
        silentStreams: [{ stream: 'microphone', reason: 'ressources absentes' }],
      },
    );
    store.silentStreams.set([
      { stream: 'microphone', reason: 'ressources absentes' },
      { stream: 'system', reason: 'moteur indisponible' },
    ]);
    fixture.detectChanges();

    expect(snackbar.error).toHaveBeenCalledTimes(2);
  });

  it('says a store failure once, then forgets it', async () => {
    const { fixture, store, error, snackbar } = await render();
    error.set({ kind: 'native', message: 'le pont est muet' });
    fixture.detectChanges();

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('le pont est muet');
    expect(store.clearError).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Le magasin des prompts est drainé lui aussi** : c'est ici que la reprise de l'ancien
   * prompt unique se joue quand les Options ne sont pas ouvertes, et sans ce drain son échec —
   * le seul de l'application à pouvoir faire perdre un texte écrit — ne se dirait nulle part.
   */
  it('says a prompt-store failure once, then forgets it', async () => {
    const { fixture, prompts, snackbar } = await render();
    prompts.error.set({ kind: 'database', message: 'reprise impossible' });
    fixture.detectChanges();

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('reprise impossible');
    expect(prompts.clearError).toHaveBeenCalledOnce();
  });

  // ------------------------------------------------------------------ export

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE TITRE PART RÉSOLU, REPLI DATÉ COMPRIS** *(P4-12)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Une session sans titre s'appelle « Session du 5 août à 16:12 » — une phrase **localisée** que
   * seule l'interface sait composer, quand le document porte `null`. Laisser Rust le relire
   * nommerait tous les exports non renommés « Mirmalion ».
   */
  it('exports through the save panel, with a resolved title and date', async () => {
    const { fixture, live, snackbar } = await render();
    done(fixture).exported.emit({ choice: 'markdown', content: 'transcript' });
    await settle(fixture);

    const [id, title, date, format] = live.chooseExportPath.mock.calls[0] as [
      string,
      string,
      string,
      string,
    ];
    expect(id).toBe('directdoc-3');
    expect(title).toBe('Session produit hebdo');
    expect(date).not.toBe('');
    expect(format).toBe('markdown');

    // ⚠️ Aucun `path` : l'emplacement choisi reste chez Rust, et cette fenêtre ne le voit jamais.
    expect(live.exportDocument).toHaveBeenCalledExactlyOnceWith({
      id: 'directdoc-3',
      content: 'transcript',
      format: 'markdown',
      title: 'Session produit hebdo',
    });
    expect(snackbar.success).toHaveBeenCalledOnce();
  });

  /** ⚠️ **Un abandon volontaire ne se commente pas** : ni erreur, ni confirmation. */
  it('says nothing when the save panel is dismissed', async () => {
    const { fixture, live, snackbar } = await render({
      chooseExportPath: vi.fn().mockResolvedValue(false),
    });
    done(fixture).exported.emit({ choice: 'pdf', content: 'transcript' });
    await settle(fixture);

    expect(live.exportDocument).not.toHaveBeenCalled();
    expect(snackbar.success).not.toHaveBeenCalled();
    expect(snackbar.error).not.toHaveBeenCalled();
  });

  it('reports a failure of the save panel itself', async () => {
    const { fixture, live, snackbar } = await render({
      chooseExportPath: vi.fn().mockRejectedValue(new Error('dossier introuvable')),
    });
    done(fixture).exported.emit({ choice: 'json', content: 'report' });
    await settle(fixture);

    expect(live.exportDocument).not.toHaveBeenCalled();
    expect(snackbar.error).toHaveBeenCalledWith('dossier introuvable');
  });

  it('reports a failed write', async () => {
    const { fixture, snackbar } = await render({
      exportDocument: vi.fn().mockRejectedValue(new Error('écriture refusée')),
    });
    done(fixture).exported.emit({ choice: 'docx', content: 'report' });
    await settle(fixture);

    expect(snackbar.error).toHaveBeenCalledWith('écriture refusée');
  });

  /** ⚠️ **La copie ne passe par aucun dialogue** : c'est un geste, pas un fichier. */
  it('copies without asking for a path, and names what it copied', async () => {
    const { fixture, live, snackbar } = await render();
    done(fixture).exported.emit({ choice: 'copy', content: 'report' });
    await settle(fixture);

    expect(live.chooseExportPath).not.toHaveBeenCalled();
    expect(live.copyDocument).toHaveBeenCalledExactlyOnceWith({
      id: 'directdoc-3',
      content: 'report',
      title: 'Session produit hebdo',
    });
    expect(snackbar.success).toHaveBeenCalledWith(expect.stringContaining('Compte rendu copié'));
  });

  it('names the transcript when it is the transcript that was copied', async () => {
    const { fixture, snackbar } = await render();
    done(fixture).exported.emit({ choice: 'copy', content: 'transcript' });
    await settle(fixture);

    expect(snackbar.success).toHaveBeenCalledWith(expect.stringContaining('Transcript copié'));
  });

  it('reports a failed copy', async () => {
    const { fixture, snackbar } = await render({
      copyDocument: vi.fn().mockRejectedValue(new Error('presse-papiers refusé')),
    });
    done(fixture).exported.emit({ choice: 'copy', content: 'transcript' });
    await settle(fixture);

    expect(snackbar.error).toHaveBeenCalledWith('presse-papiers refusé');
  });

  /**
   * ⚠️ **Une opération à la fois** : `working` sert déjà la génération, et deux drapeaux se
   * seraient contredits — un export lancé pendant une génération aurait relâché le sien en
   * premier, rouvrant les contrôles d'un document que le modèle écrit encore.
   */
  it('refuses to export while something else is already in flight', async () => {
    const { fixture, live } = await render(generating());
    done(fixture).kindChange.emit('team');
    await settle(fixture);

    done(fixture).exported.emit({ choice: 'markdown', content: 'transcript' });
    await settle(fixture);

    expect(live.chooseExportPath).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **Hors contexte Tauri, aucune boîte ne s'ouvre** : `npm run start:web` doit rester
   * navigable, et un export y échoue en silence plutôt que d'appeler un dialogue qui n'existe pas.
   */
  it('stops when no save panel can be opened at all', async () => {
    const { fixture, live } = await render({ chooseExportPath: vi.fn().mockResolvedValue(false) });
    done(fixture).exported.emit({ choice: 'csv', content: 'transcript' });
    await settle(fixture);

    expect(live.exportDocument).not.toHaveBeenCalled();
  });

  /** ⚠️ **Rien ne s'exporte pendant l'enregistrement** : le transcript n'est pas encore posé. */
  it('refuses to export a session that is still recording', async () => {
    const { fixture, live } = await render({}, { opens: recording() });
    // La barre de document n'existe pas pendant l'enregistrement : on passe par la coquille,
    // qui est ce que la garde protège.
    (fixture.componentInstance as unknown as { pickExport: (r: unknown) => void }).pickExport({
      choice: 'markdown',
      content: 'transcript',
    });
    await settle(fixture);

    expect(live.chooseExportPath).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // LA TRADUCTION DU DOCUMENT — P4-24
  // ══════════════════════════════════════════════════════════════════════════════════════════

  const REPORT = [{ heading: 'Résumé', lines: ['Point produit.'], bullets: false }];

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA TRADUCTION EST UNE VUE : L'ORIGINAL NE BOUGE JAMAIS.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * C'est ce qui permet à « Langue d'origine » de revenir **sans un appel**, et c'est ce qui
   * protège les horodatages au mot, que la traduction détruit.
   */
  it('shows the translated transcript, and gives the original back for free', async () => {
    const { fixture, live } = await render();
    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);

    expect(live.translateTranscript).toHaveBeenCalledExactlyOnceWith('directdoc-3', 'en');
    expect(done(fixture).lines()).toEqual([{ text: 'Shall we start with the roadmap?' }]);
    expect(done(fixture).transcriptTarget()).toBe('en');

    done(fixture).translate.emit({ target: 'none', content: 'transcript' });
    await settle(fixture);

    expect(live.translateTranscript).toHaveBeenCalledOnce();
    expect(done(fixture).lines()).toEqual([{ text: 'Bon, on commence ?' }, { text: 'Oui.' }]);
  });

  /** ⚠️ **Les intitulés en font partie** : le modèle les a écrits, pas une table de l'interface. */
  it('shows the translated report, headings included', async () => {
    const { fixture, live } = await render({}, { opens: finished({ report: REPORT }) });
    done(fixture).translate.emit({ target: 'en', content: 'report' });
    await settle(fixture);

    expect(live.translateReport).toHaveBeenCalledExactlyOnceWith('directdoc-3', 'en');
    expect(done(fixture).sections()).toEqual([
      { heading: 'Summary', lines: ['Weekly product review.'], bullets: false },
    ]);
    expect(done(fixture).reportTarget()).toBe('en');
  });

  /**
   * ⚠️ **Le voile nomme CE qu'on traduit, et sa barre est déterminée** : la traduction est la
   * seule des trois attentes qui sait où elle en est, pondérée par les caractères côté Rust.
   */
  it('names what it is translating, and shows a real percentage', async () => {
    const { fixture } = await render({
      translateTranscript: vi.fn(() => new Promise(() => undefined)),
    });
    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);

    translationProgressHandler?.(37);
    fixture.detectChanges();

    const overlay = veil(fixture);
    expect(overlay?.textContent).toContain('Traduction du transcript');
    expect(overlay?.textContent).toContain('37');
  });

  it('names the report when it is the report being translated', async () => {
    const { fixture } = await render(
      { translateReport: vi.fn(() => new Promise(() => undefined)) },
      { opens: finished({ report: REPORT }) },
    );
    done(fixture).translate.emit({ target: 'en', content: 'report' });
    await settle(fixture);

    expect(veil(fixture)?.textContent).toContain('Traduction du compte rendu');
  });

  /**
   * ⚠️⚠️ **DEUX TRAVAUX ANNULABLES, UN SEUL BOUTON.** Ils ne peuvent pas courir ensemble — la
   * traduction est refusée pendant une génération, et l'inverse aussi — donc le voile sait
   * lequel arrêter.
   */
  it('cancels the translation rather than a report that is not being generated', async () => {
    const { fixture, live } = await render({
      translateTranscript: vi.fn(() => new Promise(() => undefined)),
    });
    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);

    (fixture.componentInstance as unknown as { cancel: () => void }).cancel();
    expect(live.cancelTranslation).toHaveBeenCalledExactlyOnceWith('directdoc-3');
    expect(live.cancelReport).not.toHaveBeenCalled();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE MENU REVIENT À SA LANGUE PRÉCÉDENTE QUAND RIEN N'A CHANGÉ À L'ÉCRAN.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Une paire absente se dit en **information**, pas en erreur : ce n'est pas une panne, c'est
   * une langue à ajouter. Une **annulation** ne se dit pas du tout — l'utilisateur a demandé
   * l'arrêt, il l'a obtenu.
   */
  it('gives the menu back its language when the translation does not happen', async () => {
    const cases = [
      { outcome: { kind: 'pairMissing', source: 'fr', target: 'it' }, informs: true },
      { outcome: { kind: 'pairUnsupported', source: 'fr', target: 'it' }, informs: true },
      { outcome: { kind: 'cancelled' }, informs: false },
      { outcome: null, informs: false },
    ];
    for (const { outcome, informs } of cases) {
      const { fixture, snackbar } = await render({
        translateTranscript: vi.fn().mockResolvedValue(outcome),
      });
      done(fixture).translate.emit({ target: 'it', content: 'transcript' });
      await settle(fixture);

      expect(done(fixture).transcriptTarget()).toBe('none');
      expect(done(fixture).lines()).toEqual([{ text: 'Bon, on commence ?' }, { text: 'Oui.' }]);
      expect(snackbar.info).toHaveBeenCalledTimes(informs ? 1 : 0);
      expect(snackbar.error).not.toHaveBeenCalled();
    }
  });

  it('says a translation failure and keeps the text that was on screen', async () => {
    const { fixture, snackbar } = await render({
      translateTranscript: vi.fn().mockRejectedValue(new Error('moteur en panne')),
    });
    done(fixture).translate.emit({ target: 'it', content: 'transcript' });
    await settle(fixture);

    expect(snackbar.error).toHaveBeenCalledWith('moteur en panne');
    expect(done(fixture).transcriptTarget()).toBe('none');
    expect(veil(fixture)).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **L'EXPORT PORTE CE QUE L'ÉCRAN MONTRE — SANS ÇA, LE FICHIER SORT DANS L'AUTRE LANGUE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * C'est le défaut exact que P3-11 a corrigé pour les fichiers, et il serait revenu ici avec la
   * traduction de session.
   */
  it('exports and copies the translation, not the original underneath', async () => {
    const { fixture, live } = await render({}, { opens: finished({ report: REPORT }) });
    done(fixture).translate.emit({ target: 'en', content: 'report' });
    await settle(fixture);

    done(fixture).exported.emit({ choice: 'copy', content: 'report' });
    await settle(fixture);
    expect(live.copyDocument).toHaveBeenCalledExactlyOnceWith({
      id: 'directdoc-3',
      content: 'report',
      title: 'Session produit hebdo',
      sections: [{ heading: 'Summary', lines: ['Weekly product review.'], bullets: false }],
    });

    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);
    done(fixture).exported.emit({ choice: 'markdown', content: 'transcript' });
    await settle(fixture);

    expect(live.exportDocument).toHaveBeenCalledExactlyOnceWith({
      id: 'directdoc-3',
      content: 'transcript',
      format: 'markdown',
      title: 'Session produit hebdo',
      paragraphs: [{ startMs: 0, endMs: 900, text: 'Shall we start with the roadmap?' }],
    });
  });

  /**
   * ⚠️⚠️ **UN COMPTE RENDU NEUF EFFACE LA TRADUCTION DU PRÉCÉDENT.** Elle traduit des rubriques
   * qui n'existent plus : la garder afficherait l'ancien compte rendu, en anglais, sous un type
   * qu'on vient de changer. ⚠️ **On ne retraduit pas d'office** — ce serait plusieurs minutes que
   * personne n'a demandées.
   */
  it('drops the report translation when a new report is generated', async () => {
    const { fixture, live } = await render(
      { generateReport: vi.fn().mockResolvedValue(finished({ report: REPORT })) },
      { opens: finished({ report: REPORT }) },
    );
    done(fixture).translate.emit({ target: 'en', content: 'report' });
    await settle(fixture);
    expect(done(fixture).reportTarget()).toBe('en');

    done(fixture).kindChange.emit('summary');
    await settle(fixture);

    expect(done(fixture).reportTarget()).toBe('none');
    expect(done(fixture).sections()).toEqual(REPORT);
    expect(live.translateReport).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **La consolidation remplace le transcript en entier** — attribution corrigée, écho écarté :
   * une traduction d'avant ne correspondrait plus à rien.
   */
  it('drops the transcript translation when the consolidation lands', async () => {
    const { fixture } = await render();
    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);
    expect(done(fixture).transcriptTarget()).toBe('en');

    finalisedHandler?.(finished());
    await settle(fixture);

    expect(done(fixture).transcriptTarget()).toBe('none');
    expect(done(fixture).lines()).toEqual([{ text: 'Bon, on commence ?' }, { text: 'Oui.' }]);
  });

  /**
   * ⚠️ **Une opération à la fois** : traduire pendant une génération relâcherait le voile de
   * l'autre, rouvrant les contrôles d'un document que le modèle écrit encore. Et rien ne se
   * traduit pendant l'enregistrement — le transcript n'est pas encore posé.
   */
  it('refuses to translate while something else is in flight, or while recording', async () => {
    const { fixture, live } = await render(generating());
    done(fixture).kindChange.emit('team');
    await settle(fixture);
    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);
    expect(live.translateTranscript).not.toHaveBeenCalled();

    const running = await render({}, { opens: recording() });
    (
      running.fixture.componentInstance as unknown as { translateTo: (r: unknown) => void }
    ).translateTo({ target: 'en', content: 'transcript' });
    await settle(running.fixture);
    expect(running.live.translateTranscript).not.toHaveBeenCalled();
  });

  /** ⚠️ **Et pas deux traductions à la fois non plus** : la file serait impossible à annuler. */
  it('refuses a second translation while one is already running', async () => {
    const { fixture, live } = await render({
      translateTranscript: vi.fn(() => new Promise(() => undefined)),
    });
    done(fixture).translate.emit({ target: 'en', content: 'transcript' });
    await settle(fixture);
    done(fixture).translate.emit({ target: 'it', content: 'transcript' });
    await settle(fixture);

    expect(live.translateTranscript).toHaveBeenCalledOnce();
  });

  it('has no accessibility violations while recording', async () => {
    const { fixture } = await render({}, { opens: recording() });
    await expectNoAxeViolations(fixture.nativeElement);
  });

  it('has no accessibility violations on the document', async () => {
    const { fixture } = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
