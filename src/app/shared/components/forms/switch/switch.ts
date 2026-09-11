import { Component, booleanAttribute, input, model, output } from '@angular/core';

/**
 * L'interrupteur de l'application, et le seul : `role="switch"`, à effet immédiat.
 *
 * Par défaut il bascule lui-même. En mode {@link Switch.controlled}, il ne touche plus à son
 * état : il le demande par {@link Switch.toggleRequested}, et c'est l'hôte qui l'accorde.
 *
 * @remarks
 * - ⚠️ {@link Switch.ariaLabel} est obligatoire : l'interrupteur n'a aucun contenu visible, et
 *   sans nom un lecteur d'écran annonce « interrupteur, activé » sans jamais dire de quoi.
 * - ⚠️ Une liaison `[checked]` ne suffit pas à retenir un geste : Angular ne réécrit une entrée
 *   que si l'expression a changé, donc un refus qui ne change rien laisse l'interrupteur allumé.
 */
@Component({
  selector: 'app-switch',
  imports: [],
  templateUrl: './switch.html',
  styleUrl: './switch.scss',
})
export class Switch {
  /** L'état de l'interrupteur. En mode contrôlé, il n'est plus écrit d'ici. */
  readonly checked = model(false);

  /** L'interrupteur ne répond plus. */
  readonly disabled = input(false);

  /** Le nom accessible. Obligatoire : l'interrupteur n'a aucun contenu visible. */
  readonly ariaLabel = input.required<string>();

  /**
   * L'interrupteur demande au lieu d'agir — voir l'en-tête.
   *
   * `booleanAttribute` pour qu'il s'écrive nu, `<app-switch controlled …>`, comme `disabled`
   * sur un contrôle natif.
   */
  readonly controlled = input(false, { transform: booleanAttribute });

  /** La bascule est demandée. N'est émis qu'en mode contrôlé ; ailleurs, c'est `checkedChange`. */
  readonly toggleRequested = output<void>();

  /** Bascule l'interrupteur, ou demande la bascule en mode contrôlé. */
  protected toggle(): void {
    if (this.controlled()) {
      this.toggleRequested.emit();
      return;
    }
    this.checked.update((value) => !value);
  }
}
