import { Service, inject } from '@angular/core';
import type {
  AudioSource,
  LiveCopyRequest,
  LiveDocument,
  LiveExportRequest,
  LiveProgress,
  LiveSessionState,
  LiveStep,
  LiveStream,
  LiveTranscriptEvent,
  ReportKind,
  ReportPrompt,
  ReportTranslation,
  SessionSummary,
} from '../bridge/live/live.bridge';
import type { ExportFormat, TranscriptTranslation } from '../bridge/media/media.bridge';
// ⚠️ Le seul emprunt de ce service à un autre domaine : un nom d'évènement du backend, partagé
// par les deux sortes de fenêtres-documents. Le recopier ici donnerait deux littéraux que rien
// ne tient égaux.
import { listenToDocumentTranslation } from '../transcription/transcription';
import { LIVE_REPORT_TYPES, type LiveReportType } from '../../models/settings';
import { SystemBridge } from '../bridge/system/system.bridge';
import { LiveBridge } from '../bridge/live/live.bridge';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';
import { Invoke } from '../bridge/invoke/invoke';

/**
 * Ce que rend {@link Live.session} quand il n'y a pas de backend.
 *
 * @remarks
 * ⚠️ Un état au repos, jamais `null` : un écran qui décide quoi afficher n'a rien à faire d'un
 * troisième cas entre « ça enregistre » et « rien ne tourne » — la branche oubliée serait celle
 * du navigateur.
 */
const AT_REST: LiveSessionState = {
  phase: 'idle',
  documentId: null,
  startedAtMs: null,
  sourceName: null,
  withMicrophone: false,
};

/**
 * Une ligne du transcript en direct.
 *
 * @remarks
 * ⚠️ `stream` ne s'affiche nulle part : il est là pour la mécanique — une hypothèse remplace
 * celle de son propre flux, un `dropped` n'efface que le sien. Le transcript est du texte, sans
 * étiquette, pas même « Moi ».
 */
export interface LiveLine {
  /**
   * Une clé stable pour le rendu.
   *
   * @remarks
   * ⚠️ Ni l'index, ni le texte : l'index rejouerait tout le DOM à chaque ligne ajoutée, et le
   * texte se répète — deux lignes de même clé font s'effondrer le suivi.
   */
  readonly id: number;
  /** Le flux d'où vient le segment. Sert au remplacement des hypothèses, jamais à l'affichage. */
  readonly stream: LiveStream;
  /** Le texte du segment, seul ou en remplacement de l'hypothèse en cours du même flux. */
  readonly text: string;
  /**
   * Ce segment suit-il un silence ? L'écran y ouvre alors un nouveau paragraphe.
   *
   * @remarks
   * ⚠️ Décidé par le backend, qui seul a les horodatages. L'écran ne reçoit que du texte.
   */
  readonly paragraph: boolean;
}

/** La valeur du réglage qui dit « ne pas inclure de micro ». */
export const NO_MICROPHONE = 'none';

/** La valeur du pont qui dit « suis le micro système ». */
export const SYSTEM_MICROPHONE = 'default';

/**
 * La valeur du réglage, traduite dans le vocabulaire du pont.
 *
 * Exportée pour être éprouvée seule : ce sont les trois lignes qui décident si la voix de
 * l'utilisateur figure ou non dans son propre transcript.
 */
export function bridgeMicrophone(setting: string | null): string | null {
  if (setting === NO_MICROPHONE) {
    return null;
  }
  return setting ?? SYSTEM_MICROPHONE;
}

/**
 * Le titre à afficher pour une session terminée.
 *
 * Le défaut est la date et l'heure ; `proposed` ne porte que ce que l'utilisateur a écrit
 * lui-même. Exportée pour être éprouvée seule.
 *
 * @remarks
 * - ⚠️ L'heure fait partie du défaut, pas seulement la date : plusieurs sessions par jour est le
 *   cas courant, et deux « Session du 05/08/2026 » ne se distinguent pas.
 * - ⚠️ `Intl` décide de l'écriture : forcer un séparateur — « 16h12 » — casserait les cinq autres
 *   langues, où il n'existe pas. Un titre vide retombe sur le défaut, pas seulement un absent.
 */
