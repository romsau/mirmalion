/** Le dictionnaire personnel, tel que l'interface le manipule. */

/**
 * Une graphie que la dictée écrit à la place du terme correct.
 *
 * @remarks
 * ⚠️ Une variante se retire par son identifiant, jamais par son texte : deux termes peuvent
 * partager une même graphie, et la supprimer par son texte en effacerait deux.
 */
export interface DictionaryVariant {
  readonly id: number;
  readonly value: string;
}

/** Un terme correct et les graphies qui doivent devenir lui. */
export interface DictionaryTerm {
  readonly id: number;
  readonly term: string;
  /** Peut être **vide** : c'est l'état d'un terme qu'on vient de créer. */
  readonly variants: readonly DictionaryVariant[];
}

/**
 * La forme repliée d'une saisie — minuscules, sans accent —, pour comparer deux saisies et rien
 * d'autre : répondre « cette saisie existe-t-elle déjà ? » avant d'appeler le backend, afin que
 * le message de doublon soit dit dans la langue de l'utilisateur.
 *
 * @remarks
 * ⚠️ Ce n'est pas ce repliage qui fait le remplacement : celui-là vit en Rust
 * (`src-tauri/src/dictionary/mod.rs`) et lui seul décide ce qui est corrigé dans une dictée. Les
 * deux n'ont pas à coïncider — Rust traite les ligatures, pas celui-ci —, et une divergence ne
 * produit au pire qu'un doublon que la contrainte `UNIQUE` de la base refusera.
 */
export function foldEntry(entry: string): string {
  return entry
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
