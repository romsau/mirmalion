import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { OptionsFichiers } from './options-fichiers';
import { ProgressBar } from '../../../../shared/components/progress-bar/progress-bar';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { Transcription } from '../../../../core/services/transcription/transcription';
import type {
  FileDocument,
  FileDropEvent,
  LanguageDetection,
  MediaInspection,
  TranscriptionRequest,
} from '../../../../core/services/bridge/media/media.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import { MediaBridge } from '../../../../core/services/bridge/media/media.bridge';

/**
 * Ce que ce fichier éprouve : **le branchement de l'écran sur le backend** — les deux voies
 * d'import, les cinq refus, la panne, et le passage à l'état « en cours ».
 *
 * ⚠️ **Le glisser-déposer n'est pas simulé par des évènements DOM**, et c'est le fond du sujet :
 * sur macOS, wry détourne le glisser du webview et les `(drop)` d'un gabarit ne se déclenchent
 * jamais dans l'application. La doublure de `Tauri` rejoue donc les évènements que le backend
 * livre réellement.
 */
const ACCEPTED: MediaInspection = {
  status: 'accepted',
  path: '/Users/moi/Films/plateau.mp4',
  fileName: 'plateau.mp4',
  durationMs: 370_149,
  hasVideo: true,
};

/** Les extensions telles que le backend les dicte — jamais une constante du frontend. */
const EXTENSIONS = ['mp3', 'mp4', 'mov'];

/** Le verdict de détection nominal : la langue est décidée, le travail peut partir. */
const DETECTED: LanguageDetection = { status: 'detected', language: 'fr' };

/** Le document que le backend rend au bout du travail — il ouvre sa fenêtre lui-même. */
const DOCUMENT: FileDocument = {
  id: 'filedoc-0',
  title: 'plateau.mp4',
  fileName: 'plateau.mp4',
  path: ACCEPTED.path,
  language: 'fr',
  durationMs: 370_149,
  transcript: { language: 'fr', paragraphs: [] },
};

interface Overrides {
  readonly inspect?: () => Promise<MediaInspection | null>;
  readonly detect?: () => Promise<LanguageDetection | null>;
  readonly extensions?: () => Promise<readonly string[] | null>;
  readonly pick?: () => Promise<string | null>;
  readonly transcribe?: (request: TranscriptionRequest) => Promise<FileDocument | null>;
  readonly cancel?: () => Promise<void>;
}

function harness(overrides: Overrides = {}) {
  let emit: ((event: FileDropEvent) => void) | null = null;
  let report: ((percent: number) => void) | null = null;
  const unlistenDrop = vi.fn();
  const unlistenProgress = vi.fn();

  const tauri = {
    inspectMedia: vi.fn(overrides.inspect ?? (() => Promise.resolve(ACCEPTED))),
    detectMediaLanguage: vi.fn<() => Promise<LanguageDetection | null>>(
      overrides.detect ?? (() => Promise.resolve(DETECTED)),
    ),
    supportedMediaExtensions: vi.fn(overrides.extensions ?? (() => Promise.resolve(EXTENSIONS))),
    pickMediaFile: vi.fn(overrides.pick ?? (() => Promise.resolve('/Users/moi/choisi.mp3'))),
    onFileDrop: vi.fn((handler: (event: FileDropEvent) => void) => {
      emit = handler;
      return Promise.resolve(unlistenDrop);
    }),
  };
  const transcription = {
    observeProgress: vi.fn((handler: (percent: number) => void) => {
      report = handler;
      return Promise.resolve(unlistenProgress);
    }),
    transcribe: vi.fn<(request: TranscriptionRequest) => Promise<FileDocument | null>>(
      overrides.transcribe ?? (() => new Promise<FileDocument | null>(() => undefined)),
    ),
    cancel: vi.fn(overrides.cancel ?? (() => Promise.resolve())),
  };
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn(), clear: vi.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MediaBridge, useValue: tauri },
      { provide: Transcription, useValue: transcription },
      { provide: Snackbar, useValue: snackbar },
    ],
  });

  return {
    tauri,
    transcription,
    snackbar,
    unlistenDrop,
    unlistenProgress,
    drop: (event: FileDropEvent) => emit?.(event),
    /** Ce que le backend émet pendant le travail — un entier, jamais un ratio. */
    progress: (percent: number) => report?.(percent),
  };
}

