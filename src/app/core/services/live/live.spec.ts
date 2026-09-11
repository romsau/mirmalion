import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  Live,
  liveTitle,
  sessionMeta,
  elapsedSecondsSince,
  formatElapsed,
  stepLabel,
  stepPercent,
  NO_MICROPHONE,
  SYSTEM_MICROPHONE,
  bridgeMicrophone,
  reportTypeOptions,
  reportPromptGroupLabel,
  REPORT_PROMPT_GROUP_INDEX,
} from './live';
import type { AudioSource, LiveStep } from '../bridge/live/live.bridge';
import { Invoke } from '../bridge/invoke/invoke';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';
import { LiveBridge } from '../bridge/live/live.bridge';
import { SystemBridge } from '../bridge/system/system.bridge';
import { ComboSelect } from '../../../shared/components/forms/combo-select/combo-select';

const SOURCES: readonly AudioSource[] = [
  { id: 'system', name: 'Tout le système', isSystem: true },
  { id: '4212', name: 'Microsoft Teams', isSystem: false },
];

/** Une session terminée, réduite à ce qui circule. */
const CONSOLIDATED = {
  id: 'directdoc-0',
  transcript: { language: 'fr', paragraphs: [] },
  title: 'Session produit hebdo',
  sourceName: 'Microsoft Teams',
  startedAtMs: 1_754_300_000_000,
  endedAtMs: 1_754_303_600_000,
  report: [],
  translationTarget: null,
};

/** Une session **archivée**, telle que l'historique la rend. */
const ARCHIVED = {
  id: 12,
  title: null,
  sourceName: 'Microsoft Teams',
  startedAtMs: 1_754_300_000_000,
  endedAtMs: 1_754_303_600_000,
  preview: 'Bon, on commence.',
  hasReport: false,
};

const RUNNING = {
  phase: 'recording' as const,
  documentId: 'directdoc-0',
  startedAtMs: 1_754_300_000_000,
  sourceName: 'Microsoft Teams',
  withMicrophone: true,
};

function harness(overrides: Record<string, unknown> = {}) {
  const tauri = {
    listAudioSources: vi.fn().mockResolvedValue(SOURCES),
    startLiveCapture: vi.fn().mockResolvedValue(CONSOLIDATED),
    onLiveTranscript: vi.fn().mockResolvedValue(() => undefined),
    onLiveStopped: vi.fn().mockResolvedValue(() => undefined),
    onLiveFinalised: vi.fn().mockResolvedValue(() => undefined),
    onLiveProgress: vi.fn().mockResolvedValue(() => undefined),
    onLiveLevel: vi.fn().mockResolvedValue(() => undefined),
    translateText: vi.fn().mockResolvedValue({ kind: 'translated', text: 'Hello everyone.' }),
    cancelLiveReport: vi.fn().mockResolvedValue(undefined),
    listLiveSessions: vi.fn().mockResolvedValue([ARCHIVED]),
    openLiveSession: vi.fn().mockResolvedValue(undefined),
    deleteLiveSession: vi.fn().mockResolvedValue(undefined),
    clearLiveSessions: vi.fn().mockResolvedValue(2),
    copyLiveSession: vi.fn().mockResolvedValue('Résumé'),
    chooseLiveExportPath: vi.fn().mockResolvedValue(true),
    exportLiveDocument: vi.fn().mockResolvedValue(undefined),
    copyLiveDocument: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => undefined),
    stopLiveCapture: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockResolvedValue(RUNNING),
    getLiveDocument: vi.fn().mockResolvedValue(CONSOLIDATED),
    renameLiveDocument: vi.fn().mockResolvedValue(CONSOLIDATED),
    generateLiveReport: vi.fn().mockResolvedValue(CONSOLIDATED),
    closeLiveDocument: vi.fn().mockResolvedValue(undefined),
    translateLiveTranscript: vi.fn().mockResolvedValue({ kind: 'translated', paragraphs: [] }),
    translateLiveReport: vi.fn().mockResolvedValue({ kind: 'translated', sections: [] }),
    cancelDocumentTranslation: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn().mockResolvedValue(() => undefined),
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Invoke, useValue: tauri },
      { provide: LanguagesBridge, useValue: tauri },
      { provide: LiveBridge, useValue: tauri },
      { provide: SystemBridge, useValue: tauri },
    ],
  });
  return { tauri, service: TestBed.inject(Live) };
}