export function liveTitle(proposed: string | null, endedAt: Date, locale?: string): string {
  const trimmed = proposed?.trim() ?? '';
  if (trimmed.length > 0) {
    return trimmed;
  }
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(endedAt);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(endedAt);
  return $localize`:@@direct.document.untitled:Session du ${date}:date: à ${time}:time:`;
}

/**
 * La seconde ligne d'une session dans l'historique : quand, et combien de temps.
 *
 * @remarks
 * - ⚠️ Datée de son début, comme partout ailleurs : une session de trois heures commencée hier
 *   soir appartient à hier soir, et la dater de sa fin la ferait changer de jour.
 * - ⚠️ Tout passe par `Intl`, durée comprise. Forcer le « 1 h 05 » de la maquette donnerait une
 *   durée française à une interface allemande.
 * - ⚠️ Les heures n'apparaissent qu'à partir d'une heure : « 0 h 48 min » se lirait comme une
 *   valeur manquante.
 */
export function sessionMeta(startedAtMs: number, endedAtMs: number, locale?: string): string {
  const started = new Date(startedAtMs);
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(started);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(started);

  const unit = (value: number, name: 'hour' | 'minute'): string =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(
      value,
    );
  const minutes = Math.max(0, Math.round((endedAtMs - startedAtMs) / 60_000));
  const duration =
    minutes < 60
      ? unit(minutes, 'minute')
      : `${unit(Math.floor(minutes / 60), 'hour')} ${unit(minutes % 60, 'minute')}`;

  return `${day} ${time} · ${duration}`;
}

/**
 * Un type livré, c'est-à-dire tout sauf `custom`.
 *
 * @remarks
 * ⚠️ `'custom'` reste un `ReportKind` que Rust attend et une valeur de réglage ; elle ne se
 * choisit simplement plus dans le menu, où l'on choisit un prompt nommé.
 */
type BuiltinReportType = Exclude<LiveReportType, 'custom'>;

/**
 * Comment chaque type de compte rendu se nomme à l'écran.
 *
 * Une seule table pour les trois écrans qui la montrent — l'écran déclencheur, Options ▸ Direct
 * et la fenêtre-session.
 *
 * @remarks
 * ⚠️ Ici et non dans `settings.ts` : le modèle dit ce qu'une valeur peut valoir, pas comment on
 * l'appelle. Même frontière qu'entre `LANGUAGES` et les noms de langues.
 */
const REPORT_LABELS: Readonly<Record<BuiltinReportType, string>> = {
  none: $localize`:@@direct.report.none:Pas de compte rendu`,
  team: $localize`:@@direct.report.team:Point d'équipe`,
  oneToOne: $localize`:@@direct.report.oneToOne:Entretien 1:1`,
  client: $localize`:@@direct.report.client:Point client`,
  brainstorm: $localize`:@@direct.report.brainstorm:Brainstorming`,
  summary: $localize`:@@direct.report.summary:Résumé`,
  lecture: $localize`:@@direct.report.lecture:Cours / conférence`,
  media: $localize`:@@direct.report.media:Vidéo ou podcast`,
  interview: $localize`:@@direct.report.interview:Entretien`,
};

/**
 * Les branches de la cascade, et ce qu'elles rangent.
 *
 * « Pas de compte rendu » reste à plat et en tête : c'est le défaut, et il s'atteint sans ouvrir
 * de branche.
 *
 * @remarks
 * ⚠️ « Entretien » (contenu) n'est pas « Entretien 1:1 » (réunion), et la branche est ce qui les
 * distingue à l'œil : deux libellés proches dans une liste plate se confondraient.
 */
