/**
 * Les réglages non sensibles de l'application, tels que `tauri-plugin-store` les écrit dans un
 * fichier JSON en clair.
 *
 * Les valeurs par défaut sont complètes : chaque fonction doit marcher avant qu'aucun écran de
 * réglage n'existe.
 *
 * @remarks
 * ⚠️ Rien de sensible n'entre ici — transcripts, comptes rendus, historique et empreintes
 * vocales vont dans la base chiffrée. Ajouter un champ ici, c'est affirmer qu'il peut être lu
 * par n'importe quoi sur la machine.
 */

import {
  ACCENT_IDS,
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  type AccentId,
} from './accent-palette';

/** Les six langues traitées de bout en bout en local. */
export const LANGUAGES = ['fr', 'en', 'es', 'de', 'it', 'pt'] as const;

/** Une langue du périmètre, par son code à deux lettres. */
export type Language = (typeof LANGUAGES)[number];

/**
 * Clair ou sombre, jamais « Système » : le thème du système sert uniquement, au premier
 * lancement, à choisir la valeur initiale.
 */
export const THEMES = ['light', 'dark'] as const;

/** Le thème retenu. */
export type ThemeName = (typeof THEMES)[number];

/** Maintenir la touche pour parler, ou basculer d'un appui à l'autre. */
export const DICTATION_MODES = ['hold', 'toggle'] as const;

/** Le mode de déclenchement du raccourci global. */
export type DictationMode = (typeof DICTATION_MODES)[number];

/**
 * Les modes de reformulation.
 *
 * @remarks
 * ⚠️ Plus de `'none'` : c'est l'interrupteur « Reformulation » qui dit non, et deux façons de le
 * dire — un interrupteur éteint et une première ligne de menu — feraient douter de ce que fait
 * chacune. Le menu ne répond qu'à une question, « dans quel style ».
 */
export const REPHRASING_MODES = [
  'standard',
  'professional',
  'concise',
  'detailed',
  'friendly',
  'custom',
] as const;
/** La façon dont la dictée est réécrite après coup. */
export type RephrasingMode = (typeof REPHRASING_MODES)[number];

/** Les langues cibles de traduction, plus « pas de traduction » — verrouillé, toujours proposé. */
export const TRANSLATION_TARGETS = ['none', ...LANGUAGES] as const;

/** La langue vers laquelle traduire, ou `'none'`. */
export type TranslationTarget = (typeof TRANSLATION_TARGETS)[number];

/** Les tailles d'historique de dictée proposées. Au-delà, la plus ancienne sort. */
export const DICTATION_RETENTIONS = [50, 100, 200, 500] as const;

/** Le nombre de dictées conservées. */
export type DictationRetention = (typeof DICTATION_RETENTIONS)[number];

/** Les anciennetés au-delà desquelles une session est purgée. */
export const LIVE_RETENTIONS = ['30d', '3m', '6m', '1y', 'unlimited'] as const;

/** La durée de rétention des sessions. */
export type LiveRetention = (typeof LIVE_RETENTIONS)[number];

/**
 * Ce que le réglage de compte rendu peut valoir — une seule liste pour les Options et pour la
 * fenêtre Direct. `'none'` est en tête et c'est le défaut : l'arrêt d'une session ne produit
 * rien, le compte rendu est un geste.
 *
 * @remarks
 * ⚠️ L'ordre est celui de la cascade — les quatre réunions, les quatre contenus, puis
 * « Personnalisé… » —, et non l'alphabet : `reportTypeGroups` le lit pour bâtir ses branches.
 * ⚠️ Aucun identifiant ne se renomme : ils voyagent dans le fichier de réglages en clair, un
 * renommage ferait retomber tous les utilisateurs sur le défaut sans le dire.
 */
