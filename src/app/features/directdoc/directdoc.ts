import {
  Component,
  LOCALE_ID,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Header } from '../../shared/components/header/header';
import { DocOverlay } from '../../shared/components/doc-overlay/doc-overlay';
import type { TranscriptLine } from '../filedoc/components/transcript-view/transcript-view';
import { DirectRecording } from './components/direct-recording/direct-recording';
import { DirectDocument } from './components/direct-document/direct-document';
import type { DirectExport, DirectTranslation } from './components/direct-document/direct-document';
import { DirectStore } from '../../core/store/direct/direct.store';
import { DirectdocStore } from '../../core/store/directdoc/directdoc.store';
import { ReportPromptsStore } from '../../core/store/report-prompts/report-prompts.store';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { Live, liveTitle, reportTypeOptions, stepLabel } from '../../core/services/live/live';
import { Modal } from '../../core/services/modal/modal';
import { RecordingSound } from '../../core/services/overlay/recording-sound';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { toAppError } from '../../core/models/app-error';
import { LANGUAGE_ADJECTIVES } from '../../core/models/language';
import { LIVE_REPORT_TYPES } from '../../core/models/settings';
import type { Language } from '../../core/models/settings';
import type {
  LiveDocument,
  LiveProgress,
  LiveStream,
  ReportKind,
} from '../../core/services/bridge/live/live.bridge';
import { liveClock } from '../../core/services/live/live-clock';
import { LIVE_ID_PREFIX, exportDate, windowDocumentId } from '../../core/models/document-window';
import { drainErrors } from '../../core/services/snackbar/drain-errors';
import { subscriptions } from '../../core/services/bridge/subscriptions';

/**
 * Les formes que le backend accepte : les types livrés, sans « Pas de compte rendu » ni le
 * `'custom'` que seul un prompt nommé peut demander.
 */
const DELIVERED_KINDS: readonly string[] = LIVE_REPORT_TYPES.filter(
  (type) => type !== 'none' && type !== 'custom',
);

/**
 * La fenêtre Direct : l'enregistrement, puis le transcript, puis le compte rendu. Elle *est* la
 * session — la fermer l'arrête, d'où la question posée pendant l'enregistrement et pas après. Son
 * état vit dans {@link DirectdocStore} ; restent ici les abonnements, battements et libellés.
 *
 * @remarks
 * - ⚠️ La consolidation ne se lance pas d'ici : fermer cette fenêtre tue l'interface qui aurait dû
 *   l'enchaîner. Le backend s'en charge, annonce le résultat et sa progression ; on écoute.
 * - ⚠️ `DirectStore` se réhydrate depuis le backend (`sync`) : chaque fenêtre porte sa propre
 *   instance d'Angular, et celle-ci naîtrait sinon en croyant qu'aucune session ne tourne.
 */
@Component({
  selector: 'app-directdoc',
  imports: [Header, DocOverlay, DirectRecording, DirectDocument],
  templateUrl: './directdoc.html',
  styleUrl: './directdoc.scss',
})
export class Directdoc {
  private readonly live = inject(Live);
  /** Le magasin de la session en cours, partagé avec l'écran Direct. */
  private readonly session = inject(DirectStore);
  /** Le magasin de cette fenêtre-là : son document, ses attentes, ses traductions. */
  private readonly doc = inject(DirectdocStore);
  private readonly settings = inject(SettingsStore);
  /** Les prompts nommés, écrits dans les Options et partagés par toutes les fenêtres. */
  private readonly prompts = inject(ReportPromptsStore);
  private readonly modal = inject(Modal);
  private readonly sound = inject(RecordingSound);
  private readonly snackbar = inject(Snackbar);
  private readonly locale = inject(LOCALE_ID);
  private readonly subs = subscriptions();

  /** Le minuteur de la session, partagé avec l'écran Direct. */
  private readonly clock = liveClock(() => this.session.startedAtMs());

  /** L'identifiant du document affiché — celui de la fenêtre, pas le segment d'URL. */
  private readonly id = windowDocumentId(
    LIVE_ID_PREFIX,
    inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '',
  );