async function render(): Promise<ComponentFixture<OptionsFichiers>> {
  const fixture = TestBed.createComponent(OptionsFichiers);
  await settle(fixture);
  return fixture;
}

/**
 * Laisse l'écran se poser.
 *
 * ⚠️ **Deux tours, pas un.** Le glisser-déposer déclenche l'inspection **sans l'attendre** — le
 * gestionnaire d'évènement est synchrone. Au premier `whenStable`, la promesse du pont vient
 * seulement de se résoudre ; c'est le tour suivant qui relit le signal et repeint. Un seul tour
 * montrerait l'écran tel qu'il était avant le dépôt, et le test conclurait à l'envers.
 */
async function settle(fixture: ComponentFixture<OptionsFichiers>): Promise<void> {
  await fixture.whenStable();
  await fixture.whenStable();
}

function hostOf(fixture: ComponentFixture<OptionsFichiers>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** L'écran est-il teinté ? C'est la seule trace visible du glisser à son étage. */
function isTinted(fixture: ComponentFixture<OptionsFichiers>): boolean {
  return hostOf(fixture).classList.contains('is-drag');
}

/** L'écran est-il passé en « en cours » ? La zone de dépôt disparaît, la progression paraît. */
function isLive(fixture: ComponentFixture<OptionsFichiers>): boolean {
  return hostOf(fixture).querySelector('app-progress-bar') !== null;
}

function labelOf(fixture: ComponentFixture<OptionsFichiers>): string {
  return hostOf(fixture).querySelector('app-progress-bar .label')?.textContent?.trim() ?? '';
}

const REFUSALS = ['empty', 'unreadable', 'noAudioTrack', 'multipleFiles', 'noFile'] as const;

function refusing(problem: (typeof REFUSALS)[number]): Overrides {
  return { inspect: () => Promise.resolve({ status: 'rejected', problem }) };
}

describe('OptionsFichiers', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('annonce les 6 langues reconnues, et elles seules', async () => {
    // ⚠️ Ce test empêche la phrase de contredire `LANGUAGES` : elle énumère les langues en
    // toutes lettres, rien ne la relie au périmètre, et une langue retirée y survivrait.
    harness();
    const langs = hostOf(await render()).querySelector('.dz-langs')?.textContent ?? '';

    expect(langs).toContain('6 langues');
    expect(langs).not.toContain('néerlandais');
    expect(langs).not.toContain('turc');
    for (const language of [
      'français',
      'anglais',
      'espagnol',
      'allemand',
      'italien',
      'portugais',
    ]) {
      expect(langs).toContain(language);
    }
    for (const retired of ['chinois', 'japonais', 'coréen']) {
      expect(langs).not.toContain(retired);
    }
  });

  describe('le retour visuel du glisser', () => {
    it('ne teinte rien tant qu’aucun fichier ne survole la fenêtre', async () => {
      harness();

      expect(isTinted(await render())).toBe(false);
    });

    it('teinte l’écran à l’entrée et l’éteint à la sortie', async () => {
      const { drop } = harness();
      const fixture = await render();

      drop({ kind: 'enter' });
      await settle(fixture);
      expect(isTinted(fixture)).toBe(true);

      drop({ kind: 'leave' });
      await settle(fixture);
      expect(isTinted(fixture)).toBe(false);
    });

    it('éteint la teinte au dépôt, que macOS ne fait suivre d’aucun « leave »', async () => {
      const { drop } = harness();
      const fixture = await render();

      drop({ kind: 'enter' });
      await settle(fixture);
      drop({ kind: 'drop', paths: ['/tmp/a.mp3'] });
      await settle(fixture);

      expect(isTinted(fixture)).toBe(false);
    });

    it('ignore un glisser pendant qu’un média est déjà en cours', async () => {
      // Une seule opération à la fois : teinter promettrait un second import qu'on refuserait.
      const { drop, tauri } = harness();
      const fixture = await render();

      drop({ kind: 'drop', paths: ['/tmp/a.mp3'] });
      await settle(fixture);
      expect(isLive(fixture)).toBe(true);

      drop({ kind: 'enter' });
      await settle(fixture);
      expect(isTinted(fixture)).toBe(false);

      drop({ kind: 'drop', paths: ['/tmp/b.mp3'] });
      await settle(fixture);
      expect(tauri.inspectMedia).toHaveBeenCalledOnce();
    });
  });

  describe('le dépôt', () => {
    it('fait inspecter les chemins livrés par le backend', async () => {
      // ⚠️ Ce sont des CHEMINS, pas des `File` : un `File` de `DataTransfer` n'en porte aucun.
      const { drop, tauri } = harness();
      const fixture = await render();

      drop({ kind: 'drop', paths: ['/Users/moi/Films/plateau.mp4'] });
      await settle(fixture);

      expect(tauri.inspectMedia).toHaveBeenCalledExactlyOnceWith(['/Users/moi/Films/plateau.mp4']);
    });

    it('bascule en « en cours » avec le nom du fichier en libellé', async () => {
      const { drop } = harness();
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(isLive(fixture)).toBe(true);
      expect(labelOf(fixture)).toBe('plateau.mp4');
      expect(hostOf(fixture).querySelector('app-file-drop-zone')).toBeNull();
    });

    it('affiche une progression DÉTERMINÉE, en pourcentages entiers', async () => {
      // ⚠️ Le pourcentage est vrai : le backend le calcule sur la position dans le média et
      // n'émet que sur changement d'entier. C'est ce qui autorise une barre remplie.
      const { drop, progress } = harness();
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      expect(hostOf(fixture).querySelector('app-progress-bar .bar.indeterminate')).toBeNull();

      progress(62);
      await settle(fixture);

      expect(
        hostOf(fixture).querySelector('app-progress-bar .bar')?.getAttribute('aria-valuenow'),
      ).toBe('62');
    });

    it('reste à l’import hors contexte Tauri, sans rien dire', async () => {
      const { drop, snackbar } = harness({ inspect: () => Promise.resolve(null) });
      const fixture = await render();

      drop({ kind: 'drop', paths: ['/tmp/a.mp3'] });
      await settle(fixture);

      expect(isLive(fixture)).toBe(false);
      expect(snackbar.error).not.toHaveBeenCalled();
    });
  });

  describe('les cinq refus', () => {
    for (const problem of REFUSALS) {
      it(`« ${problem} » affiche une snackbar et n’entre jamais en « en cours »`, async () => {
        const { drop, snackbar } = harness(refusing(problem));
        const fixture = await render();

        drop({ kind: 'drop', paths: ['/tmp/x'] });
        await settle(fixture);

        expect(snackbar.error).toHaveBeenCalledOnce();
        expect(isLive(fixture)).toBe(false);
      });
    }

    it('donne à chaque motif une phrase qui lui est propre', async () => {
      // ⚠️ Qui a déposé une vidéo muette n'a pas la même chose à faire que qui a déposé un
      // fichier corrompu : un message générique renverrait les deux au même mur.
      const messages: string[] = [];
      for (const problem of REFUSALS) {
        const { drop, snackbar } = harness(refusing(problem));
        const fixture = await render();
        drop({ kind: 'drop', paths: ['/tmp/x'] });
        await settle(fixture);
        messages.push(String(snackbar.error.mock.calls[0]?.[0]));
      }

      expect(new Set(messages).size).toBe(REFUSALS.length);
      expect(messages.every((message) => message.length > 0)).toBe(true);
    });

    it('nomme des formats quand le fichier est illisible, et là seulement', async () => {
      // ⚠️ L'écran d'import ne porte aucune liste de formats — la validation ouvre le conteneur,
      // pas l'extension. Le seul endroit où citer des formats aide vraiment est le refus qui
      // vient d'un format : une vidéo muette ou un fichier vide n'ont rien à en faire.
      const said: Record<string, string> = {};
      for (const problem of REFUSALS) {
        const { drop, snackbar } = harness(refusing(problem));
        const fixture = await render();
        drop({ kind: 'drop', paths: ['/tmp/x'] });
        await settle(fixture);
        said[problem] = String(snackbar.error.mock.calls[0]?.[0]);
      }

      expect(said['unreadable']).toContain('MP3');
      expect(said['unreadable']).toContain('MP4');
      for (const problem of REFUSALS.filter((other) => other !== 'unreadable')) {
        expect(said[problem]).not.toContain('MP3');
      }
    });

    it('distingue une brique cassée d’un mauvais fichier', async () => {
      // ⚠️ Une `Err` de l'inspection dit que le pont natif est cassé, jamais que le média ne
      // convient pas. Confondre les deux enverrait l'utilisateur chercher indéfiniment ce qui
      // cloche dans son fichier.
      const { drop: refuse, snackbar: refused } = harness(refusing('unreadable'));
      const refusedFixture = await render();
      refuse({ kind: 'drop', paths: ['/tmp/x'] });
      await settle(refusedFixture);

      const { drop, snackbar } = harness({
        inspect: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      const fixture = await render();
      drop({ kind: 'drop', paths: ['/tmp/x'] });
      await settle(fixture);

      expect(snackbar.error).toHaveBeenCalledOnce();
      expect(snackbar.error.mock.calls[0]?.[0]).not.toBe(refused.error.mock.calls[0]?.[0]);
      expect(isLive(fixture)).toBe(false);
    });
  });

  describe('le sélecteur « Parcourir »', () => {
    async function browse(fixture: ComponentFixture<OptionsFichiers>): Promise<void> {
      hostOf(fixture).querySelector<HTMLButtonElement>('app-button button')?.click();
      await settle(fixture);
    }

    it('filtre le sélecteur avec les extensions du backend, jamais avec une liste locale', async () => {
      const { tauri } = harness();
      const fixture = await render();

      await browse(fixture);

      expect(tauri.supportedMediaExtensions).toHaveBeenCalledOnce();
      expect(tauri.pickMediaFile).toHaveBeenCalledExactlyOnceWith(EXTENSIONS);
    });

    it('inspecte le fichier choisi comme s’il avait été déposé', async () => {
      const { tauri } = harness({ pick: () => Promise.resolve('/Users/moi/choisi.mp3') });
      const fixture = await render();

      await browse(fixture);

      expect(tauri.inspectMedia).toHaveBeenCalledExactlyOnceWith(['/Users/moi/choisi.mp3']);
      expect(isLive(fixture)).toBe(true);
    });

    it('ne filtre sur rien quand le backend ne répond pas — hors contexte Tauri', async () => {
      const { tauri } = harness({ extensions: () => Promise.resolve(null) });
      const fixture = await render();

      await browse(fixture);

      expect(tauri.pickMediaFile).toHaveBeenCalledExactlyOnceWith([]);
    });

    it('ne dit rien quand l’utilisateur annule le sélecteur', async () => {
      // Une snackbar sur un geste que l'utilisateur vient d'annuler lui-même serait du bruit.
      const { tauri, snackbar } = harness({ pick: () => Promise.resolve(null) });
      const fixture = await render();

      await browse(fixture);

      expect(tauri.inspectMedia).not.toHaveBeenCalled();
      expect(snackbar.error).not.toHaveBeenCalled();
      expect(isLive(fixture)).toBe(false);
    });

    it('signale une panne du sélecteur', async () => {
      const { snackbar } = harness({
        extensions: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      const fixture = await render();

      await browse(fixture);

      expect(snackbar.error).toHaveBeenCalledOnce();
      expect(isLive(fixture)).toBe(false);
    });
  });

  describe('la transcription', () => {
    it('s’abonne à la progression AVANT de lancer le travail', async () => {
      // ⚠️ Le travail natif démarre dans la foulée de la commande : un abonnement posé après
      // elle manquerait les premières avancées, et toutes sur un média court.
      const { drop, transcription } = harness();
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(transcription.observeProgress).toHaveBeenCalledOnce();
      expect(transcription.observeProgress.mock.invocationCallOrder[0]).toBeLessThan(
        transcription.transcribe.mock.invocationCallOrder[0] ?? Infinity,
      );
    });

    it('transcrit dans la langue DÉTECTÉE, sans demander de réglage à l’import', async () => {
      // ⚠️ Ce test a longtemps passé sur une constante : le corps de `detectLanguage` rendait
      // « fr » en dur. La langue attendue ici est donc **volontairement autre que le
      // français** — c'est la seule façon de distinguer « détecté » de « codé en dur ».
      const { drop, tauri, transcription } = harness({
        detect: () => Promise.resolve({ status: 'detected', language: 'it' }),
      });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(tauri.detectMediaLanguage).toHaveBeenCalledExactlyOnceWith(ACCEPTED.path);
      expect(transcription.transcribe).toHaveBeenCalledExactlyOnceWith({
        path: ACCEPTED.path,
        fileName: 'plateau.mp4',
        language: 'it',
      });
    });

    it('annonce la détection, puis le nom du fichier', async () => {
      // ⚠️ Sans ce premier libellé, la barre reste à 0 % sous un nom de fichier pendant que la
      // machine travaille — indiscernable d'une barre bloquée.
      const pending: { decide?: (verdict: LanguageDetection) => void } = {};
      const { drop } = harness({
        detect: () =>
          new Promise<LanguageDetection>((resolve) => {
            pending.decide = resolve;
          }),
      });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(labelOf(fixture)).toBe('Détection de la langue…');

      pending.decide?.(DETECTED);
      // Deux passes : la première laisse le `finally` s'exécuter, la seconde repeint.
      await settle(fixture);
      await settle(fixture);

      expect(labelOf(fixture)).toBe('plateau.mp4');
    });

    it('ne porte aucun libellé au repos, où aucune barre ne le lit', async () => {
      // ⚠️ Le repli à vide n'est jamais AFFICHÉ — la barre n'existe pas tant qu'aucun média
      // n'est accepté. Il est là pour que le libellé reste une chaîne : rendre `null` à
      // `ProgressBar` lui ferait écrire « null » le jour où quelqu'un l'y branche autrement.
      const fixture = await render();
      const label = (fixture.componentInstance as unknown as { progressLabel: () => string })
        .progressLabel;

      expect(label()).toBe('');
    });

    it('détecte AVANT de s’abonner à la progression', async () => {
      // ⚠️ La détection peut ne rien décider : s'abonner d'abord poserait un écouteur sur un
      // travail qui ne démarrera pas.
      const { drop, tauri, transcription } = harness();
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(tauri.detectMediaLanguage.mock.invocationCallOrder[0]).toBeLessThan(
        transcription.observeProgress.mock.invocationCallOrder[0] ?? Infinity,
      );
    });

    it('revient à l’import quand le document est prêt — sa fenêtre s’ouvre ailleurs', async () => {
      const { drop } = harness({ transcribe: () => Promise.resolve(DOCUMENT) });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      await settle(fixture);

      expect(isLive(fixture)).toBe(false);
      expect(hostOf(fixture).querySelector('app-file-drop-zone')).not.toBeNull();
    });

    it('se débranche de la progression, quoi qu’il arrive', async () => {
      const { drop, unlistenProgress } = harness({ transcribe: () => Promise.resolve(DOCUMENT) });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      await settle(fixture);

      expect(unlistenProgress).toHaveBeenCalledOnce();
    });

    it('signale un échec et rend l’écran d’import', async () => {
      const { drop, snackbar } = harness({
        transcribe: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      await settle(fixture);

      expect(snackbar.error).toHaveBeenCalledOnce();
      expect(isLive(fixture)).toBe(false);
    });

    it('ne dit rien d’une annulation : l’utilisateur vient de la demander', async () => {
      const { drop, snackbar } = harness({
        transcribe: () => Promise.reject({ kind: 'cancelled', message: 'annulé' }),
      });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      await settle(fixture);

      expect(snackbar.error).not.toHaveBeenCalled();
    });
  });

  describe('la langue qui ne se décide pas', () => {
    // ⚠️ Quatre motifs, quatre phrases distinctes, et c'est l'objet du test. Ils demandent quatre
    // gestes différents — changer de fichier, choisir la langue soi-même, installer CETTE langue,
    // en installer une. Un message unique laisserait sans issue dans trois cas sur quatre.
    const UNDECIDED = [
      'noSpeech',
      'unsupportedLanguage',
      'tooShort',
      'noInstalledLanguage',
    ] as const;

    it('dit le motif et revient à l’import, sans rien transcrire', async () => {
      for (const problem of UNDECIDED) {
        const { drop, snackbar, transcription } = harness({
          detect: () => Promise.resolve({ status: 'undecided', problem }),
        });
        const fixture = await render();

        drop({ kind: 'drop', paths: [ACCEPTED.path] });
        await settle(fixture);

        expect(transcription.transcribe, problem).not.toHaveBeenCalled();
        expect(transcription.observeProgress, problem).not.toHaveBeenCalled();
        expect(snackbar.error, problem).toHaveBeenCalledOnce();
        expect(isLive(fixture), problem).toBe(false);
      }
    });

    it('n’écrit pas la même phrase pour deux motifs', async () => {
      const said: string[] = [];
      for (const problem of UNDECIDED) {
        const { drop, snackbar } = harness({
          detect: () => Promise.resolve({ status: 'undecided', problem }),
        });
        const fixture = await render();

        drop({ kind: 'drop', paths: [ACCEPTED.path] });
        await settle(fixture);

        said.push(String(snackbar.error.mock.calls[0]?.[0] ?? ''));
      }

      expect(new Set(said).size).toBe(UNDECIDED.length);
      expect(said.every((phrase) => phrase.length > 0)).toBe(true);
    });

    it('ne dit RIEN hors contexte Tauri, où il n’y a pas de verdict', async () => {
      // Le navigateur n'est pas un utilisateur à qui expliquer quelque chose.
      const { drop, snackbar, transcription } = harness({ detect: () => Promise.resolve(null) });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(snackbar.error).not.toHaveBeenCalled();
      expect(transcription.transcribe).not.toHaveBeenCalled();
      expect(isLive(fixture)).toBe(false);
    });

    it('n’écrase rien si l’utilisateur a annulé PENDANT la détection', async () => {
      // ⚠️ La détection dure quelques secondes : annuler pendant qu'elle tourne est le cas
      // courant, pas le cas tordu. Le jeton doit écarter le verdict qui arrive en retard —
      // sinon il remettrait l'écran à l'import alors qu'un second média y est peut-être déjà.
      // ⚠️ Le résolveur est rangé dans un objet et non dans un `let` : TypeScript réduit une
      // variable affectée dans un exécuteur de promesse à `never`, et l'appeler ne compile pas.
      const pending: { decide?: (verdict: LanguageDetection) => void } = {};
      const { drop, snackbar, transcription } = harness({
        detect: () =>
          new Promise<LanguageDetection>((resolve) => {
            pending.decide = resolve;
          }),
      });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      expect(isLive(fixture)).toBe(true);

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);

      pending.decide?.({ status: 'undecided', problem: 'noSpeech' });
      await settle(fixture);

      expect(transcription.transcribe).not.toHaveBeenCalled();
      expect(isLive(fixture)).toBe(false);
      // ⚠️ Le motif est dit quand même : la détection a réellement conclu, et l'utilisateur a
      // le droit de savoir pourquoi son fichier n'aurait pas marché. Ce que le jeton protège
      // est l'ÉTAT de l'écran, pas la parole.
      expect(snackbar.error).toHaveBeenCalledOnce();
    });

    it('traite une panne de la détection comme une panne de transcription', async () => {
      // ⚠️ Une `Err` de la détection veut dire « la brique native est cassée » — c'est la même
      // issue que si le moteur avait lâché, et le même message.
      const { drop, snackbar } = harness({ detect: () => Promise.reject(new Error('pont')) });
      const fixture = await render();

      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      expect(snackbar.error).toHaveBeenCalledOnce();
      expect(isLive(fixture)).toBe(false);
    });
  });

  describe('la sortie de l’état « en cours »', () => {
    it('« Annuler » arrête le travail natif, pas seulement l’affichage', async () => {
      // ⚠️ Masquer l'interface ne suffit pas : un moteur qui continue de dérouler une heure de
      // média consomme un cœur pour rien, et l'écran ment en annonçant l'arrêt.
      const { drop, transcription } = harness();
      const fixture = await render();
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);

      expect(transcription.cancel).toHaveBeenCalledOnce();
    });

    it('ne dit rien quand l’annulation elle-même échoue', async () => {
      // L'écran est déjà revenu à l'import : une snackbar ferait douter d'un geste abouti.
      const { drop, snackbar } = harness({ cancel: () => Promise.reject(new Error('boum')) });
      const fixture = await render();
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);

      expect(snackbar.error).not.toHaveBeenCalled();
    });

    it('un travail abandonné ne parle plus au nom de l’écran', async () => {
      // ⚠️ La promesse de `transcribe` retombe après l'annulation : sans jeton, sa retombée
      // effacerait le média déposé à la place, ou afficherait l'erreur d'un travail arrêté.
      //
      // ⚠️ **On retient CHAQUE rejeteur, pas seulement le dernier.** Une seule variable
      // réassignée à chaque appel ferait retomber le **second** travail — celui qui est
      // légitimement en cours — et le test prouverait le contraire de ce qu'il annonce.
      const failures: ((reason: unknown) => void)[] = [];
      const { drop, progress, snackbar } = harness({
        transcribe: () =>
          new Promise<FileDocument | null>((_, reject) => {
            failures.push(reject);
          }),
      });
      const fixture = await render();
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      progress(80);
      // Le PREMIER travail, celui que l'utilisateur a abandonné, retombe maintenant.
      failures[0]({ kind: 'native', message: 'boum' });
      await settle(fixture);

      expect(snackbar.error).not.toHaveBeenCalled();
      expect(isLive(fixture), 'le second média reste en cours').toBe(true);
    });

    it('la progression d’un travail abandonné ne bouge plus la barre', async () => {
      // ⚠️ Le pont natif peut rendre une avancée déjà en vol au moment de l'annulation. Sans le
      // jeton, elle ferait reculer la barre du média suivant — un écran qui repart en arrière.
      const { drop, progress, transcription } = harness({
        transcribe: () => new Promise<FileDocument | null>(() => undefined),
      });
      const fixture = await render();
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);
      const stale = transcription.observeProgress.mock.calls[0][0];

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      progress(42);
      await settle(fixture);
      stale(9);
      await settle(fixture);

      expect(
        fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.progress(),
        'l’avancée périmée est ignorée',
      ).toBe(42);
    });

    it('la RÉUSSITE d’un travail abandonné n’efface pas le média suivant', async () => {
      // ⚠️ Le symétrique de l'échec : une transcription annulée peut aboutir malgré tout, et sa
      // réussite refermerait l'écran sur le média que l'utilisateur vient de déposer.
      const finishes: ((document: FileDocument | null) => void)[] = [];
      const { drop } = harness({
        transcribe: () =>
          new Promise<FileDocument | null>((resolve) => {
            finishes.push(resolve);
          }),
      });
      const fixture = await render();
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      finishes[0](null);
      await settle(fixture);

      expect(isLive(fixture), 'le second média reste en cours').toBe(true);
    });

    it('« Annuler » ramène à l’écran d’import', async () => {
      // ⚠️ On émet la sortie du composant de progression plutôt que de cliquer son bouton :
      // celui-ci ne paraît qu'après 2,5 s, et une horloge simulée fige `whenStable` — le test
      // attendrait pour de bon. Ce qui est éprouvé ici est la liaison `(cancelled)`, pas le
      // délai d'apparition, qui a son propre test dans `ProgressBar`.
      const { drop } = harness();
      const fixture = await render();
      drop({ kind: 'drop', paths: [ACCEPTED.path] });
      await settle(fixture);

      fixture.debugElement.query(By.directive(ProgressBar)).componentInstance.cancelled.emit();
      await settle(fixture);

      expect(isLive(fixture)).toBe(false);
      expect(hostOf(fixture).querySelector('app-file-drop-zone')).not.toBeNull();
    });
  });

  describe('l’abonnement au glisser', () => {
    it('se débranche à la destruction de l’écran', async () => {
      const { unlistenDrop } = harness();
      const fixture = await render();

      fixture.destroy();

      expect(unlistenDrop).toHaveBeenCalledOnce();
    });

    it('se débranche aussitôt si l’écran a été quitté pendant l’attente', async () => {
      // Sans cela, l'abonnement survivrait sans propriétaire et rejouerait un import sur un
      // composant détruit.
      let resolve: (stop: () => void) => void = () => undefined;
      const unlistenDrop = vi.fn();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: MediaBridge,
            useValue: {
              onFileDrop: vi.fn(
                () =>
                  new Promise<() => void>((r) => {
                    resolve = r;
                  }),
              ),
            },
          },
          { provide: Snackbar, useValue: { error: vi.fn() } },
        ],
      });
      const fixture = TestBed.createComponent(OptionsFichiers);
      fixture.destroy();

      resolve(unlistenDrop);
      await settle(fixture);

      expect(unlistenDrop).toHaveBeenCalledOnce();
    });
  });

  it('n’a aucune violation d’accessibilité, dans les deux états', async () => {
    const { drop } = harness();
    const fixture = await render();
    await expectNoAxeViolations(fixture.nativeElement);

    drop({ kind: 'enter' });
    await settle(fixture);
    await expectNoAxeViolations(fixture.nativeElement);

    drop({ kind: 'drop', paths: [ACCEPTED.path] });
    await settle(fixture);
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