export const LIVE_REPORT_TYPES = [
  'none',
  'custom',
  'team',
  'oneToOne',
  'client',
  'brainstorm',
  'summary',
  'lecture',
  'media',
  'interview',
] as const;
/**
 * Le type de compte rendu retenu dans les réglages.
 *
 * @remarks
 * ⚠️ `'none'` n'est pas un `ReportKind` et les deux types ne fusionnent pas : « ne rien
 * produire » est une réponse de l'interface, et le fondre ferait partir `'none'` dans
 * `generate_live_report`, où Rust le refuserait à la désérialisation.
 * ⚠️ `'custom'` ne se choisit plus dans le menu : on y choisit un PROMPT NOMMÉ, et le réglage
 * garde son numéro dans `liveReportPromptId`. La valeur reste, parce que Rust l'attend toujours
 * comme `ReportKind` — le texte, lui, vient de `report_prompts`, dans la base chiffrée.
 */
export type LiveReportType = (typeof LIVE_REPORT_TYPES)[number];

/** Ce que l'application sait d'elle-même entre deux lancements. */
export interface AppSettings {
  /** Issu du système au premier lancement, explicite ensuite. */
  readonly theme: ThemeName;
  /**
   * La teinte d'accent du thème clair.
   *
   * @remarks
   * ⚠️ Un identifiant de teinte, jamais une couleur : les valeurs vivent dans
   * `accent-palette.ts`, ce qui permet d'en corriger une sans réécrire les réglages déjà
   * enregistrés chez l'utilisateur.
   */
  readonly accentLight: AccentId;
  /** La teinte d'accent du thème sombre, mémorisée indépendamment de celle du thème clair. */
  readonly accentDark: AccentId;
  /** Langue de l'interface, détectée depuis macOS au premier lancement. */
  readonly interfaceLanguage: Language;
  /** Langue parlée par défaut en dictée. */
  readonly dictationLanguage: Language;
  /**
   * Les langues que l'utilisateur a activées pour parler, en dictée comme en session. Pas pour
   * les fichiers : la langue d'un média est détectée, jamais choisie.
   *
   * @remarks
   * ⚠️ Activé n'est pas installé : l'installé se lit du moteur
   * (`EngineCapabilities.installedLocales`), l'activé se lit d'ici. Une lecture du moteur en
   * échec ne doit pas vider les menus, et un pack purgé par macOS ne doit pas effacer un choix.
   * ⚠️ Ne vaut jamais la liste vide — le garde-fou vit dans le modèle, un écran ne protégeant
   * que le chemin qu'il connaît.
   */
  readonly spokenLanguages: readonly Language[];
  /**
   * Les langues vers lesquelles l'utilisateur a choisi de pouvoir traduire.
   *
   * @remarks
   * ⚠️ Vide par défaut : personne ne traduit d'office. « Pas de traduction » reste offert quoi
   * qu'il arrive — c'est une valeur du menu, pas une entrée de cette liste.
   */
  readonly translationLanguages: readonly Language[];
  /**
   * L'identifiant du micro choisi, `null` pour celui du système. Un seul micro pour toute
   * l'application : il se règle dans Options ▸ Général et sert la dictée comme le Direct.
   *
   * @remarks
   * ⚠️ `'none'` n'est pas une valeur d'ici. « Ne pas inclure de micro » est un choix de session,
   * pas un choix d'appareil, et il vit dans {@link AppSettings.liveIncludeMicrophone} : le
   * replier ici ferait apparaître « pas de micro » dans un réglage global, donc pour la dictée,
   * qui ne peut pas s'en passer.
   */
  readonly microphoneId: string | null;
  /**
   * Ma voix est-elle enregistrée pendant un direct ? Un booléen et non un identifiant :
   * l'appareil est choisi une fois pour toutes dans {@link AppSettings.microphoneId}.
   *
   * @remarks
   * ⚠️ Se règle sur l'écran, pas dans les Options : on doit voir au démarrage si sa voix sera
   * enregistrée. Enfoui dans un réglage, on enregistrerait une conférence entière en captant
   * son bureau sans s'en rendre compte — et le transcript le montrerait.
   */
  readonly liveIncludeMicrophone: boolean;
  /**
   * La langue parlée pendant une session, distincte de `dictationLanguage` : on dicte dans sa
   * langue et on assiste à des sessions dans une autre.
   *
   * Toujours prise dans `spokenLanguages` — le sanitiseur s'en porte garant.
   */
  readonly liveLanguage: Language;
  /**
   * Le type de compte rendu proposé par défaut.
   *
   * @remarks
   * ⚠️ Ce réglage propose, il ne déclenche pas : il pré-choisit l'entrée du sélecteur dans la
   * fenêtre-session, et rien ne part avant que l'utilisateur ait désigné une forme.
   */
  readonly liveReportType: LiveReportType;
  /**
   * Le prompt personnalisé retenu comme compte rendu par défaut, `null` sinon.
   *
   * @remarks
   * ⚠️ Compagnon de `liveReportType`, non son remplaçant : celui-là garde sa liste close, celui-ci
   * dit LEQUEL des prompts nommés — les fondre en `custom:<id>` casserait la validation.
   * ⚠️ Un NUMÉRO, pas le contenu : peut donc vivre dans ce fichier en clair, le titre jamais.
   * ⚠️ Un identifiant caduc retombe sur « Pas de compte rendu » à la lecture, pas au sanitiseur.
   */
  readonly liveReportPromptId: number | null;
  /**
   * L'indicateur visuel — la pilule flottante — s'affiche-t-il pendant un direct ?
   *
   * @remarks
   * ⚠️ Ne parle que du direct : en dictée la pilule dure trois secondes, en direct elle peut
   * rester deux heures au-dessus de toutes les applications — donc dans un partage d'écran.
   * ⚠️ L'éteindre laisse le battement de l'icône du tray pour seul repère visible ; rien ne se
   * peint à côté d'elle, et un test de `tray.rs` garde cette porte-là.
   * ⚠️ « Pilule » est un mot de code ; l'interface, elle, dit « indicateur visuel ».
   */
  readonly liveOverlayVisible: boolean;
  /**
   * La langue vers laquelle suivre une session, `'none'` pour ne rien traduire.
   *
   * @remarks
   * ⚠️ Ce réglage propose, il ne gouverne pas une session en cours : il pré-remplit le champ
   * « Traduction » du formulaire déclencheur, et ce que cette session traduit est rangé avec son
   * document. Sans cette séparation, préparer la session suivante changerait la langue de celle
   * qui tourne — les deux fenêtres partagent le même fichier.
   * ⚠️ Distinct de `translationTarget`, qui est celui de la dictée.
   */
  readonly liveTranslationTarget: TranslationTarget;
  /** Maintenir la touche pour parler, ou basculer d'un appui à l'autre. */
  readonly dictationMode: DictationMode;
  /**
   * Le nettoyage par le modèle de langue est-il appliqué aux dictées ?
   *
   * @remarks
   * ⚠️ Allumé par défaut : c'est ce que l'application a toujours fait, et l'éteindre est un
   * choix. Éteint, l'étape n'existe plus — la pilule ne l'annonce pas et le modèle n'est pas
   * appelé. Le Direct n'est pas concerné : il ne nettoie rien.
   */
  readonly cleanupEnabled: boolean;
  /**
   * La reformulation est-elle appliquée aux dictées ?
   *
   * @remarks
   * ⚠️ Séparé de {@link AppSettings.rephrasingMode} pour que le style survive à l'extinction :
   * éteindre puis rallumer retrouve « Professionnel » si c'était lui. Un seul champ portant
   * « aucune » aurait effacé le choix à chaque bascule.
   */
  readonly rephrasingEnabled: boolean;
  /** Le style dans lequel une dictée est réécrite, quand la reformulation est allumée. */
  readonly rephrasingMode: RephrasingMode;
  /** La langue vers laquelle traduire une dictée, `'none'` pour ne rien traduire. */
  readonly translationTarget: TranslationTarget;
  /** Le nombre de dictées gardées dans l'historique. */
  readonly dictationRetention: DictationRetention;
  /** L'ancienneté au-delà de laquelle une session est purgée. */
  readonly liveRetention: LiveRetention;
  /**
   * Les sons de début et de fin d'enregistrement, dictée et Direct confondus — un seul réglage,
   * dans Options ▸ Général.
   *
   * @remarks
   * ⚠️ Les couper ne retire aucune information : chaque son double la pilule, qui apparaît et
   * disparaît aux mêmes instants. C'est ce qui rend l'option inoffensive.
   */
  readonly soundsEnabled: boolean;
  /**
   * L'application apparaît-elle dans le Dock ? **Vrai par défaut** : ne pas voir dans le Dock ce
   * qu'on vient de lancer déroute, et le tray seul se cherche. Qui veut une application qui ne
   * vit que dans la barre des menus la décoche.
   *
   * @remarks
   * ⚠️ Aussi lu par Rust, directement dans le fichier et avant toute fenêtre : la politique
   * d'activation se pose au démarrage, et l'attendre du frontend ferait clignoter l'icône. Le
   * nom de la clé doit donc rester d'accord avec `settings.rs`.
   */
  readonly showInDock: boolean;
  /** Le premier lancement a-t-il été mené à son terme ? */
  readonly onboardingCompleted: boolean;
  /**
   * L'Accessibilité a-t-elle déjà été accordée sur cette machine ?
   *
   * @remarks
   * ⚠️ Sans cette mémoire, « jamais accordée » et « accordée puis disparue » sont le même état
   * pour l'application — or le premier est le travail de l'onboarding, et le second ne s'annonce
   * nulle part : macOS retire l'autorisation sans un mot, et le raccourci global cesse
   * simplement de répondre. Le drapeau ne redescend jamais : il dit un fait passé.
   */
  readonly accessibilityGranted: boolean;

