/**
 * Le Direct : la capture, le transcript au fil de l'eau, les sessions et leurs comptes rendus.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';
import type {
  ExportFormat,
  RenderedParagraph,
  Transcript,
  TranscriptTranslation,
} from '../media/media.bridge';

/** Une source captable pour une session : une application, ou tout le système. */
export interface AudioSource {
  /** `'system'` pour tout le système, sinon le `pid`. **Opaque** côté frontend. */
  readonly id: string;
  readonly name: string;
  /** Vrai pour la seule entrée « Tout le système », toujours en tête de liste. */
  readonly isSystem: boolean;
}

/** De quel flux vient un morceau de transcript de session. */
export type LiveStream = 'system' | 'microphone';

/**
 * Ce qu'un flux de session vient de produire.
 *
 * `partial` remplace l'hypothèse précédente du même flux, `final` s'ajoute, `failed` dit que ce
 * flux ne sera pas transcrit — la capture, elle, continue.
 *
 * @remarks
 * ⚠️ `text` ne porte que le nouveau morceau, jamais le transcript accumulé : c'est l'écran qui
 * accumule, et c'est ce qui rend le coût d'une session indépendant de sa durée.
 */
export interface LiveSpeech {
  readonly kind: 'partial' | 'final' | 'failed';
  /**
   * Le flux d'où vient le morceau — c'est tout ce que le Direct affirme de qui parle.
   *
   * @remarks
   * ⚠️ « Moi » ou « Participant », vrai par construction. Aucun numéro de locuteur ne circule
   * ici : la diarisation fine se fait à l'arrêt, sur l'enregistrement entier.
   */
  readonly stream: LiveStream;
  readonly text: string;
  /**
   * Ce segment suit-il un silence ? L'écran y ouvre un nouveau paragraphe. Seuls les `final`
   * en portent un.
   *
   * @remarks
   * ⚠️ Décidé par le backend, qui seul a les horodatages — l'écran ne reçoit que du texte.
   */
  readonly paragraph?: boolean;
}

/**
 * L'hypothèse en cours d'un flux est à effacer.
 *
 * @remarks
 * - ⚠️ Émis quand ce que le micro entend n'est que l'écho des haut-parleurs. Sans lui, la
 *   phrase des autres reste affichée sous « Moi », à côté de la même phrase du flux système.
 * - ⚠️ Il ne porte pas de texte, et le type doit le dire : un `text` facultatif sur toutes les
 *   natures obligerait chaque lecteur à un repli qu'aucune d'elles n'atteint jamais.
 */
export interface LiveSpeechDropped {
  readonly kind: 'dropped';
  readonly stream: LiveStream;
}

/** Ce qui circule sur le canal du transcript de session. */
export type LiveTranscriptEvent = LiveSpeech | LiveSpeechDropped;

/**
 * Une session, telle que sa fenêtre la lit — en cours d'enregistrement ou terminée.
 *
 * @remarks
 * ⚠️ Un seul fait distingue les deux états : `endedAtMs`. `null` veut dire « ça enregistre »,
 * un nombre veut dire « c'est fini ». Un second champ booléen pourrait diverger du premier ; il
 * n'existe donc ni ici, ni côté Rust.
 */
