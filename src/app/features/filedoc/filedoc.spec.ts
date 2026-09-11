import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_ID } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Filedoc } from './filedoc';
import { DocOverlay } from '../../shared/components/doc-overlay/doc-overlay';
import { InlineTitle } from '../../shared/components/inline-title/inline-title';
import { Transcription } from '../../core/services/transcription/transcription';
import { Modal } from '../../core/services/modal/modal';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import type { ConfirmData } from '../../shared/components/confirm-dialog/confirm-dialog';
import type {
  FileDocument,
  TranscriptParagraph,
  TranscriptTranslation,
} from '../../core/services/bridge/media/media.bridge';
import { expectNoAxeViolations } from '../../../testing/axe';

/**
 * Ce que ce fichier éprouve : **l'assemblage**. Ce que la fenêtre traduit du contrat backend
 * (le transcript, la durée), ce qu'elle fait des trois menus de sa barre, et le fait qu'elle
 * attrape **toutes** les voies de fermeture.
 *
 * ⚠️ **Le store n'est pas doublé.** C'est lui qui porte la règle « une opération à la fois » ;
 * le remplacer par un objet complaisant ferait passer des tests sur une machinerie qui
 * n'existe pas. Ce qui est doublé est la frontière : le service de domaine, la modale, la
 * snackbar.
 */
function paragraph(text: string): TranscriptParagraph {
  return { words: text.split(' ').map((word) => ({ text: word, startMs: 0, endMs: 1 })) };
}

function documentWith(
  paragraphs: readonly TranscriptParagraph[],
  durationMs = 370_149,
): FileDocument {
  return {
    id: 'filedoc-3',
    title: 'plateau.mp4',
    fileName: 'plateau.mp4',
    path: '/Users/moi/Films/plateau.mp4',
    language: 'fr',
    durationMs,
    transcript: { language: 'fr', paragraphs },
  };
}

const TWO_VOICES = documentWith([
  paragraph('Bienvenue dans cet épisode.'),
  paragraph('Merci de me recevoir.'),
]);

const TRANSLATED: TranscriptTranslation = {
  kind: 'translated',
  paragraphs: [
    { startMs: 0, endMs: 1, text: 'Willkommen zu dieser Folge.' },
    { startMs: 1, endMs: 2, text: 'Danke für die Einladung.' },
  ],
};

interface Overrides {
  readonly document?: () => Promise<FileDocument | null>;
  readonly rename?: () => Promise<FileDocument | null>;
  readonly confirm?: () => Promise<boolean>;
  readonly translate?: () => Promise<TranscriptTranslation | null>;
  readonly chooseExportPath?: () => Promise<boolean>;
  readonly exportDocument?: () => Promise<void>;
  readonly copy?: () => Promise<void>;
  /**
   * La langue de l'interface, celle du bundle chargé.
   *
   * ⚠️ Français par défaut, comme la locale source : sans ce fournisseur, `LOCALE_ID` vaut
   * « en-US » et se confond avec la locale du système, ce qui rend le défaut invisible.
   */
  readonly locale?: string;
}

function harness(overrides: Overrides = {}) {
  let requestClose: (() => void) | null = null;
  let report: ((percent: number) => void) | null = null;
  const unlistenClose = vi.fn();
  const unlistenProgress = vi.fn();

  const transcription = {
    document: vi.fn(overrides.document ?? (() => Promise.resolve(TWO_VOICES))),
    rename: vi.fn(overrides.rename ?? (() => Promise.resolve(TWO_VOICES))),
    close: vi.fn(() => Promise.resolve()),
    translate: vi.fn(overrides.translate ?? (() => Promise.resolve(TRANSLATED))),
    cancelTranslation: vi.fn(() => Promise.resolve()),
    chooseExportPath: vi.fn(overrides.chooseExportPath ?? (() => Promise.resolve(true))),
    export: vi.fn(overrides.exportDocument ?? (() => Promise.resolve())),
    copy: vi.fn(overrides.copy ?? (() => Promise.resolve())),
    observeCloseRequest: vi.fn((handler: () => void) => {
      requestClose = handler;
      return Promise.resolve(unlistenClose);
    }),
    observeTranslationProgress: vi.fn((_id: string, handler: (percent: number) => void) => {
      report = handler;
      return Promise.resolve(unlistenProgress);
    }),
  };
  const modal = {
    confirm: vi.fn<(data: ConfirmData) => Promise<boolean>>(
      overrides.confirm ?? (() => Promise.resolve(true)),
    ),
  };
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn(), clear: vi.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Transcription, useValue: transcription },
      { provide: Modal, useValue: modal },
      { provide: Snackbar, useValue: snackbar },
      { provide: LOCALE_ID, useValue: overrides.locale ?? 'fr' },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ id: '3' }) } },
      },
    ],
  });

  return {
    transcription,
    modal,
    snackbar,
    unlistenClose,
    unlistenProgress,
    /** Ce que produisent la pastille rouge, ⌘W et le menu — la même demande, une seule voie. */
    close: () => requestClose?.(),
    /** Ce que le backend émet pendant qu'il traduit, tour après tour. */
    reportProgress: (percent: number) => report?.(percent),
  };
}

