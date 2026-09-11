/**
 * Les seize teintes d'accent, chacune déclinée en thème clair et en thème sombre.
 *
 * @remarks
 * ⚠️ Fichier généré : le régénérer avec `node scripts/build-accent-palette.mjs`, qui porte le
 * choix des teintes et le calcul des valeurs dérivées. Une valeur corrigée à la main disparaît
 * à la prochaine exécution.
 * ⚠️ `scripts/check-contrast.mjs` remesure cette table à chaque `npm run verify`, en lisant les
 * fonds de `src/styles/themes/` : un fond de thème qui bouge sans régénération fait échouer la
 * vérification.
 */

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
 * Les identifiants des seize teintes, dans l'ordre de la roue chromatique, chaude → froide.
 *
 * C'est l'ordre d'affichage des pastilles dans les Options, sur deux rangées de huit.
 */
export const ACCENT_IDS = [
  'red',
  'orange',
  'amber',
  'gold',
  'olive',
  'green',
  'emerald',
  'teal',
  'cyan',
  'klein',
  'blue',
  'indigo',
  'violet',
  'magenta',
  'fuchsia',
  'rose',
] as const;

/** L'identifiant d'une teinte d'accent — c'est lui qui est enregistré, jamais une couleur. */
export type AccentId = (typeof ACCENT_IDS)[number];

/** La teinte retenue par défaut en thème clair : le bleu Klein. */
export const DEFAULT_ACCENT_LIGHT: AccentId = 'klein';

/** La teinte retenue par défaut en thème sombre : le magenta. */
export const DEFAULT_ACCENT_DARK: AccentId = 'magenta';

/** Les jetons de chaque teinte, dans les deux thèmes. */
export const ACCENT_PALETTE: Readonly<Record<AccentId, AccentTint>> = {
  red: {
    light: { accent: '#b91c1c', accent600: '#d82121', accent50: '#fdf2f2', accentInk: '#b91c1c' },
    dark: { accent: '#b91c1c', accent600: '#d82121', accent50: '#3a0909', accentInk: '#e96c6c' },
  },
  orange: {
    light: { accent: '#c2410c', accent600: '#d0460d', accent50: '#fef5f1', accentInk: '#c2410c' },
    dark: { accent: '#c2410c', accent600: '#d0460d', accent50: '#3e1504', accentInk: '#f2672e' },
  },
  amber: {
    light: { accent: '#b45309', accent600: '#be5709', accent50: '#fef6f0', accentInk: '#b45309' },
    dark: { accent: '#b45309', accent600: '#be5709', accent50: '#3f1d03', accentInk: '#ee6e0c' },
  },
  gold: {
    light: { accent: '#a16207', accent600: '#a66507', accent50: '#fef9f0', accentInk: '#a16207' },
    dark: { accent: '#a16207', accent600: '#a66507', accent50: '#3b2403', accentInk: '#d28009' },
  },
  olive: {
    light: { accent: '#4d7c0f', accent600: '#508110', accent50: '#f8fdf1', accentInk: '#4d7c0f' },
    dark: { accent: '#4d7c0f', accent600: '#508110', accent50: '#1f3206', accentInk: '#66a514' },
  },
  green: {
    light: { accent: '#166534', accent600: '#1c8243', accent50: '#f2fcf6', accentInk: '#166534' },
    dark: { accent: '#166534', accent600: '#1c8243', accent50: '#0b321a', accentInk: '#25a856' },
  },
  emerald: {
    light: { accent: '#065f46', accent600: '#08815f', accent50: '#f1fefa', accentInk: '#065f46' },
    dark: { accent: '#065f46', accent600: '#08815f', accent50: '#033023', accentInk: '#0ba77b' },
  },
  teal: {
    light: { accent: '#0f766e', accent600: '#11847b', accent50: '#f1fdfc', accentInk: '#0f766e' },
    dark: { accent: '#0f766e', accent600: '#11847b', accent50: '#052d2a', accentInk: '#15a398' },
  },
  cyan: {
    light: { accent: '#0e7490', accent600: '#0f7f9e', accent50: '#f1fbfe', accentInk: '#0e7490' },
    dark: { accent: '#0e7490', accent600: '#0f7f9e', accent50: '#06313c', accentInk: '#13a1c8' },
  },
  klein: {
    light: { accent: '#002fa7', accent600: '#0a3bc0', accent50: '#eef1fb', accentInk: '#002fa7' },
    dark: { accent: '#002fa7', accent600: '#0039cb', accent50: '#001342', accentInk: '#608cff' },
  },
  blue: {
    light: { accent: '#1d4ed8', accent600: '#3563e4', accent50: '#f2f5fd', accentInk: '#1d4ed8' },
    dark: { accent: '#1d4ed8', accent600: '#3563e4', accent50: '#08153a', accentInk: '#6f90ec' },
  },
  indigo: {
    light: { accent: '#4338ca', accent600: '#5e54d2', accent50: '#f4f3fc', accentInk: '#4338ca' },
    dark: { accent: '#4338ca', accent600: '#5e54d2', accent50: '#110e34', accentInk: '#8f89df' },
  },
  violet: {
    light: { accent: '#6d28d9', accent600: '#8246de', accent50: '#f6f2fd', accentInk: '#6d28d9' },
    dark: { accent: '#6d28d9', accent600: '#8246de', accent50: '#1c0a38', accentInk: '#a87fe8' },
  },
  magenta: {
    light: { accent: '#a32fa3', accent600: '#bf37bf', accent50: '#fcf3fc', accentInk: '#a32fa3' },
    dark: { accent: '#a32fa3', accent600: '#b03fb0', accent50: '#2a1a2a', accentInk: '#d36bd3' },
  },
  fuchsia: {
    light: { accent: '#a21caf', accent600: '#be21ce', accent50: '#fcf2fd', accentInk: '#a21caf' },
    dark: { accent: '#a21caf', accent600: '#be21ce', accent50: '#350939', accentInk: '#da60e6' },
  },
  rose: {
    light: { accent: '#be185d', accent600: '#de1c6d', accent50: '#fdf1f6', accentInk: '#be185d' },
    dark: { accent: '#be185d', accent600: '#de1c6d', accent50: '#3b071d', accentInk: '#eb609a' },
  },
};
