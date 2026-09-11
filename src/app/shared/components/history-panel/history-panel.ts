import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualScrollViewport,
} from '@angular/cdk/scrolling';
import { Icon } from '../icon/icon';
import { Button } from '../button/button';

/**
 * Une ligne d'historique, réduite à ce que le panneau a besoin de savoir.
 *
 * @remarks
 * ⚠️ Volontairement pauvre : c'est ce qui laisse le Direct réutiliser ce panneau sans qu'il
 * apprenne ce qu'est une dictée. L'appelant décide quel texte montrer — pour la dictée, celui
 * qui a été inséré au curseur.
 */
export interface HistoryEntry {
  /** L'identifiant de la ligne, celui que le panneau renvoie dans ses sorties. */
  readonly id: number;
  /** Le texte affiché en première ligne. */
  readonly text: string;
  /**
   * La seconde ligne, sous le texte — « 5 août 16:30 · 48 min ».
   *
   * @remarks
   * - ⚠️ Facultative, et c'est elle qui change la forme de la ligne : absente, l'entrée est
   *   celle d'une dictée, un texte sur une ou deux lignes ; présente, celle d'une session —
   *   titre coupé à l'ellipse, méta dessous, et la ligne devient cliquable.
   * - ⚠️ Ne pas la fondre dans `text` : deux graisses, deux tailles, et une ligne concaténée ne
   *   se laisserait ni tronquer ni annoncer séparément.
   */
  readonly meta?: string;
}

/**
 * Le panneau d'historique de la colonne de droite : des lignes, et une recherche dépliable.
 *
 * Trois états : vide, où l'invitation de l'appelant occupe seule la colonne, sans résultat, et
 * peuplé. Le panneau ne connaît ni store ni service et reçoit des lignes déjà filtrées.
 *
 * @remarks
 * - ⚠️ Le filtrage se fait à la source, jamais ici : masquer des lignes en CSS les laisserait
 *   dans l'ordre de tabulation et dans le compte annoncé, et casserait le virtual scroll.
 * - ⚠️ La loupe porte `aria-expanded`, jamais `aria-pressed` : elle déplie une zone, elle ne
 *   bascule pas un état et ne doit pas rester visuellement enfoncée.
 */
@Component({
  selector: 'app-history-panel',
  imports: [
    Icon,
    Button,
    NgTemplateOutlet,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
  ],
  templateUrl: './history-panel.html',
  styleUrl: './history-panel.scss',
})
export class HistoryPanel {
  /** Les lignes à montrer, déjà filtrées, du plus récent au plus ancien. */
  readonly entries = input.required<readonly HistoryEntry[]>();

  /** Le titre de la colonne — « Dernières dictées ». */
  readonly label = input.required<string>();

  /**
   * L'historique est-il vide ?
   *
   * @remarks
   * ⚠️ Reçu, et non déduit d'`entries` : une liste vide peut aussi bien vouloir dire « la
   * recherche ne rend rien », ce qui n'appelle pas le même écran. Seul l'appelant sait.
   */
  readonly empty = input.required<boolean>();

  /** Le texte cherché, tel que l'appelant le tient. */
  readonly search = input('');

  /** Le nom accessible du champ de recherche. */
  readonly searchLabel = input.required<string>();

  /** L'invite affichée dans le champ de recherche tant qu'il est vide. */
  readonly searchPlaceholder = input.required<string>();

  /** Ce qui s'affiche quand la recherche ne rend rien alors que l'historique existe. */
  readonly noResultLabel = input.required<string>();

  /**
   * La hauteur d'une ligne, en pixels, et l'interrupteur du virtual scroll : `0` — le défaut —
   * veut dire liste ordinaire.
   *
   * @remarks
   * - ⚠️ Le virtual scroll de la CDK recycle le DOM à hauteur fixe : il ne convient qu'aux
   *   lignes dont la hauteur ne dépend pas du contenu. Les sessions le sont, pas les dictées,
   *   dont le texte s'étale sur une ou deux lignes — l'y brancher en couperait une sur deux.
   * - ⚠️ Cette valeur descend jusqu'au style (`--hist-item-h`) : l'écrire des deux côtés les
   *   ferait diverger d'un pixel par ligne, ce qui ne se voit qu'après plusieurs centaines.
   */
  readonly itemSize = input(0);

  /** Le texte cherché vient de changer. */
  readonly searchChange = output<string>();

  /** La ligne dont le texte est à copier. */
  readonly copy = output<number>();

  /** La ligne à supprimer. */
  readonly remove = output<number>();

  /** L'historique entier est à vider. */
  readonly clearAll = output<void>();

  /**
   * Une ligne a été ouverte.
   *
   * @remarks
   * ⚠️ N'est émis que par les lignes à deux étages : c'est la présence d'une méta qui rend la
   * ligne cliquable, parce qu'elle dit qu'il y a un document derrière. Une dictée n'ouvre rien,
   * elle est déjà tout entière sous les yeux.
   */
  readonly open = output<number>();

  /** L'identité d'une ligne. ⚠️ Nommée, non inline : `cdkVirtualFor` compare la fonction. */
  protected readonly byId = (_index: number, entry: HistoryEntry): number => entry.id;

  /** Le champ de recherche est-il déplié ? Faux à l'ouverture du panneau. */
  protected readonly searching = signal(false);

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private readonly injector = inject(Injector);

  /** Relaie la saisie du champ de recherche. */
  protected onSearch(event: Event): void {
    this.searchChange.emit((event.target as HTMLInputElement).value);
  }

  /**
   * Déplie ou replie la recherche.
   *
   * @remarks
   * ⚠️ Le focus part dans le champ à l'ouverture : sans quoi il faudrait cliquer une seconde
   * fois pour taper, et le clavier seul n'y arriverait pas du tout.
   */
  protected toggleSearch(): void {
    const opening = !this.searching();
    this.searching.set(opening);

    if (opening) {
      // ⚠️ `afterNextRender`, et pas une micro-tâche : le champ n'existe pas encore au moment
      // du clic — il naît du `@if` que ce clic vient d'ouvrir.
      afterNextRender(() => this.field()?.nativeElement.focus(), { injector: this.injector });
      return;
    }
    // ⚠️ Refermer efface : une liste filtrée sans champ visible n'a plus rien qui l'explique,
    // et l'utilisateur croirait avoir perdu des dictées.
    if (this.search() !== '') {
      this.searchChange.emit('');
    }
  }
}
