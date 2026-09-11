import { Component, inject, signal } from '@angular/core';
import { DictionaryRow } from './components/dictionary-row/dictionary-row';
import { DictionaryToolbar } from './components/dictionary-toolbar/dictionary-toolbar';
import {
  DictionaryWordForm,
  type DictionaryWordFormResult,
} from './components/dictionary-word-form/dictionary-word-form';
import { DictionaryStore } from '../../../../core/store/dictionary/dictionary.store';
import { foldEntry } from '../../../../core/models/dictionary-term';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { drainErrors } from '../../../../core/services/snackbar/drain-errors';

/**
 * La catégorie Dictionnaire : elle injecte le store, orchestre, et ne dessine rien elle-même —
 * la liste est faite de `dictionary-row`, l'ajout d'un mot est une modale.
 *
 * @remarks
 * - ⚠️ **L'ajout passe par une MODALE, la modification d'une graphie reste sur place.** Un
 *   formulaire déplié faisait sauter le panneau et se réordonner la liste sous lui ; une modale
 *   ne déplace rien, est seule par construction, et Échap la ferme. Les écritures fautives
 *   SUIVANTES, elles, s'ajoutent une par une par « + une autre » : rouvrir une boîte pour un mot
 *   de plus serait le chemin le plus long.
 * - ⚠️ La liste est montée directement, sans rangée « drill-in » d'accueil ni titre-bouton
 *   retour : une catégorie ne se quitte pas, on en choisit une autre au rail.
 */
@Component({
  selector: 'app-options-dictionnaire',
  imports: [DictionaryToolbar, DictionaryRow],
  templateUrl: './options-dictionnaire.html',
  styleUrl: './options-dictionnaire.scss',
})
export class OptionsDictionnaire {
  protected readonly store = inject(DictionaryStore);

  private readonly modal = inject(Modal);
  private readonly snackbar = inject(Snackbar);

  /** La ligne dont la dernière graphie a été refusée. */
  protected readonly duplicateVariant = signal<number | null>(null);

  constructor() {
    void this.store.load();

    // ⚠️ Les échecs du store se disent une fois puis s'oublient, sans quoi la snackbar
    // reviendrait à chaque rendu.
    drainErrors(this.store);
  }

  /**
   * Demande un mot et sa première écriture fautive, puis écrit les deux.
   *
   * @remarks
   * ⚠️ **Un mot déjà connu ne fait pas perdre la saisie** : l'écriture fautive, elle, est
   * valide, et elle se range sous le mot existant. La modale est refermée — refuser le couple
   * jetterait les deux champs sans rien à corriger.
   */
  protected async addWord(): Promise<void> {
    const written = await this.modal.open<DictionaryWordFormResult>(DictionaryWordForm, {
      heading: $localize`:@@dictionary.word.heading:Ajouter un mot`,
    }).closed;
    if (written === undefined) {
      return;
    }

    const outcome = await this.store.addTerm(written.term);
    if (outcome === 'failed') {
      return;
    }

    // ⚠️ Le mot est cherché dans la liste du magasin, jamais deviné, et comparé REPLIÉ : c'est
    // ainsi que le magasin juge le doublon, et « WhatsApp » doit retrouver le « whatsapp » listé.
    const folded = foldEntry(written.term);
    const target = this.store.terms().find((entry) => foldEntry(entry.term) === folded);
    if (target === undefined) {
      return;
    }
    const filed = await this.store.addVariant(target.id, written.said);

    // ⚠️ Rien ne s'annonce par-dessus un ÉCHEC : la snackbar est unique, et le rangement
    // chasserait l'erreur que le magasin vient de dire, en affirmant l'inverse. Une graphie déjà
    // listée, elle, s'annonce — la phrase dit un état, et cet état est vrai.
    if (outcome === 'duplicate' && filed !== 'failed') {
      this.snackbar.info(
        $localize`:@@dictionary.word.merged:Ce mot était déjà dans votre dictionnaire : cette écriture est rangée dessous.`,
      );
    }
  }

  /** Ajoute une graphie sous un terme. */
  protected async onAddVariant(termId: number, value: string): Promise<void> {
    const outcome = await this.store.addVariant(termId, value);
    this.duplicateVariant.set(outcome === 'duplicate' ? termId : null);
  }

  /** Retire une graphie. Immédiat, sans confirmation. */
  protected async onRemoveVariant(id: number): Promise<void> {
    this.duplicateVariant.set(null);
    await this.store.removeVariant(id);
  }

  /** Retire un terme et toutes ses graphies. Immédiat, sans confirmation. */
  protected async onRemoveTerm(id: number): Promise<void> {
    this.duplicateVariant.set(null);
    await this.store.removeTerm(id);
  }
}