export interface LiveDocument {
  readonly id: string;
  /**
   * L'intitulé proposé par le modèle local, `null` s'il n'y avait rien à nommer.
   *
   * @remarks
   * ⚠️ `null` n'est pas une panne : une session de vingt secondes ne porte pas de sujet et le
   * backend refuse d'en inventer un (`live::title`). Le repli « Session du {date} » se compose
   * côté interface avec `Intl` — voir `liveTitle`.
   */
  readonly title: string | null;
  /** Ce qui était capté — « Microsoft Teams », « Tout le système ». Pour la ligne de méta. */
  readonly sourceName: string;
  /**
   * Quand la session a commencé, en millisecondes depuis l'époque.
   *
   * @remarks
   * ⚠️ C'est lui qui date la session, et non sa fin : le titre par défaut s'affiche pendant
   * l'enregistrement, et une session datée de sa fin verrait son propre titre changer sous les
   * yeux de l'utilisateur au moment de l'arrêt.
   */
  readonly startedAtMs: number;
  /**
   * Quand la session s'est terminée, `null` tant qu'elle enregistre.
   *
   * @remarks
   * ⚠️ Relevé par le backend à la fin de la session, jamais recalculé à l'affichage : une
   * fenêtre laissée ouverte toute la nuit finirait par se dater du lendemain.
   */
  readonly endedAtMs: number | null;
  /** ⚠️ Vide pendant l'enregistrement : le direct arrive par évènements, pas par ici. */
  readonly transcript: Transcript;
  /**
   * Les rubriques du compte rendu, vides tant qu'il n'a pas été demandé.
   *
   * @remarks
   * ⚠️ Vide n'est pas un échec : le compte rendu se génère à la demande, et la fenêtre s'ouvre
   * bien avant qu'il existe.
   */
  readonly report: readonly ReportSection[];
  /**
   * La langue vers laquelle cette session est suivie, `null` s'il n'y en a pas.
   *
   * @remarks
   * ⚠️ C'est une propriété de la session, pas le réglage : `liveTranslationTarget` dit ce que le
   * formulaire propose. Lire le réglage depuis la fenêtre-session ferait changer de langue une
   * session en cours dès qu'on prépare la suivante — les deux fenêtres partagent le fichier.
   */
  readonly translationTarget: string | null;
}

/**
 * Une session archivée, telle que le panneau d'historique la lit.
 *
 * @remarks
 * - ⚠️ Ni transcript ni compte rendu : une session d'une heure pèse des centaines de
 *   kilo-octets de JSON, quand la liste n'en montre que deux lignes. La session entière ne se
 *   lit qu'à l'ouverture de sa fenêtre, côté Rust, sans passer par ici.
 * - ⚠️ `id` est celui de la ligne, pas celui de la fenêtre : `LiveDocument.id` ne survit pas au
 *   redémarrage, celui-ci est persistant et désigne la session dans l'historique.
 */
export interface SessionSummary {
  readonly id: number;
  /**
   * Le titre donné par l'utilisateur, `null` s'il n'en a pas donné.
   *
   * @remarks
   * ⚠️ Le repli « Session du 5 août à 16:12 » se compose ici, avec `Intl` — voir `liveTitle`.
   * L'écrire en base le figerait dans la langue du jour où la session a eu lieu.
   */
  readonly title: string | null;
  readonly sourceName: string;
  /** Le début, à la seconde près : la base range les instants en ISO 8601 UTC. */
  readonly startedAtMs: number;
  /** La fin, à la seconde près. Toujours renseignée : la session est archivée. */
  readonly endedAtMs: number;
  /**
   * Le début du transcript, pour la recherche.
   *
   * @remarks
   * - ⚠️ C'est un début, pas une recherche plein texte : un mot prononcé à la quarantième
   *   minute ne rend rien. Le plein texte demanderait FTS5 et un index à tenir.
   * - ⚠️ Vide sur les sessions archivées avant la migration 6, qui ne rattrape rien : elles se
   *   listent, s'ouvrent et se copient normalement, et restent trouvables par leur titre.
   */
  readonly preview: string;
  /** Y a-t-il un compte rendu ? ⚠️ Un booléen, jamais les rubriques. */
  readonly hasReport: boolean;
}

/**
 * Une rubrique du compte rendu.
 *
 * @remarks
 * ⚠️ Soit un paragraphe, soit des puces — jamais les deux. La maquette dessine `.cr-p` ou
 * `.cr-list` sous chaque `.cr-h` : mélanger les deux produirait une mise en page que rien ne
 * prévoit.
 */
export interface ReportSection {
  readonly heading: string;
  readonly lines: readonly string[];
  readonly bullets: boolean;
}

/**
 * Les neuf types de compte rendu. Le type change les rubriques, pas le ton.
 *
 * @remarks
 * - ⚠️ `'none'` n'en fait pas partie : « ne rien produire » est une réponse de l'interface, et
 *   l'y fondre ferait partir `'none'` dans `generate_live_report`, où Rust le refuserait à la
 *   désérialisation. C'est `LiveReportType` (`models/settings`) qui porte ce choix.
 * - ⚠️ Miroir exact de `ReportKind` (`src-tauri/src/live/report.rs`), identifiants compris : ils
 *   voyagent dans le fichier de réglages, un renommage ferait retomber sur le défaut.
 */
