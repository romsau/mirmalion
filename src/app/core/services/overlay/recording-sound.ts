import { Service, inject } from '@angular/core';
import { MAIN_WINDOW } from '../bridge/invoke/invoke';
import { subscriptions } from '../bridge/subscriptions';
import { SHORTCUT_EVENT } from '../bridge/shortcut/shortcut.bridge';
import type { ShortcutAction } from '../bridge/shortcut/shortcut.bridge';
import { SettingsStore } from '../../store/settings/settings.store';
import { Invoke } from '../bridge/invoke/invoke';

/** Les deux sons, servis par Angular comme n'importe quel actif statique. */
const SOURCES: Readonly<Record<ShortcutAction, string>> = {
  start: 'assets/sounds/sound-start.mp3',
  stop: 'assets/sounds/sound-stop.mp3',
};

/**
 * Les deux sons d'enregistrement — un au début, un à l'arrêt, dictée et Direct confondus.
 *
 * Il ne s'abonne que pour la dictée, dont le raccourci global est le seul déclencheur
 * automatique ; le Direct appelle {@link RecordingSound.play} lui-même.
 *
 * @remarks
 * - ⚠️ Injecté pour son effet de bord, comme `Theme` : personne ne l'appelle, il s'abonne seul.
 *   Sans injection quelque part — `App` —, il n'existe pas.
 * - ⚠️ Il est ce qui interdit de détruire la fenêtre principale : sans webview vivant pour
 *   recevoir l'évènement, l'application devient muette sans que rien de visible ne casse.
 */
@Service()
export class RecordingSound {
  private readonly core = inject(Invoke);
  private readonly settings = inject(SettingsStore);

  private readonly players: Readonly<Record<ShortcutAction, HTMLAudioElement>> = {
    start: new Audio(SOURCES.start),
    stop: new Audio(SOURCES.stop),
  };

  private readonly subs = subscriptions();

  /**
   * Précharge les deux sons, puis branche l'écoute du raccourci.
   *
   * @remarks
   * ⚠️ Les `Audio` sont construits au démarrage, jamais au moment de jouer : un décodage MP3
   * déclenché à l'appui du raccourci s'entendrait — le son arriverait après le début de la
   * phrase, donc après l'overlay qu'il accompagne.
   */
  constructor() {
    for (const player of Object.values(this.players)) {
      player.preload = 'auto';
      player.load();
    }

    void this.listen();
  }

  /**
   * Branche la lecture sur le raccourci global, dans la fenêtre principale seulement.
   *
   * @remarks
   * ⚠️ L'application Angular est montée dans chaque fenêtre, overlay compris, et un évènement
   * diffusé les atteint toutes : sans ce garde, le son part deux fois. Il est ici et non dans
   * `App`, parce que c'est ce service qui a un effet global, pas la racine.
   */
  private async listen(): Promise<void> {
    if ((await this.core.windowLabel()) !== MAIN_WINDOW) {
      return;
    }
    await this.subs.keep(
      this.core.listen<ShortcutAction>(SHORTCUT_EVENT, (action) => {
        this.play(action);
      }),
    );
  }

  /**
   * Joue le son de l'action, si les sons sont activés.
   *
   * @remarks
   * - ⚠️ Le réglage se consulte ici et nulle part ailleurs : un appelant qui teste
   *   `soundsEnabled` avant d'appeler écrit la même vérité à deux endroits.
   * - ⚠️ Aucun retour n'existe uniquement en son : ces deux-là doublent l'overlay, qui paraît
   *   aux mêmes instants. C'est ce qui autorise l'option à les couper sans rien perdre.
   */
  play(action: ShortcutAction): void {
    if (!this.settings.settings().soundsEnabled) {
      return;
    }
    this.emit(action);
  }

  /**
   * Joue le son sans consulter le réglage.
   *
   * @remarks
   * - ⚠️ Rejouer demande de rembobiner : deux dictées d'affilée réutilisent le même élément, et
   *   sans `currentTime = 0` la seconde repartirait de la fin du fichier, inaudible.
   * - ⚠️ Un échec de lecture ne remonte nulle part, pas même en snackbar : une erreur à
   *   l'instant où l'utilisateur commence à parler gênerait plus que le silence.
   */
  private emit(action: ShortcutAction): void {
    const player = this.players[action];
    player.currentTime = 0;
    void player.play().catch(() => undefined);
  }
}