/**
 * ⚠️⚠️ **LE CŒUR DE CE SERVICE, ET LA SEULE RAISON POUR LAQUELLE IL EXISTE.** Les deux
 * vocabulaires du micro se ressemblent et s'opposent : `null` veut dire « micro système » côté
 * réglage et « pas de micro » côté pont. Passer la valeur telle quelle couperait la voix de
 * tous ceux qui n'ont jamais choisi de micro — c'est-à-dire de la majorité, `null` étant le
 * défaut.
 */
describe('bridgeMicrophone', () => {
  it('turns the setting default into the bridge system microphone', () => {
    expect(bridgeMicrophone(null)).toBe(SYSTEM_MICROPHONE);
  });

  it('turns the no-microphone choice into the bridge null', () => {
    expect(bridgeMicrophone(NO_MICROPHONE)).toBeNull();
  });

  it('passes a real device identifier through untouched', () => {
    expect(bridgeMicrophone('77')).toBe('77');
  });

  /** Les deux valeurs ne se confondent jamais : c'est ce qui rend l'option atteignable. */
  it('never maps two different intents onto the same bridge value', () => {
    expect(bridgeMicrophone(null)).not.toBe(bridgeMicrophone(NO_MICROPHONE));
  });
});

describe('Live', () => {
  it('lists the captureable sources', async () => {
    const { service } = harness();
    await expect(service.audioSources()).resolves.toEqual(SOURCES);
  });

  it('gives an empty list rather than null outside Tauri', async () => {
    const { service } = harness({ listAudioSources: vi.fn().mockResolvedValue(null) });
    await expect(service.audioSources()).resolves.toEqual([]);
  });

  it('translates the microphone setting before starting', async () => {
    const { service, tauri } = harness();
    await expect(service.start('4212', null, 'fr', 'en')).resolves.toEqual(CONSOLIDATED);
    expect(tauri.startLiveCapture).toHaveBeenCalledExactlyOnceWith(
      '4212',
      SYSTEM_MICROPHONE,
      'fr',
      'en',
    );
  });

  it('starts without a microphone when the user excluded it', async () => {
    const { service, tauri } = harness();
    await service.start('system', NO_MICROPHONE, 'fr', null);
    expect(tauri.startLiveCapture).toHaveBeenCalledExactlyOnceWith('system', null, 'fr', null);
  });

  /**
   * ⚠️ **Le service ne fait que passer le plat**, et c'est ce qu'on vérifie : la traduction du
   * vocabulaire du micro est son seul travail, l'abonnement doit rester transparent.
   */
  it('passes the transcript subscription straight through', async () => {
    const { service, tauri } = harness();
    const handler = vi.fn();
    const unlisten = await service.onTranscript(handler);

    expect(tauri.onLiveTranscript).toHaveBeenCalledExactlyOnceWith(handler);
    expect(typeof unlisten).toBe('function');
  });

  it('stops the capture', async () => {
    const { service, tauri } = harness();
    await service.stop();
    expect(tauri.stopLiveCapture).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Le service DÉBALLE l'identifiant, il ne passe pas l'évènement brut.** Ses appelants
   * n'ont qu'une question — « est-ce ma session ? » — et leur faire connaître la forme de la
   * charge utile du pont pour y répondre serait leur donner un détail de plomberie.
   */
  it('unwraps the identifier of the session that stopped', async () => {
    const { service, tauri } = harness();
    const handler = vi.fn();
    await service.onStopped(handler);

    tauri.onLiveStopped.mock.calls[0]?.[0]({ documentId: 'directdoc-3' });

    expect(handler).toHaveBeenCalledExactlyOnceWith('directdoc-3');
  });

  it('passes the finalisation subscription straight through', async () => {
    const { service, tauri } = harness();
    const handler = vi.fn();
    await service.onFinalised(handler);
    expect(tauri.onLiveFinalised).toHaveBeenCalledExactlyOnceWith(handler);
  });

  it('passes the progress subscription straight through', async () => {
    const { service, tauri } = harness();
    const handler = vi.fn();
    await service.onProgress(handler);
    expect(tauri.onLiveProgress).toHaveBeenCalledExactlyOnceWith(handler);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE SEGMENT EST L'UNITÉ, ET IL N'EST JAMAIS RETRADUIT** *(décision 5)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Traduire une hypothèse rendrait une traduction qui se réécrit toute seule ; retraduire un
   * *paragraphe* à chaque segment qui s'y ajoute reviendrait au même, en pire — jusqu'à une
   * dizaine de réécritures du même bloc.
   */
  it('translates one acquired segment, from the spoken language to the target', async () => {
    const { service, tauri } = harness();
    await expect(service.translate('Bonjour à tous.', 'fr', 'en')).resolves.toBe('Hello everyone.');
    expect(tauri.translateText).toHaveBeenCalledExactlyOnceWith('fr', 'en', 'Bonjour à tous.');
  });

  /**
   * ⚠️⚠️ **UNE PAIRE ABSENTE N'EST PAS UNE PANNE.** Le segment reste dans sa langue et le
   * transcript continue d'avancer : une **absence** de traduction se voit et se comprend, là où
   * un transcript qui s'arrête se lit comme une panne.
   */
  it('gives back nothing rather than fail when the pair is missing', async () => {
    for (const outcome of [
      { kind: 'pairMissing', source: 'fr', target: 'pt' },
      { kind: 'pairUnsupported', source: 'fr', target: 'pt' },
      null,
    ]) {
      const { service } = harness({ translateText: vi.fn().mockResolvedValue(outcome) });
      await expect(service.translate('Bonjour.', 'fr', 'pt')).resolves.toBeNull();
    }
  });

  it('asks to give up the generation in flight', async () => {
    const { service, tauri } = harness();
    await service.cancelReport('directdoc-0');
    expect(tauri.cancelLiveReport).toHaveBeenCalledExactlyOnceWith('directdoc-0');
  });

  /**
   * ⚠️ **Deux commandes, une par vue** *(P4-24)* : la barre d'actions est partagée, et chaque
   * contrôle veut dire ce qu'il dit **pour la vue où l'on est**.
   */
  it('translates the view that is being looked at, transcript or report', async () => {
    const { service, tauri } = harness();

    await expect(service.translateTranscript('directdoc-0', 'en')).resolves.toEqual({
      kind: 'translated',
      paragraphs: [],
    });
    expect(tauri.translateLiveTranscript).toHaveBeenCalledExactlyOnceWith('directdoc-0', 'en');

    await expect(service.translateReport('directdoc-0', 'en')).resolves.toEqual({
      kind: 'translated',
      sections: [],
    });
    expect(tauri.translateLiveReport).toHaveBeenCalledExactlyOnceWith('directdoc-0', 'en');
  });

  /**
   * ⚠️ **La même commande d'arrêt que la fenêtre-fichier**, et ce n'est pas un raccourci : les
   * deux partagent la table `TranslationJobs`, dont la clé est l'identifiant du document.
   */
  it('asks to give up the translation in flight', async () => {
    const { service, tauri } = harness();
    await service.cancelTranslation('directdoc-0');
    expect(tauri.cancelDocumentTranslation).toHaveBeenCalledExactlyOnceWith('directdoc-0');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **L'AVANCÉE EST FILTRÉE SUR LE DOCUMENT, ET LE FILTRE N'EST PAS DÉCORATIF.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Un évènement Tauri est **diffusé à toutes les fenêtres** : sans lui, la barre d'une session
   * afficherait l'avancée de la voisine.
   */
  it('reports only the progress of its own document', async () => {
    let emit: ((progress: { documentId: string; percent: number }) => void) | null = null;
    const { service, tauri } = harness({
      listen: vi.fn(async (_event: string, handler: (progress: unknown) => void) => {
        emit = handler as (progress: { documentId: string; percent: number }) => void;
        return () => undefined;
      }),
    });

    const seen: number[] = [];
    await service.onTranslationProgress('directdoc-3', (percent) => seen.push(percent));
    expect(tauri.listen.mock.calls[0]?.[0]).toBe('document-translation');

    emit!({ documentId: 'directdoc-3', percent: 42 });
    emit!({ documentId: 'directdoc-9', percent: 99 });
    expect(seen).toEqual([42]);
  });

  it('intercepts the window close requests', async () => {
    const { service, tauri } = harness();
    const handler = vi.fn();
    await service.onCloseRequest(handler);
    expect(tauri.onCloseRequested).toHaveBeenCalledExactlyOnceWith(handler);
  });

  it('reads where the session is', async () => {
    const { service, tauri } = harness();
    await expect(service.session()).resolves.toEqual(RUNNING);
    expect(tauri.getLiveSession).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️⚠️ **UN ÉTAT AU REPOS, JAMAIS `null`.** `npm run start:web` doit rester navigable, et un
   * écran qui décide quoi afficher n'a rien à faire d'un troisième cas entre « ça enregistre » et
   * « rien ne tourne » — il l'oublierait, et la branche oubliée serait celle du navigateur.
   */
  it('says the session is at rest rather than unknown outside Tauri', async () => {
    const { service } = harness({ getLiveSession: vi.fn().mockResolvedValue(null) });
    await expect(service.session()).resolves.toEqual({
      phase: 'idle',
      documentId: null,
      startedAtMs: null,
      sourceName: null,
      withMicrophone: false,
    });
  });

  it('reads a finished live for its window', async () => {
    const { service, tauri } = harness();
    await expect(service.document('directdoc-0')).resolves.toEqual(CONSOLIDATED);
    expect(tauri.getLiveDocument).toHaveBeenCalledExactlyOnceWith('directdoc-0');
  });

  it('renames a finished live', async () => {
    const { service, tauri } = harness();
    await service.rename('directdoc-0', 'Point client');
    expect(tauri.renameLiveDocument).toHaveBeenCalledExactlyOnceWith('directdoc-0', 'Point client');
  });

  it('asks for the report of a finished live', async () => {
    const { service, tauri } = harness();
    await expect(service.generateReport('directdoc-0', 'lecture', null)).resolves.toEqual(
      CONSOLIDATED,
    );
    expect(tauri.generateLiveReport).toHaveBeenCalledExactlyOnceWith(
      'directdoc-0',
      'lecture',
      null,
    );
  });

  it('reads the archived history', async () => {
    const { service, tauri } = harness();
    await expect(service.sessions()).resolves.toEqual([ARCHIVED]);
    expect(tauri.listLiveSessions).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Une liste vide plutôt que `null` hors contexte Tauri** : `npm run start:web` doit rester
   * navigable, et un panneau qui décide quoi afficher n'a rien à faire d'un troisième cas entre
   * « rien » et « quelque chose ».
   */
  it('gives an empty history rather than null outside Tauri', async () => {
    const { service } = harness({ listLiveSessions: vi.fn().mockResolvedValue(null) });
    await expect(service.sessions()).resolves.toEqual([]);
  });

  it('reopens an archived session', async () => {
    const { service, tauri } = harness();
    await service.openSession(12);
    expect(tauri.openLiveSession).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('deletes one archived session', async () => {
    const { service, tauri } = harness();
    await service.deleteSession(12);
    expect(tauri.deleteLiveSession).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('empties the whole archived history', async () => {
    const { service, tauri } = harness();
    await service.clearSessions();
    expect(tauri.clearLiveSessions).toHaveBeenCalledOnce();
  });

  it('reads the text of a session for the clipboard', async () => {
    const { service, tauri } = harness();
    await expect(service.sessionText(12)).resolves.toBe('Résumé');
    expect(tauri.copyLiveSession).toHaveBeenCalledExactlyOnceWith(12);
  });

  /** ⚠️ **Une chaîne vide plutôt que `null`** : `npm run start:web` doit rester navigable. */
  it('gives an empty text rather than null outside Tauri', async () => {
    const { service } = harness({ copyLiveSession: vi.fn().mockResolvedValue(null) });
    await expect(service.sessionText(12)).resolves.toBe('');
  });

  /** ⚠️ Le titre et la date partent **résolus** : Rust ne fabrique aucun texte localisé. */
  it('opens the save panel with a resolved title and date, and no path of its own', async () => {
    const { service, tauri } = harness();
    await expect(
      service.chooseExportPath('directdoc-0', 'Session du 5 août', '5 août 2026', 'markdown'),
    ).resolves.toBe(true);
    expect(tauri.chooseLiveExportPath).toHaveBeenCalledExactlyOnceWith(
      'directdoc-0',
      'Session du 5 août',
      '5 août 2026',
      'markdown',
    );
  });

  it('writes and copies the content the window shows', async () => {
    const { service, tauri } = harness();
    const request = {
      id: 'directdoc-0',
      content: 'report',
      format: 'docx',
      title: 'T',
      path: '/tmp/a.docx',
    } as const;
    await service.exportDocument(request);
    expect(tauri.exportLiveDocument).toHaveBeenCalledExactlyOnceWith(request);

    const copy = { id: 'directdoc-0', content: 'transcript', title: 'T' } as const;
    await service.copyDocument(copy);
    expect(tauri.copyLiveDocument).toHaveBeenCalledExactlyOnceWith(copy);
  });

  it('closes a finished live and its window', async () => {
    const { service, tauri } = harness();
    await service.closeDocument('directdoc-0');
    expect(tauri.closeLiveDocument).toHaveBeenCalledExactlyOnceWith('directdoc-0');
  });

  it('subscribes to the level the backend pushes', async () => {
    const { service, tauri } = harness();
    const handler = (level: number) => level;
    await service.onLevel(handler);
    expect(tauri.onLiveLevel).toHaveBeenCalledExactlyOnceWith(handler);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UN SEUL MENU DE COMPTE RENDU, PARTOUT, SANS VARIANTE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * La fenêtre-session en amputait « Pas de compte rendu » dès qu'un compte rendu existait : le
   * même contrôle offrait donc quatre lignes ici et cinq là. Les deux écrans passent désormais la
   * même liste de prompts, et obtiennent le même menu.
   */
  it('offers one and only one report menu', () => {
    expect(reportTypeOptions([]).map((option) => option.label)).toEqual([
      'Pas de compte rendu',
      "Point d'équipe",
      'Entretien 1:1',
      'Point client',
      'Brainstorming',
      'Résumé',
      'Cours / conférence',
      'Vidéo ou podcast',
      'Entretien',
    ]);
  });

  /** ⚠️ « Pas de compte rendu » n'a pas de branche : c'est ce qui le garde au premier niveau. */
  it('leaves none out of every branch', () => {
    const flat = reportTypeOptions([]).filter((option) => option.group === undefined);
    expect(flat.map((option) => option.value)).toEqual(['none']);
  });

  it('range les prompts nommés dans une rubrique « Personnalisé », en deuxième', () => {
    const options = reportTypeOptions([{ id: 7, title: 'Bilan', prompt: '…' }]);

    expect(options[0]).toMatchObject({ value: 'none', group: undefined });
    expect(options[1]).toMatchObject({ value: '7', label: 'Bilan' });
    expect(options[1]?.group).toBe(reportPromptGroupLabel());
    // ⚠️ La rubrique précède « Réunions » : c'est la place qu'occupait l'entrée « Personnalisé… ».
    expect(options.findIndex((option) => option.value === '7')).toBeLessThan(
      options.findIndex((option) => option.value === 'team'),
    );
  });

  it('ne propose plus d’entrée « Personnalisé… » à plat', () => {
    // ⚠️ `'custom'` reste une valeur de RÉGLAGE et un `ReportKind` pour Rust — mais elle ne se
    // choisit plus dans le menu : on y choisit un prompt nommé.
    expect(reportTypeOptions([]).some((option) => option.value === 'custom')).toBe(false);
  });

  it('garde la rubrique dans la liste même sans aucun prompt', () => {
    // Elle sera grisée, pas absente : la faire disparaître n'apprendrait pas qu'elle existe.
    expect(reportPromptGroupLabel()).toBeTruthy();
  });
});

/**
 * ⚠️⚠️ **ON DÉDUIT LA DURÉE D'UN INSTANT DE DÉPART, ON NE COMPTE JAMAIS LES BATTEMENTS.** Un
 * compteur incrémenté meurt avec le composant qui le tient, et il ne survit pas davantage à la
 * fermeture d'une fenêtre. C'est aussi ce qui permet aux **deux** fenêtres d'afficher exactement
 * le même minuteur.
 */
describe('elapsedSecondsSince', () => {
  it('says nothing has run when nothing has started', () => {
    expect(elapsedSecondsSince(null, 1_754_300_000_000)).toBe(0);
  });

  it('counts whole seconds since the start', () => {
    expect(elapsedSecondsSince(1_754_300_000_000, 1_754_300_012_400)).toBe(12);
  });

  /**
   * ⚠️ **Une horloge qui recule rend zéro, pas un négatif.** Un changement d'heure système ou un
   * réveil de veille peuvent ramener `Date.now()` en arrière ; un minuteur à `-00:00:03` serait
   * pire que faux, il serait absurde.
   */
  it('never goes backwards when the clock does', () => {
    expect(elapsedSecondsSince(1_754_300_000_000, 1_754_299_990_000)).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('writes hours, minutes and seconds, padded', () => {
    expect(formatElapsed(724, 'fr-FR')).toBe('00:12:04');
  });

  /**
   * ⚠️ **Les heures ne sont pas plafonnées** : une session de trois heures affiche `03:00:00`. Un
   * chrono qui repartirait à zéro serait un mensonge, et les sessions longues sont un cas
   * nominal.
   */
  it('does not wrap past the hour', () => {
    expect(formatElapsed(10_800, 'fr-FR')).toBe('03:00:00');
  });

  it('treats a negative or fractional duration as the second it has reached', () => {
    expect(formatElapsed(-5, 'fr-FR')).toBe('00:00:00');
    expect(formatElapsed(59.9, 'fr-FR')).toBe('00:00:59');
  });
});

describe('liveTitle', () => {
  const ENDED = new Date(2026, 7, 5, 16, 12);

  it('keeps what the user renamed it to', () => {
    expect(liveTitle('Session produit hebdo', ENDED, 'fr')).toBe('Session produit hebdo');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE DÉFAUT EST LA DATE **ET** L'HEURE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(porteur, 2026-08-05)*. Plusieurs sessions par jour est le cas courant : trois documents
   * nommés « Session du 05/08/2026 » ne se distinguent pas les uns des autres.
   *
   * ⚠️ **Localisé, et c'est pour ça qu'il est ici** : le backend ne connaît ni la langue de
   * l'interface, ni le format de date du lieu, et il n'a pas à les apprendre pour un en-tête.
   */
  it('falls back to the date and the time the live ended', () => {
    const title = liveTitle(null, ENDED, 'fr');

    expect(title).toContain(new Intl.DateTimeFormat('fr', { dateStyle: 'short' }).format(ENDED));
    expect(title).toContain(new Intl.DateTimeFormat('fr', { timeStyle: 'short' }).format(ENDED));
  });

  /**
   * ⚠️ **Deux sessions du même jour ne portent PAS le même titre** — c'est la raison d'être de
   * l'heure, et un test qui ne regarderait que le format ne l'éprouverait pas.
   */
  it('tells two sessions of the same day apart', () => {
    const morning = new Date(2026, 7, 5, 9, 30);
    expect(liveTitle(null, ENDED, 'fr')).not.toBe(liveTitle(null, morning, 'fr'));
  });

  /**
   * ⚠️ **Un titre vide retombe AUSSI.** Un renommage effacé rend une chaîne d'espaces, et un
   * en-tête blanc que rien n'explique est pire qu'une date.
   */
  it('falls back on a blank title, not only on a missing one', () => {
    expect(liveTitle('   ', ENDED, 'fr')).toBe(liveTitle(null, ENDED, 'fr'));
  });

  /** Un titre entouré d'espaces est rendu propre, pas rejeté. */
  it('trims what the user wrote rather than refusing it', () => {
    expect(liveTitle('  Point client  ', ENDED, 'fr')).toBe('Point client');
  });

  /** Sans langue explicite, `Intl` prend celle de l'exécution — le cas du produit. */
  it('uses the runtime locale when none is given', () => {
    expect(liveTitle(null, ENDED)).toContain(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(ENDED),
    );
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **UNE SESSION EST DATÉE DE SON DÉBUT, ET SA DURÉE PASSE PAR `Intl`.**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La maquette écrit « 1 h 05 » ; ce séparateur n'existe pas dans les cinq autres langues, et le
 * forcer donnerait une durée française à une interface allemande.
 */
describe('sessionMeta', () => {
  /** Le 5 août 2026 à 14:30 UTC. */
  const STARTED = Date.UTC(2026, 7, 5, 14, 30);

  it('dates the session by its START, never by its end', () => {
    const overnight = sessionMeta(STARTED, STARTED + 10 * 3_600_000, 'fr');
    const short = sessionMeta(STARTED, STARTED + 60_000, 'fr');
    const day = new Intl.DateTimeFormat('fr', { day: 'numeric', month: 'short' }).format(
      new Date(STARTED),
    );

    expect(overnight).toContain(day);
    expect(short).toContain(day);
  });

  it('says a short session in minutes alone', () => {
    // ⚠️ Une classe d'espace : `Intl` sépare le nombre de son unité par une fine insécable.
    expect(sessionMeta(STARTED, STARTED + 48 * 60_000, 'fr')).toMatch(/48\s*min/u);
  });

  /** ⚠️ **Pas de « 0 h 48 min »** : une unité à zéro se lit comme une valeur manquante. */
  it('adds the hours only from one hour on', () => {
    expect(sessionMeta(STARTED, STARTED + 59 * 60_000, 'fr')).not.toMatch(/h/u);
    expect(sessionMeta(STARTED, STARTED + 65 * 60_000, 'fr')).toMatch(/1\s*h/u);
  });

  /** Une fin antérieure au début — horloge reculée — rend zéro, jamais une durée négative. */
  it('never spells a negative duration', () => {
    expect(sessionMeta(STARTED, STARTED - 60_000, 'fr')).toMatch(/0\s*min/u);
  });

  /** Sans langue explicite, `Intl` prend celle de l'exécution — le cas du produit. */
  it('uses the runtime locale when none is given', () => {
    expect(sessionMeta(STARTED, STARTED + 60_000)).toContain(
      new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(
        new Date(STARTED),
      ),
    );
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **LE LIBELLÉ SE COMPOSE ICI, PAS DANS RUST** *(correction de la fiche P4-19)*.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La fiche demandait que l'évènement de progression porte « son libellé ». Ce serait une phrase
 * française émise par le backend au milieu d'une interface localisée **au build** dans six
 * langues : elle sortirait telle quelle en italien comme en allemand.
 */
describe('stepLabel', () => {
  const STEPS: readonly LiveStep[] = [
    'settling',
    'voices',
    'echo',
    'weaving',
    'erasing',
    'notes',
    'writing',
  ];

  /**
   * ⚠️⚠️ **LA TABLE EST COMPLÈTE, ET C'EST CE TEST QUI LE DIT.** Une étape sans libellé rendrait
   * `undefined` sous le voile — un bloc de progression **sans texte**, ce qui ressemble trait
   * pour trait à un défaut d'affichage plutôt qu'à une étape oubliée.
   */
  it('names every step Rust can emit', () => {
    for (const step of STEPS) {
      expect(stepLabel(step)?.length).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠️⚠️ **QUATRE ÉTAPES QUI DIRAIENT LA MÊME CHOSE NE DIRAIENT RIEN.** Tout l'objet de P4-19 est
   * que l'utilisateur sache **de quelle attente il s'agit** ; des libellés qui se répètent
   * ramèneraient le « Chargement… » unique qu'on vient de retirer.
   */
  it('never says the same thing twice', () => {
    const labels = STEPS.map(stepLabel);
    expect(new Set(labels).size).toBe(STEPS.length);
  });

  /**
   * ⚠️ **Aucun mot du code ne sort à l'écran.** « Entrelacer », « diariser », « slice » sont nos
   * mots ; ils n'apprennent rien à qui attend son transcript.
   */
  it('never shows an engineering word to the user', () => {
    const said = STEPS.map(stepLabel).join(' ').toLowerCase();
    for (const jargon of ['entrelac', 'diaris', 'slice', 'map-reduce', 'tranche']) {
      expect(said).not.toContain(jargon);
    }
  });

  /**
   * ⚠️⚠️ **NE JAMAIS AFFICHER DE TEMPS RESTANT** *(décision 3)*. Les étapes n'ont pas la même
   * durée, et un temps annoncé faux est pire qu'aucun temps : il est cru.
   */
  it('never promises a duration', () => {
    const said = STEPS.map(stepLabel).join(' ').toLowerCase();
    for (const promise of ['restant', 'seconde', 'minute', 'environ']) {
      expect(said).not.toContain(promise);
    }
  });

  /**
   * ⚠️ **« Suppression de l'audio » mérite son libellé bien qu'elle dure quelques
   * millisecondes** : c'est le seul instant où l'application *montre* que l'enregistrement ne
   * survit pas à la session.
   */
  it('says out loud that the audio is being deleted', () => {
    expect(stepLabel('erasing').toLowerCase()).toContain('audio');
  });
});

describe('stepPercent', () => {
  /** Le premier évènement laisse la barre à zéro : l'étape nommée est celle qui **commence**. */
  it('starts at nothing done', () => {
    expect(stepPercent(0, 5)).toBe(0);
  });

  it('counts the steps already crossed', () => {
    expect(stepPercent(3, 5)).toBe(60);
    expect(stepPercent(1, 3)).toBe(33);
  });

  /**
   * ⚠️⚠️ **UN TOTAL NUL REND `null`, PAS ZÉRO.** `null` veut dire « en cours, durée inconnue » et
   * la barre passe en indéterminé ; `0` afficherait « 0 % » sur un travail dont on ne sait rien,
   * et une division par zéro se lirait `NaN%` à l'écran.
   */
  it('gives up rather than divide by nothing', () => {
    expect(stepPercent(0, 0)).toBeNull();
    expect(stepPercent(2, -1)).toBeNull();
  });

  /** Une charge utile aberrante ne fait pas déborder la barre. */
  it('never goes past full', () => {
    expect(stepPercent(9, 5)).toBe(100);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **LE RANG DE LA RUBRIQUE, MESURÉ SUR LE MENU RÉELLEMENT RENDU.**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `REPORT_PROMPT_GROUP_INDEX` sert dans **deux espaces d'index différents** : un rang parmi les
 * options ici, un rang parmi les lignes de premier niveau — options à plat **et** branches — dans
 * `ComboSelect.lockedGroups`. Ils coïncident tant qu'une seule ligne à plat précède le point
 * d'insertion, et rien dans les deux fichiers ne le garantit. Ce test est ce lien : il rend le
 * menu et lit la place que la rubrique y prend vraiment.
 *
 * ⚠️ Il tombe si l'un des deux emplois bouge seul — une option à plat ajoutée avant la rubrique,
 * ou une branche remontée devant elle — alors que la constante, elle, n'aurait pas changé.
 */
describe('le rang de la rubrique « Personnalisé »', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.querySelector('.cdk-overlay-container')?.remove();
  });

  it('est le même dans les options et dans le menu rendu', () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(ComboSelect);
    fixture.componentRef.setInput(
      'options',
      reportTypeOptions([{ id: 7, title: 'Bilan', prompt: '…' }]),
    );
    fixture.componentRef.setInput('value', 'none');
    fixture.componentRef.setInput('ariaLabel', 'Type de compte rendu');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
    fixture.detectChanges();

    const premierNiveau = [...document.querySelectorAll<HTMLElement>('#combo-listbox > div')].map(
      (node) => node.querySelector('.lbl')?.textContent?.trim(),
    );

    expect(premierNiveau[REPORT_PROMPT_GROUP_INDEX]).toBe(reportPromptGroupLabel());
  });
});
