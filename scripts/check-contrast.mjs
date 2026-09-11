#!/usr/bin/env node
/**
 * Vérifie les contrastes des jetons de couleur, dans les deux thèmes.
 *
 * La definition of done exige 4,5:1 sur le texte et 3:1 sur les icônes et bordures. Vérifié
 * à l'œil, ce critère se dégrade au premier ajustement de jeton. Vérifié ici, il tient.
 *
 * Le script lit les valeurs **dans les fichiers de thème** — il n'en connaît aucune. Changer
 * un jeton change donc ce qui est mesuré, sans toucher au script. En contrepartie, il ne sait
 * lire que `--nom: #hex;` et `--nom: color-mix(in srgb, var(--a) N%, var(--b));` : c'est
 * exactement ce que contiennent `themes/_light.scss` et `_dark.scss`, et c'est une raison de
 * plus de les garder ainsi.
 *
 * ⚠️ Ce contrôle mesure des **couples de jetons**, pas des rendus. Un composant qui poserait
 * du texte `--muted` sur un fond `--accent` échapperait à cette liste. L'audit visuel de la
 * phase 6 reste nécessaire.
 *
 * ⚠️ Aucune suite ne couvre ce script : lancer `--selftest` avant de croire un vert.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const THEMES = {
  clair: 'src/styles/themes/_light.scss',
  sombre: 'src/styles/themes/_dark.scss',
};

/** Le blanc pur, utilisé comme encre sur les aplats pleins. Ce n'est pas un jeton. */
const WHITE = '#ffffff';

/**
 * Les couples à vérifier. `bg` et `fg` sont des noms de jetons, sauf `#…` pris littéralement.
 *
 * `min` vaut 4.5 pour du texte, 3 pour ce qui n'est que forme : bordures, filets, icônes.
 */