const REPORT_GROUPS: Readonly<Partial<Record<BuiltinReportType, string>>> = {
  team: $localize`:@@direct.report.group.meetings:Réunions`,
  oneToOne: $localize`:@@direct.report.group.meetings:Réunions`,
  client: $localize`:@@direct.report.group.meetings:Réunions`,
  brainstorm: $localize`:@@direct.report.group.meetings:Réunions`,
  summary: $localize`:@@direct.report.group.content:Contenus`,
  lecture: $localize`:@@direct.report.group.content:Contenus`,
  media: $localize`:@@direct.report.group.content:Contenus`,
  interview: $localize`:@@direct.report.group.content:Contenus`,
};

/**
 * Le rang de la rubrique « Personnalisé » parmi les lignes de premier niveau du menu.
 *
 * @remarks
 * ⚠️ Vidée, la rubrique se montre grisée — et c'est ce rang qu'elle doit alors occuper, celui
 * qu'elle gardera une fois pleine. Une rubrique qui change de place en se remplissant fait bouger
 * le menu sous l'utilisateur. C'est le `index` à passer à `ComboSelect.lockedGroups`.
 */
export const REPORT_PROMPT_GROUP_INDEX = 1;

/**
 * Le nom de la rubrique qui déroule les prompts écrits par l'utilisateur.
 *
 * @remarks
 * ⚠️ Une fonction et non une constante : le libellé se lit à l'appel, et un menu vide doit
 * pouvoir le montrer grisé sans avoir un seul prompt à ranger dessous.
 */
export const reportPromptGroupLabel = (): string =>
  $localize`:@@direct.report.group.custom:Personnalisé`;

/**
 * Les types de compte rendu proposables, dans l'ordre du menu.
 *
 * @remarks
 * - ⚠️ **Elle PREND la liste des prompts** : le menu reste le même partout parce que les deux
 *   écrans passent la même liste, non parce qu'elle est figée.
 * - ⚠️ La valeur d'un prompt est son identifiant en texte : `FormOption` veut une chaîne, et un
 *   identifiant ne peut entrer en collision ni avec `'none'` ni avec un type livré.
 * - ⚠️ La cascade vient du champ `group`, et seul `ComboSelect` la rend : un `<select>` natif
 *   l'ignore et rendrait la liste à plat.
 */
export function reportTypeOptions(
  prompts: readonly ReportPrompt[],
): readonly { value: string; label: string; group?: string }[] {
  const custom = prompts.map((entry) => ({
    value: String(entry.id),
    label: entry.title,
    group: reportPromptGroupLabel(),
  }));
  const builtin = LIVE_REPORT_TYPES.filter(
    (type): type is BuiltinReportType => type !== 'custom',
  ).map((type) => ({
    value: type,
    label: REPORT_LABELS[type],
    group: REPORT_GROUPS[type],
  }));
  // « Pas de compte rendu » d'abord, la rubrique Personnalisé au rang qu'elle garde toujours,
  // les branches livrées après.
  return [
    ...builtin.slice(0, REPORT_PROMPT_GROUP_INDEX),
    ...custom,
    ...builtin.slice(REPORT_PROMPT_GROUP_INDEX),
  ];
}

/**
 * Comment chaque étape se nomme sous le voile : Rust nomme l'étape, cette table en fait une phrase.
 *
 * @remarks
 * - ⚠️ Le libellé se compose ici et jamais dans Rust : une phrase française émise par le backend
 *   sortirait telle quelle dans les cinq autres langues, l'interface étant localisée au build.
 * - ⚠️ Chaque étape dit ce qu'elle fait, et aucune ne dit le mot du code : « entrelacer » ou
 *   « slice » n'apprennent rien à qui attend son transcript.
 * - ⚠️ Aucune durée nulle part : les étapes n'ont pas la même longueur, un temps annoncé serait
 *   faux, et un temps faux est cru.
 */
