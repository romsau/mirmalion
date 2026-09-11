import {
  Component,
  LOCALE_ID,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';

/**
 * Ce qu'un prompt peut faire de plus long, en caractères.
 *
 * @remarks
 * ⚠️ Le miroir de `MAX_PROMPT_LENGTH` (`src-tauri/src/commands/prompts.rs`), qui est la vraie
 * borne : celle-ci ne fait que l'annoncer. Rust refuse au-delà, le WebView n'étant pas fiable.
 */
export const MAX_PROMPT_LENGTH = 2000;

/**
 * Le champ où l'on écrit un prompt libre, avec son compteur.
 *
 * Trois écrans le portent — la dictée, la fenêtre-session, Options ▸ Direct. La borne et son
 * compteur vivent ici pour que les trois disent la même chose.
 *
 * @remarks
 * - ⚠️ La saisie est bornée à {@link MAX_PROMPT_LENGTH}, que Rust refuse de dépasser. Sans elle,
 *   coller un texte trop long ne montrait rien : l'écriture échouait 400 ms plus tard, par une
 *   snackbar qui ne parlait pas de longueur.
 * - ⚠️ Le compteur s'affiche **même à vide** : c'est un budget annoncé, pas une alarme.
 */
@Component({
  selector: 'app-prompt-field',
  templateUrl: './prompt-field.html',
  styleUrl: './prompt-field.scss',
})
export class PromptField {
  /** Le texte affiché. L'hôte en reste maître — voir {@link PromptField.valueChange}. */
  readonly value = input.required<string>();

  /** Le nom accessible du champ. */
  readonly ariaLabel = input.required<string>();

  /** Le texte d'attente, affiché tant que le champ est vide. */
  readonly placeholder = input('');

  /**
   * Le champ tient sur trois lignes plutôt qu'une.
   *
   * @remarks
   * ⚠️ Deux éléments et non un `<textarea>` réglé à une ligne : celui-ci garderait sa poignée de
   * redimensionnement et sa hauteur de zone de texte là où la dictée veut une ligne de saisie.
   */
  readonly multiline = input(false, { transform: booleanAttribute });

  /** Le champ ne répond plus. */
  readonly disabled = input(false);

  /** Chaque frappe, telle quelle. L'hôte décide de ce qu'il en fait. */
  readonly valueChange = output<string>();

  private readonly numbers = new Intl.NumberFormat(inject(LOCALE_ID));

  /** La borne, pour l'attribut `maxlength`, qui veut un nombre brut. */
  protected readonly max = MAX_PROMPT_LENGTH;

  /**
   * Le compteur, tel qu'il se lit — « 9 / 2 000 ».
   *
   * @remarks
   * ⚠️ Par `Intl`, comme tout nombre affiché : le séparateur de milliers n'est pas le même dans
   * les six langues, et `2000` écrit à la main se lirait faux dans cinq d'entre elles.
   */
  protected readonly count = computed(
    () => `${this.numbers.format(this.written())} / ${this.numbers.format(MAX_PROMPT_LENGTH)}`,
  );

  /**
   * Combien de caractères sont écrits.
   *
   * @remarks
   * ⚠️ **En points de code, pas en `length`** : `String.length` compte des unités UTF-16 et
   * donne 2 pour un emoji, quand Rust compte des `chars` et en voit 1. Le compteur annoncerait
   * une longueur que la base ne reconnaîtrait pas.
   */
  protected readonly written = computed(() => [...this.value()].length);

  /** Retient la frappe et la rend telle quelle. */
  protected onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement | HTMLTextAreaElement).value);
  }
}
