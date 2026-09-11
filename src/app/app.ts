import { Component, effect, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Theme } from './core/services/theme/theme';
import { RecordingSound } from './core/services/overlay/recording-sound';
import { Snackbar } from './core/services/snackbar/snackbar';
import { Invoke, MAIN_WINDOW } from './core/services/bridge/invoke/invoke';
import { SettingsStore } from './core/store/settings/settings.store';

/**
 * La racine de chaque fenêtre : elle ne fait que router. La mise en page vit dans `WindowShell`,
 * déclaré composant de route parente, que les fenêtres secondaires ne traversent pas.
 *
 * @remarks
 * ⚠️ `Theme`, `RecordingSound` et `SettingsStore.load()` sont montés ici plutôt que dans la
 * coquille : leurs effets n'existent qu'une fois injectés, et les fenêtres secondaires
 * resteraient sinon non peintes, muettes, et sur les valeurs par défaut. La dictée se déclenche
 * fenêtre fermée, donc depuis n'importe quel écran.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly settings = inject(SettingsStore);
  private readonly snackbar = inject(Snackbar);
  private readonly core = inject(Invoke);

  /** Injectés pour leur seul effet de bord — voir l'en-tête de la classe. */
  private readonly theme = inject(Theme);
  private readonly recordingSound = inject(RecordingSound);

  /**
   * Sommes-nous dans la fenêtre principale ? `null` tant que le pont n'a pas répondu.
   *
   * @remarks
   * ⚠️ Ce troisième état est ce qui rend l'annonce fiable : l'étiquette de la fenêtre se lit par
   * le pont, donc plus tard qu'un échec de lecture des réglages. Un booléen initialisé à faux
   * avalerait l'annonce du démarrage ; ici, l'effet se rejoue quand la réponse arrive.
   */
  private readonly isMainWindow = signal<boolean | null>(null);

  constructor() {
    void this.core.windowLabel().then((label) => this.isMainWindow.set(label === MAIN_WINDOW));
    void this.settings.load();

    // ⚠️ Un réglage qui n'a pas pu être écrit se dit ici, et non chez les quinze appelants
    // d'`update()` : un contrôle par appelant serait quinze occasions d'en oublier un.
    // `SettingsStore` range l'échec dans `error` sans annuler le changement affiché, que
    // l'aperçu en temps réel exige.
    //
    // ⚠️ On lit `error` et non `isDegraded` : deux échecs consécutifs donnent deux objets
    // distincts, donc deux annonces, là où un booléen resté vrai n'en donnerait qu'une.
    //
    // ⚠️ Fenêtre principale seulement : chaque fenêtre porte son propre magasin et échouerait de
    // la même façon — un disque plein ferait apparaître la phrase dans chaque document ouvert,
    // et dans la pilule, qui n'accepte aucune interaction.
    effect(() => {
      const failure = this.settings.error();
      if (failure === null || this.isMainWindow() !== true) {
        return;
      }
      this.snackbar.error(
        $localize`:@@settings.saveFailed:Vos réglages n'ont pas pu être enregistrés : ils seront perdus au prochain démarrage.`,
      );
    });
  }
}
