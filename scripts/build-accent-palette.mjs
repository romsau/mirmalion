#!/usr/bin/env node
/**
 * Génère la table des 16 teintes d'accent de `src/app/core/models/accent-palette.ts`.
 *
 * Chaque teinte fournit quatre jetons, deux fois — une par thème : 128 valeurs, chacune soumise
 * à un seuil de contraste. Seules les 16 teintes de base sont écrites à la main ; les 112 autres
 * sont **dérivées par recherche sous contrainte**, en déplaçant la clarté jusqu'au premier pas
 * qui passe le seuil, donc au plus près de la teinte d'origine.
 *
 * @remarks
 * ⚠️ Il ne juge pas l'esthétique : il garantit un plancher de lisibilité, rien de plus. Deux
 * teintes voisines peuvent produire des encres proches, et c'est à l'œil de le voir.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Les 16 teintes du cadrage §3.8.1 option 5, dans l'ordre de la roue chromatique (chaude →
 * froide). Les hues sémantiques — rouge, orange, vert — sont ici en versions **profondes et
 * mates**, délibérément distinctes des couleurs de statut vives (`--danger`, `--warning`,
 * `--success`) pour ne pas brouiller le sens.
 *
 * ⚠️ La maquette portait une palette **vive** (`#00C8FF`, `#C6FF00`, `#FFD600`…) antérieure à
 * cette décision : mesurée, **12 de ses 16 teintes** portaient le blanc en
 * dessous de 4,5:1 — jusqu'à 1,19:1 pour le citron. Elles étaient inutilisables comme fond.
 */
const TINTS = [
  ['red', '#B91C1C'],
  ['orange', '#C2410C'],
  ['amber', '#B45309'],
  ['gold', '#A16207'],
  ['olive', '#4D7C0F'],
  ['green', '#166534'],
  ['emerald', '#065F46'],
  ['teal', '#0F766E'],
  ['cyan', '#0E7490'],
  ['klein', '#002FA7'],
  ['blue', '#1D4ED8'],
  ['indigo', '#4338CA'],
  ['violet', '#6D28D9'],
  ['magenta', '#A32FA3'],
  ['fuchsia', '#A21CAF'],
  ['rose', '#BE185D'],
];

/**
 * Les fonds sur lesquels une encre d'accent peut se retrouver, par thème.
 *
 * Ils sont **recopiés** de `src/styles/themes/` à dessein : le générateur ne tourne qu'à la
 * main, et `scripts/check-contrast.mjs` — qui, lui, lit les fichiers de thème — revérifie la
 * table produite à chaque `npm run verify`. Un fond qui changerait ici sans être régénéré
 * ferait donc échouer la vérification, pas passer une régression.
 */
const SURFACES = {
  light: ['#ffffff', '#f6f7fb'],
  // La surface élevée (#262a33) est la plus claire des trois, donc la plus exigeante pour une
  // encre claire : c'est elle qui commande.
  dark: ['#1a1c22', '#23262f', '#262a33'],
};

/**
 * Les deux teintes par défaut ne sont **pas** dérivées : elles sont recopiées de la maquette,
 * où elles ont été réglées à la main puis mesurées. La règle globale n° 1 s'applique — un
 * écart de rendu se tranche en faveur de la maquette, y compris contre un calcul.
 *
 * Le générateur les soumet quand même à toutes les contraintes de contraste : épinglé ne veut
 * pas dire dispensé.
 */
const PINNED = {
  'klein.light': {
    accent: '#002fa7',
    accent600: '#0a3bc0',
    accent50: '#eef1fb',
    accentInk: '#002fa7',
  },
  'magenta.dark': {
    accent: '#a32fa3',
    accent600: '#b03fb0',
    accent50: '#2a1a2a',
    // ⚠️ **Ce n'est pas le magenta de la maquette (#cf5fcf), et ce n'est pas non plus une
    // valeur libre.** #cf5fcf tombe à 4,45:1 sur `--surface-soft` — sous le seuil texte. La
    // valeur retenue est celle que la recherche du générateur trouverait : **même teinte, même
    // saturation, la clarté minimale qui passe** les trois fonds sombres, la surface élevée
    // (#262a33) étant la plus exigeante. Vert 107, contre 95 pour la maquette.

    // La première correction avait posé #d873d8 — vert 115, huit points de clarté
    // au-dessus du nécessaire. Trop rose, relevé à l'œil à la revue de clôture de la phase 1,
    // puis remesuré. Ne pas « arrondir » cette valeur : elle est à trois centièmes du seuil.
    accentInk: '#d36bd3',
  },
};

const WHITE = '#ffffff';
const TEXT_MIN = 4.5;
/** Une marge sur le seuil : une valeur pile à 4,50 se retrouve sous le seuil au moindre arrondi. */
const MARGIN = 0.05;

// ---------------------------------------------------------------------------------------------
// Couleur
// ---------------------------------------------------------------------------------------------

