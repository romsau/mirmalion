import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import {
  OptionsRail,
  OPTIONS_CATEGORIES,
  type OptionsCategoryId,
} from './components/options-rail/options-rail';

/**
 * La catégorie que désigne une URL d'Options. Tout ce qui n'est pas une catégorie connue retombe
 * sur « Général », l'accueil des Options.
 *
 * @remarks
 * ⚠️ Elle lit le premier segment après `/options` et s'arrête là : c'est ce qui garde le rail sur
 * « Langues » dans `/options/langues/parlees`. Une famille nouvelle n'a rien à ajouter ici, il
 * lui suffit de figurer dans {@link OPTIONS_CATEGORIES}.
 */
export function categoryFromUrl(url: string): OptionsCategoryId {
  const segment = url.split(/[?#]/, 1)[0].split('/')[2];
  return OPTIONS_CATEGORIES.find((category) => category === segment) ?? 'general';
}

/**
 * La coquille de l'écran Options — patron « Réglages Système » de macOS.
 *
 * @remarks
 * - ⚠️ Le panneau de droite n'affiche aucun titre de catégorie : le rail seul dit où l'on est et
 *   porte `aria-current`. Les réglages se rendent bord à bord, d'où `screen-frame`.
 * - ⚠️ Pas de champ de recherche : ne pas en ajouter « pendant qu'on y est ».
 */
@Component({
  selector: 'app-options',
  imports: [OptionsRail, RouterOutlet],
  templateUrl: './options.html',
  styleUrl: './options.scss',
})
export class Options {
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** La famille ouverte, déduite de l'URL courante. */
  protected readonly category = computed(() => categoryFromUrl(this.url()));

  /** Ouvre une famille de réglages. */
  protected go(category: OptionsCategoryId): void {
    void this.router.navigate(['/options', category]);
  }
}