  // ⚠️ `launchAtLogin` n'est pas ici et ne doit pas y revenir : sa vérité vit dans macOS, sous
  // forme d'un élément d'ouverture de session que l'utilisateur peut retirer sans nous prévenir.
  // Un second exemplaire resterait allumé en promettant un démarrage qui n'arrive plus. L'état
  // se lit et s'écrit par le pont — voir `commands/autostart.rs`.
}

/**
 * Ce que l'application vaut sur une machine vierge.
 *
 * `theme` et les langues sont des replis que le premier lancement remplace par ce qu'il détecte
 * du système ; l'anglais est retenu comme la langue la plus largement comprise.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  accentLight: DEFAULT_ACCENT_LIGHT,
  accentDark: DEFAULT_ACCENT_DARK,
  interfaceLanguage: 'en',
  dictationLanguage: 'en',
  spokenLanguages: ['en'],
  translationLanguages: [],
  microphoneId: null,
  liveIncludeMicrophone: true,
  liveLanguage: 'en',
  liveReportType: 'none',
  liveReportPromptId: null,
  // ⚠️ Affiché par défaut : c'est le repère qui se voit sans aller chercher la barre de menus,
  // où l'icône se contente de battre.
  liveOverlayVisible: true,
  liveTranslationTarget: 'none',
  dictationMode: 'hold',
  cleanupEnabled: true,
  rephrasingEnabled: false,
  rephrasingMode: 'standard',
  translationTarget: 'none',
  dictationRetention: 200,
  liveRetention: '6m',
  soundsEnabled: true,
  showInDock: true,
  onboardingCompleted: false,
  accessibilityGranted: false,
};

/** La valeur figure-t-elle dans la liste des valeurs admises ? */
function oneOf<T>(allowed: readonly T[], value: unknown): value is T {
  return allowed.includes(value as T);
}

