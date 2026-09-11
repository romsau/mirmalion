import { Component, input, output } from '@angular/core';
import { ProgressBar } from '../progress-bar/progress-bar';

/**
 * Le voile de travail d'une fenêtre-document : un fond translucide, un bloc de progression.
 *
 * @remarks
 * - ⚠️ Il se pose en `position: absolute` : sans ancêtre positionné, il couvre la page entière.
 *   Plusieurs fenêtres-documents coexistent — un voile ancré au viewport masquerait le mauvais.
 * - ⚠️ Il ne désactive pas les contrôles qu'il recouvre : ils sont cachés à l'œil et à la
 *   souris, pas au clavier. C'est à l'hôte de rendre sa barre d'actions inerte.
 * - ⚠️ La barre, le pourcentage et le bouton d'arrêt appartiennent à `ProgressBar` : ce
 *   composant n'apporte que la boîte — voile, centrage, largeur.
 */
@Component({
  selector: 'app-doc-overlay',
  imports: [ProgressBar],
  templateUrl: './doc-overlay.html',
  styleUrl: './doc-overlay.scss',
})
export class DocOverlay {
  /** Ce que le voile annonce : l'opération en cours. */
  readonly label = input.required<string>();

  /**
   * L'avancement, de `0` à `100`.
   *
   * @remarks
   * ⚠️ `null` veut dire « en cours, durée inconnue », jamais « 0 % » : le voile n'invente aucune
   * progression, il affiche ce qu'on lui donne.
   */
  readonly progress = input<number | null>(null);

  /**
   * L'opération peut être interrompue.
   *
   * « Annuler » n'apparaît qu'au bout de quelques secondes — le seuil est tenu par
   * `ProgressBar`, pour que le bouton ne clignote pas sur les opérations trop courtes.
   */
  readonly cancellable = input(true);

  /** L'utilisateur demande l'arrêt. Le voile n'interrompt rien : c'est à l'hôte de le faire. */
  readonly cancelled = output<void>();
}