  /** Depuis combien de temps la session enregistre. */
  protected readonly elapsedSeconds = this.clock.elapsedSeconds;
  /** Le niveau combiné des deux flux, de 0 à 1 — ce que le VU-mètre affiche. */
  protected readonly level = signal(0);

  protected readonly recording = this.doc.recording;
  protected readonly working = this.doc.working;
  protected readonly veiled = this.doc.veiled;
  protected readonly cancellable = this.doc.cancellable;
  protected readonly progress = this.doc.progress;
  protected readonly sections = this.doc.sections;
  protected readonly transcriptTarget = this.doc.transcriptTarget;
  protected readonly reportTarget = this.doc.reportTarget;
  protected readonly translationTarget = this.doc.translationTarget;

  /** Les entrées du menu de compte rendu, prompts nommés compris. */
  protected readonly kinds = computed(() => reportTypeOptions(this.prompts.prompts()));

  /**
   * Ce que les réglages proposent : le numéro du prompt choisi, ou le type livré.
   *
   * @remarks
   * ⚠️ Un identifiant qui ne désigne plus rien retombe sur « Pas de compte rendu » : le réglage
   * survit à la suppression du prompt dans l'autre fenêtre, et le menu montrerait sinon une
   * valeur absente de sa propre liste.
   */
  private readonly proposedKind = computed(() => {
    const settings = this.settings.settings();
    if (settings.liveReportType !== 'custom') {
      return settings.liveReportType as string;
    }
    const chosen = this.prompts.byId(settings.liveReportPromptId);
    return chosen === undefined ? 'none' : String(chosen.id);
  });

  /**
   * La forme affichée par le sélecteur de la fenêtre. Elle part de ce qu'Options ▸ Direct
   * propose, le défaut étant « rien » : le réglage propose, le choix dans ce menu déclenche.
   *
   * @remarks
   * ⚠️ Un `linkedSignal` et non un `computed` : le réglage donne la valeur de départ, puis
   * l'utilisateur en est maître. Un `computed` lui reprendrait son choix au premier changement de
   * réglage — depuis l'autre fenêtre, qui partage le même fichier.
   */
  protected readonly kind = linkedSignal<string, string>({
    source: () => this.proposedKind(),
    computation: (proposed) => proposed,
  });

  /** Une traduction est-elle en vol ? La file est **séquentielle** — voir `drainTranslations`. */
  private translating = false;

  /**
   * Les flux dont on a déjà annoncé le silence.
   *
   * @remarks
   * ⚠️ La fenêtre garde cette trace, pas le magasin : le moteur peut échouer plusieurs fois de
   * suite, et répéter la snackbar en ferait un mur devant l'écran.
   */
  private readonly announcedSilence = new Set<LiveStream>();

  protected readonly finalisingLabel = $localize`:@@direct.document.finalising:Finalisation de la session…`;
  protected readonly workLabel = $localize`:@@direct.document.working:Compte rendu en cours…`;

  /**
   * Le libellé du voile : il nomme l'étape dès que le backend en a franchi une, un
   * « Chargement… » unique laissant croire à un seul et même traitement.
   *
   * @remarks
   * ⚠️ Les deux libellés génériques couvrent l'intervalle entre le lever du voile et le premier
   * évènement. Sans eux, une fraction de seconde — ou un évènement perdu — donnerait un voile
   * sans texte.
   */
  protected readonly veilLabel = computed(() => {
    // ⚠️ La traduction passe avant l'étape : elle ne franchit pas d'étapes — elle rapporte un
    // pourcentage —, et un libellé d'étape resté de la génération précédente s'afficherait sinon
    // au-dessus de sa barre.
    const translating = this.doc.translatingContent();
    if (translating !== null) {
      return translating === 'report'
        ? $localize`:@@direct.document.translatingReport:Traduction du compte rendu…`
        : $localize`:@@direct.document.translatingTranscript:Traduction du transcript…`;
    }
    const step = this.doc.step();
    if (step !== null) {
      return stepLabel(step.step);
    }
    return this.doc.finalising() ? this.finalisingLabel : this.workLabel;
  });

