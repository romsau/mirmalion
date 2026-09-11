/**
 * Le registre des icônes de l'application : une icône, une forme.
 *
 * Toutes sont extraites de `docs/ui/ui.html`, au trait, en `viewBox="0 0 24 24"`, et héritent
 * de `currentColor` — c'est ce qui permet à un bouton de s'inverser au survol sans dupliquer
 * son icône. Les `<circle>`, `<rect>` et `<line>` de la maquette sont convertis en chemins : le
 * composant n'a qu'une primitive à rendre.
 *
 * @remarks
 * ⚠️ Ni image ni `background-image` : elles ne suivraient pas `currentColor`. Le faux menu
 * macOS de la maquette — pomme, wifi, batterie — n'est pas ici non plus : il simule le système
 * pour la démonstration, l'application n'en dessine aucune.
 */

/**
 * Une forme du tracé.
 *
 * `fill` et `stroke` sont l'exception : par défaut une forme est tracée en `currentColor` et
 * n'est pas remplie. Les rares icônes qui s'en écartent — les pastilles de statut, pleines, et
 * les molettes des curseurs, opaques pour masquer le rail derrière elles — le déclarent.
 */
export interface IconShape {
  /** Le tracé, au format `d` de `<path>`. */
  readonly d: string;
  /** Le remplissage, quand la forme s'écarte du tracé nu. */
  readonly fill?: string;
  /** L'encre du trait, quand elle ne doit pas suivre `currentColor`. */
  readonly stroke?: string;
}

/** Une icône du registre : ses tracés et son épaisseur de trait. */
export interface IconDefinition {
  /** Les tracés, dessinés dans l'ordre. */
  readonly shapes: readonly IconShape[];
  /**
   * L'épaisseur de trait canonique de cette icône, celle qu'elle porte dans la maquette.
   *
   * Elle n'est pas uniforme : les chevrons et les coches sont plus épais parce qu'ils sont
   * rendus plus petits, et une compensation optique s'impose. Un appelant peut la remplacer,
   * mais il vaut mieux corriger la valeur ici que la surcharger partout.
   */
  readonly strokeWidth: number;
}

const line = (d: string): IconShape => ({ d });