export type ReportKind =
  | 'team'
  | 'oneToOne'
  | 'client'
  | 'brainstorm'
  | 'summary'
  | 'lecture'
  | 'media'
  | 'interview'
  | 'custom';

/**
 * Le canal des évènements de transcript de session.
 *
 * @remarks
 * ⚠️ Distinct de celui de la dictée : charge utile différente, consommateur différent.
 */
export const LIVE_TRANSCRIPT_EVENT = 'live-transcript';

/**
 * Le canal de l'arrêt d'une session — l'enregistrement est fini, la consolidation commence.
 *
 * @remarks
 * ⚠️ Deux canaux et non un : le déclencheur rend son formulaire tout de suite, quand la
 * fenêtre-session lève son voile et patiente. Un seul évènement à la fin aurait verrouillé le
 * formulaire pendant un travail qui ne le concerne pas.
 */
export const LIVE_STOPPED_EVENT = 'live-stopped';

/** Le canal de la consolidation terminée. Sa charge utile est le document complet. */
export const LIVE_FINALISED_EVENT = 'live-finalised';

/**
 * Le prompt de compte rendu vient d'être écrit, par cette fenêtre ou par une autre.
 *
 * @remarks
 * ⚠️ **Sans charge utile, et à dessein** : le prompt nomme un client, un employeur. Il reste
 * dans la base chiffrée et chaque fenêtre l'y relit ; l'évènement ne dit que « il a changé ».
 * Miroir de `LIVE_PROMPT_EVENT` (`src-tauri/src/commands/prompts.rs`).
 */
export const LIVE_PROMPT_EVENT = 'live-prompt-changed';

/**
 * Le canal de la progression d'un travail de session — finalisation ou compte rendu.
 *
 * @remarks
 * ⚠️ Un seul canal pour les deux attentes, parce qu'elles ne se recouvrent jamais : un compte
 * rendu ne se demande que sur un document déjà consolidé, et l'étape suffit à dire de quel
 * travail il s'agit.
 */
export const LIVE_PROGRESS_EVENT = 'live-progress';

/**
 * Le canal du niveau des deux flux, poussé tant que la capture tourne.
 *
 * @remarks
 * ⚠️ Aucun identifiant de document n'y voyage, et il n'en faut pas : le tap est unique dans le
 * processus, donc une seule session capte à la fois. Les fenêtres-sessions terminées
 * n'enregistrent pas et ne montrent aucun mètre.
 */
export const LIVE_LEVEL_EVENT = 'live-level';

/** Ce que porte {@link LIVE_LEVEL_EVENT} : le niveau combiné, de 0 à 1. */
export interface LiveLevel {
  readonly level: number;
}

/**
 * Une étape franchie par un travail de session. Les cinq premières appartiennent à la
 * finalisation, les deux dernières au compte rendu.
 *
 * @remarks
 * ⚠️ Ces noms viennent de Rust et sont lus par `stepLabel` (`core/services/live`) : en ajouter
 * un ici sans l'ajouter là ferait retomber le voile sur son libellé générique, sans erreur
 * nulle part.
 */
export type LiveStep = 'settling' | 'voices' | 'echo' | 'weaving' | 'erasing' | 'notes' | 'writing';

/**
 * Où en est un travail de session.
 *
 * @remarks
 * - ⚠️ Aucun libellé ne voyage : une phrase française émise par Rust sortirait telle quelle
 *   dans les cinq autres langues. Rust nomme l'étape, Angular la traduit.
 * - ⚠️ `done` compte les étapes finies et `step` est celle qui commence : au premier évènement
 *   la barre est à zéro et le libellé dit ce qui se fait.
 * - ⚠️ `documentId` n'est pas décoratif : un évènement Tauri est diffusé à toutes les fenêtres.
 */
export interface LiveProgress {
  readonly documentId: string;
  readonly step: LiveStep;
  readonly done: number;
  readonly total: number;
}

/**
 * Quelle session vient de s'arrêter.
 *
 * @remarks
 * ⚠️ Un évènement Tauri est diffusé à toutes les fenêtres, et plusieurs fenêtres-sessions
 * terminées peuvent être ouvertes en même temps. Sans cet identifiant, chacune se croirait
 * concernée et lèverait un voile sur un document qui ne bouge pas.
 */