  /**
   * Le titre affiché — celui du modèle, ou le repli daté.
   *
   * @remarks
   * - ⚠️ Daté du début de la session, jamais de sa fin : il s'affiche pendant l'enregistrement et
   *   changerait sinon sous les yeux de l'utilisateur au moment de l'arrêt.
   * - ⚠️ Le repli se compose ici, dans la langue de l'interface : le backend ne connaît ni la
   *   langue de l'écran ni le format de date du lieu.
   */
  protected readonly title = computed(() => {
    const found = this.doc.document();
    return found === null ? '' : liveTitle(found.title, new Date(found.startedAtMs), this.locale);
  });

  /**
   * La ligne d'informations, qui ne dit pas la même chose selon l'état : pendant l'enregistrement
   * ce qu'on capte, après quand la session a eu lieu.
   *
   * @remarks
   * ⚠️ Taire le micro pendant qu'on enregistre laisserait passer une session entière sans la voix
   * de l'utilisateur sans que rien ne le dise ; annoncer la date d'une session en cours, elle,
   * n'apprendrait rien.
   */
  protected readonly meta = computed(() => {
    const found = this.doc.document();
    if (found === null) {
      return '';
    }
    if (this.recording()) {
      return this.session.recordingWithMicrophone()
        ? $localize`:@@direct.document.metaWithMic:${found.sourceName}:name: · avec mon micro`
        : $localize`:@@direct.document.metaNoMic:${found.sourceName}:name: · sans micro`;
    }
    const when = new Intl.DateTimeFormat(this.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(found.startedAtMs));
    return `${when} · ${found.sourceName}`;
  });

  /**
   * Le transcript consolidé, prêt pour la vue partagée : du texte sans aucune étiquette,
   * exactement comme celui d'un fichier.
   */
  protected readonly lines = computed<readonly TranscriptLine[]>(() => {
    // ⚠️ La traduction remplace le texte et rien d'autre : elle rend autant de paragraphes que
    // l'original, aux mêmes bornes de temps — ce sont celles de l'audio.
    const translated = this.doc.transcriptTranslation();
    if (translated !== null) {
      return translated.map((paragraph) => ({ text: paragraph.text }));
    }
    return (this.doc.document()?.transcript.paragraphs ?? []).map((paragraph) => ({
      text: paragraph.words.map((word) => word.text).join(' '),
    }));
  });

  /**
   * La langue parlée, telle que l'en-tête de colonne l'attend.
   *
   * @remarks
   * ⚠️ `null` plutôt qu'une chaîne vide : une fenêtre ouverte avant la lecture du document n'a
   * aucune langue, et `LANGUAGE_NAMES['']` rendrait `undefined` dans un en-tête.
   */
  protected readonly spokenName = computed(() => {
    const spoken = this.doc.spokenLanguage();
    return spoken.length === 0 ? null : (spoken as Language);
  });

  /** Les segments acquis de la session en cours. */
  protected readonly liveLines = computed(() => this.session.transcript());
  /** La traduction de chaque segment acquis, par identifiant. */
  protected readonly translations = computed(() => this.session.translations());
  /** Ce qui est en train d'être dit, par flux. */
  protected readonly pending = computed(() => this.session.pending());
  /** L'arrêt est-il en vol ? Le bouton refuse alors un second clic. */
  protected readonly stopping = computed(() => this.session.busy());

