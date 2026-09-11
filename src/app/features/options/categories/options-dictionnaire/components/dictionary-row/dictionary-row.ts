import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Icon } from '../../../../../../shared/components/icon/icon';
import type { DictionaryTerm } from '../../../../../../core/models/dictionary-term';

/**
 * Une ligne du dictionnaire : le terme correct, ses graphies en étiquettes, et la corbeille.
 *
 * Il ne porte que de l'état de vue — le champ « + variante » est-il ouvert —, qu'aucun autre
 * composant ne lit ; le remonter au parent ferait recalculer la liste entière à chaque frappe.
 * L'étiquette de variante n'est pas un composant : un `<span>` et une croix vivent au gabarit.
 *
 * @remarks
 * ⚠️ Le focus est piloté, jamais supposé : un bouton se change en champ, une croix disparaît sous
 * le doigt. À chaque transformation quelque chose doit le recevoir explicitement, sinon il
 * retombe sur `<body>` au milieu de la liste.
 */
@Component({
  selector: 'app-dictionary-row',
  imports: [Icon],
  templateUrl: './dictionary-row.html',
  styleUrl: './dictionary-row.scss',
})
export class DictionaryRow {
  /** Le terme et ses graphies. */
  readonly entry = input.required<DictionaryTerm>();

  /** Le parent a refusé la dernière graphie : elle existait déjà sous ce terme. */
  readonly duplicate = input(false);

  /** Une graphie vient d'être saisie. */
  readonly addVariant = output<string>();

  /** Une graphie vient d'être retirée. */
  readonly removeVariant = output<number>();

  /** Le terme entier vient d'être supprimé. */
  readonly removeTerm = output<void>();

  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Le champ de saisie d'une graphie est-il ouvert ? */
  protected readonly adding = signal(false);

  /**
   * Pose le focus sur un élément de cette ligne, au prochain rendu.
   *
   * @remarks
   * - ⚠️ `afterNextRender`, jamais `queueMicrotask` : la cible n'existe pas encore quand on
   *   demande le focus, et une micro-tâche s'exécute avant le rendu — il tombe sur `<body>`.
   * - ⚠️ Le DOM est interrogé, pas `viewChild` : une requête de vue fait porter au composant une
   *   assertion générée qu'aucun test ne peut atteindre, et la couverture tombe sous son seuil.
   */
  private focusIn(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  /**
   * Le nom accessible de la corbeille du terme.
   *
   * @remarks
   * ⚠️ Il nomme sa cible, là où l'écran s'en dispense : un lecteur d'écran saute de bouton en
   * bouton, et quinze « Supprimer » d'affilée ne distinguent plus rien.
   */
  protected removeTermLabel(): string {
    const term = this.entry().term;
    return $localize`:@@dictionary.removeTerm:Supprimer ${term}:term:`;
  }

  /** Le nom accessible de la croix d'une graphie — elle nomme la graphie et son terme. */
  protected removeVariantLabel(variant: string): string {
    const term = this.entry().term;
    return $localize`:@@dictionary.removeVariant:Retirer ${variant}:variant: de ${term}:term:`;
  }

  /**
   * Le nom accessible du bouton « + une autre ».
   *
   * @remarks
   * ⚠️ Il nomme le terme, quand le bouton visible s'appuie sur la légende à côté de lui : quinze
   * « une autre » d'affilée ne distinguent rien pour qui saute de bouton en bouton.
   */
  protected addVariantLabel(): string {
    const term = this.entry().term;
    return $localize`:@@dictionary.addVariantFor:Ajouter ce que la dictée écrit pour ${term}:term:`;
  }

  /** Ouvre le champ à l'emplacement même du bouton. */
  protected open(): void {
    this.adding.set(true);
    this.focusIn('.dico-input');
  }

  /**
   * Valide une graphie. Entrée laisse le champ ouvert — on corrige rarement une seule graphie à
   * la fois : le champ est vidé, le focus ne bouge pas. Un champ vide referme.
   */
  protected submit(event: Event): void {
    const field = event.target as HTMLInputElement;
    const value = field.value.trim();
    if (!value) {
      this.close(field);
      return;
    }
    this.addVariant.emit(value);
    field.value = '';
  }

  /**
   * Échap referme le champ **et rend le focus au bouton** qui réapparaît — sinon il tomberait
   * sur `<body>`, au milieu de la liste.
   */
  protected cancel(event: Event): void {
    this.close(event.target as HTMLInputElement);
  }

  /**
   * La perte de focus referme aussi, mais ne reprend rien : l'utilisateur est déjà parti
   * ailleurs, et lui arracher le focus serait pire que de ne rien faire.
   */
  protected leave(): void {
    this.adding.set(false);
  }

  /**
   * Referme le champ en rendant le focus au bouton qui réapparaît.
   *
   * @remarks
   * ⚠️ Sans variante : les deux chemins qui passent ici — Échap, Entrée à vide — sont des gestes
   * délibérés, et l'utilisateur doit retrouver où il en était. La perte de focus, elle, ne
   * reprend rien et ne passe pas par ici.
   */
  private close(field: HTMLInputElement): void {
    field.value = '';
    this.adding.set(false);
    this.focusIn('.dico-more');
  }
}