export interface LiveStopped {
  readonly documentId: string;
}

/**
 * Où en est la session, du point de vue de ce qu'une fenêtre doit montrer.
 *
 * @remarks
 * ⚠️ Trois états et non deux : entre « Arrêter » et le transcript consolidé, il s'écoule
 * plusieurs secondes sur une session d'une heure — c'est le voile. Un booléen ferait retomber
 * la fenêtre sur un document vide pendant ce temps-là.
 */
export type LivePhase = 'idle' | 'recording' | 'finalising';

/**
 * Ce qu'une fenêtre a besoin de savoir de la session en cours, à froid.
 *
 * @remarks
 * ⚠️ C'est la réhydratation, et sans elle une seconde fenêtre ne sait rien : chaque fenêtre
 * porte sa propre instance d'Angular, donc son propre magasin — ce que le déclencheur a retenu
 * en démarrant est invisible à la fenêtre-session, et réciproquement.
 */
export interface LiveSessionState {
  readonly phase: LivePhase;
  readonly documentId: string | null;
  /** C'est de là que les deux fenêtres tirent leur minuteur. */
  readonly startedAtMs: number | null;
  readonly sourceName: string | null;
  readonly withMicrophone: boolean;
}

/**
 * Ce qu'une fenêtre-session exporte : ce qu'elle affiche.
 *
 * @remarks
 * ⚠️ Un seul sélecteur « Exporter », et il porte sur la vue où l'on est : la barre d'actions est
 * partagée par les deux vues, et chaque contrôle veut dire ce qu'il dit pour la vue courante.
 * Un troisième choix redemanderait ce que l'écran affiche déjà.
 */
export type LiveContent = 'transcript' | 'report';

/**
 * Ce qu'il faut pour écrire l'export d'une session.
 *
 * @remarks
 * - ⚠️ `title` voyage, il ne se relit pas : une session sans titre s'appelle « Session du 5 août
 *   à 16:12 », une phrase localisée que seule l'interface sait composer.
 * - ⚠️ `paragraphs` et `sections` portent ce que l'écran montre ; les omettre ferait sortir un
 *   fichier dans la langue d'origine. Un seul des deux sert — celui que `content` désigne.
 * - ⚠️ **Aucun chemin d'écriture** : la boîte « Enregistrer sous » est ouverte par Rust. Voir
 *   {@link ExportRequest}.
 */
export interface LiveExportRequest {
  readonly id: string;
  readonly content: LiveContent;
  readonly format: ExportFormat;
  /** Le titre résolu ici, repli daté compris. */
  readonly title: string;
  /** Le transcript affiché, ou absent pour relire celui du document. */
  readonly paragraphs?: readonly RenderedParagraph[];
  /** Le compte rendu affiché, ou absent pour relire celui du document. */
  readonly sections?: readonly ReportSection[];
}

/** Ce qu'il faut pour copier une session dans le presse-papiers. */
export interface LiveCopyRequest {
  readonly id: string;
  readonly content: LiveContent;
  readonly title: string;
  /** Voir {@link LiveExportRequest} : coller une autre langue que celle qu'on lit serait pire. */
  readonly paragraphs?: readonly RenderedParagraph[];
  readonly sections?: readonly ReportSection[];
}

/**
 * Ce que rend la traduction d'un compte rendu. Miroir de `ReportTranslation`
 * (`src-tauri/src/translation/report.rs`).
 *
 * @remarks
 * ⚠️ Les mêmes quatre issues que {@link TranscriptTranslation}, et elles se traitent pareil :
 * une paire absente ou non supportée n'est pas une panne, et une annulation ne rend aucune
 * rubrique.
 */
export type ReportTranslation =
  | { readonly kind: 'translated'; readonly sections: readonly ReportSection[] }
  | { readonly kind: 'pairMissing'; readonly source: string; readonly target: string }
  | { readonly kind: 'pairUnsupported'; readonly source: string; readonly target: string }
  | { readonly kind: 'cancelled' };

/**
 * Un prompt de compte rendu nommé.
 *
 * @remarks
 * ⚠️ Miroir de `ReportPrompt` (`src-tauri/src/commands/prompts.rs`), `camelCase` compris.
 * ⚠️ `id` est un ENTIER, jamais réattribué (`AUTOINCREMENT`) : c'est ce qui permet au réglage du
 * compte rendu par défaut de désigner un prompt sans risquer d'en désigner un autre.
 */