  constructor() {
    void this.open();

    // ⚠️ Le chrono suit l'état, pas le clic : cette fenêtre peut naître au milieu d'une session —
    // rouverte, ou simplement lente à s'afficher — et il doit alors repartir tout seul.
    effect(() => {
      if (this.recording()) {
        this.clock.start();
      } else {
        this.clock.stop();
      }
    });

    // ⚠️ Un flux muet se dit en snackbar, et le message doit porter deux choses : ce flux ne sera
    // pas transcrit, et l'enregistrement continue. Sans la seconde, l'utilisateur arrêterait sa
    // session en croyant tout perdu. C'est cette fenêtre qui le dit, étant celle qui montre le
    // transcript et donc la seule à pouvoir en expliquer un trou.
    effect(() => {
      for (const silent of this.session.silentStreams()) {
        if (this.announcedSilence.has(silent.stream)) {
          continue;
        }
        this.announcedSilence.add(silent.stream);
        this.snackbar.error(this.silenceMessage(silent));
      }
    });

    drainErrors(this.session);
    drainErrors(this.doc);

    // ⚠️ Les prompts nommés aussi : c'est la seule fenêtre qui les charge sans les Options, et
    // la reprise de l'ancien prompt unique s'y joue. Sans ce drain, son échec — le seul de
    // l'application à pouvoir faire perdre un texte écrit — ne se dirait nulle part.
    drainErrors(this.prompts);

    // ⚠️ La traduction suit les segments acquis, et rien d'autre : l'effet ne dépend que de
    // `liveLines()`, jamais de `pending()` — traduire une hypothèse rendrait une traduction qui se
    // réécrit toute seule.
    effect(() => {
      this.liveLines();
      void this.drainTranslations();
    });
  }

  /** Arrête la session, puis sonne. */
  protected async stop(): Promise<void> {
    if (!this.recording()) {
      return;
    }
    this.doc.finalise();
    await this.session.stop();
    this.doc.stopRecording();
    this.session.dropPendingSpeech();
    this.chime();
  }

  /** Renonce au travail en cours — une génération, ou une traduction. */
  protected cancel(): void {
    this.doc.cancel();
  }

  /**
   * L'utilisateur a désigné une langue pour la vue qu'il regarde.
   *
   * @remarks
   * ⚠️ Rien n'est attendu ici : le gabarit ne peut pas suivre une promesse, et le voile dit déjà
   * que la fenêtre travaille.
   */
  protected translateTo(request: DirectTranslation): void {
    void this.runTranslation(request);
  }

  /**
   * Dit ce qu'il faut dire d'une traduction qui n'a pas eu lieu.
   *
   * @remarks
   * ⚠️ Une annulation ne se dit pas du tout ; une paire absente se dit en information, pas en
   * erreur. On ne nomme jamais la paire, seulement la langue cible.
   */
  private async runTranslation({ target, content }: DirectTranslation): Promise<void> {
    const outcome = await this.doc.translate(content, target);
    if (target === 'none') {
      return;
    }
    if (outcome === 'pairMissing') {
      this.snackbar.info(
        $localize`:@@translation.pairMissing:La traduction vers la langue ${LANGUAGE_ADJECTIVES[target]}:name: n'est pas installée. Ajoutez-la dans Options ▸ Langues.`,
      );
    } else if (outcome === 'pairUnsupported') {
      this.snackbar.info(
        $localize`:@@translation.pairUnsupported:La traduction vers la langue ${LANGUAGE_ADJECTIVES[target]}:name: n'est pas prise en charge.`,
      );
    }
  }

  /**
   * L'utilisateur a désigné une forme. Choisir est le geste : il n'y a pas de bouton « Générer ».
   *
   * @remarks
   * ⚠️ Toute sélection relance, y compris celle déjà affichée : c'est ce qui remplace le bouton
   * disparu. Aucune égalité ne filtre ici.
   */
  protected chooseKind(value: string): void {
    this.kind.set(value);
    void this.generate(value);
  }

  /**
   * Passe au magasin le type demandé, et le texte du prompt quand c'en est un.
   *
   * @remarks
   * ⚠️ Seul un type livré part au backend : « Pas de compte rendu » est une réponse de
   * l'interface, et le numéro d'un prompt supprimé dans l'autre fenêtre entre l'ouverture du menu
   * et le clic n'en désigne plus aucun. Rust refuserait l'un comme l'autre à la
   * désérialisation — c'est-à-dire au pire moment.
   */
  private async generate(value: string): Promise<void> {
    const prompt = this.prompts.byId(Number(value));
    if (prompt !== undefined) {
      await this.doc.generate('custom', prompt.prompt);
      return;
    }
    if (DELIVERED_KINDS.includes(value)) {
      await this.doc.generate(value as ReportKind, null);
    }
  }