const PAIRS = [
  // Texte sur les deux surfaces de l'application.
  { fg: '--ink', bg: '--surface', min: 4.5 },
  { fg: '--ink', bg: '--surface-soft', min: 4.5 },
  { fg: '--muted', bg: '--surface', min: 4.5 },
  { fg: '--muted', bg: '--surface-soft', min: 4.5 },

  // ⚠️ **Un texte d'attente EST du texte, et 4,5:1 s'y applique** (WCAG 1.4.3). Il a d'abord été
  // éclairci à l'œil — `--muted` dilué à 62 % dans la surface —, ce qui l'a mis à **2,43:1** en
  // thème clair sans qu'aucun contrôle ne bronche : il ne vivait pas dans `themes/`, mais dans un
  // `color-mix` écrit à l'intérieur d'un mixin. Le fond du champ étant `--surface`, c'est ce
  // couple-là qui est mesuré, et son jumeau élevé juste en dessous.
  { fg: '--placeholder-ink', bg: '--surface', min: 4.5 },
  { fg: '--ink', bg: '--key-bg', min: 4.5 },

  // La barre de notification, qui ne suit pas la règle d'élévation en thème clair : son fond
  // et celui de ses contrôles neutres sont deux jetons à part, donc deux couples à mesurer.
  { fg: '--ink', bg: '--snack-surface', min: 4.5 },
  { fg: '--ink', bg: '--snack-control', min: 4.5 },
  { fg: '--ink', bg: '--snack-control-active', min: 4.5 },
  { fg: '--muted', bg: '--snack-surface', min: 4.5 },

  // L'accent : encre sur les surfaces, blanc sur l'aplat.
  { fg: '--accent-ink', bg: '--surface', min: 4.5 },
  { fg: '--accent-ink', bg: '--surface-soft', min: 4.5 },
  { fg: '--accent-ink', bg: '--accent-50', min: 4.5 },
  // L'icône de la barre de mise à jour : une forme, d'où 3:1.
  { fg: '--accent-ink', bg: '--snack-surface', min: 3 },
  { fg: '--accent-on', bg: '--accent', min: 4.5 },
  { fg: '--accent-on', bg: '--accent-600', min: 4.5 },

  // ⚠️ L'ORANGE PORTE UNE EXCEPTION DÉLIBÉRÉE — décision du porteur,.

  // ⚠️ **PÉRIMÈTRE RÉDUIT** : l'orange n'est plus une couleur de BOUTON, il ne
  // sert plus qu'à la signalétique d'état non cliquable (snackbar d'erreur, tag « à
  // autoriser », encart de confidentialité, icône d'avertissement). L'exception ne concerne
  // donc plus que du TEXTE de tag et une icône — voir le détail couple par couple ci-dessous.

  // Un orange vif est une couleur CLAIRE : écrit sur fond clair il plafonne à 3,04:1, et le
  // blanc posé dessus aussi. Les deux voies conformes ont été construites, rendues sur la
  // maquette et refusées : un orange assombri jusqu'à porter le blanc (#BF4E00, 4,88:1) et
  // une encre foncée sur l'aplat vif (5,95:1). Motif du refus : l'orange est la couleur
  // d'AVERTISSEMENT du produit ; terni, il ne remplit plus son office.

  // Le seuil de ces couples est donc abaissé — mais PAS supprimé, et à la valeur réellement
  // mesurée, pas à zéro. Le plancher est 2,5:1 : si un futur ajustement faisait descendre
  // l'orange plus bas, ce script le dirait. Les autres rôles de l'orange gardent 4,5:1.

  // Valeurs constatées en thème clair, du plus favorable au moins favorable :
  //   sur --surface (#fff) .......... 3,04:1
  //   sur --surface-soft ............ 2,84:1
  //   sur --warning-50 .............. 2,61:1

  // ⚠️ `#d66412` tiendrait 3:1 sur les trois, pour un écart de teinte à peine perceptible.
  // Proposé au porteur ; sa couleur a été maintenue.

  // ⚠️ L'exception ne vaut que pour le thème CLAIR : en sombre, `--warning-ink` (#f2a24e)
  // donne 8,15:1. Le seuil est commun aux deux thèmes faute d'être exprimable par thème, mais
  // le sombre le dépasse largement — il n'y a rien à y assouplir.
  // ⚠️ Ce couple N'EST PLUS UNE EXCEPTION depuis. Il ne portait du TEXTE que sur
  // les boutons orange, qui ont disparu ; son seul emploi restant est l'ICÔNE d'avertissement
  // (glyphe blanc dans un disque orange). Une icône relève de WCAG 1.4.11 « non-text
  // contrast », dont le seuil est 3:1 — et 3,04:1 le passe. Seuil relevé en conséquence, sans
  // marqueur d'exception : il n'y en a plus ici.
  { fg: '--warning-on', bg: '--warning', min: 3 },
  { fg: '--warning-ink', bg: '--surface', min: 2.5, exception: 'orange vif' },
  { fg: '--warning-ink', bg: '--surface-soft', min: 2.5, exception: 'orange vif' },
  // ⚠️ **CE COUPLE A QUITTÉ L'EXCEPTION**, et c'est le porteur qui l'a vu à
  // l'œil avant qu'aucun outil ne le signale : « dans les chips orange on lit pas bien ». Le
  // chiffre était pourtant là, deux lignes plus haut — 2,61:1, le plus mauvais des trois, et
  // sous le plancher de 3:1 que l'exception se donnait dans `_light.scss`. **Un seuil abaissé
  // à la valeur mesurée ne protège de rien : il enregistre.** Celui-ci a laissé passer
  // pendant quatre jours du texte à 11,5 px qu'on ne pouvait pas lire.

  // Le texte posé sur l'aplat teinté a donc son propre jeton, `--warning-on-50`, exigé à
  // **4,5:1 sans exception**. L'orange d'alerte n'a pas bougé : les deux lignes ci-dessus
  // gardent leur écart, pour les emplois où l'orange vif est le message.
  { fg: '--warning-on-50', bg: '--warning-50', min: 4.5 },
  { fg: '--ink', bg: '--warning-50', min: 4.5 },

  // Le rouge et le vert, construits sur la même logique à trois rôles — mais eux gardent le
  // blanc sur l'aplat, contrairement à l'orange.
  { fg: '--danger-on', bg: '--danger', min: 4.5 },
  { fg: '--danger-ink', bg: '--surface', min: 4.5 },
  { fg: '--danger-ink', bg: '--surface-soft', min: 4.5 },
  { fg: '--danger-ink', bg: '--danger-50', min: 4.5 },
  { fg: '--ink', bg: '--danger-50', min: 4.5 },
  { fg: '--success-on', bg: '--success', min: 4.5 },
  { fg: '--success-ink', bg: '--surface', min: 4.5 },
  { fg: '--success-ink', bg: '--surface-soft', min: 4.5 },
  { fg: '--success-ink', bg: '--success-50', min: 4.5 },
  { fg: '--ink', bg: '--success-50', min: 4.5 },

  // ⚠️ **L'arbitrage de `--line` est tranché.** Deux voies étaient ouvertes — relever `--line`, ou lui adjoindre un second
  // jeton. C'est le **second jeton** qui l'emporte, et le motif est un motif de dégât
  // collatéral : `--line` est employé **40 fois**, dont l'écrasante majorité en **filets de
  // séparation** — sous chaque ligne de réglage, entre les colonnes du transcript, sur le bord
  // de chaque carte. Les relever tous à 3:1 aurait transformé l'application en quadrillage
  // pour corriger **huit** contrôles.

  // Le partage, et c'est lui qu'il faut relire avant d'employer l'un ou l'autre :

  //   `--line`         SÉPARE — filets, arêtes, bords de carte, rail de défilement, `kbd`.
  //                    Décoratif au sens de WCAG 1.4.11, qui l'exempte. **Reste à 1,25:1.**
  //   `--line-strong`  BORDE UN CONTRÔLE que rien d'autre ne signale. **3:1 exigé.**

  // ⚠️ **Le critère n'est pas « est-ce cliquable »**, c'est **« qu'est-ce qui dirait à
  // l'utilisateur que le contrôle est là si le trait n'y était pas »**. Une carte de langue
  // porte un nom et un interrupteur ; une ligne d'historique porte son texte ; le rond de
  // repli porte un chevron à 10,69:1. Tous restent en `--line`. Un **champ de saisie vide**,
  // lui, n'a ni texte, ni icône, ni fond distinct de la page — le sien est `--surface-soft`,
  // à 1,04:1 de `--surface`. Son trait est la seule chose qui existe.

  // Les huit : les deux mixins de champ (`field-surface`, `prompt-field`), `select`, la barre
  // de recherche du dictionnaire, celle de l'historique, le champ de terme, le titre éditable
  // en ligne — et le **rail de l'interrupteur éteint**, qui était le pire cas de tous.

  // ⚠️ **Ces couples n'ont pas d'`exception` et ne doivent jamais en recevoir une.** Ce qui a
  // été négocié ici est le **périmètre** du seuil, jamais sa valeur : les jetons sont calés
  // sur la valeur la plus discrète qui tienne 3:1, si bien qu'un éclaircissement d'un seul
  // cran fait tomber ce contrôle. C'est voulu.
  { fg: '--line-strong', bg: '--surface', min: 3 },
  { fg: '--line-strong', bg: '--surface-soft', min: 3 },
  // Le rond de repli garde `--line`, mais `--accent-50` reste mesuré : c'est le fond teinté le
  // plus sombre du thème clair, donc le pire cas si un champ venait un jour s'y poser.
  { fg: '--line-strong', bg: '--accent-50', min: 3 },

  // Les surfaces élevées (modales, panneaux, snackbar) redéfinissent quatre jetons : le texte
  // qu'elles portent doit rester lisible, sinon le mécanisme d'élévation se paie en lisibilité.
  { fg: '--ink', bg: '--elevated-surface', min: 4.5 },
  { fg: '--muted', bg: '--elevated-surface', min: 4.5 },
  { fg: '--ink', bg: '--elevated-surface-soft', min: 4.5 },
  { fg: '--accent-ink', bg: '--elevated-surface', min: 4.5 },
  { fg: '--accent-ink', bg: '--elevated-surface-soft', min: 4.5 },
  { fg: '--danger-ink', bg: '--elevated-surface', min: 4.5 },
  { fg: '--warning-ink', bg: '--elevated-surface', min: 2.5, exception: 'orange vif' },
  { fg: '--success-ink', bg: '--elevated-surface', min: 4.5 },
  // `--elevated-line` est absent pour la même raison que `--line` : il sépare.
  // ⚠️ **`--elevated-line-strong` A SA PROPRE VALEUR, ET LA MESURER ICI N'EST PAS UNE
  // FORMALITÉ** : en thème sombre la surface élevée est plus CLAIRE que le fond de
  // l'application (#262a33 contre #1a1c22). Un champ dans une modale qui aurait gardé le trait
  // du fond serait repassé sous 3:1 **sans que rien ne le dise** — le mixin `elevated-surface`
  // remappe donc le jeton, et ces deux lignes vérifient qu'il a de quoi le faire.
  { fg: '--elevated-line-strong', bg: '--elevated-surface', min: 3 },
  { fg: '--elevated-line-strong', bg: '--elevated-surface-soft', min: 3 },
  { fg: '--elevated-placeholder-ink', bg: '--elevated-surface', min: 4.5 },
];

