import { effect, inject, untracked, type Signal } from '@angular/core';
import { Snackbar } from './snackbar';
import type { AppError } from '../../models/app-error';

/**
 * Ce qu'un magasin doit offrir pour que ses échecs se disent tout seuls.
 *
 * @remarks
 * ⚠️ Le contrat minimal, et non un type de magasin : c'est ce qui laisse les sept appelants
 * passer le leur sans qu'aucun n'ait à hériter de quoi que ce soit.
 */
export interface ErrorSource {
  /** Le dernier échec, ou `null` quand il n'y a rien à dire. */
  readonly error: Signal<AppError | null>;
  /** Oublie l'échec courant. */
  clearError(): void;
}

/**
 * Dit les échecs d'un magasin en snackbar, une fois chacun, puis les oublie. À appeler depuis un
 * contexte d'injection : l'effet posé vit et meurt avec le composant.
 *
 * @param source - Le magasin dont on draine les échecs.
 *
 * @remarks
 * - ⚠️ La remise à zéro est le point : sans elle, la snackbar reviendrait à chaque cycle de
 * détection, longtemps après le geste qui l'a causée.
 * - ⚠️ `untracked` autour de l'écriture : `clearError()` touche le signal que l'effet vient de
 * lire, et sans lui l'effet se réinscrit sur sa propre écriture.
 */
export function drainErrors(source: ErrorSource): void {
  const snackbar = inject(Snackbar);
  effect(() => {
    const failure = source.error();
    if (failure === null) {
      return;
    }
    untracked(() => {
      snackbar.error(failure.message);
      source.clearError();
    });
  });
}