  /**
   * Le menu « Exporter » vient d'être actionné.
   *
   * @remarks
   * ⚠️ Rien n'est attendu ici : le gabarit ne peut pas suivre une promesse, et `working()` dit
   * déjà que la fenêtre est occupée.
   */
  protected pickExport(request: DirectExport): void {
    void this.runExport(request);
  }

  /**
   * Annonce l'export réussi.
   *
   * @remarks
   * ⚠️ Le titre part résolu : Rust ne fabrique aucun texte localisé, et une session sans titre
   * porte `null` — le laisser relire nommerait tous ses exports pareil.
   */
  private async runExport({ choice, content }: DirectExport): Promise<void> {
    const title = this.title();
    if (choice === 'copy') {
      if (await this.doc.copy(content, title)) {
        this.snackbar.success(
          content === 'report'
            ? $localize`:@@directdoc.export.copiedReport:Compte rendu copié dans le presse-papiers.`
            : $localize`:@@directdoc.export.copiedTranscript:Transcript copié dans le presse-papiers.`,
        );
      }
      return;
    }
    if (await this.doc.exportTo(content, choice, title, exportDate(this.locale))) {
      this.snackbar.success($localize`:@@directdoc.export.written:Session exportée.`);
    }
  }

  /** Renomme la session. */
  protected async rename(title: string): Promise<void> {
    await this.doc.rename(title);
  }

  /**
   * Ce qui se passe quand on demande la fermeture de la fenêtre : la question, puis l'arrêt.
   *
   * @remarks
   * - ⚠️ La question dit ce qui va se passer et son refus dit ce qui continue : devant deux issues
   *   qui font chacune quelque chose, « Annuler » ne désignerait rien.
   * - ⚠️ Elle annonce que le transcript est conservé, faute de quoi fermer ressemble à une perte,
   *   et ne s'ouvre que pendant l'enregistrement — après, il n'y a plus rien à interrompre.
   */
  protected async requestClose(): Promise<void> {
    if (this.recording()) {
      const confirmed = await this.modal.confirm({
        heading: $localize`:@@direct.close.title:Arrêter la session ?`,
        message: $localize`:@@direct.close.message:Fermer cette fenêtre met fin à la session en cours. Tout ce qui a déjà été transcrit est conservé.`,
        confirmLabel: $localize`:@@common.stop:Arrêter`,
        cancelLabel: $localize`:@@direct.close.cancel:Continuer la session`,
      });
      if (!confirmed) {
        return;
      }
      await this.stop();
    }
    await this.doc.close();
  }

  /**
   * Le premier travail de la fenêtre : s'abonner, se mettre à l'heure de la session, puis lire son
   * document.
   *
   * @remarks
   * ⚠️ L'abonnement au transcript précède tout le reste : le moteur émet dès le démarrage de la
   * capture et ne rejoue pas ce qui est passé — s'abonner après la lecture du document perdrait
   * les premiers mots.
   */
  private async open(): Promise<void> {
    await this.subscribe();
    void this.prompts.load();
    await this.session.sync();
    await this.doc.open(this.id);
  }