/**
 * Le filet de sous-liste, dans les **deux jeux** de jetons — l'application et les surfaces
 * élevées, comme `--line-strong`.
 *
 * ⚠️ **Ce ne sont pas des couples WCAG** : `--line-soft` est décoratif, exempté par 1.4.11
 * comme `--line`. C'est son **rang** qui se mesure, dans les deux sens : effacé il ne rythme
 * plus rien, aussi marqué que `--line` il met au même rang la frontière entre deux réglages
 * et le rythme interne d'une liste — ce que le jeton existe justement pour distinguer.
 */
const SOFT_LINES = [
  { soft: '--line-soft', line: '--line', bg: '--surface' },
  { soft: '--elevated-line-soft', line: '--elevated-line', bg: '--elevated-surface' },
];

/**
 * Le plancher de visibilité du filet doux, sur la surface d'où il est calculé.
 *
 * Mesuré au mélange livré : 1,13:1 en clair, 1,12:1 en sombre, 1,19:1 sur la surface élevée
 * sombre. Ce n'est pas un seuil WCAG, c'est ce qui reste avant l'invisibilité.
 */
const SOFT_LINE_FLOOR = 1.1;

/**
 * Extrait `--nom: #hex;` et `--nom: color-mix(…);` d'un thème ; le reste est ignoré.
 *
 * La valeur est gardée **telle qu'écrite** : un `color-mix` ne se calcule qu'à la demande, si
 * bien qu'un jeton dérivé qu'aucun couple ne mesure — `--drop-tint` — n'a pas à être résoluble.
 */