const STEP_LABELS: Readonly<Record<LiveStep, string>> = {
  settling: $localize`:@@direct.step.settling:Récupération des derniers mots…`,
  voices: $localize`:@@direct.step.voices:Analyse des voix…`,
  echo: $localize`:@@direct.step.echo:Retrait de l'écho…`,
  weaving: $localize`:@@direct.step.weaving:Assemblage du transcript…`,
  erasing: $localize`:@@direct.step.erasing:Suppression de l'audio…`,
  notes: $localize`:@@direct.step.notes:Lecture de la session…`,
  writing: $localize`:@@direct.step.writing:Rédaction du compte rendu…`,
};

/**
 * Le libellé d'une étape.
 *
 * Exportée pour être éprouvée seule : c'est elle qui décide de ce que l'utilisateur lit pendant
 * l'unique moment où il attend.
 */
export function stepLabel(step: LiveStep): string {
  return STEP_LABELS[step];
}

/**
 * La proportion d'étapes faites, en pourcentage entier — ou `null` si le total est absurde.
 *
 * Exportée pour être éprouvée seule.
 *
 * @remarks
 * ⚠️ Un total nul rend `null`, pas zéro : `null` veut dire « en cours, durée inconnue » et la
 * barre passe en indéterminé, quand `0` afficherait « 0 % » sur un travail dont on ne sait rien.
 * La charge utile vient d'un évènement, et une division par zéro se lirait `NaN%` à l'écran.
 */
export function stepPercent(done: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }
  return Math.round((Math.min(done, total) / total) * 100);
}

/**
 * Depuis combien de secondes la session tourne. `0` si elle n'a pas commencé.
 *
 * @remarks
 * - ⚠️ La durée se déduit d'un instant de départ, jamais d'un compteur de battements : un
 *   compteur incrémenté meurt avec le composant qui le tient — quitter l'écran Direct le faisait
 *   retomber à `00:00:00`, figé. Un instant de départ se relit, la durée se recalcule.
 * - ⚠️ Partagée par les deux fenêtres, qui affichent le même minuteur : deux formules
 *   divergeraient au premier arrondi.
 */
export function elapsedSecondsSince(startedAtMs: number | null, nowMs: number): number {
  if (startedAtMs === null) {
    return 0;
  }
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

/**
 * Le temps écoulé, en `hh:mm:ss`.
 *
 * Toujours trois groupes, contrairement au `m:ss` de la pilule, qui n'a pas la place.
 *
 * @remarks
 * - ⚠️ Les heures ne sont pas plafonnées : une session dépasse l'heure, et un chrono qui
 *   repartirait à zéro serait un mensonge.
 * - ⚠️ `Intl`, jamais un `padStart` : un remplissage manuel rendrait des chiffres latins dans une
 *   interface qui n'en veut pas forcément.
 */
export function formatElapsed(seconds: number, locale?: string): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return `${pad.format(hours)}:${pad.format(minutes)}:${pad.format(total % 60)}`;
}

/**
 * Renommer une session, et le nom accessible du champ de titre.
 *
 * @remarks
 * ⚠️ Partagés par la fenêtre-session et son bandeau d'enregistrement, qui montrent le même titre
 * à deux moments. Deux déclarations se rendraient différemment.
 */
export const SESSION_RENAME_LABEL = $localize`:@@direct.document.rename:Renommer la session`;

/** Le nom accessible du champ de titre d'une session. Voir {@link SESSION_RENAME_LABEL}. */
export const SESSION_TITLE_FIELD_LABEL = $localize`:@@direct.document.titleField:Titre de la session`;

/**
 * L'invite du champ de prompt de compte rendu.
 *
 * @remarks
 * ⚠️ Partagée par la fenêtre-session et Options ▸ Direct : c'est le même champ, écrit deux fois.
 */
export const REPORT_PROMPT_PLACEHOLDER = $localize`:@@direct.report.prompt:Écrivez votre prompt de compte rendu…`;