/**
 * Relit une liste de langues enregistrée, en n'en gardant que ce qui a un sens.
 *
 * Ce qui n'est pas un tableau donne un tableau vide ; les valeurs inconnues sautent une par une
 * — un code retiré du périmètre ne doit pas emporter les autres — et les doublons sont écrasés,
 * un fichier édité à la main pouvant en contenir.
 *
 * @remarks
 * ⚠️ L'ordre d'enregistrement est conservé, pas trié : le tri des menus dépend de la langue de
 * l'interface, le figer ici le rendrait faux dans cinq langues sur six.
 */
function languageList(value: unknown): readonly Language[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: Language[] = [];
  for (const entry of value) {
    if (oneOf(LANGUAGES, entry) && !kept.includes(entry)) {
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * Reconstruit des réglages valides à partir de n'importe quoi.
 *
 * @param raw - Ce que le fichier de réglages a rendu, quelle qu'en soit la forme.
 * @returns Des réglages complets, chaque champ validé séparément.
 *
 * @remarks
 * ⚠️ Le fichier est en clair sur le disque : il peut être tronqué, édité à la main ou écrit par
 * une version future. Un seul champ abîmé ne doit pas faire perdre les autres, d'où un repli par
 * champ et non un repli global.
 */
/**
 * Ce que l'ancien fichier disait de la reformulation, ou `null` s'il ne dit rien d'exploitable.
 *
 * @remarks
 * ⚠️ Ne s'exprime que sur un fichier écrit **avant** l'interrupteur : dès que le booléen existe,
 * il fait foi. Sans cette garde, éteindre la reformulation sur un style choisi se rallumerait
 * seule à la relecture suivante.
 */
function rephrasedBefore(stored: Record<string, unknown>): boolean | null {
  if (typeof stored['rephrasingEnabled'] === 'boolean') {
    return null;
  }
  const before = stored['rephrasingMode'];
  return typeof before === 'string' && before !== 'none' ? true : null;
}

export function sanitiseSettings(raw: unknown): AppSettings {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <T>(key: keyof AppSettings, allowed: readonly T[]): T =>
    oneOf(allowed, stored[key]) ? stored[key] : (DEFAULT_SETTINGS[key] as T);
  const flag = (key: keyof AppSettings): boolean =>
    typeof stored[key] === 'boolean' ? stored[key] : (DEFAULT_SETTINGS[key] as boolean);

  const storedDictationLanguage = pick('dictationLanguage', LANGUAGES);
  const storedLiveLanguage = pick('liveLanguage', LANGUAGES);
  // ⚠️ La migration des anciens fichiers passe par ici, et par nulle part ailleurs : un fichier
  // sans liste de langues en rend une vide, or une liste parlée vide est un état interdit. On
  // retombe sur la langue de dictée déjà enregistrée — rendre les six, ou rendre le défaut
  // anglais, ferait découvrir à l'utilisateur des menus qu'il n'a pas composés.
  const spoken = languageList(stored['spokenLanguages']);
  const spokenLanguages = spoken.length > 0 ? spoken : [storedDictationLanguage];
  const translationLanguages = languageList(stored['translationLanguages']);

  // ⚠️ Les langues retenues, corrigées, avant les cibles : c'est à la langue **corrigée** qu'une
  // cible se compare. Une langue éteinte dans les Options retombe sur la première activée, et
  // comparer à celle du fichier laisserait passer « traduire le français en français ».
  const dictationLanguage = spokenLanguages.includes(storedDictationLanguage)
    ? storedDictationLanguage
    : spokenLanguages[0];
  const liveLanguage = spokenLanguages.includes(storedLiveLanguage)
    ? storedLiveLanguage
    : spokenLanguages[0];

  // ⚠️ Les deux choix courants doivent figurer dans leur liste, sans quoi un écran de travail
  // afficherait une valeur absente de son propre menu — éteindre dans les Options la langue
  // qu'on utilisait suffit à le produire. On retombe sur la première langue activée et sur
  // « pas de traduction », deux états toujours valides.
  const storedTarget = pick('translationTarget', TRANSLATION_TARGETS);
  const storedLiveTarget = pick('liveTranslationTarget', TRANSLATION_TARGETS);

  /**
   * La cible retenue : « aucune » dès qu'elle n'est plus proposable.
   *
   * @param target - La cible lue dans le fichier.
   * @param spokenLanguage - La langue parlée de l'écran, déjà corrigée.
   * @returns La cible, ou `'none'`.
   *
   * @remarks
   * ⚠️ Deux raisons de retomber, et une seule sortie : la cible a été éteinte dans les Options,
   * ou elle est devenue la langue parlée — le menu ne propose ni l'une ni l'autre.
   */
  const target = (target: TranslationTarget, spokenLanguage: Language): TranslationTarget =>
    target !== 'none' && (!translationLanguages.includes(target) || target === spokenLanguage)
      ? 'none'
      : target;

  return {
    theme: pick('theme', THEMES),
    accentLight: pick('accentLight', ACCENT_IDS),
    accentDark: pick('accentDark', ACCENT_IDS),
    interfaceLanguage: pick('interfaceLanguage', LANGUAGES),
    dictationLanguage,
    spokenLanguages,
    translationLanguages,
    microphoneId: typeof stored['microphoneId'] === 'string' ? stored['microphoneId'] : null,
    // ⚠️ Le défaut est `true` : un booléen absent du fichier — première ouverture, ou fichier
    // tronqué — doit inclure le micro, sans quoi une réunion entière s'enregistrerait sans la
    // voix de l'utilisateur, et rien ne l'aurait dit.
    liveIncludeMicrophone:
      typeof stored['liveIncludeMicrophone'] === 'boolean' ? stored['liveIncludeMicrophone'] : true,
    // ⚠️ Même garde que pour la dictée : une langue de session absente des langues activées
    // afficherait dans l'écran une valeur que son propre menu ne propose pas.
    liveLanguage,
    liveReportType: pick('liveReportType', LIVE_REPORT_TYPES),
    liveReportPromptId:
      typeof stored['liveReportPromptId'] === 'number' &&
      Number.isInteger(stored['liveReportPromptId']) &&
      stored['liveReportPromptId'] > 0
        ? stored['liveReportPromptId']
        : null,
    // ⚠️ Le défaut est `true`, comme pour le micro : un booléen absent du fichier doit montrer
    // l'indicateur, sans quoi un enregistrement tournerait sans le moindre repère à l'écran sur
    // une machine où personne n'a rien réglé.
    liveOverlayVisible:
      typeof stored['liveOverlayVisible'] === 'boolean' ? stored['liveOverlayVisible'] : true,
    // ⚠️ La langue parlée comparée est celle du Direct, pas celle de la dictée : on peut dicter
    // en français pendant qu'une session tourne en anglais.
    liveTranslationTarget: target(storedLiveTarget, liveLanguage),
    dictationMode: pick('dictationMode', DICTATION_MODES),
    cleanupEnabled: flag('cleanupEnabled'),
    // ⚠️ **La migration des fichiers écrits avant l'interrupteur passe par ici.** Ils portent un
    // `rephrasingMode` valant un style, ou `'none'` — jamais le booléen. Retomber sur le défaut
    // éteindrait la reformulation de qui l'avait réglée ; on la relit donc dans l'ancien champ.
    rephrasingEnabled: rephrasedBefore(stored) ?? flag('rephrasingEnabled'),
    rephrasingMode: pick('rephrasingMode', REPHRASING_MODES),
    translationTarget: target(storedTarget, dictationLanguage),
    dictationRetention: pick('dictationRetention', DICTATION_RETENTIONS),
    liveRetention: pick('liveRetention', LIVE_RETENTIONS),
    soundsEnabled: flag('soundsEnabled'),
    showInDock: flag('showInDock'),
    onboardingCompleted: flag('onboardingCompleted'),
    accessibilityGranted: flag('accessibilityGranted'),
  };
}
