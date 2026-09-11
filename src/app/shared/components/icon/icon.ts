import { Component, computed, input } from '@angular/core';
import { ICONS, type IconName } from './icons';

/**
 * L'unique manière de dessiner une icône : un `<svg>` tiré d'`ICONS`.
 *
 * {@link Icon.label} absent vaut décoratif — l'icône est alors masquée aux technologies
 * d'assistance ; renseigné, elle devient une image annoncée. L'icône occupe `1em` et se
 * dimensionne depuis son parent (`.mon-bouton app-icon { width: 16px }`) : pas d'entrée `size`.
 *
 * @remarks
 * ⚠️ Une icône décorative étiquetée est bavarde, une icône signifiante sans étiquette est
 * muette. `label` n'est pas un texte de survol : une infobulle se pose en `title` sur l'élément
 * cliquable, jamais sur l'icône.
 */
@Component({
  selector: 'app-icon',
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth() ?? icon().strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.role]="label() ? 'img' : null"
      [attr.aria-label]="label()"
      [attr.aria-hidden]="label() ? null : 'true'"
    >
      <g [class.spin]="spin()">
        @for (shape of icon().shapes; track shape.d) {
          <path [attr.d]="shape.d" [attr.fill]="shape.fill" [attr.stroke]="shape.stroke" />
        }
      </g>
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      width: 1em;
      height: 1em;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    /*
     * La rotation s'applique en vectoriel, dans le SVG. 'transform-box: view-box' est la clé :
     * sans lui, l'origine serait la boîte du dessin — pour un arc de cercle incomplet, ce n'est
     * pas le centre du cercle.
     *
     * ⚠️ Appliquée à l'élément hôte, elle tournerait une image déjà rastérisée : WebKit arrondit
     * sa position au pixel de l'écran à chaque image, et sur un écran mis à l'échelle en
     * fraction le centre de rotation se déplace — le glyphe monte et descend en tournant.
     */
    .spin {
      transform-box: view-box;
      transform-origin: center;
      animation: icon-spin 0.8s linear infinite;
    }

    @keyframes icon-spin {
      to {
        transform: rotate(360deg);
      }
    }

    /*
     * ⚠️ On calme la rotation, on ne la supprime pas : c'est la seule chose qui distingue « ça
     * travaille » de « c'est planté ». Le '!important' neutralise la règle globale de
     * '_base.scss', qui coupe toutes les boucles d'animation.
     */
    @media (prefers-reduced-motion: reduce) {
      .spin {
        animation-duration: 2s !important;
        animation-iteration-count: infinite !important;
      }
    }
  `,
})
export class Icon {
  /** L'icône à dessiner. */
  readonly name = input.required<IconName>();

  /**
   * Le nom accessible. Le renseigner rend l'icône signifiante : elle devient une image annoncée.
   * L'omettre la masque aux technologies d'assistance.
   */
  readonly label = input<string>();

  /**
   * Remplace l'épaisseur canonique de l'icône.
   *
   * À n'utiliser que lorsque la maquette rend la même icône à deux tailles très différentes et
   * compense optiquement. Corriger la valeur dans `icons.ts` vaut mieux que la surcharger.
   */
  readonly strokeWidth = input<number>();

  /**
   * Fait tourner l'icône : l'attente qui progresse, par opposition à celle qui a planté.
   *
   * @remarks
   * ⚠️ La rotation appartient à l'icône, pas à qui l'affiche : un appelant qui l'animerait
   * lui-même ferait tourner l'élément hôte, donc une image rastérisée, et retrouverait le
   * tremblement que cette implémentation évite — voir le commentaire des styles.
   */
  readonly spin = input(false);

  /** La définition de l'icône nommée : ses tracés et son épaisseur canonique. */
  protected readonly icon = computed(() => ICONS[this.name()]);
}