/**
 * Ce que l'écran Direct a besoin de demander au backend.
 *
 * Sa responsabilité propre est de traduire deux vocabulaires du micro qui se ressemblent et
 * s'opposent ; la conversion vit dans {@link bridgeMicrophone}, et nulle part ailleurs.
 *
 * @remarks
 * - ⚠️ Côté écran, `null` veut dire « micro système » et `'none'` « pas de micro » ; côté pont,
 *   `null` veut dire « pas de micro » et `'default'` « micro système ». Passer la valeur telle
 *   quelle couperait le micro de tous ceux qui n'en ont jamais choisi — `null` est le défaut.
 * - ⚠️ Le magasin ne parle jamais au pont : ce service pousse, `DirectStore` tient l'état.
 */
@Service()
export class Live {
  private readonly languages = inject(LanguagesBridge);
  private readonly bridge = inject(LiveBridge);
  private readonly core = inject(Invoke);
  private readonly system = inject(SystemBridge);

  /**
   * Les sources captables.
   *
   * N'ouvre aucun tap et ne déclenche aucun prompt : la liste se remplit dès l'affichage de
   * l'écran. Hors contexte Tauri elle est vide, et l'écran le dit plutôt que de proposer un
   * choix qui n'existe pas.
   */
  async audioSources(): Promise<readonly AudioSource[]> {
    return (await this.bridge.listAudioSources()) ?? [];
  }

  /**
   * Démarre la capture, et rend le document de la session dont le backend vient d'ouvrir la
   * fenêtre. `null` hors contexte Tauri.
   *
   * @param microphoneId - La valeur du réglage, pas celle du pont.
   * @param language - La langue de transcription en direct ; `null` enregistre sans transcrire,
   *   ce qui reste un enregistrement valide — tout se refait depuis le fichier.
   */
  async start(
    sourceId: string,
    microphoneId: string | null,
    language: string | null,
    translationTarget: string | null,
  ): Promise<LiveDocument | null> {
    return this.bridge.startLiveCapture(
      sourceId,
      bridgeMicrophone(microphoneId),
      language,
      translationTarget,
    );
  }

  /**
   * Traduit un segment acquis du transcript. Rend `null` si rien n'a pu être traduit.
   *
   * @remarks
   * - ⚠️ Un segment acquis, et jamais retraduit : traduire une hypothèse rendrait une traduction
   *   qui se réécrit seule, et retraduire un paragraphe coûterait 3,6 s de moteur par ajout.
   * - ⚠️ L'unité est le segment (~200 caractères), pas le paragraphe (jusqu'à 800). Les
   *   traductions se regroupent aux mêmes frontières que l'original, colonnes alignées.
   * - ⚠️ Une paire absente rend `null` et n'est pas une panne : le segment reste dans sa langue
   *   et le transcript continue d'avancer.
   */
  async translate(text: string, source: string, target: string): Promise<string | null> {
    const outcome = await this.languages.translateText(source, target, text);
    return outcome?.kind === 'translated' ? outcome.text : null;
  }

  /**
   * S'abonne au transcript en direct. Rend de quoi se désabonner.
   *
   * Hors contexte Tauri, le désabonnement est une fonction vide — pas un `null` à tester chez
   * l'appelant.
   */
  async onTranscript(handler: (event: LiveTranscriptEvent) => void): Promise<() => void> {
    return this.bridge.onLiveTranscript(handler);
  }

  /**
   * Arrête la capture. Sans effet si rien ne tourne.
   *
   * @remarks
   * ⚠️ La consolidation suit d'elle-même, et aucun frontend ne la lance : trois gestes arrêtent
   * une session, dont la fermeture de la fenêtre-session — celle qui aurait dû enchaîner est
   * alors celle qui meurt. On l'apprend par {@link Live.onStopped}, puis {@link Live.onFinalised}.
   */
  async stop(): Promise<void> {
    await this.bridge.stopLiveCapture();
  }

