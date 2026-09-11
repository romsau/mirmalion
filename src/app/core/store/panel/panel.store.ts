import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';

/** Ce que la fenêtre sait de son panneau d'historique. */
interface PanelState {
  /**
   * Le panneau d'historique est-il replié ?
   *
   * @remarks
   * ⚠️ Vrai au démarrage et jamais persisté : la fenêtre s'ouvre ainsi dans sa largeur réduite,
   * celle qui convient à une dictée, et non à moitié vide en attendant qu'on regarde l'historique.
   */
  readonly collapsed: boolean;
}

const initialState: PanelState = { collapsed: true };

/**
 * L'état du panneau d'historique — replié ou non, et rien d'autre.
 *
 * Trois endroits qui ne se connaissent pas en dépendent : l'écran, dont la grille passe à deux
 * colonnes, la fenêtre, qui double de largeur (`WindowShell`), et le bouton qui le bascule.
 *
 * @remarks
 * ⚠️ Il ne dit pas de quel historique il s'agit : un seul écran est affiché à la fois, et un
 * état par écran donnerait deux vérités pour une seule fenêtre.
 */
export const PanelStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store) => ({
    /** Replie le panneau s'il est déployé, le déploie sinon. */
    toggle(): void {
      patchState(store, { collapsed: !store.collapsed() });
    },
  })),
);