async function render(): Promise<ComponentFixture<Filedoc>> {
  const fixture = TestBed.createComponent(Filedoc);
  await settle(fixture);
  return fixture;
}

/**
 * Laisse la fenêtre se poser.
 *
 * ⚠️⚠️ **UN `setTimeout`, ET NON UN NOMBRE DE `whenStable`.** Les opérations partent sans être
 * attendues, et leur chaîne traverse plusieurs promesses — le service de domaine, le garde du
 * store, la mise à jour d'état. Sans zone, `whenStable` ne suit pas ces promesses-là : compter
 * les tours revient à figer dans le test la profondeur d'appel du code, et le moindre `await` de
 * plus casse des tests qui n'ont rien à voir. Un délai zéro s'exécute **après toute la file de
 * micro-tâches**, quelle que soit sa longueur ; `whenStable` ne sert plus qu'à repeindre.
 */
async function settle(fixture: ComponentFixture<Filedoc>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

function hostOf(fixture: ComponentFixture<Filedoc>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * Le voile de travail, ou `null` quand la fenêtre n'est occupée par rien.
 *
 * ⚠️ **On interroge le composant, pas le bouton « Annuler ».** Celui-ci n'apparaît qu'au bout de
 * 2,5 s — c'est `ProgressBar` qui tient ce seuil, et son propre spec l'éprouve. Ce qui se joue
 * ici est l'entrée : quelles opérations ont le droit de proposer l'arrêt.
 */
function overlay(fixture: ComponentFixture<Filedoc>): DocOverlay | null {
  return fixture.debugElement.query(By.directive(DocOverlay))?.componentInstance ?? null;
}

/**
 * Le pourcentage porté par le voile, ou `null` quand la barre est indéterminée.
 *
 * ⚠️ **Lu sur `aria-valuenow`, jamais sur le texte rendu** : le pourcentage écrit passe par
 * `Intl`, dont le séparateur change avec la locale — l'assertion serait vraie ou fausse selon
 * l'ordre des fichiers de test. L'attribut, lui, est le contrat.
 */
function percentShown(fixture: ComponentFixture<Filedoc>): string | null {
  return (
    hostOf(fixture).querySelector('app-doc-overlay .bar')?.getAttribute('aria-valuenow') ?? null
  );
}

/**
 * Le **déclencheur** d'un des trois menus de la barre.
 *
 * ⚠️ **Désignés par leur classe, jamais par leur rang** : la barre en porte trois, et chercher le
 * premier du document en attraperait un autre que celui qu'on croit.
 *
 * ⚠️ **On passe par le DOM et non par l'instance**, parce que c'est là que se joue la seule
 * chose qui compte : ce que l'utilisateur *voit* après un choix que l'hôte refuse.
 */
function control(fixture: ComponentFixture<Filedoc>, which: Menu): HTMLButtonElement {
  const element = hostOf(fixture).querySelector<HTMLButtonElement>(
    `app-combo-select.${which} [role="combobox"]`,
  );
  if (element === null) {
    throw new Error(`aucun sélecteur « ${which} » rendu`);
  }
  return element;
}

type Menu = 'translate' | 'export';

/** Ce que le déclencheur affiche — le seul juge de ce que l'utilisateur croit avoir obtenu. */
function shows(fixture: ComponentFixture<Filedoc>, which: Menu): string {
  return control(fixture, which).textContent?.trim() ?? '';
}

/**
 * Déroule un menu et rend ses lignes. Le panneau vit dans l'overlay du CDK, hors de l'hôte.
 *
 * ⚠️ Un seul panneau à la fois : le suivant remplacerait celui-ci, mais `afterEach` nettoie
 * l'overlay pour qu'un test n'hérite jamais de la liste d'un autre.
 */
function entries(fixture: ComponentFixture<Filedoc>, which: Menu): string[] {
  control(fixture, which).click();
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent?.trim() ?? '',
  );
}

/** Choisit dans un menu déroulé, comme le ferait la souris. */
function pick(fixture: ComponentFixture<Filedoc>, which: Menu, label: string): void {
  entries(fixture, which);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.textContent?.trim() === label,
  );
  if (option === undefined) {
    throw new Error(`« ${label} » n’est pas proposé par le menu « ${which} »`);
  }
  option.click();
  fixture.detectChanges();
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('Filedoc', () => {
  it('lit le document en recollant le préfixe que la route a perdu', async () => {
    // ⚠️ L'URL porte `3`, le backend attend `filedoc-3` : Angular n'apparie ses paramètres que
    // sur un segment entier, l'étiquette de fenêtre a donc été coupée.
    const { transcription } = harness();
    await render();

    expect(transcription.document).toHaveBeenCalledExactlyOnceWith('filedoc-3');
  });

  describe('le transcript', () => {
    it('recolle les mots horodatés en un texte lisible', async () => {
      harness();
      const fixture = await render();

      expect(hostOf(fixture).querySelector('.cr-p')?.textContent?.trim()).toBe(
        'Bienvenue dans cet épisode.',
      );
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ⚠️⚠️ **AUCUNE ÉTIQUETTE DE LOCUTEUR NULLE PART DANS LA FENÊTRE.**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * *(Porteur, 2026-08-06.)* Cette fenêtre décalait les numéros de 1 — Rust compte depuis 0,
     * l'utilisateur ne lit pas « Locuteur 0 » —, composait les libellés ici parce qu'ils se
     * traduisent dans six langues, et basculait entre deux rendus selon le nombre de voix.
     */
    it('ne dessine aucune pastille et ne nomme personne', async () => {
      harness();
      const fixture = await render();
      const host = hostOf(fixture);

      expect(host.querySelector('.tr-raw')).not.toBeNull();
      expect(host.querySelector('.spk')).toBeNull();
      expect(host.querySelector('.tr-list')).toBeNull();
      expect(host.textContent).not.toContain('Locuteur');
    });

    it('n’affiche rien tant que la lecture n’a pas eu lieu', async () => {
      // ⚠️ Un transcript vide et « pas encore lu » se ressemblent : monter la vue avant la
      // réponse ferait clignoter un document vide à chaque ouverture.
      harness({ document: () => new Promise<FileDocument>(() => undefined) });
      const fixture = await render();

      expect(hostOf(fixture).querySelector('app-transcript-view')).toBeNull();
    });

    it('reste vide, sans casser, quand le pont ne rend rien', async () => {
      harness({ document: () => Promise.resolve(null) });
      const fixture = await render();

      expect(hostOf(fixture).querySelector('.cr-p')).toBeNull();
      expect(hostOf(fixture).querySelector('app-transcript-view')).not.toBeNull();
    });
  });

  describe('l’en-tête', () => {
    it('affiche la durée du média — le backend n’a pas de date à donner', async () => {
      // ⚠️ La maquette y met une date ; un fichier importé n'en a aucune, et celle du jour ne
      // dirait rien de vrai sur un enregistrement de l'an dernier.
      harness();
      const fixture = await render();

      expect(hostOf(fixture).querySelector('.done-meta')?.textContent?.trim()).toBe('6:10');
    });

    it('passe aux heures dès que le média les dépasse', async () => {
      harness({ document: () => Promise.resolve(documentWith([], 3_723_000)) });
      const fixture = await render();

      expect(hostOf(fixture).querySelector('.done-meta')?.textContent?.trim()).toBe('1:02:03');
    });

    it('renomme le document et affiche ce que Rust rend', async () => {
      const renamed = documentWith([paragraph('Bonjour.')]);
      const { transcription } = harness({
        rename: () => Promise.resolve({ ...renamed, title: 'Plateau télé' }),
      });
      const fixture = await render();

      fixture.debugElement
        .query(By.directive(InlineTitle))
        .componentInstance.renamed.emit('Plateau télé');
      await settle(fixture);

      expect(transcription.rename).toHaveBeenCalledExactlyOnceWith('filedoc-3', 'Plateau télé');
      expect(hostOf(fixture).querySelector('h1')?.textContent?.trim()).toBe('Plateau télé');
    });
  });

  describe('la fermeture', () => {
    it('s’intercepte : la pastille rouge, ⌘W et le menu passent tous par la même demande', async () => {
      // ⚠️⚠️ Le backend ne pose aucun `prevent_close` sur une fenêtre-document. Sans cette
      // interception, la pastille rouge détruirait le document sans rien demander.
      const { transcription } = harness();
      await render();

      expect(transcription.observeCloseRequest).toHaveBeenCalledOnce();
    });

    it('ferme sans rien demander, et libère le document', async () => {
      // ⚠️⚠️ Décision du porteur (2026-08-03) : plus de modale. Une transcription de fichier se
      // refait en quelques secondes — le média source n'a jamais quitté le disque. Prévenir d'une
      // perte « définitive » qui coûte cinq secondes à réparer est une nuisance, pas un filet.
      const { transcription, modal, close } = harness();
      const fixture = await render();

      close();
      await settle(fixture);

      expect(modal.confirm).not.toHaveBeenCalled();
      expect(transcription.close).toHaveBeenCalledExactlyOnceWith('filedoc-3');
    });

    it('ferme aussi quand il n’y a rien à perdre', async () => {
      const { transcription, close } = harness({
        document: () => Promise.resolve(documentWith([])),
      });
      const fixture = await render();

      close();
      await settle(fixture);

      expect(transcription.close).toHaveBeenCalledExactlyOnceWith('filedoc-3');
    });

    it('se débranche à la destruction de la fenêtre', async () => {
      const { unlistenClose, unlistenProgress } = harness();
      const fixture = await render();

      fixture.destroy();

      expect(unlistenClose).toHaveBeenCalledOnce();
      expect(unlistenProgress).toHaveBeenCalledOnce();
    });

    it('se débranche aussitôt si la fenêtre a été détruite pendant l’attente', async () => {
      let resolve: (stop: () => void) => void = () => undefined;
      const unlistenClose = vi.fn();
      const unlistenProgress = vi.fn();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: Transcription,
            useValue: {
              document: vi.fn(() => Promise.resolve(TWO_VOICES)),
              observeCloseRequest: vi.fn(
                () =>
                  new Promise<() => void>((r) => {
                    resolve = r;
                  }),
              ),
              observeTranslationProgress: vi.fn(() => Promise.resolve(unlistenProgress)),
            },
          },
          { provide: Modal, useValue: { confirm: vi.fn() } },
          { provide: Snackbar, useValue: { error: vi.fn() } },
          {
            provide: ActivatedRoute,
            useValue: { snapshot: { paramMap: convertToParamMap({ id: '3' }) } },
          },
        ],
      });
      const fixture = TestBed.createComponent(Filedoc);
      fixture.destroy();

      resolve(unlistenClose);
      await settle(fixture);

      expect(unlistenClose).toHaveBeenCalledOnce();
      expect(unlistenProgress).toHaveBeenCalledOnce();
    });
  });

  describe('la traduction', () => {
    it('propose « Langue d’origine » puis les SIX langues, par ordre alphabétique', async () => {
      // ⚠️ Ni néerlandais ni turc : hors périmètre depuis leur mesure. Et l'ordre suit le nom
      // TRADUIT, pas le code — il change donc avec la langue de l'interface.
      harness();
      const fixture = await render();

      expect(entries(fixture, 'translate')).toEqual([
        "Langue d'origine",
        'Allemand',
        'Anglais',
        'Espagnol',
        'Français',
        'Italien',
        'Portugais',
      ]);
    });

    it('remplace le texte affiché', async () => {
      const { transcription } = harness();
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);

      expect(transcription.translate).toHaveBeenCalledExactlyOnceWith('filedoc-3', 'de');
      expect(hostOf(fixture).querySelector('.cr-p')?.textContent?.trim()).toBe(
        'Willkommen zu dieser Folge.',
      );
    });

    /**
     * ⚠️⚠️ **LA TRADUCTION EST LA SEULE OPÉRATION QUI RAPPORTE SON AVANCÉE** : elle boucle tour
     * par tour, et le backend en dit la part faite. Une barre indéterminée ici serait une
     * information qu'on a et qu'on cache.
     */
    it('couvre la fenêtre d’un voile qui suit l’avancée réelle', async () => {
      let settleWork: (outcome: TranscriptTranslation) => void = () => undefined;
      const { reportProgress } = harness({
        translate: () => new Promise<TranscriptTranslation>((resolve) => (settleWork = resolve)),
      });
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);
      expect(hostOf(fixture).querySelector('app-doc-overlay .bar.indeterminate')).toBeNull();
      expect(percentShown(fixture)).toBe('0');

      reportProgress(37);
      await settle(fixture);
      expect(percentShown(fixture)).toBe('37');
      expect(hostOf(fixture).querySelector('app-doc-overlay .percent')).not.toBeNull();

      settleWork(TRANSLATED);
      await settle(fixture);
      expect(hostOf(fixture).querySelector('app-doc-overlay')).toBeNull();
    });

    it('s’abonne à l’avancée de SON document, dès l’ouverture de la fenêtre', async () => {
      // ⚠️ L'abonnement précède la première traduction : posé au clic, il manquerait les
      // premières avancées. Et il nomme le document — un évènement Tauri est diffusé à toutes
      // les fenêtres.
      const { transcription } = harness();
      await render();

      expect(transcription.observeTranslationProgress).toHaveBeenCalledOnce();
      expect(transcription.observeTranslationProgress.mock.calls[0]?.[0]).toBe('filedoc-3');
    });

    it('repart de zéro à la traduction suivante', async () => {
      // Gardée, la barre afficherait le pourcentage de la précédente et la nouvelle paraîtrait
      // presque finie avant d'avoir commencé.
      let settleWork: (outcome: TranscriptTranslation) => void = () => undefined;
      const { reportProgress } = harness({
        translate: () => new Promise<TranscriptTranslation>((resolve) => (settleWork = resolve)),
      });
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);
      reportProgress(80);
      settleWork(TRANSLATED);
      await settle(fixture);

      pick(fixture, 'translate', 'Italien');
      await settle(fixture);

      expect(percentShown(fixture)).toBe('0');
    });

    it('n’affiche aucun pourcentage sur les opérations qui n’en rapportent pas', async () => {
      // ⚠️ La copie n'émet rien : un pourcentage y serait inventé.
      let settleWork: () => void = () => undefined;
      const { reportProgress } = harness({
        copy: () => new Promise<void>((resolve) => (settleWork = resolve)),
      });
      const fixture = await render();

      pick(fixture, 'export', 'Copier (presse-papier)');
      await settle(fixture);
      reportProgress(50);
      await settle(fixture);

      expect(hostOf(fixture).querySelector('app-doc-overlay .bar.indeterminate')).not.toBeNull();
      expect(percentShown(fixture)).toBeNull();

      settleWork();
      await settle(fixture);
    });

    it('revient à la langue d’origine sans rien demander au backend', async () => {
      const { transcription } = harness();
      const fixture = await render();
      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);
      transcription.translate.mockClear();

      pick(fixture, 'translate', "Langue d'origine");
      await settle(fixture);

      expect(transcription.translate).not.toHaveBeenCalled();
      expect(hostOf(fixture).querySelector('.cr-p')?.textContent?.trim()).toBe(
        'Bienvenue dans cet épisode.',
      );
    });

    it('dit une paire absente en INFORMATION, et rend au menu la langue qu’il affichait', async () => {
      // ⚠️⚠️ Ce n'est pas une panne : le backend rend un succès qui dit « je n'ai pas traduit ».
      // Une snackbar d'erreur ferait douter l'utilisateur de sa machine.
      const { snackbar } = harness({
        translate: () => Promise.resolve({ kind: 'pairMissing', source: 'fr', target: 'de' }),
      });
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);

      expect(snackbar.info).toHaveBeenCalledOnce();
      expect(snackbar.error).not.toHaveBeenCalled();
      expect(shows(fixture, 'translate')).toBe("Langue d'origine");
    });

    it('dit une paire non prise en charge, et rend le menu de la même façon', async () => {
      const { snackbar } = harness({
        translate: () => Promise.resolve({ kind: 'pairUnsupported', source: 'fr', target: 'it' }),
      });
      const fixture = await render();

      pick(fixture, 'translate', 'Italien');
      await settle(fixture);

      expect(snackbar.info).toHaveBeenCalledOnce();
      expect(shows(fixture, 'translate')).toBe("Langue d'origine");
    });

    it('propose l’arrêt, et à la traduction SEULE', async () => {
      // ⚠️⚠️ C'est la seule opération qu'on sache interrompre : `cancel_document_translation`
      // lève un drapeau que la boucle relit à chaque cran. La ré-analyse, l'export, la copie et
      // la fermeture n'ont aucune commande d'arrêt — leur « Annuler » serait un mensonge.
      let settleWork: (outcome: TranscriptTranslation) => void = () => undefined;
      harness({
        translate: () => new Promise<TranscriptTranslation>((resolve) => (settleWork = resolve)),
      });
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);

      expect(overlay(fixture)?.cancellable()).toBe(true);

      settleWork(TRANSLATED);
      await settle(fixture);
    });

    it('transmet la demande d’arrêt au backend, en nommant son document', async () => {
      let settleWork: (outcome: TranscriptTranslation) => void = () => undefined;
      const { transcription } = harness({
        translate: () => new Promise<TranscriptTranslation>((resolve) => (settleWork = resolve)),
      });
      const fixture = await render();
      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);

      overlay(fixture)?.cancelled.emit();
      await settle(fixture);

      expect(transcription.cancelTranslation).toHaveBeenCalledExactlyOnceWith('filedoc-3');

      settleWork({ kind: 'cancelled' });
      await settle(fixture);
    });

    it('rend le menu à sa langue et ne dit RIEN quand l’arrêt a eu lieu', async () => {
      // ⚠️⚠️ Annuler n'est pas un échec, et ce n'est pas non plus une information à donner :
      // l'utilisateur vient de le demander. Ni snackbar rouge, ni snackbar bleue.
      const { snackbar } = harness({ translate: () => Promise.resolve({ kind: 'cancelled' }) });
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);

      expect(shows(fixture, 'translate')).toBe("Langue d'origine");
      expect(snackbar.error).not.toHaveBeenCalled();
      expect(snackbar.info).not.toHaveBeenCalled();
      expect(hostOf(fixture).querySelector('app-doc-overlay')).toBeNull();
      expect(hostOf(fixture).querySelector('.cr-p')?.textContent?.trim()).toBe(
        'Bienvenue dans cet épisode.',
      );
    });

    it('garde à l’écran la traduction précédente quand la suivante est annulée', async () => {
      // ⚠️ On jette ce qui a été traduit à moitié — mais pas ce qui l'avait été en entier avant.
      const outcomes: TranscriptTranslation[] = [TRANSLATED, { kind: 'cancelled' }];
      harness({ translate: () => Promise.resolve(outcomes.shift() ?? TRANSLATED) });
      const fixture = await render();
      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);

      pick(fixture, 'translate', 'Italien');
      await settle(fixture);

      expect(shows(fixture, 'translate')).toBe('Allemand');
      expect(hostOf(fixture).querySelector('.cr-p')?.textContent?.trim()).toBe(
        'Willkommen zu dieser Folge.',
      );
    });

    it('n’ajoute rien à un échec, qui parle déjà de lui-même', async () => {
      const { snackbar } = harness({
        translate: () => Promise.reject({ kind: 'native', message: 'boum' }),
      });
      const fixture = await render();

      pick(fixture, 'translate', 'Allemand');
      await settle(fixture);
      await settle(fixture);

      expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('boum');
      expect(snackbar.info).not.toHaveBeenCalled();
      expect(shows(fixture, 'translate')).toBe("Langue d'origine");
    });
  });

  describe('l’export', () => {
    it('offre les six entrées de la maquette, le presse-papiers en tête', async () => {
      harness();
      const fixture = await render();

      // ⚠️ **« Exporter » n'est PAS une ligne du menu** : c'est le libellé de tête, que le
      // déclencheur garde entre deux actions. Une commande, pas un champ.
      expect(shows(fixture, 'export')).toBe('Exporter');
      expect(entries(fixture, 'export')).toEqual([
        'Copier (presse-papier)',
        'CSV (.csv)',
        'JSON (.json)',
        'Markdown (.md)',
        'PDF (.pdf)',
        'Sous-titres (.srt)',
        'Sous-titres (.vtt)',
        'Texte (.txt)',
        'Word (.docx)',
      ]);
    });

    it('ne propose pas de sous-titres quand il n’y a pas un mot à horodater', async () => {
      // ⚠️ Un `.srt` sans réplique est un fichier que le lecteur accepte et qui ne montre rien —
      // pire qu'une absence, l'utilisateur croit avoir exporté.
      harness({ document: () => Promise.resolve(documentWith([])) });
      const fixture = await render();

      expect(entries(fixture, 'export')).not.toContain('Sous-titres (.srt)');
      expect(entries(fixture, 'export')).not.toContain('Sous-titres (.vtt)');
      expect(entries(fixture, 'export')).toContain('Markdown (.md)');
    });

    it('copie le document, et le dit', async () => {
      const { transcription, snackbar } = harness();
      const fixture = await render();

      pick(fixture, 'export', 'Copier (presse-papier)');
      await settle(fixture);

      expect(transcription.copy).toHaveBeenCalledExactlyOnceWith({ id: 'filedoc-3' });
      expect(snackbar.success).toHaveBeenCalledOnce();
    });

    it('écrit à l’emplacement choisi, avec une date localisée par `Intl`', async () => {
      const { transcription, snackbar } = harness();
      const fixture = await render();

      pick(fixture, 'export', 'Markdown (.md)');
      await settle(fixture);

      const date = new Intl.DateTimeFormat('fr', { dateStyle: 'medium' }).format(new Date());
      expect(transcription.chooseExportPath).toHaveBeenCalledExactlyOnceWith(
        'filedoc-3',
        date,
        'markdown',
      );
      expect(transcription.export).toHaveBeenCalledExactlyOnceWith({
        id: 'filedoc-3',
        format: 'markdown',
      });
      expect(snackbar.success).toHaveBeenCalledOnce();
    });

    it('date le fichier proposé dans la langue de l’interface, non dans celle du système', async () => {
      // ⚠️ `Intl` sans locale rend celle de l'environnement — donc celle de macOS, jamais celle
      // du bundle chargé. Sur un Mac en anglais, une interface allemande proposerait
      // « Aug 16, 2026 » dans un nom de fichier. La langue de l'interface est celle que porte
      // `LOCALE_ID`, et elle seule.
      const { transcription } = harness({ locale: 'de' });
      const fixture = await render();

      pick(fixture, 'export', 'Markdown (.md)');
      await settle(fixture);

      const date = new Intl.DateTimeFormat('de', { dateStyle: 'medium' }).format(new Date());
      expect(transcription.chooseExportPath).toHaveBeenCalledExactlyOnceWith(
        'filedoc-3',
        date,
        'markdown',
      );
    });

    it('ne dit rien quand l’utilisateur renonce dans « Enregistrer sous »', async () => {
      const { transcription, snackbar } = harness({
        chooseExportPath: () => Promise.resolve(false),
      });
      const fixture = await render();

      pick(fixture, 'export', 'PDF (.pdf)');
      await settle(fixture);

      expect(transcription.export).not.toHaveBeenCalled();
      expect(snackbar.success).not.toHaveBeenCalled();
      expect(snackbar.error).not.toHaveBeenCalled();
    });

    it('ne se félicite pas d’une écriture qui a échoué', async () => {
      const { snackbar } = harness({
        exportDocument: () => Promise.reject({ kind: 'io', message: 'disque plein' }),
      });
      const fixture = await render();

      pick(fixture, 'export', 'CSV (.csv)');
      await settle(fixture);
      await settle(fixture);

      expect(snackbar.success).not.toHaveBeenCalled();
      expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('disque plein');
    });

    it('annonce ce qu’elle fait pendant la copie, puis pendant l’écriture', async () => {
      // Le voile nomme l'opération : « Copie… » et « Export… » ne se confondent pas, et aucun des
      // deux ne rapporte d'avancée — la barre reste indéterminée.
      let finish: () => void = () => undefined;
      const first = harness({ copy: () => new Promise<void>((resolve) => (finish = resolve)) });
      const fixture = await render();

      pick(fixture, 'export', 'Copier (presse-papier)');
      await settle(fixture);
      expect(hostOf(fixture).querySelector('app-doc-overlay .label')?.textContent?.trim()).toBe(
        'Copie…',
      );
      finish();
      await settle(fixture);
      expect(first.snackbar.success).toHaveBeenCalledOnce();

      const second = harness({
        exportDocument: () => new Promise<void>((resolve) => (finish = resolve)),
      });
      const writing = await render();

      pick(writing, 'export', 'PDF (.pdf)');
      await settle(writing);
      expect(hostOf(writing).querySelector('app-doc-overlay .label')?.textContent?.trim()).toBe(
        'Export…',
      );
      finish();
      await settle(writing);
      expect(second.snackbar.success).toHaveBeenCalledOnce();
    });

    it('ne se félicite pas d’une copie qui a échoué', async () => {
      const { snackbar } = harness({
        copy: () => Promise.reject({ kind: 'native', message: 'presse-papiers refusé' }),
      });
      const fixture = await render();

      pick(fixture, 'export', 'Copier (presse-papier)');
      await settle(fixture);

      expect(snackbar.success).not.toHaveBeenCalled();
      expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('presse-papiers refusé');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ⚠️⚠️ **LES DEUX CHAMPS DE LOCUTEURS NE PARTENT PLUS, ET RUST LES REFUSERAIT.**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * Cette fenêtre composait une table de libellés — « Locuteur 1 » ne se fabrique pas côté
     * Rust, c'est du texte localisé au build — et transmettait la bascule d'affichage. Les deux
     * champs sont partis le 2026-08-06, et le backend les rejette désormais bruyamment
     * (`deny_unknown_fields`) : les renvoyer ferait échouer l'export au lieu de l'ignorer.
     */
    it('n’envoie ni libellés de locuteurs ni bascule d’affichage', async () => {
      const { transcription } = harness();
      const fixture = await render();

      pick(fixture, 'export', 'Copier (presse-papier)');
      await settle(fixture);

      const request = transcription.copy.mock.calls.at(0)?.at(0) as unknown as Record<
        string,
        unknown
      >;
      expect(Object.keys(request)).toEqual(['id', 'paragraphs']);
      expect(request['labels']).toBeUndefined();
      expect(request['speakersHidden']).toBeUndefined();
    });

    /**
     * ⚠️ **Aucun geste ne peut produire `''`** : le libellé de tête n'entre pas dans la liste, et
     * `ComboSelect` s'en porte garant. La garde tient la promesse du **type** — `''` fait partie
     * d'`ExportChoice` parce que c'est la valeur portée entre deux actions —, d'où une émission
     * forcée : c'est le seul moyen d'éprouver ce que le DOM ne peut plus produire.
     */
    it('le libellé de tête n’est pas un format', async () => {
      const { transcription } = harness();
      const fixture = await render();

      fixture.debugElement
        .query(By.css('app-combo-select.export'))
        .componentInstance.valueChange.emit('');
      await settle(fixture);

      expect(transcription.copy).not.toHaveBeenCalled();
      expect(transcription.chooseExportPath).not.toHaveBeenCalled();
    });
  });

  it('lit le document `filedoc-` même sans paramètre de route', async () => {
    // Une URL sans segment ne doit pas fabriquer un `undefined` : le backend refusera un
    // identifiant inconnu, et l'erreur se dira normalement.
    const transcription = {
      document: vi.fn(() => Promise.resolve(null)),
      observeCloseRequest: vi.fn(() => Promise.resolve(() => undefined)),
      observeTranslationProgress: vi.fn(() => Promise.resolve(() => undefined)),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Transcription, useValue: transcription },
        { provide: Modal, useValue: { confirm: vi.fn() } },
        { provide: Snackbar, useValue: { error: vi.fn() } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({}) } } },
      ],
    });
    await render();

    expect(transcription.document).toHaveBeenCalledExactlyOnceWith('filedoc-');
  });

  it('n’a aucune violation d’accessibilité, document affiché comme pendant un travail', async () => {
    let settleWork: () => void = () => undefined;
    harness({ copy: () => new Promise<void>((resolve) => (settleWork = resolve)) });
    const fixture = await render();
    await expectNoAxeViolations(fixture.nativeElement);

    pick(fixture, 'export', 'Copier (presse-papier)');
    await settle(fixture);
    await expectNoAxeViolations(fixture.nativeElement);

    settleWork();
    await settle(fixture);
  });
});