export interface ReportPrompt {
  readonly id: number;
  readonly title: string;
  readonly prompt: string;
}

/** Le Direct : la capture, le transcript au fil de l'eau, les sessions et leurs comptes rendus. */
@Service()
export class LiveBridge {
  private readonly core = inject(Invoke);

  /**
   * Les sources captables pour une session : les applications qui émettent réellement du son,
   * plus « Tout le système » en tête. N'ouvre aucun tap et ne déclenche aucun prompt.
   *
   * @remarks
   * ⚠️ C'est un instantané : une application qui se met à émettre après coup n'y est pas, d'où
   * une relecture à chaque ouverture du sélecteur.
   */
  async listAudioSources(): Promise<readonly AudioSource[] | null> {
    return this.core.call<readonly AudioSource[]>('list_audio_sources');
  }

  /**
   * Démarre la capture d'une session.
   *
   * @param microphoneDeviceId - `null` pour ne pas inclure de micro, `'default'` pour le micro
   * système, sinon l'identifiant d'une entrée. ⚠️ Les deux premiers ne se confondent pas.
   */
  async startLiveCapture(
    sourceId: string,
    microphoneDeviceId: string | null,
    language: string | null,
    translationTarget: string | null,
  ): Promise<LiveDocument | null> {
    return this.core.call<LiveDocument>('start_live_capture', {
      sourceId,
      microphoneDeviceId,
      language,
      translationTarget,
    });
  }

  /** Arrête la capture en cours. La consolidation prend le relais. */
  async stopLiveCapture(): Promise<void> {
    await this.core.call<null>('stop_live_capture');
  }

  /**
   * S'abonne au transcript en direct. Rend de quoi se désabonner.
   *
   * @remarks
   * ⚠️ Par évènement, jamais par sondage : sonder n'apporterait pas le texte plus tôt, mais
   * ajouterait une demi-période de latence et un aller-retour IPC en boucle pendant deux heures.
   */
  async onLiveTranscript(handler: (event: LiveTranscriptEvent) => void): Promise<() => void> {
    return this.core.listen<LiveTranscriptEvent>(LIVE_TRANSCRIPT_EVENT, handler);
  }

  /**
   * S'abonne à l'arrêt d'une session. Rend de quoi se désabonner.
   *
   * @remarks
   * ⚠️ Ce n'est pas la fin du travail, c'est la fin de l'enregistrement : la consolidation
   * commence à cet instant. C'est {@link onLiveFinalised} qui dit qu'elle est finie.
   */
  async onLiveStopped(handler: (event: LiveStopped) => void): Promise<() => void> {
    return this.core.listen<LiveStopped>(LIVE_STOPPED_EVENT, handler);
  }

  /**
   * S'abonne à la consolidation d'une session. Rend de quoi se désabonner.
   *
   * @remarks
   * ⚠️ Le document voyage dans l'évènement : la fenêtre n'a pas d'aller-retour à faire pour
   * l'obtenir, à l'instant précis où son utilisateur attend déjà.
   */
  async onLiveFinalised(handler: (document: LiveDocument) => void): Promise<() => void> {
    return this.core.listen<LiveDocument>(LIVE_FINALISED_EVENT, handler);
  }

  /**
   * S'abonne au changement du prompt de compte rendu. Rend de quoi se désabonner.
   *
   * @remarks
   * ⚠️ Diffusé à **toutes** les fenêtres, y compris à celle qui vient d'écrire : c'est à
   * l'appelant de savoir s'il est en avance sur la base.
   */
  async onLivePromptChanged(handler: () => void): Promise<() => void> {
    return this.core.listen<null>(LIVE_PROMPT_EVENT, () => handler());
  }

  /**
   * S'abonne à la progression d'un travail de session. Rend de quoi se désabonner.
   *
   * @remarks
   * ⚠️ Un évènement perdu n'arrête rien : ce qui compte est de rendre le document, pas de
   * remplir sa barre.
   */
  async onLiveProgress(handler: (progress: LiveProgress) => void): Promise<() => void> {
    return this.core.listen<LiveProgress>(LIVE_PROGRESS_EVENT, handler);
  }