function readTokens(path) {
  const source = readFileSync(join(process.cwd(), path), 'utf8');
  const tokens = new Map();
  const declaration = /(--[\w-]+):\s*(#[0-9a-fA-F]{3,8}|color-mix\([^;]*\))\s*;/g;
  for (const [, name, value] of source.matchAll(declaration)) {
    tokens.set(name, value);
  }
  return tokens;
}

/** `#abc`, `#aabbcc` → canaux 0–255. Les formes à 4 et 8 chiffres (alpha) sont refusées. */
function channels(hex) {
  const digits = hex.slice(1);
  if (digits.length === 3) {
    return [...digits].map((digit) => Number.parseInt(digit + digit, 16));
  }
  if (digits.length === 6) {
    return [0, 2, 4].map((start) => Number.parseInt(digits.slice(start, start + 2), 16));
  }
  throw new Error(`couleur non opaque ou mal formée : ${hex}`);
}

/** Luminance relative, WCAG 2.x. */
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

/** La seule forme de `color-mix` employée par les thèmes, et la seule que ce script sait lire. */
const COLOR_MIX = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/;

/**
 * `color-mix(in srgb, first share%, second)` sur deux couleurs opaques : un mélange linéaire,
 * canal par canal, sans prémultiplication puisqu'il n'y a pas d'alpha.
 */
function mix(first, second, share) {
  const [from, to] = [channels(first), channels(second)];
  const channel = (value, index) =>
    Math.round(value * share + to[index] * (1 - share))
      .toString(16)
      .padStart(2, '0');
  return `#${from.map(channel).join('')}`;
}

/**
 * Un nom de jeton se résout dans le thème ; un `#hex` se prend tel quel.
 *
 * ⚠️ Un jeton **dérivé** se calcule, il ne se lit pas : `--line-soft` n'a de valeur que celle
 * de `--line` et `--surface` du thème courant.
 */
function resolve(tokens, reference, theme) {
  if (reference.startsWith('#')) {
    return reference;
  }
  const value = tokens.get(reference);
  if (value === undefined) {
    throw new Error(`jeton absent du thème ${theme} : ${reference}`);
  }
  if (value.startsWith('#')) {
    return value;
  }
  const parts = COLOR_MIX.exec(value);
  if (parts === null) {
    throw new Error(`jeton illisible dans le thème ${theme} : ${reference}`);
  }
  const [, first, share, second] = parts;
  return mix(resolve(tokens, first, theme), resolve(tokens, second, theme), Number(share) / 100);
}

let failed = 0;
let checked = 0;

/**
 * Les couples dont le seuil a été délibérément abaissé, par motif.
 *
 * ⚠️ **Ils sont COMPTÉS et AFFICHÉS**, jamais silencieux. Une exception qu'on ne voit plus
 * finit par ne plus être une exception : le rapport la rappelle à chaque exécution.
 */
const exceptions = new Map();

function assert(label, ratio, min, exception) {
  checked += 1;
  if (exception) {
    exceptions.set(exception, (exceptions.get(exception) ?? 0) + 1);
  }
  if (ratio < min) {
    failed += 1;
    process.stdout.write(`✗ ${label} : ${ratio.toFixed(2)}:1 (minimum ${min}:1)\n`);
  }
}

/** L'inverse d'`assert` : un rapport qui doit rester **sous** un plafond. */
function assertSofter(label, ratio, ceiling) {
  checked += 1;
  if (ratio >= ceiling) {
    failed += 1;
    process.stdout.write(`✗ ${label} : ${ratio.toFixed(2)}:1 (plafond ${ceiling.toFixed(2)}:1)\n`);
  }
}

/**
 * Soumet les règles du script à des cas dont la réponse est connue.
 *
 * ⚠️ **Il sort du processus dans les deux cas** : le corps qui mesure les thèmes est au niveau
 * du module, donc rendre la main le ferait tourner derrière l'autotest.
 */
function selftest() {
  const failures = [];
  let count = 0;
  // ⚠️ Le nombre s'annonce en comptant, jamais en dur : un total écrit à la main survit à
  // l'ajout d'un contrôle et annonce alors une couverture qu'il n'a plus.
  const expect = (what, condition) => {
    count += 1;
    if (!condition) {
      failures.push(what);
    }
  };
  const refuses = (what, run) => {
    let thrown = false;
    try {
      run();
    } catch {
      thrown = true;
    }
    expect(what, thrown);
  };

  expect('le noir sur le blanc vaut 21:1', Math.abs(contrast('#ffffff', '#000000') - 21) < 0.01);
  expect('une couleur sur elle-même vaut 1:1', contrast('#e4e6ee', '#e4e6ee') === 1);
  expect(
    'le rapport ne dépend pas de l’ordre',
    contrast('#000', '#fff') === contrast('#fff', '#000'),
  );
  refuses('une couleur à alpha est refusée', () => channels('#ffffff80'));
  refuses('une couleur mal formée est refusée', () => channels('#fffff'));

  expect('un mélange à moitié tombe au milieu', mix('#ffffff', '#000000', 0.5) === '#808080');
  expect('un mélange à 100 % rend la première', mix('#e4e6ee', '#ffffff', 1) === '#e4e6ee');
  expect('un mélange à 0 % rend la seconde', mix('#e4e6ee', '#ffffff', 0) === '#ffffff');

  const tokens = new Map([
    ['--line', '#e4e6ee'],
    ['--surface', '#ffffff'],
    ['--line-soft', 'color-mix(in srgb, var(--line) 55%, var(--surface))'],
    ['--tordu', 'color-mix(in oklab, var(--line) 55%, var(--surface))'],
  ]);
  expect('un jeton hexadécimal se lit tel quel', resolve(tokens, '--line', 'test') === '#e4e6ee');
  expect('un `#hex` littéral se prend tel quel', resolve(tokens, '#123456', 'test') === '#123456');
  expect('un jeton dérivé se calcule', resolve(tokens, '--line-soft', 'test') === '#f0f1f6');
  // ⚠️ Le défaut réellement survenu, encodé : le texte d'attente dilué à 62 % dans le blanc
  // tombe à 2,43:1, et le seuil du texte doit le voir.
  expect(
    'un texte d’attente trop pâli tombe sous AA',
    contrast(mix('#6b7080', '#ffffff', 0.62), '#ffffff') < 4.5,
  );
  expect('la part livrée le tient', contrast(mix('#6b7080', '#ffffff', 0.96), '#ffffff') >= 4.5);
  refuses('un jeton absent est refusé', () => resolve(tokens, '--fantome', 'test'));
  refuses('un mélange non reconnu est refusé', () => resolve(tokens, '--tordu', 'test'));

  // ⚠️ Les deux verdicts se vérifient **par leurs effets** — ils comptent et ils écrivent. La
  // sortie est donc mise en sourdine le temps de les éprouver, sinon l'autotest afficherait
  // des ✗ qui n'en sont pas.
  const written = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  const verdicts = [];
  const seen = (run) => {
    const before = failed;
    run();
    verdicts.push(failed > before);
  };
  seen(() => assert('cas', 2.9, 3));
  seen(() => assert('cas', 3, 3));
  seen(() => assertSofter('cas', 1.25, 1.25));
  seen(() => assertSofter('cas', 1.13, 1.25));
  process.stdout.write = written;
  expect('un couple sous le seuil est vu', verdicts[0]);
  expect('un couple juste au seuil passe', !verdicts[1]);
  expect('un filet doux aussi marqué que `--line` est vu', verdicts[2]);
  expect('un filet doux plus discret passe', !verdicts[3]);

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write(`  ✗ ${failure}\n`);
    }
    process.stdout.write(
      `\nAutotest : ${failures.length} contrôle(s) ne détectent pas ce qu'ils annoncent.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Autotest contrastes : les ${count} contrôles tombent bien sur ce qu'ils sont censés attraper.\n`,
  );
  process.exit(0);
}

