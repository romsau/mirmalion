import { Component, LOCALE_ID, computed, inject, input, output } from '@angular/core';

/**
 * Le champ d'une ligne à borne réglable, avec son compteur.
 *
 * @remarks
 * ⚠️ Le compteur s'affiche **même à vide** : c'est un budget annoncé, pas une alarme.
 */
@Component({
  selector: 'app-text-field',
  templateUrl: './text-field.html',
  styleUrl: './text-field.scss',
})
export class TextField {
  /** Le texte affiché. L'hôte en reste maître — voir {@link TextField.valueChange}. */
  readonly value = input.required<string>();

  /** Le nom accessible du champ. */
  readonly ariaLabel = input.required<string>();

  /** Le texte d'attente, affiché tant que le champ est vide. */
  readonly placeholder = input('');

  /**
   * Le nombre maximal de caractères, et ce que le compteur annonce.
   *
   * @remarks
   * ⚠️ Une entrée, et non une constante : c'est ce qui distingue ce champ de `PromptField`, dont
   * la borne est le miroir en dur de `MAX_PROMPT_LENGTH`. L'appelant doit poser la même valeur
   * que celle que Rust refuse de dépasser.
   */
  readonly maxLength = input.required<number>();

  /** Le champ ne répond plus. */
  readonly disabled = input(false);

  /**
   * Ce qui est écrit est-il refusé ?
   *
   * @remarks
   * ⚠️ Sans elle, un champ dont l'hôte affiche l'erreur à côté reste « valide » pour un lecteur
   * d'écran, et « Enregistrer » s'éteint sans que rien ne dise pourquoi.
   */
  readonly invalid = input(false);

  /**
   * L'identifiant de l'élément qui dit la faute, ou `null`.
   *
   * @remarks
   * ⚠️ C'est l'hôte qui le pose : le message vit chez lui, et lui seul peut en garantir
   * l'unicité dans la page.
   */
  readonly describedBy = input<string | null>(null);

  /** Affiche le compteur sous le champ. */
  readonly showCounter = input(true);

  /** Chaque frappe, telle quelle. L'hôte décide de ce qu'il en fait. */
  readonly valueChange = output<string>();

  private readonly numbers = new Intl.NumberFormat(inject(LOCALE_ID));

  /** Le compteur, tel qu'il se lit — « 9 / 40 ». */
  protected readonly count = computed(
    () => `${this.numbers.format(this.written())} / ${this.numbers.format(this.maxLength())}`,
  );

  /**
   * Combien de caractères sont écrits.
   *
   * @remarks
   * ⚠️ **En points de code, pas en `length`** : `String.length` compte des unités UTF-16 et
   * donne 2 pour un emoji, quand Rust compte des `chars` et en voit 1.
   */
  protected readonly written = computed(() => [...this.value()].length);

  /** Retient la frappe et la rend telle quelle. */
  protected onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement).value);
  }
}
