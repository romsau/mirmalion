import { Component, computed, inject, signal } from '@angular/core';
import { Button } from '../../../../../../shared/components/button/button';
import { TextField } from '../../../../../../shared/components/forms/text-field/text-field';
import { ModalRef } from '../../../../../../core/services/modal/modal-ref';

/**
 * Ce qu'un mot du dictionnaire peut faire de plus long, en caractères.
 *
 * @remarks
 * ⚠️ Le miroir de `MAX_LENGTH` (`src-tauri/src/commands/dictionary.rs`), qui est la vraie borne :
 * celle-ci ne fait que l'annoncer, le WebView n'étant pas fiable.
 */
export const MAX_DICTIONARY_WORD_LENGTH = 120;

/** Ce que la modale rend quand on ajoute. `undefined` veut dire annulé. */
export interface DictionaryWordFormResult {
  /** Le mot correct, celui que la dictée doit écrire. */
  readonly term: string;
  /** Ce que la dictée écrit à sa place, et qu'il faut corriger. */
  readonly said: string;
}

/**
 * Le contenu de la modale d'un mot : le mot correct, une écriture fautive, deux issues.
 *
 * Elle n'ajoute que ; modifier un mot reste sur place. Elle ne reçoit donc rien, n'écrit rien, et
 * rend le couple saisi à l'appelant.
 *
 * @remarks
 * - ⚠️ **Les deux champs sont demandés ensemble** : un mot sans écriture fautive ne corrige rien,
 *   et le second geste, tant qu'il était seulement possible, ne se faisait pas.
 * - ⚠️ Elle n'affiche aucun titre de boîte : c'est `Modal.open({ heading })` qui le pose.
 */
@Component({
  selector: 'app-dictionary-word-form',
  imports: [Button, TextField],
  templateUrl: './dictionary-word-form.html',
  styleUrl: './dictionary-word-form.scss',
})
export class DictionaryWordForm {
  private readonly ref = inject(ModalRef) as ModalRef<DictionaryWordFormResult>;

  /** La borne des deux champs, celle que la base refuse de dépasser. */
  protected readonly maxLength = MAX_DICTIONARY_WORD_LENGTH;

  /** Le mot correct en cours de saisie. */
  protected readonly term = signal('');

  /** L'écriture fautive en cours de saisie. */
  protected readonly said = signal('');

  /** Peut-on ajouter ? Les deux champs sont exigés, et des espaces n'en remplissent aucun. */
  protected readonly canAdd = computed(
    () => this.term().trim() !== '' && this.said().trim() !== '',
  );

  /** Retient le mot frappé. */
  protected writeTerm(text: string): void {
    this.term.set(text);
  }

  /** Retient l'écriture fautive frappée. */
  protected writeSaid(text: string): void {
    this.said.set(text);
  }

  /**
   * Rend le couple saisi, taillé.
   *
   * @remarks
   * ⚠️ Taillé ici : c'est ce couple-là qui part en base, où deux mots ne différant que par un
   * espace de bord seraient deux entrées d'une même liste.
   */
  protected add(): void {
    this.ref.close({ term: this.term().trim(), said: this.said().trim() });
  }

  /** Ferme sans rien rendre : `undefined` est l'abandon. */
  protected cancel(): void {
    this.ref.close();
  }
}
