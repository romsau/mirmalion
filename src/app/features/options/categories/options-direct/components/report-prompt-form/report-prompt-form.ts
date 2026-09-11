import { Component, computed, inject, signal } from '@angular/core';
import { Button } from '../../../../../../shared/components/button/button';
import { TextField } from '../../../../../../shared/components/forms/text-field/text-field';
import { PromptField } from '../../../../../../shared/components/forms/prompt-field/prompt-field';
import { MODAL_DATA, ModalRef } from '../../../../../../core/services/modal/modal-ref';
import { REPORT_PROMPT_PLACEHOLDER } from '../../../../../../core/services/live/live';
import type { ReportPrompt } from '../../../../../../core/services/bridge/live/live.bridge';

/**
 * Ce qu'un titre de prompt peut faire de plus long, en caractères.
 *
 * @remarks
 * ⚠️ Le miroir de `MAX_TITLE_LENGTH` (`src-tauri/src/commands/prompts.rs`), qui est la vraie
 * borne : celle-ci ne fait que l'annoncer, le WebView n'étant pas fiable.
 */
export const MAX_PROMPT_TITLE_LENGTH = 40;

/**
 * Ce qu'on dit d'un titre qu'un autre prompt porte déjà.
 *
 * @remarks
 * ⚠️ Une constante partagée, et non le même identifiant balisé de deux côtés : le contenu d'un
 * élément porte des espaces de bord qu'un `$localize` n'a pas, et le premier retour à la ligne
 * ferait voir à l'extracteur deux textes pour un seul identifiant.
 */
export const DUPLICATE_TITLE_MESSAGE = $localize`:@@direct.prompt.duplicate:Ce titre est déjà pris.`;

/**
 * Le compteur qui rend l'identifiant du message d'erreur unique à chaque instance.
 *
 * @remarks
 * ⚠️ Un identifiant écrit en dur serait dupliqué si deux instances étaient montées, et
 * l'`aria-describedby` du champ désignerait alors deux éléments — ce que ni jsdom ni AXE ne
 * relèvent.
 */
let instances = 0;

/** Ce que l'appelant fournit à la modale d'un prompt. */
export interface ReportPromptFormData {
  /** Le prompt à modifier, `null` à l'ajout. */
  readonly prompt: ReportPrompt | null;
  /**
   * Ce titre est-il déjà porté par un AUTRE prompt ?
   *
   * @remarks
   * ⚠️ Une fonction passée en données, pas le magasin injecté : une modale qui injecterait le
   * magasin ne serait pas éprouvable seule. Même motif que `LanguageInstallData`.
   * ⚠️ Elle doit exclure le prompt en cours de modification, sans quoi corriger une faute de
   * son texte serait refusé au nom de son propre titre.
   */
  readonly taken: (title: string) => boolean;
}

/** Ce que la modale rend quand on enregistre. `undefined` veut dire annulé. */
export interface ReportPromptFormResult {
  readonly title: string;
  readonly prompt: string;
}

/**
 * Le contenu de la modale d'un prompt de compte rendu : un titre, un texte, deux issues.
 *
 * La même pour l'ajout et pour la modification — seules les données reçues changent. Elle
 * n'écrit rien : elle rend le couple saisi et laisse l'appelant décider.
 *
 * @remarks
 * ⚠️ Elle n'affiche aucun titre de boîte : c'est `Modal.open({ heading })` qui le pose, et
 * `ModalContainer` qui le rend. En écrire un ici le dirait deux fois.
 */
@Component({
  selector: 'app-report-prompt-form',
  imports: [Button, TextField, PromptField],
  templateUrl: './report-prompt-form.html',
  styleUrl: './report-prompt-form.scss',
})
export class ReportPromptForm {
  private readonly data = inject(MODAL_DATA) as ReportPromptFormData;
  private readonly ref = inject(ModalRef) as ModalRef<ReportPromptFormResult>;

  /** Ce que la boîte dit d'un titre déjà pris. */
  protected readonly duplicateMessage = DUPLICATE_TITLE_MESSAGE;

  /** L'identifiant de ce message, celui que le champ désigne quand il est en faute. */
  protected readonly duplicateId = `rp-duplicate-${(instances += 1)}`;

  /** La borne du titre, pour le compteur du champ. */
  protected readonly maxTitleLength = MAX_PROMPT_TITLE_LENGTH;

  /** Le texte d'attente du champ de prompt, celui des deux autres écrans. */
  protected readonly promptPlaceholder = REPORT_PROMPT_PLACEHOLDER;

  /** Le titre en cours de saisie. */
  protected readonly title = signal(this.data.prompt?.title ?? '');

  /** Le texte en cours de saisie. */
  protected readonly prompt = signal(this.data.prompt?.prompt ?? '');

  /**
   * Ce titre est-il celui d'un autre prompt ?
   *
   * @remarks
   * ⚠️ Muet tant que le champ est vide : un champ qu'on n'a pas encore rempli n'est pas en
   * faute.
   */
  protected readonly duplicate = computed(
    () => this.title().trim() !== '' && this.data.taken(this.title()),
  );

  /**
   * Peut-on enregistrer ?
   *
   * @remarks
   * ⚠️ Les deux champs sont exigés : un prompt sans titre ne se retrouve pas dans un menu, un
   * titre sans prompt ne produit rien.
   */
  protected readonly canSave = computed(
    () => !this.duplicate() && this.title().trim() !== '' && this.prompt().trim() !== '',
  );

  /** Retient le titre frappé. */
  protected writeTitle(text: string): void {
    this.title.set(text);
  }

  /** Retient le texte frappé. */
  protected writePrompt(text: string): void {
    this.prompt.set(text);
  }

  /**
   * Rend le couple saisi, taillé.
   *
   * @remarks
   * ⚠️ Taillé ici et non chez l'appelant : c'est ce couple-là qui part en base, et deux titres
   * qui ne diffèrent que par un espace de bord seraient deux entrées d'un même menu.
   */
  protected save(): void {
    this.ref.close({ title: this.title().trim(), prompt: this.prompt().trim() });
  }

  /** Ferme sans rien rendre : `undefined` est l'abandon. */
  protected cancel(): void {
    this.ref.close();
  }
}