  /** S'abonne à l'arrêt d'une session, c'est-à-dire au début de la consolidation. */
  async onStopped(handler: (documentId: string) => void): Promise<() => void> {
    return this.bridge.onLiveStopped((event) => handler(event.documentId));
  }

  /** S'abonne à la fin de la consolidation : le document complet arrive. */
  async onFinalised(handler: (document: LiveDocument) => void): Promise<() => void> {
    return this.bridge.onLiveFinalised(handler);
  }

  /**
   * S'abonne à la progression des travaux de session — finalisation et compte rendu.
   *
   * Un seul abonnement pour les deux attentes : elles ne courent jamais en même temps sur la
   * même session, et l'étape dit de laquelle il s'agit.
   */
  async onProgress(handler: (progress: LiveProgress) => void): Promise<() => void> {
    return this.bridge.onLiveProgress(handler);
  }

  /**
   * S'abonne au niveau des deux flux — ce que le VU-mètre affiche.
   *
   * Le backend bat la mesure et se tait quand la capture s'arrête, après un dernier zéro : la
   * fenêtre n'a rien à relever, rien à cadencer et rien à comparer.
   */
  async onLevel(handler: (level: number) => void): Promise<() => void> {
    return this.bridge.onLiveLevel(handler);
  }

  /**
   * Où en est la session en cours — ce qu'une fenêtre relit pour se remettre à jour.
   *
   * Rend un état au repos hors contexte Tauri, jamais `null` : un écran qui doit décider quoi
   * afficher n'a rien à faire d'un troisième cas.
   */
  async session(): Promise<LiveSessionState> {
    return (await this.bridge.getLiveSession()) ?? AT_REST;
  }

  /**
   * Relit une session. Premier appel de sa fenêtre au démarrage.
   *
   * Rend `null` hors contexte Tauri, pas une erreur : l'écran dit alors qu'il n'a rien à montrer.
   */
  async document(id: string): Promise<LiveDocument | null> {
    return this.bridge.getLiveDocument(id);
  }

  /** Renomme la session. Un titre vidé ramène le repli « Session du {date} ». */
  async rename(id: string, title: string): Promise<LiveDocument | null> {
    return this.bridge.renameLiveDocument(id, title);
  }

  /**
   * Génère — ou régénère — le compte rendu d'une session.
   *
   * Ne re-transcrit rien : le transcript ne dépend pas du type, et il n'y a plus d'audio à
   * relire. Seul le modèle de langue retravaille.
   */
  async generateReport(
    id: string,
    kind: ReportKind,
    prompt: string | null,
  ): Promise<LiveDocument | null> {
    return this.bridge.generateLiveReport(id, kind, prompt);
  }

  /**
   * Demande l'arrêt de la génération en cours. Idempotente.
   *
   * @remarks
   * ⚠️ Renoncer ramène l'état d'avant et ne vide rien : {@link Live.generateReport} rend le
   * document inchangé — sans compte rendu si c'était le premier, avec le précédent si c'était une
   * régénération. Le backend le garantit, l'écran n'a rien à défaire.
   */
  async cancelReport(id: string): Promise<void> {
    await this.bridge.cancelLiveReport(id);
  }

  /**
   * L'historique des sessions archivées, du plus récent au plus ancien.
   *
   * Rend une liste vide hors contexte Tauri, jamais `null` : un panneau qui décide quoi afficher
   * n'a rien à faire d'un troisième cas entre « rien » et « quelque chose ».
   *
   * @remarks
   * ⚠️ La purge tourne à chaque appel, côté backend : c'est ce qui rend la rétention rétroactive
   * — réduire le réglage s'applique en arrière, dès l'ouverture suivante.
   */
  async sessions(): Promise<readonly SessionSummary[]> {
    return (await this.bridge.listLiveSessions()) ?? [];
  }

  /**
   * Rouvre une session archivée dans sa fenêtre.
   *
   * C'est le backend qui décide de la fenêtre, pas l'écran : une session déjà ouverte est ramenée
   * devant plutôt que dédoublée.
   */
  async openSession(id: number): Promise<void> {
    await this.bridge.openLiveSession(id);
  }

