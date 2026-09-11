/**
 * Ce que les deux fenêtres-documents — session et fichier — font de la même façon.
 *
 * Elles divergent par tout le reste : l'une confirme sa fermeture, l'autre non ; l'une porte un
 * compte rendu, l'autre un seul transcript. Seul ce qui est strictement identique vit ici.
 */

/**
 * Ce qui précède le numéro d'une fenêtre-fichier dans son identifiant.
 *
 * @remarks
 * ⚠️ Miroir du nom que Rust donne à ses documents : `get_file_document` attend `filedoc-0`.
 */
export const DOCUMENT_ID_PREFIX = 'filedoc-';

/** Ce qui précède le numéro d'une fenêtre-session. Miroir de Rust, comme son voisin. */
export const LIVE_ID_PREFIX = 'directdoc-';

/**
 * Recompose l'identifiant d'un document depuis le segment d'URL.
 *
 * @param prefix - {@link DOCUMENT_ID_PREFIX} ou {@link LIVE_ID_PREFIX}.
 * @param segment - Le paramètre de route, qui ne porte que le numéro.
 *
 * @remarks
 * ⚠️ Le segment n'est pas l'identifiant : l'étiquette de la fenêtre vaut `filedoc-3`, et
 * `applyWindowRoute` la coupe au premier tiret parce qu'Angular n'apparie ses paramètres que sur
 * un segment entier. C'est ici, et nulle part ailleurs, qu'on recolle les deux moitiés.
 */
export function windowDocumentId(prefix: string, segment: string): string {
  return `${prefix}${segment}`;
}

/**
 * La date que portera le nom du fichier proposé à l'export.
 *
 * @param locale - La langue de l'interface, celle du bundle chargé.
 *
 * @remarks
 * - ⚠️ La locale se passe, elle ne se laisse pas deviner : sans elle, `Intl` rend celle de macOS,
 * et un Mac en anglais écrirait « Aug 16, 2026 » dans une interface française. Rust n'a ni
 * catalogue ni calendrier — il assainit la chaîne et l'assemble.
 * - ⚠️ La date du jour, et non celle du document : un fichier importé n'en porte aucune, et une
 * session porte déjà la sienne dans son titre.
 */
export function exportDate(locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date());
}
