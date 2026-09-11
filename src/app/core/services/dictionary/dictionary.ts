import { Service, inject } from '@angular/core';
import { DictationBridge } from '../bridge/dictation/dictation.bridge';
import type { DictionaryTerm, DictionaryVariant } from '../../models/dictionary-term';

/**
 * Le dictionnaire personnel : lire les termes, les créer, les défaire.
 *
 * Seul point du domaine qui parle au backend ; il ne porte aucun état, il traduit cinq gestes
 * en cinq commandes et ramène le `null` du navigateur à une valeur exploitable. Hors contexte
 * Tauri, la liste est donc vide et les écritures sans effet : l'écran affiche son invitation à
 * créer un premier terme.
 */
@Service()
export class Dictionary {
  private readonly bridge = inject(DictationBridge);

  /** Tous les termes, triés par la base, casse ignorée. */
  async list(): Promise<readonly DictionaryTerm[]> {
    return (await this.bridge.listDictionaryTerms()) ?? [];
  }

  /**
   * Crée un terme et rend la ligne, ou `null` hors contexte Tauri.
   *
   * @remarks
   * ⚠️ Le doublon se vérifie avant l'appel, dans `DictionaryStore.addTerm`. La contrainte
   * `UNIQUE` de la base reste, mais son message vient de Rust et n'est pas localisé.
   */
  async addTerm(term: string): Promise<DictionaryTerm | null> {
    return this.bridge.addDictionaryTerm(term);
  }

  /** Supprime un terme et toutes ses variantes. */
  async removeTerm(id: number): Promise<void> {
    await this.bridge.deleteDictionaryTerm(id);
  }

  /** Ajoute une graphie sous un terme, et rend l'étiquette. */
  async addVariant(termId: number, variant: string): Promise<DictionaryVariant | null> {
    return this.bridge.addDictionaryVariant(termId, variant);
  }

  /** Retire une graphie, par identifiant. */
  async removeVariant(id: number): Promise<void> {
    await this.bridge.deleteDictionaryVariant(id);
  }
}