const REGISTRY = {
  // Navigation et chrome
  'chevron-left': {
    shapes: [line('m15 6-6 6 6 6')],
    strokeWidth: 2.2,
  },
  'chevron-right': {
    shapes: [line('m9 6 6 6-6 6')],
    strokeWidth: 2.2,
  },
  'chevron-down': {
    shapes: [line('m6 9 6 6 6-6')],
    strokeWidth: 2,
  },
  menu: {
    shapes: [line('M4 7h16M4 12h16M4 17h16')],
    strokeWidth: 2,
  },
  close: {
    shapes: [line('M6 6l12 12M18 6L6 18')],
    strokeWidth: 2.4,
  },
  plus: {
    shapes: [line('M12 5v14M5 12h14')],
    strokeWidth: 2.2,
  },
  check: {
    shapes: [line('m5 12 5 5 9-11')],
    strokeWidth: 2.6,
  },
  search: {
    shapes: [line('M4 11a7 7 0 1 0 14 0a7 7 0 1 0 -14 0'), line('m21 21-4.3-4.3')],
    strokeWidth: 2,
  },

  // Actions
  trash: {
    shapes: [
      line(
        'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14',
      ),
    ],
    strokeWidth: 2,
  },
  copy: {
    shapes: [
      line('M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z'),
      line('M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1'),
    ],
    strokeWidth: 2,
  },
  pencil: {
    shapes: [line('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')],
    strokeWidth: 2,
  },
  download: {
    shapes: [line('M12 3v12'), line('m7 10 5 5 5-5'), line('M5 21h14')],
    strokeWidth: 2,
  },
  refresh: {
    shapes: [
      line('M3 12a9 9 0 0 1 15-6.7L21 8'),
      line('M21 3v5h-5'),
      line('M21 12a9 9 0 0 1-15 6.7L3 16'),
      line('M3 21v-5h5'),
    ],
    strokeWidth: 2,
  },
  undo: {
    shapes: [line('M3 12a9 9 0 1 0 3-6.7L3 8'), line('M3 3v5h5')],
    strokeWidth: 2,
  },
  /** L'anneau tournant. C'est la rotation, portée par le CSS, qui en fait un indicateur. */
  spinner: {
    shapes: [line('M21 12a9 9 0 1 1-6.2-8.6')],
    strokeWidth: 2,
  },

  // Dictée, session, fichiers
  /** Le micro sur pied — l'icône de la dictée. */
  mic: {
    shapes: [
      line('M12 3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3v-5a3 3 0 0 1 3 -3z'),
      line('M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8'),
    ],
    strokeWidth: 2,
  },
  /** Le même micro sans son socle, pour le rail des Options. */
  'mic-plain': {
    shapes: [
      line('M12 3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3v-5a3 3 0 0 1 3 -3z'),
      line('M6 11a6 6 0 0 0 12 0M12 17v4'),
    ],
    strokeWidth: 2,
  },
  document: {
    shapes: [line('M14 3v5h5'), line('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z')],
    strokeWidth: 2,
  },
  /** Le document lignné du transcript — les lignes le distinguent du document nu. */
  transcript: {
    shapes: [
      line('M14 3v5h5M8 13h8M8 17h8M8 9h2'),
      line('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z'),
    ],
    strokeWidth: 2,
  },
  'file-lines': {
    shapes: [
      line('M14 3v4a1 1 0 0 0 1 1h4'),
      line('M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z'),
      line('M9 13h6M9 17h4'),
    ],
    strokeWidth: 2,
  },
  folder: {
    shapes: [
      line(
        'M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7.6l-1.7-2.3a1 1 0 0 0-.8-.4H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1z',
      ),
    ],
    strokeWidth: 1.9,
  },
  /** Les barres d'un signal audio — la zone de dépôt d'un média. */
  waveform: {
    shapes: [line('M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4')],
    strokeWidth: 2,
  },
  translate: {
    shapes: [
      line('m5 8 6 6'),
      line('m4 14 6-6 2-3'),
      line('M2 5h12'),
      line('M7 2h1'),
      line('m22 22-5-10-5 10'),
      line('M14 18h6'),
    ],
    strokeWidth: 2,
  },

  // Modes de dictée
  /** Le point d'enregistrement — « Maintenir ». */
  'mode-hold': {
    shapes: [
      line('M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0'),
      line('M9.4 12a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0'),
    ],
    strokeWidth: 2,
  },
  /** Les ondes concentriques — « Mains libres ». */
  'mode-handsfree': {
    shapes: [
      line('M9.3 12a2.7 2.7 0 1 0 5.4 0a2.7 2.7 0 1 0 -5.4 0'),
      line('M8.6 8.6a4.8 4.8 0 0 0 0 6.8'),
      line('M15.4 8.6a4.8 4.8 0 0 1 0 6.8'),
      line('M5.8 5.8a9 9 0 0 0 0 12.4'),
      line('M18.2 5.8a9 9 0 0 1 0 12.4'),
    ],
    strokeWidth: 2,
  },

  // Réglages
  /**
   * Les curseurs des Options. Les molettes sont **remplies de la surface** : c'est ce qui
   * masque le rail derrière elles et donne la profondeur.
   */
  sliders: {
    shapes: [
      line('M4 7L20 7'),
      { d: 'M6.6 7a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0', fill: 'var(--surface)' },
      line('M4 17L20 17'),
      { d: 'M12.6 17a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0', fill: 'var(--surface)' },
    ],
    strokeWidth: 2,
  },
  sun: {
    shapes: [
      line('M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0'),
      line(
        'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
      ),
    ],
    strokeWidth: 2,
  },
  moon: {
    shapes: [line('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z')],
    strokeWidth: 2,
  },
  clock: {
    shapes: [line('M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0'), line('M12 7v5l3 2')],
    strokeWidth: 2,
  },
  /**
   * Deux bulles qui se répondent — la famille Langues.
   *
   * @remarks
   * - ⚠️ Pas de globe : sur le web il dit « réseau », contresens exact pour une application
   *   dont rien ne sort de la machine, et ses méridiens font un pâté à 16 px, la taille à
   *   laquelle le rail la rend.
   * - ⚠️ La forme « A 文 » n'est pas celle-ci : c'est `translate`, déjà au registre.
   */
  bubbles: {
    shapes: [
      line('M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z'),
      line('M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1'),
    ],
    strokeWidth: 2,
  },
  /**
   * Le livre — la famille Dictionnaire.
   *
   * @remarks
   * ⚠️ Aucune page de texte ne la remplace : `document` désigne la famille Fichiers,
   * `transcript` et `file-lines` diraient « un fichier » et non « un lexique qu'on consulte ».
   * C'est la marche de reliure à gauche qui distingue le livre des trois pages à 16 px.
   */
  book: {
    shapes: [
      line(
        'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
      ),
    ],
    strokeWidth: 2,
  },
  /**
   * La puce — les moteurs et modèles.
   *
   * @remarks
   * ⚠️ Boîtier de 15 × 15 sur la grille de 24, cœur à 5,6 : à 10 × 10, cœur et contour
   * n'étaient plus séparés que d'une fraction de pixel à 16 px et se confondaient en un bloc
   * plein.
   */
  engine: {
    shapes: [
      line(
        'M7.7 4.5h8.6a3.2 3.2 0 0 1 3.2 3.2v8.6a3.2 3.2 0 0 1-3.2 3.2H7.7a3.2 3.2 0 0 1-3.2-3.2V7.7a3.2 3.2 0 0 1 3.2-3.2z',
      ),
      line(
        'M10.6 9.2h2.8a1.4 1.4 0 0 1 1.4 1.4v2.8a1.4 1.4 0 0 1-1.4 1.4h-2.8a1.4 1.4 0 0 1-1.4-1.4v-2.8a1.4 1.4 0 0 1 1.4-1.4z',
      ),
      line(
        'M9 1.6v2.9M15 1.6v2.9M9 19.5v2.9M15 19.5v2.9M1.6 9h2.9M1.6 15h2.9M19.5 9h2.9M19.5 15h2.9',
      ),
    ],
    strokeWidth: 2,
  },
  /** Le volume — un modèle téléchargé. */
  cube: {
    shapes: [
      line(
        'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
      ),
      line('m3.3 7 8.7 5 8.7-5M12 22V12'),
    ],
    strokeWidth: 1.8,
  },
  keyboard: {
    shapes: [
      line('M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z'),
      line('M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8'),
    ],
    strokeWidth: 2,
  },
  screen: {
    shapes: [
      line('M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2z'),
      line('M8 21h8M12 17v4'),
    ],
    strokeWidth: 2,
  },
  /**
   * L'écran qui sonne — le Direct. Elle ferme le trio des sources : `mic` pour ma voix,
   * celle-ci pour l'écran, `document` pour un fichier.
   *
   * @remarks
   * ⚠️ Ce n'est pas un doublon de `screen` : `screen` dit l'appareil — l'autorisation
   * d'enregistrement d'écran, à l'onboarding —, celle-ci dit le son qui en sort maintenant. Les
   * barres à l'intérieur sont la seule différence, et elles sont l'icône.
   */
  'screen-wave': {
    shapes: [
      line('M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2z'),
      line('M8 21h8M12 17v4'),
      line('M7.5 9v3M10.5 7v7M13.5 8.2v4.6M16.5 9.4v2.2'),
    ],
    strokeWidth: 2,
  },

  // Alertes et statuts
  'alert-triangle': {
    shapes: [
      line('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'),
      line('M12 9v4M12 17h.01'),
    ],
    strokeWidth: 2,
  },
  /**
   * Les trois pastilles de statut, seules icônes pleines du registre.
   *
   * @remarks
   * ⚠️ Elles ne peuvent pas hériter de `currentColor` : leur sens est leur couleur. Le glyphe
   * intérieur prend l'encre assortie à l'aplat, jamais le blanc par défaut, qui ne tient pas
   * sur l'orange.
   */
  'status-success': {
    shapes: [
      { d: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', fill: 'var(--success)', stroke: 'none' },
      { d: 'm7.5 12.4 3 3 6-6.4', stroke: 'var(--success-on)' },
    ],
    strokeWidth: 2.3,
  },
  'status-warning': {
    shapes: [
      { d: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', fill: 'var(--warning)', stroke: 'none' },
      { d: 'M12 7v6M12 16.4h.01', stroke: 'var(--warning-on)' },
    ],
    strokeWidth: 2.3,
  },
  'status-error': {
    shapes: [
      { d: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', fill: 'var(--danger)', stroke: 'none' },
      { d: 'M12 7v6M12 16.4h.01', stroke: 'var(--danger-on)' },
    ],
    strokeWidth: 2.3,
  },
} as const satisfies Record<string, IconDefinition>;

/**
 * Le nom d'une icône, typé.
 *
 * @remarks
 * ⚠️ C'est ce qu'un registre apporte sur un sprite : `name="trahs"` ne compile pas, là où
 * `<use href="#i-trahs">` échouerait en silence à l'exécution.
 */
export type IconName = keyof typeof REGISTRY;

/**
 * Le registre, réexposé en {@link IconDefinition}.
 *
 * @remarks
 * ⚠️ L'annotation est nécessaire : sous `as const`, `fill` et `stroke` n'existent que sur les
 * entrées qui les déclarent, et un consommateur ne pourrait pas les lire uniformément. Le nom,
 * lui, reste tiré du littéral — le typage des clés sans celui des valeurs.
 */
export const ICONS: Readonly<Record<IconName, IconDefinition>> = REGISTRY;

/** Tous les noms d'icônes, dans l'ordre du registre. */
export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];