  /**
   * S'abonne au niveau des deux flux. Rend de quoi se désabonner.
   *
   * @remarks
   * ⚠️ Un évènement perdu n'a aucune conséquence : le suivant arrive un dixième de seconde plus
   * tard, et le mètre n'a pas de mémoire.
   */
  async onLiveLevel(handler: (level: number) => void): Promise<() => void> {
    return this.core.listen<LiveLevel>(LIVE_LEVEL_EVENT, ({ level }) => handler(level));
  }

  /**
   * Où en est la session en cours — la réhydratation d'une fenêtre.
   *
   * @remarks
   * ⚠️ Elle répond « que dois-je montrer », et non « le tap coule-t-il » : les deux divergent
   * pendant toute la consolidation, où la session existe alors que le tap est fermé depuis
   * longtemps.
   */
  async getLiveSession(): Promise<LiveSessionState | null> {
    return this.core.call<LiveSessionState>('get_live_session');
  }

  /** Relit une session. Premier appel de sa fenêtre au démarrage. */
  async getLiveDocument(id: string): Promise<LiveDocument | null> {
    return this.core.call<LiveDocument>('get_live_document', { id });
  }

  /** Renomme la session. Un titre vidé ramène le repli « Session du {date} ». */
  async renameLiveDocument(id: string, title: string): Promise<LiveDocument | null> {
    return this.core.call<LiveDocument>('rename_live_document', { id, title });
  }

  /**
   * Génère — ou régénère — le compte rendu d'une session.
   *
   * @remarks
   * ⚠️ Ne re-transcrit rien : le transcript ne dépend pas du type, et il n'y a plus d'audio à
   * relire. Seul le modèle de langue retravaille.
   */
  async generateLiveReport(
    id: string,
    kind: ReportKind,
    prompt: string | null,
  ): Promise<LiveDocument | null> {
    return this.core.call<LiveDocument>('generate_live_report', { id, kind, prompt });
  }

  /**
   * Demande l'arrêt de la génération du compte rendu de `id`.
   *
   * @remarks
   * - ⚠️ Idempotente et sans échec : l'interface peut cliquer juste après la fin, et refuser lui
   *   donnerait une erreur pour un geste qui n'a rien cassé.
   * - ⚠️ L'arrêt se constate entre deux passes, jamais au milieu d'une. Ce qui le dit est le
   *   document rendu par {@link generateLiveReport} : il revient inchangé.
   */
  async cancelLiveReport(id: string): Promise<void> {
    await this.core.call<null>('cancel_live_report', { id });
  }

  /**
   * L'historique des sessions, purgé puis lu.
   *
   * @remarks
   * ⚠️ La purge précède la lecture, et c'est ce qui la rend rétroactive : qui vient de réduire
   * sa rétention verrait sinon, une fois de plus, exactement ce qu'il a demandé de faire
   * disparaître.
   */
  async listLiveSessions(): Promise<readonly SessionSummary[] | null> {
    return this.core.call<readonly SessionSummary[]>('list_live_sessions');
  }

  /**
   * Rouvre une session archivée dans sa fenêtre.
   *
   * @remarks
   * ⚠️ Une session n'a qu'une fenêtre, même rouverte deux fois : le backend ramène devant celle
   * qui existe déjà. Deux fenêtres sur la même ligne écriraient tour à tour dedans, et celle qui
   * n'a pas écrit en dernier afficherait pour toujours un état qui n'existe plus.
   */
  async openLiveSession(id: number): Promise<void> {
    await this.core.call<null>('open_live_session', { id });
  }

  /** Supprime une session de l'historique, et ferme sa fenêtre si elle en avait une. */
  async deleteLiveSession(id: number): Promise<void> {
    await this.core.call<null>('delete_live_session', { id });
  }

  /** Vide l'historique des sessions. Rend le nombre de sessions parties, `null` hors Tauri. */
  async clearLiveSessions(): Promise<number | null> {
    return this.core.call<number>('clear_live_sessions');
  }

  /**
   * Le texte d'une session, prêt pour le presse-papier : le compte rendu s'il existe, le
   * transcript sinon.
   *
   * @remarks
   * ⚠️ Jamais rien — le presse-papier ne donne aucun retour, et un bouton qui y met le vide est
   * indiscernable d'un bouton cassé.
   */
  async copyLiveSession(id: number): Promise<string | null> {
    return this.core.call<string>('copy_live_session', { id });
  }

