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
import { Icon } from '../icon/icon';

/**
 * Le titre d'une fenêtre-document, renommable sur place.
 *
 * Clic sur le titre ou sur le crayon ouvre un champ pré-rempli et présélectionné ; Entrée et le
 * clic ailleurs valident, Échap annule, un champ vidé retombe sur {@link InlineTitle.fallback}.
 * Il n'écrit rien : c'est l'hôte qui retient le nom et repose {@link InlineTitle.value}.
 *
 * @remarks
 * ⚠️ Le `<h1>` cliquable n'est pas la voie clavier — un titre focalisable ajouterait un arrêt
 * de tabulation par document. C'est le bouton crayon, un vrai `<button>` révélé au focus autant
 * qu'au survol ; le clic sur le titre est un raccourci souris, en plus, jamais à la place.
 */
@Component({
  selector: 'app-inline-title',
  imports: [Icon],
  templateUrl: './inline-title.html',
  styleUrl: './inline-title.scss',
})
export class InlineTitle {
  /** Le titre affiché. C'est l'hôte qui le repose après un renommage. */
  readonly value = input.required<string>();

  /**
   * Ce que devient le titre quand le champ est validé vide.
   *
   * @remarks
   * ⚠️ Une entrée, et non une valeur en dur : une fenêtre de transcription retombe sur le nom
   * du fichier, une fenêtre-session sur sa date. Seul l'hôte sait laquelle.
   */
  readonly fallback = input.required<string>();

  /** Le nom accessible du bouton crayon — « Renommer la transcription ». */
  readonly renameLabel = input.required<string>();

  /**
   * Le nom accessible du champ — « Titre de la transcription ».
   *
   * @remarks
   * ⚠️ Distinct de {@link InlineTitle.renameLabel} : l'un nomme une action, l'autre une valeur.
   * Réutiliser le premier ferait annoncer « Renommer la transcription, zone d'édition », soit
   * le bouton d'où l'on vient et non ce qu'on est en train de saisir.
   */
  readonly fieldLabel = input.required<string>();

  /**
   * Le nouveau nom.
   *
   * @remarks
   * ⚠️ N'est émis que s'il change : valider sans avoir touché à rien ne doit déclencher ni
   * écriture, ni marqueur « modifié ».
   */
  readonly renamed = output<string>();

  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Le champ de saisie est-il ouvert ? */
  protected readonly editing = signal(false);

  /**
   * Ouvre le champ et lui donne le focus, texte présélectionné : le geste le plus courant est
   * de remplacer le nom, pas de le compléter.
   */
  protected edit(): void {
    this.editing.set(true);
    afterNextRender(
      () => {
        const field = this.host.nativeElement.querySelector<HTMLInputElement>('.title-input');
        field?.focus();
        field?.select();
      },
      { injector: this.injector },
    );
  }

  /**
   * Entrée : valide, et rend le focus au crayon qui reprend la place du champ.
   *
   * @param event - L'évènement du champ validé.
   * @remarks
   * ⚠️ Sans ce retour de focus, il tomberait sur `<body>` — l'élément qui le portait vient
   * d'être retiré du DOM — et la navigation au clavier serait perdue en haut de la fenêtre.
   */
  protected submit(event: Event): void {
    this.commit(event.target as HTMLInputElement);
    this.focusPencil();
  }

  /**
   * Perte de focus : valide, mais ne reprend rien — l'utilisateur est déjà parti ailleurs.
   *
   * @param event - L'évènement du champ quitté.
   * @remarks
   * ⚠️ Ne se déclenche ni sur Entrée ni sur Échap, bien que les deux retirent le champ : un
   * élément supprimé du DOM n'émet pas de `blur`. C'est ce qui permet à Échap d'annuler sans
   * qu'une validation passe derrière lui.
   */
  protected leave(event: Event): void {
    this.commit(event.target as HTMLInputElement);
  }

  /** Échap : rien n'est émis, et le crayon récupère le focus. */
  protected cancel(): void {
    this.editing.set(false);
    this.focusPencil();
  }

  /** Retient la saisie : repli sur le titre de secours si elle est vide, émission si elle change. */
  private commit(field: HTMLInputElement): void {
    const typed = field.value.trim();
    const next = typed === '' ? this.fallback() : typed;
    this.editing.set(false);
    if (next !== this.value()) {
      this.renamed.emit(next);
    }
  }

  /**
   * Rend le focus au crayon. Même contrainte, même réponse que {@link InlineTitle.edit} : la
   * cible n'existe qu'après le rendu.
   */
  private focusPencil(): void {
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLButtonElement>('.title-rename')?.focus(),
      { injector: this.injector },
    );
  }
}
