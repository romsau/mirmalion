/**
 * La dictée : ses entrées audio, son historique, son dictionnaire et ses prompts.
 *
 * Un bridge de domaine : il ne fait que traduire des appels en commandes du backend, et ne
 * porte aucun état. Le cœur du pont vit dans `Invoke`.
 */

import { Service, inject } from '@angular/core';
import { Invoke } from '../invoke/invoke';
import type { DictionaryTerm, DictionaryVariant } from '../../../models/dictionary-term';

/**
 * Une entrée audio de la machine.
 *
 * Miroir d'`InputDevice` (`src-tauri/src/commands/audio.rs`).
 */
export interface InputDevice {
  /** Opaque : on le renvoie tel quel, il n'y a rien à en déduire. */
  readonly id: string;
  readonly name: string;
  /** L'entrée que macOS utilise par défaut — le choix retenu tant que rien n'est choisi. */
  readonly isDefault: boolean;
}

/**
 * Une dictée de l'historique.
 *
 * @remarks
 * - ⚠️ Une variante de texte absente est une information : elle dit que l'étape n'a pas eu lieu
 *   — nettoyage refusé, reformulation non demandée, traduction sans paire installée. Y
 *   substituer le texte de l'étape précédente ferait croire à un traitement qui n'a pas eu lieu.
 * - ⚠️ Aucune date ne traverse le pont : la base en stocke une pour trier et purger, le panneau
 *   n'en affiche aucune.
 */
export interface DictationRecord {
  readonly id: number;
  /** La langue **parlée**, telle qu'elle était au démarrage de la dictée. */
  readonly language: string;
  readonly rawText: string;
  readonly cleanedText: string | null;
  readonly rephrasedText: string | null;
  readonly translatedText: string | null;
  /** La langue de `translatedText`, renseignée **seulement** si la traduction a abouti. */
  readonly translatedLanguage: string | null;
}

/**
 * Le nom de l'évènement Tauri qui dit qu'une dictée vient d'entrer dans l'historique.
 *
 * @remarks
 * ⚠️ Sans charge utile : il annonce qu'il y a du nouveau, pas ce qu'il y a. Le contenu ne
 * traverse l'IPC que par `list_dictations`. Défini côté Rust dans `commands/dictations.rs` —
 * les deux noms doivent rester identiques.
 */
export const DICTATION_RECORDED_EVENT = 'dictation://recorded';

/** La dictée : ses entrées audio, son historique, son dictionnaire et ses prompts. */
@Service()
export class DictationBridge {
  private readonly core = inject(Invoke);

  /**
   * Les entrées audio de la machine.
   *
   * Ne déclenche aucun prompt et n'ouvre aucun micro : le sélecteur peut donc se remplir dès
   * l'affichage de l'écran, autorisation accordée ou non.
   */
  async listInputDevices(): Promise<readonly InputDevice[] | null> {
    return this.core.call<readonly InputDevice[]>('list_input_devices');
  }

  /**
   * Le prompt de reformulation personnalisé, ou `null` s'il n'y en a jamais eu.
   *
   * @remarks
   * ⚠️ Il vit dans la base chiffrée, pas dans les réglages : c'est du texte libre écrit par
   * l'utilisateur, qui peut nommer un métier, un employeur, un client. Le fichier de réglages
   * est un JSON en clair, et rien de sensible n'y entre.
   */
  async getRephrasingPrompt(): Promise<string | null> {
    return this.core.call<string | null>('get_rephrasing_prompt');
  }

  /** Enregistre le prompt de reformulation. Un texte vide efface celui qui existait. */
  async setRephrasingPrompt(prompt: string): Promise<void> {
    await this.core.call<null>('set_rephrasing_prompt', { prompt });
  }

  /**
   * L'historique de dictée, du plus récent au plus ancien.
   *
   * @remarks
   * ⚠️ Rendu en entier, et c'est ce qui rend la recherche possible : le plafond est de 500, donc
   * quelques centaines de kilo-octets. Le filtre du panneau s'applique à cette source — c'est le
   * seul endroit où l'on sait comparer « session » et « direct », SQLite ne le sachant pas sans
   * extension ICU.
   */
  async listDictations(): Promise<DictationRecord[] | null> {
    return this.core.call<DictationRecord[]>('list_dictations');
  }

  /** Supprime une dictée. Sans confirmation — c'est « Tout supprimer » qui en demande une. */
  async deleteDictation(id: number): Promise<void> {
    await this.core.call<null>('delete_dictation', { id });
  }

  /** Vide l'historique. À n'appeler que derrière la modale de confirmation. */
  async clearDictations(): Promise<void> {
    await this.core.call<null>('clear_dictations');
  }

  /**
   * Applique le plafond d'historique à ce qui est déjà enregistré. L'écriture d'une dictée
   * applique déjà le plafond de son côté.
   *
   * @remarks
   * ⚠️ À appeler quand l'utilisateur abaisse le plafond : sans cela, passer de 500 à 50
   * laisserait 450 entrées visibles jusqu'à ce que la FIFO les ait lentement chassées.
   */
  async applyDictationRetention(): Promise<void> {
    await this.core.call<null>('apply_dictation_retention');
  }

  /**
   * Le dictionnaire personnel, trié par terme, casse ignorée.
   *
   * @remarks
   * ⚠️ Rendu en entier, comme l'historique et pour la même raison : quelques dizaines de lignes,
   * et c'est ce qui permet de filtrer et de détecter un doublon sans aller-retour.
   */
  async listDictionaryTerms(): Promise<DictionaryTerm[] | null> {
    return this.core.call<DictionaryTerm[]>('list_dictionary_terms');
  }

  /**
   * Ajoute un terme et rend la ligne créée, sans variante.
   *
   * @remarks
   * ⚠️ Le doublon se refuse avant cet appel, dans l'interface : la contrainte `UNIQUE` de la
   * base ferait bien remonter une erreur, mais son message vient de Rust et n'est pas localisé.
   * Voir `foldEntry` dans le modèle.
   */
  async addDictionaryTerm(term: string): Promise<DictionaryTerm | null> {
    return this.core.call<DictionaryTerm>('add_dictionary_term', { term });
  }

  /** Supprime un terme et toutes ses variantes (cascade côté base). */
  async deleteDictionaryTerm(id: number): Promise<void> {
    await this.core.call<null>('delete_dictionary_term', { id });
  }

  /** Ajoute une graphie sous un terme existant, et rend l'étiquette créée. */
  async addDictionaryVariant(termId: number, variant: string): Promise<DictionaryVariant | null> {
    return this.core.call<DictionaryVariant>('add_dictionary_variant', { termId, variant });
  }

  /** Retire une graphie, par identifiant et non par son texte. */
  async deleteDictionaryVariant(id: number): Promise<void> {
    await this.core.call<null>('delete_dictionary_variant', { id });
  }
}
