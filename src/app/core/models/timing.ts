/**
 * Les cadences de l'interface : ce qui se relit, et ce qui attend avant d'écrire.
 *
 * Ce module ne porte que des durées. Les seuils propres à un composant — la temporisation d'une
 * snackbar, le délai avant qu'une barre propose « Annuler » — restent chez lui : ils décrivent
 * ce composant, pas le rythme de l'application.
 */

/**
 * Le pas de tous les chronos de l'interface : écran Direct, fenêtre-session, pilule flottante.
 *
 * @remarks
 * ⚠️ Un chrono ne compte pas, il relit : la durée se recalcule depuis l'instant de départ retenu
 * par le magasin, si bien qu'un intervalle en retard ne décale rien. C'est aussi ce qui permet
 * aux trois écrans de partager cette valeur sans se synchroniser entre eux.
 */
export const TICK_INTERVAL_MS = 1_000;

/**
 * Le délai d'inactivité avant d'écrire un prompt saisi au clavier.
 *
 * @remarks
 * ⚠️ Le même des deux côtés — dictée et Direct : ce sont deux champs de même nature, et deux
 * valeurs feraient répondre l'un plus vite que l'autre sans qu'aucune règle ne le justifie.
 */
export const PROMPT_WRITE_DELAY_MS = 400;

/**
 * Les cinq barres d'un indicateur de niveau, de la plus à gauche à la plus à droite.
 *
 * @remarks
 * ⚠️ Un tableau d'index et non un nombre : `@for` a besoin de quelque chose à parcourir, et
 * l'index sert au calcul de hauteur de chaque barre. La pilule et le VU-mètre de la
 * fenêtre-session en dessinent le même nombre.
 */
export const METER_BARS: readonly number[] = [0, 1, 2, 3, 4];