if (process.argv.includes('--selftest')) {
  selftest();
}

const themeTokens = {};

for (const [theme, path] of Object.entries(THEMES)) {
  const tokens = readTokens(path);
  themeTokens[theme] = tokens;
  for (const { fg, bg, min, exception } of PAIRS) {
    assert(
      `thème ${theme} — ${fg} sur ${bg}`,
      contrast(resolve(tokens, fg, theme), resolve(tokens, bg, theme)),
      min,
      exception,
    );
  }
  for (const { soft, line, bg } of SOFT_LINES) {
    const surface = resolve(tokens, bg, theme);
    const ratio = contrast(resolve(tokens, soft, theme), surface);
    assert(`thème ${theme} — ${soft} sur ${bg}`, ratio, SOFT_LINE_FLOOR);
    assertSofter(
      `thème ${theme} — ${soft} plus doux que ${line} sur ${bg}`,
      ratio,
      contrast(resolve(tokens, line, theme), surface),
    );
  }
}

// -----------------------------------------------------------------------------------------
// Les 16 teintes d'accent

// L'utilisateur peut remplacer les quatre jetons `--accent*` par ceux de n'importe quelle
// teinte (§3.8.1 option 5). Vérifier le seul accent par défaut ne prouverait donc rien : ce
// sont les 16 × 2 quadruplets qu'il faut mesurer, **contre les fonds réels des thèmes** — que
// ce script lit, et que le générateur ne fait que recopier. C'est ici, et pas dans
// `build-accent-palette.mjs`, que le lien entre la table et les thèmes est vérifié.
// -----------------------------------------------------------------------------------------

