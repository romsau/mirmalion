import { Component, inject, input, output } from '@angular/core';
import { Button } from '../button/button';
import { SystemBridge } from '../../../core/services/bridge/system/system.bridge';
import { Modal } from '../../../core/services/modal/modal';

/** Les trois écrans que la coquille sait afficher. L'ordre est celui du header. */
export type ScreenId = 'dictee' | 'direct' | 'options';

/**
 * Le header global : le nom de l'application, et les entrées vers les autres écrans.
 *
 * Ce ne sont pas trois onglets — l'écran courant n'a pas d'entrée vers lui-même, et c'est
 * cette absence qui dit où l'on est. Il n'appelle pas le routeur : il émet l'écran demandé, et
 * c'est la coquille qui navigue.
 *
 * @remarks
 * - ⚠️ Pas d'entrée « Historique » : l'historique est un panneau contextuel du mode courant,
 *   pas une destination.
 * - ⚠️ Pas de bascule de thème ici : elle appartient à l'écran des options.
 */
@Component({
  selector: 'app-header',
  imports: [Button],
  templateUrl: './header.html',
  styleUrl: './header.scss',
  host: {
    // ⚠️ Sans ce rôle, le nom de l'application vit hors de tout repère de page ; il range
    // l'en-tête entier là où on l'attend, et complète le `<main>` posé par `WindowShell`. Un
    // seul par page, dit l'ARIA — l'hôte n'est monté qu'une fois par fenêtre. Aucun spec ne
    // peut le voir : la règle `region` d'AXE est `pageLevel: true`, jamais vraie sur un fragment.
    role: 'banner',
    '[class.compact]': 'compact()',
    // ⚠️ C'est par là qu'on déplace la fenêtre. En `titleBarStyle: Overlay`, le webview couvre
    // la barre de titre et avale les évènements souris ; Tauri rétablit le déplacement sur les
    // seuls éléments portant cet attribut, en comparant la cible exacte du clic. À poser sur
    // chaque élément de fond, pas seulement sur l'hôte — voir le gabarit.
    'data-tauri-drag-region': '',
    '(dblclick)': 'onDoubleClick($event)',
  },
})
export class Header {
  /**
   * L'écran affiché. Son entrée est retirée de la barre.
   *
   * @remarks
   * ⚠️ `null` veut dire « hors de l'application » : c'est la fenêtre d'onboarding, qui porte le
   * même header pour l'identité mais aucune navigation — les trois entrées mènent à des écrans
   * que cette fenêtre n'a pas.
   */
  readonly current = input<ScreenId | null>(null);

  /**
   * La fenêtre étroite : Options tombe en icône seule, et le nom de la marque s'en va.
   *
   * @remarks
   * ⚠️ Options seul — les deux destinations gardent leur mot dans les deux modes, contre la
   * maquette et par arbitrage du porteur : ce sont elles qu'on cherche.
   * ⚠️ Le libellé disparaît du gabarit, pas seulement de l'affichage : c'est `ariaLabel`, posé
   * dans les deux modes, qui garantit que le nom accessible ne bouge pas. Le `font-size: 0` de
   * la maquette laisserait un texte de taille nulle dans l'arbre d'accessibilité.
   */
  readonly compact = input(false);

  /** L'écran demandé par l'utilisateur. */
  readonly navigate = output<ScreenId>();

  private readonly system = inject(SystemBridge);

  /**
   * Le service de modales, lu par le gabarit pour neutraliser la navigation pendant qu'une boîte
   * est ouverte.
   *
   * @remarks
   * ⚠️ Une lecture, pas une ouverture : le header n'ouvre aucune modale. Le voile ne couvre plus
   * la barre de titre, c'est donc au header de refuser les clics que le voile n'intercepte plus.
   */
  protected readonly modal = inject(Modal);

  /**
   * Agrandit la fenêtre, comme le double-clic sur une barre de titre ordinaire.
   *
   * @remarks
   * ⚠️ **Le même partage que le déplacement** : seuls les éléments de fond portent
   * `data-tauri-drag-region`, et c'est lui qui distingue la barre de titre de ce qu'elle
   * contient. Sans ce filtre, un double-clic sur une entrée changerait d'écran ET ferait sauter
   * la fenêtre.
   * ⚠️ Sans effet là où la fenêtre est figée : c'est le backend qui le refuse, pas ce composant,
   * qui ne sait pas dans quelle fenêtre il est monté.
   */
  protected onDoubleClick(event: Event): void {
    if (!(event.target as Element).hasAttribute('data-tauri-drag-region')) {
      return;
    }
    void this.system.toggleWindowZoom();
  }
}