  /** Ferme la session, libère sa mémoire et ferme sa fenêtre. Idempotente. */
  async closeLiveDocument(id: string): Promise<void> {
    await this.core.call<null>('close_live_document', { id });
  }

  /**
   * Ouvre « Enregistrer sous » pour cette session et retient l'emplacement choisi, côté Rust.
   *
   * @returns vrai quand l'utilisateur a désigné un fichier, faux s'il a renoncé.
   *
   * @remarks
   * ⚠️ `title` et `date` partent tous deux résolus : ce sont deux textes localisés, et Rust n'en
   * fabrique aucun. Le chemin, lui, ne fait pas le voyage — voir {@link ExportRequest}.
   */
  async chooseLiveExportPath(
    id: string,
    title: string,
    date: string,
    format: ExportFormat,
  ): Promise<boolean> {
    return (
      (await this.core.call<boolean>('choose_live_export_path', { id, title, date, format })) ??
      false
    );
  }

  /** Rend la session — transcript ou compte rendu — et l'écrit à l'emplacement choisi. */
  async exportLiveDocument(request: LiveExportRequest): Promise<void> {
    await this.core.call<null>('export_live_document', { request });
  }

  /** Place la session dans le presse-papiers, en HTML et en Markdown. */
  async copyLiveDocument(request: LiveCopyRequest): Promise<void> {
    await this.core.call<null>('copy_live_document', { request });
  }

  /**
   * Traduit le transcript d'une session ouverte et rend ses paragraphes.
   *
   * @remarks
   * ⚠️ Une commande à part de {@link translateDocument} : Tauri range son état par type, et une
   * seule commande ne peut pas lire à la fois le magasin des fichiers et celui des sessions. Le
   * reste est partagé, y compris {@link cancelDocumentTranslation}, qui arrête les deux.
   */
  async translateLiveTranscript(id: string, target: string): Promise<TranscriptTranslation | null> {
    return this.core.call<TranscriptTranslation>('translate_live_transcript', { id, target });
  }

  /**
   * Traduit le compte rendu d'une session ouverte, intitulés compris.
   *
   * @remarks
   * ⚠️ Les intitulés aussi : « Résumé », « Décisions » sont écrits par le modèle dans la langue
   * du transcript, ils ne sortent d'aucune table de l'interface.
   */
  async translateLiveReport(id: string, target: string): Promise<ReportTranslation | null> {
    return this.core.call<ReportTranslation>('translate_live_report', { id, target });
  }

  /**
   * Les prompts de compte rendu nommés, triés par titre. Vide hors Tauri.
   *
   * @remarks
   * ⚠️ Jamais `null` : l'écran affiche une liste, et un troisième cas entre « vide » et
   * « remplie » serait une branche que personne ne couvrirait.
   */
  async listReportPrompts(): Promise<readonly ReportPrompt[]> {
    return (await this.core.call<ReportPrompt[]>('list_report_prompts')) ?? [];
  }

  /** Crée un prompt nommé et rend ce que la base a écrit, `null` hors Tauri. */
  async createReportPrompt(title: string, prompt: string): Promise<ReportPrompt | null> {
    return this.core.call<ReportPrompt>('create_report_prompt', { title, prompt });
  }

  /** Modifie un prompt nommé. Son numéro ne change pas. */
  async updateReportPrompt(
    id: number,
    title: string,
    prompt: string,
  ): Promise<ReportPrompt | null> {
    return this.core.call<ReportPrompt>('update_report_prompt', { id, title, prompt });
  }

  /** Supprime un prompt nommé. Supprimer ce qui n'existe plus réussit. */
  async deleteReportPrompt(id: number): Promise<void> {
    await this.core.call<null>('delete_report_prompt', { id });
  }

  /**
   * Reprend l'ancien prompt unique en premier prompt nommé. Rend `true` s'il y avait quelque
   * chose à reprendre.
   *
   * @remarks
   * ⚠️ Le titre vient d'ici, traduit : une migration SQL ne parle pas six langues.
   */
  async adoptLegacyLivePrompt(title: string): Promise<boolean> {
    return (await this.core.call<boolean>('adopt_legacy_live_prompt', { title })) ?? false;
  }
}