  /** Supprime une session de l'historique, et ferme sa fenêtre si elle en avait une. */
  async deleteSession(id: number): Promise<void> {
    await this.bridge.deleteLiveSession(id);
  }

  /** Vide l'historique des sessions. */
  async clearSessions(): Promise<void> {
    await this.bridge.clearLiveSessions();
  }

  /** Le texte d'une session : le compte rendu s'il existe, le transcript sinon. */
  async sessionText(id: number): Promise<string> {
    return (await this.bridge.copyLiveSession(id)) ?? '';
  }

  /**
   * Ouvre « Enregistrer sous ». Rend vrai quand l'utilisateur a désigné un fichier.
   *
   * @remarks
   * ⚠️ Le titre et la date partent résolus : ce sont deux textes localisés, et Rust n'en fabrique
   * aucun — il les assainit et les assemble pour proposer un nom. Le chemin, lui, reste chez lui.
   */
  async chooseExportPath(
    id: string,
    title: string,
    date: string,
    format: ExportFormat,
  ): Promise<boolean> {
    return this.bridge.chooseLiveExportPath(id, title, date, format);
  }

  /** Écrit la session — transcript ou compte rendu — à l'emplacement choisi. */
  async exportDocument(request: LiveExportRequest): Promise<void> {
    await this.bridge.exportLiveDocument(request);
  }

  /** Place la session dans le presse-papiers, en HTML et en Markdown. */
  async copyDocument(request: LiveCopyRequest): Promise<void> {
    await this.bridge.copyLiveDocument(request);
  }

  /**
   * Traduit le transcript de la session — une vue, jamais un remplacement.
   *
   * @remarks
   * ⚠️ La langue source n'est pas un paramètre : c'est celle du document, posée dès son début.
   */
  async translateTranscript(id: string, target: string): Promise<TranscriptTranslation | null> {
    return this.bridge.translateLiveTranscript(id, target);
  }

  /** Traduit le compte rendu de la session, intitulés compris. */
  async translateReport(id: string, target: string): Promise<ReportTranslation | null> {
    return this.bridge.translateLiveReport(id, target);
  }

  /**
   * Demande l'arrêt de la traduction en cours sur ce document.
   *
   * La même commande que la fenêtre-fichier, et ce n'est pas un raccourci : les deux partagent la
   * table `TranslationJobs`, dont la clé est l'identifiant du document — `directdoc-3` et
   * `filedoc-3` n'y sont pas la même entrée.
   */
  async cancelTranslation(id: string): Promise<void> {
    await this.languages.cancelDocumentTranslation(id);
  }

  /**
   * S'abonne à l'avancée d'une traduction, filtrée sur ce document.
   *
   * @remarks
   * ⚠️ Le filtre n'est pas décoratif : un évènement Tauri est diffusé à toutes les fenêtres, et
   * plusieurs fenêtres-sessions peuvent traduire en même temps. Sans lui, la barre de l'une
   * afficherait l'avancée de l'autre.
   */
  async onTranslationProgress(id: string, handler: (percent: number) => void): Promise<() => void> {
    return listenToDocumentTranslation(this.core, id, handler);
  }

  /** Ferme la session et sa fenêtre. Idempotente. */
  async closeDocument(id: string): Promise<void> {
    await this.bridge.closeLiveDocument(id);
  }

  /**
   * Intercepte les demandes de fermeture de la fenêtre courante. Rend le désabonnement.
   *
   * @remarks
   * ⚠️ Pour cette fenêtre-ci, fermer est un geste d'arrêt — l'inverse de la fenêtre principale,
   * dont la fermeture ne touche à rien. Sans cette interception, la pastille rouge détruirait la
   * fenêtre d'une session en cours sans un mot.
   */
  async onCloseRequest(handler: () => void): Promise<() => void> {
    return this.system.onCloseRequested(handler);
  }
}