const PALETTE_FILE = 'src/app/core/models/accent-palette.ts';

/** Relit le fichier généré. Il est plat et régulier : une expression rationnelle suffit. */
function readPalette() {
  const source = readFileSync(join(process.cwd(), PALETTE_FILE), 'utf8');
  const tints = [];
  const entry =
    /(\w+): \{\s*light: \{ accent: '(#[0-9a-f]{6})', accent600: '(#[0-9a-f]{6})', accent50: '(#[0-9a-f]{6})', accentInk: '(#[0-9a-f]{6})' \},\s*dark: \{ accent: '(#[0-9a-f]{6})', accent600: '(#[0-9a-f]{6})', accent50: '(#[0-9a-f]{6})', accentInk: '(#[0-9a-f]{6})' \},/g;
  for (const match of source.matchAll(entry)) {
    const [, id, ...values] = match;
    const quadruple = (offset) => ({
      accent: values[offset],
      accent600: values[offset + 1],
      accent50: values[offset + 2],
      accentInk: values[offset + 3],
    });
    tints.push({ id, clair: quadruple(0), sombre: quadruple(4) });
  }
  return tints;
}

const palette = readPalette();

if (palette.length === 0) {
  process.stdout.write(
    `✗ aucune teinte lue dans ${PALETTE_FILE} — le contrôle ne prouverait rien\n`,
  );
  process.exit(1);
}

/** Les fonds sur lesquels une encre d'accent peut se retrouver, lus dans les thèmes. */
const inkSurfaces = {
  clair: ['--surface', '--surface-soft', '--elevated-surface'],
  sombre: ['--surface', '--surface-soft', '--elevated-surface'],
};

for (const tint of palette) {
  for (const theme of Object.keys(THEMES)) {
    const { accent, accent600, accent50, accentInk } = tint[theme];
    assert(`teinte ${tint.id} (${theme}) — blanc sur l'aplat`, contrast(WHITE, accent), 4.5);
    assert(`teinte ${tint.id} (${theme}) — blanc sur le survol`, contrast(WHITE, accent600), 4.5);
    assert(
      `teinte ${tint.id} (${theme}) — encre sur le fond teinté`,
      contrast(accentInk, accent50),
      4.5,
    );
    for (const surface of inkSurfaces[theme]) {
      assert(
        `teinte ${tint.id} (${theme}) — encre sur ${surface}`,
        contrast(accentInk, resolve(themeTokens[theme], surface, theme)),
        4.5,
      );
    }
  }
}

if (failed > 0) {
  process.stdout.write(
    `\n${failed} couple(s) sous le seuil sur ${checked}. Les valeurs se calculent, pas se règlent à l'œil.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Contrastes : ${checked} couples vérifiés (jetons des 2 thèmes + les ${palette.length} teintes d'accent), tous au-dessus du seuil.\n`,
);

// Une exception qu'on ne voit plus finit par ne plus être une exception : elle est rappelée à
// chaque exécution, avec son motif, plutôt que d'être enfouie dans un commentaire.
for (const [motif, count] of exceptions) {
  process.stdout.write(
    `  ⚠️  ${count} couple(s) sous le seuil AA de 4,5:1 — exception « ${motif} », motivée dans PAIRS.\n`,
  );
}