  /**
   * Branche les sept canaux : le transcript, l'arrêt, la consolidation, la progression des
   * travaux, celle d'une traduction, la croix et le niveau des flux.
   */
  private async subscribe(): Promise<void> {
    try {
      await this.subs.keep(this.live.onTranscript((event) => this.session.applyTranscript(event)));
      await this.subs.keep(this.live.onStopped((documentId) => this.stopped(documentId)));
      await this.subs.keep(this.live.onFinalised((document) => this.finalised(document)));
      await this.subs.keep(this.live.onProgress((progress) => this.progressed(progress)));
      // ⚠️ Posé à l'ouverture, pas au départ d'une traduction : le travail natif démarre dans la
      // foulée de la commande, et un abonnement posé après elle manquerait les premières avancées.
      // Le tenir pour la vie de la fenêtre supprime la course.
      await this.subs.keep(
        this.live.onTranslationProgress(this.id, (percent) =>
          this.doc.translationProgressed(percent),
        ),
      );
      await this.subs.keep(this.live.onCloseRequest(() => void this.requestClose()));
      // ⚠️ Posé pour la vie de la fenêtre, comme les autres : le backend bat la mesure dès le
      // démarrage du tap, et une fenêtre rouverte au milieu d'une session doit l'attraper en vol.
      await this.subs.keep(this.live.onLevel((level) => this.level.set(level)));
    } catch (error) {
      // Un abonnement qui échoue prive du direct, pas de l'enregistrement : l'audio est écrit quoi
      // qu'il arrive, et le transcript se refait depuis lui.
      this.snackbar.error(toAppError(error).message);
    }
  }

  /** La session s'est arrêtée — ici ou dans l'autre fenêtre. */
  private stopped(documentId: string): void {
    if (this.doc.stopped(documentId)) {
      this.session.stopped();
    }
  }

  /**
   * Ce qu'on dit d'un flux qui ne sera pas transcrit.
   *
   * @remarks
   * ⚠️ La raison rendue par le moteur est reprise telle quelle : c'est ce qui rend le message
   * actionnable, là où « la transcription a échoué » laisserait chercher.
   */
  private silenceMessage(silent: { stream: LiveStream; reason: string }): string {
    return silent.stream === 'microphone'
      ? $localize`:@@direct.transcript.micSilent:Votre micro ne sera pas transcrit (${silent.reason}:reason:). L'enregistrement continue.`
      : $localize`:@@direct.transcript.systemSilent:L'audio de la session ne sera pas transcrit (${silent.reason}:reason:). L'enregistrement continue.`;
  }

  /** Une étape de plus est franchie. */
  private progressed(progress: LiveProgress): void {
    this.doc.progressed(progress);
  }

  /** La consolidation est finie : le document complet arrive dans l'évènement. */
  private finalised(document: LiveDocument): void {
    this.doc.finalised(document);
  }

  /**
   * Joue le son de la fin de session, si son réglage l'autorise.
   *
   * @remarks
   * ⚠️ C'est ici que le réglage se lit, pas dans le service : les sons sont réglés par domaine, et
   * un service qui choisirait lui-même devrait savoir laquelle des deux fonctions tourne.
   */
  private chime(): void {
    this.sound.play('stop');
  }

  /**
   * Traduit les segments acquis qui ne le sont pas encore, un par un. Le moteur d'Apple traduit à
   * ~4,5 ms par caractère et n'aime pas les appels concurrents ; la file les sérialise et garde
   * l'ordre, une colonne qui se remplirait dans le désordre étant illisible.
   *
   * @remarks
   * ⚠️ Un échec ne se dit pas en snackbar : une paire absente produirait un message par segment,
   * un mur devant le transcript. Le paragraphe reste dans sa langue, ce qui est l'information —
   * une absence de traduction se voit, là où un transcript figé se lit comme une panne.
   */
  private async drainTranslations(): Promise<void> {
    const target = this.translationTarget();
    const source = this.doc.spokenLanguage();
    if (this.translating || target === null || source.length === 0) {
      return;
    }
    this.translating = true;
    try {
      // ⚠️ Relu à chaque tour, jamais capturé : des segments arrivent pendant qu'on traduit.
      for (;;) {
        const next = this.liveLines().find((line) => this.translations()[line.id] === undefined);
        if (next === undefined || !this.subs.alive()) {
          return;
        }
        const translated = await this.live.translate(next.text, source, target);
        // ⚠️ Un échec range quand même quelque chose : le texte d'origine. Sans cela, la file
        // buterait pour toujours sur le même segment et n'atteindrait jamais les suivants.
        this.session.translated(next.id, translated ?? next.text);
      }
    } catch {
      // Même raison : on n'annonce rien, et on laissera le prochain segment relancer la file.
    } finally {
      this.translating = false;
    }
  }
}
