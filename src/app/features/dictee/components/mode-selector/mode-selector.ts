import { Component, computed, model } from '@angular/core';
import { Icon } from '../../../../shared/components/icon/icon';
import type { DictationMode } from '../../../../core/models/settings';

/**
 * Le choix entre « Maintenir » et « Mains libres », avec l'indice de raccourci qui l'explique.
 *
 * Deux bascules `aria-pressed` dans un groupe, et non un groupe de radios : chacune s'annonce
 * elle-même et reste atteignable par Tab, comme le rend la maquette.
 *
 * @remarks
 * ⚠️ Ni `Button`, ni `Segmented` : la maquette lui donne son propre motif (`.mode-card` /
 * `.mode-btn`) — aucun fond au repos, l'accent plein sur le choix retenu, les deux boutons
 * empilés dans une carte creusée. Un `Button` porterait un fond teinté au repos.
 */
@Component({
  selector: 'app-mode-selector',
  imports: [Icon],
  templateUrl: './mode-selector.html',
  styleUrl: './mode-selector.scss',
})
export class ModeSelector {
  /** Le mode de déclenchement, en aller-retour avec l'hôte. */
  readonly mode = model.required<DictationMode>();

  /**
   * La phrase qui explique le mode retenu.
   *
   * @remarks
   * ⚠️ Composée ici et non par deux blocs `@if` dans le gabarit : deux nœuds distincts feraient
   * annoncer une disparition puis une apparition là où il n'y a qu'un texte qui change.
   */
  protected readonly hint = computed(() =>
    this.mode() === 'hold'
      ? $localize`:@@dictee.mode.hint.hold:Maintenez pour dicter.`
      : $localize`:@@dictee.mode.hint.toggle:Tapez pour démarrer, tapez pour arrêter.`,
  );
}