function channels(hex) {
  return [0, 2, 4].map((start) => Number.parseInt(hex.slice(1 + start, 3 + start), 16));
}

function luminance(hex) {
  const [red, green, blue] = channels(hex).map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function toHsl(hex) {
  const [red, green, blue] = channels(hex).map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) {
    return { hue: 0, saturation: 0, lightness };
  }
  const delta = max - min;
  const saturation = delta / (lightness > 0.5 ? 2 - max - min : max + min);
  const hue =
    max === red
      ? (green - blue) / delta + (green < blue ? 6 : 0)
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return { hue: hue / 6, saturation, lightness };
}

function toHex({ hue, saturation, lightness }) {
  const component = (offset) => {
    let position = (hue + offset) % 1;
    if (position < 0) {
      position += 1;
    }
    if (saturation === 0) {
      return lightness;
    }
    const high =
      lightness < 0.5
        ? lightness * (1 + saturation)
        : lightness + saturation - lightness * saturation;
    const low = 2 * lightness - high;
    if (position < 1 / 6) return low + (high - low) * 6 * position;
    if (position < 1 / 2) return high;
    if (position < 2 / 3) return low + (high - low) * (2 / 3 - position) * 6;
    return low;
  };
  return `#${[component(1 / 3), component(0), component(-1 / 3)]
    .map((value) => Math.round(clamp(value, 0, 1) * 255))
    .toString()
    .split(',')
    .map((value) => Number(value).toString(16).padStart(2, '0'))
    .join('')}`;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** La même teinte, à une autre clarté. La saturation est conservée : c'est ce qui la garde reconnaissable. */
function atLightness(hex, lightness) {
  const hsl = toHsl(hex);
  return toHex({ ...hsl, lightness: clamp(lightness, 0, 1) });
}

/**
 * Déplace la clarté par pas de 1 % jusqu'à ce que `passes` accepte la couleur.
 *
 * On s'arrête au **premier** pas qui passe : la valeur retenue est donc la plus proche de la
 * teinte d'origine parmi celles qui tiennent le seuil.
 */
function search(hex, direction, passes) {
  const start = toHsl(hex).lightness;
  for (let step = 0; step <= 100; step += 1) {
    const candidate = atLightness(hex, start + (direction * step) / 100);
    if (passes(candidate)) {
      return candidate;
    }
  }
  throw new Error(`aucune clarté ne satisfait la contrainte pour ${hex}`);
}

// ---------------------------------------------------------------------------------------------
// Dérivation des quatre jetons
// ---------------------------------------------------------------------------------------------

const readable = (surfaces) => (candidate) =>
  surfaces.every((surface) => contrast(candidate, surface) >= TEXT_MIN + MARGIN);

const carriesWhite = (candidate) => contrast(WHITE, candidate) >= TEXT_MIN + MARGIN;

/**
 * L'aplat au survol **s'éclaircit** — c'est ce que fait la maquette dans les deux thèmes
 * (`#002FA7` → `#0a3bc0` en clair, `#a32fa3` → `#b03fb0` en sombre).
 *
 * Éclaircir rapproche l'aplat du blanc qu'il porte : on prend donc le pas le plus large qui
 * garde le texte lisible, et on assombrit si même le plus petit échoue.
 */
function hoverOf(accent) {
  const lightness = toHsl(accent).lightness;
  for (let step = 7; step >= 1; step -= 1) {
    const candidate = atLightness(accent, lightness + step / 100);
    if (carriesWhite(candidate)) {
      return candidate;
    }
  }
  return atLightness(accent, lightness - 0.06);
}

/**
 * En thème clair : l'aplat est la teinte elle-même, et l'encre l'est aussi si elle tient sur
 * les deux surfaces claires — sinon on l'assombrit.
 */
function lightTokens(base) {
  const accent = search(base, -1, carriesWhite);
  const accentInk = search(accent, -1, readable(SURFACES.light));
  // Le fond teinté : on part très clair et on redescend juste ce qu'il faut pour que l'encre y
  // tienne. C'est la contrainte inverse des autres — d'où la recherche vers le bas.
  const accent50 = search(atLightness(accent, 0.97), -1, (candidate) =>
    readable([candidate])(accentInk),
  );
  return { accent, accent600: hoverOf(accent), accent50, accentInk };
}

/**
 * En thème sombre : l'aplat reste la teinte (le blanc y tient déjà), mais **l'encre doit
 * s'éclaircir** — aucune des 16 teintes profondes ne passe le seuil texte sur un fond sombre,
 * elles plafonnent entre 1,41 et 3,07:1.
 */
function darkTokens(base) {
  const accent = search(base, -1, carriesWhite);
  const accentInk = search(accent, +1, readable(SURFACES.dark));
  // Le fond teinté part très sombre et s'assombrit encore si l'encre n'y tient pas. Sans cette
  // recherche, une teinte lumineuse à saturation élevée — l'olive — donnait 4,07:1.
  const accent50 = search(atLightness(accent, 0.13), -1, (candidate) =>
    readable([candidate])(accentInk),
  );
  return { accent, accent600: hoverOf(accent), accent50, accentInk };
}

// ---------------------------------------------------------------------------------------------
// Émission
// ---------------------------------------------------------------------------------------------

const entries = TINTS.map(([id, base]) => ({
  id,
  base,
  light: PINNED[`${id}.light`] ?? lightTokens(base),
  dark: PINNED[`${id}.dark`] ?? darkTokens(base),
}));

/**
 * Garde-fou : mieux vaut un générateur qui refuse d'écrire qu'une table qu'il faudrait
 * revérifier. Il couvre aussi les valeurs épinglées — c'est précisément parce qu'elles ne sont
 * pas calculées qu'il faut les mesurer.
 */
for (const { id, light, dark } of entries) {
  const checks = [
    [`${id} clair : blanc sur l'aplat`, contrast(WHITE, light.accent)],
    [`${id} clair : blanc sur le survol`, contrast(WHITE, light.accent600)],
    [`${id} clair : encre sur le fond teinté`, contrast(light.accentInk, light.accent50)],
    ...SURFACES.light.map((surface) => [
      `${id} clair : encre sur ${surface}`,
      contrast(light.accentInk, surface),
    ]),
    [`${id} sombre : blanc sur l'aplat`, contrast(WHITE, dark.accent)],
    [`${id} sombre : blanc sur le survol`, contrast(WHITE, dark.accent600)],
    [`${id} sombre : encre sur le fond teinté`, contrast(dark.accentInk, dark.accent50)],
    ...SURFACES.dark.map((surface) => [
      `${id} sombre : encre sur ${surface}`,
      contrast(dark.accentInk, surface),
    ]),
  ];
  for (const [label, ratio] of checks) {
    if (ratio < TEXT_MIN) {
      throw new Error(`${label} — ${ratio.toFixed(2)}:1, sous le seuil de ${TEXT_MIN}:1`);
    }
  }
}

const block = ({ accent, accent600, accent50, accentInk }) =>
  `{ accent: '${accent}', accent600: '${accent600}', accent50: '${accent50}', accentInk: '${accentInk}' }`;

const table = entries
  .map(
    ({ id, light, dark }) =>
      `  ${id}: {\n    light: ${block(light)},\n    dark: ${block(dark)},\n  },`,
  )
  .join('\n');

const source = `// ⚠️ FICHIER GÉNÉRÉ — ne pas modifier à la main.
    //
// Régénérer avec \`node scripts/build-accent-palette.mjs\`. Ce script porte le raisonnement :
// pourquoi ces 16 teintes, comment les 112 valeurs dérivées sont calculées, et sous quelles
// contraintes de contraste. Corriger une valeur ici la ferait disparaître à la prochaine
// exécution — et ferait mentir la vérification.

// \`scripts/check-contrast.mjs\` remesure cette table à chaque \`npm run verify\`, en lisant les
// fonds dans \`src/styles/themes/\`. Un fond de thème qui bougerait sans régénération fait donc
// échouer la vérification.

/** Les quatre jetons qu'une teinte doit fournir pour repeindre l'application. */
export interface AccentTokens {
  readonly accent: string;
  readonly accent600: string;
  readonly accent50: string;
  readonly accentInk: string;
}

/** Une teinte est un couple : ce qu'elle vaut en thème clair, ce qu'elle vaut en sombre. */
export interface AccentTint {
  readonly light: AccentTokens;
  readonly dark: AccentTokens;
}

/**
 * Dans l'ordre de la roue chromatique, chaude → froide — c'est l'ordre d'affichage des
 * pastilles dans les Options (2 rangées de 8).
 */
export const ACCENT_IDS = [
${TINTS.map(([id]) => `  '${id}',`).join('\n')}
] as const;

export type AccentId = (typeof ACCENT_IDS)[number];

/** Les défauts du cadrage §3.8.1 option 5 : bleu Klein en clair, magenta en sombre. */
export const DEFAULT_ACCENT_LIGHT: AccentId = 'klein';
export const DEFAULT_ACCENT_DARK: AccentId = 'magenta';

export const ACCENT_PALETTE: Readonly<Record<AccentId, AccentTint>> = {
${table}
};
`;

writeFileSync(join(process.cwd(), 'src/app/core/models/accent-palette.ts'), source);

process.stdout.write(
  `${entries.length} teintes générées, ${entries.length * 8} valeurs dérivées.\n`,
);
for (const { id, base, light, dark } of entries) {
  process.stdout.write(
    `  ${id.padEnd(9)} ${base} → clair ${light.accent}/${light.accentInk}  sombre ${dark.accent}/${dark.accentInk}\n`,
  );
}
