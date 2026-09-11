import { DOCUMENT, Service, computed, effect, inject } from '@angular/core';
import { SettingsStore } from '../../store/settings/settings.store';
import { SystemBridge } from '../bridge/system/system.bridge';
import { ACCENT_PALETTE, type AccentId, type AccentTokens } from '../../models/accent-palette';
import type { ThemeName } from '../../models/settings';

/**
 * Peint le thème et la teinte d'accent sur le document, et les change.
 *
 * Il ne détient aucun état : le thème et les deux accents vivent dans `SettingsStore`. Un effet
 * repeint dès que cet état bouge, d'où un aperçu immédiat sans bouton « Appliquer ».
 *
 * @remarks
 * - ⚠️ L'effet ne tourne que si le service est instancié : c'est `App` qui l'injecte, la racine
 *   de chaque fenêtre et non la coquille, que les fenêtres secondaires ne traversent pas.
 * - ⚠️ Le thème du système ne se relit jamais après le premier lancement : il n'y a pas de mode
 *   « Système », seul le choix de l'utilisateur compte.
 */
@Service()
export class Theme {
  private readonly document = inject(DOCUMENT);
  private readonly settings = inject(SettingsStore);
  private readonly system = inject(SystemBridge);

  /** Le thème courant — clair ou sombre, jamais « système ». */
  readonly theme = this.settings.theme;

  /** La teinte du thème courant. Changer de thème change donc ce que rend ce signal. */
  readonly accent = computed<AccentId>(() => {
    const settings = this.settings.settings();
    return this.theme() === 'dark' ? settings.accentDark : settings.accentLight;
  });

  /** Branche la peinture sur le thème et la teinte, pour la vie du service. */
  constructor() {
    effect(() => this.paint(this.theme(), this.accent()));
  }

  /** Bascule vers le thème demandé, et réaffiche l'accent qui lui est propre. */
  async setTheme(theme: ThemeName): Promise<void> {
    await this.settings.update({ theme });
  }

  /**
   * Change la teinte du thème courant, et de lui seul.
   *
   * C'est ce qui fait que le clair et le sombre gardent chacun la leur : le réglage écrit
   * dépend du thème actif au moment du clic.
   */
  async setAccent(accent: AccentId): Promise<void> {
    await this.settings.update(
      this.theme() === 'dark' ? { accentDark: accent } : { accentLight: accent },
    );
  }

  /**
   * Écrit sur `<html>` : l'attribut qui sélectionne le thème, puis les quatre variables qui
   * portent la teinte.
   *
   * @remarks
   * ⚠️ Les quatre variables sont posées en style en ligne sur `:root`, ce qui recouvre les
   * valeurs par défaut des fichiers de thème. C'est la seule couture par laquelle une teinte
   * s'applique : aucun composant ne doit peindre une couleur d'accent en dur.
   */
  private paint(theme: ThemeName, accent: AccentId): void {
    const root = this.document.documentElement;
    root.dataset['theme'] = theme;
    const tokens: AccentTokens = ACCENT_PALETTE[accent][theme];
    root.style.setProperty('--accent', tokens.accent);
    root.style.setProperty('--accent-600', tokens.accent600);
    root.style.setProperty('--accent-50', tokens.accent50);
    root.style.setProperty('--accent-ink', tokens.accentInk);

    // ⚠️ Le cadre de la fenêtre ne se peint pas en CSS : macOS le dessine selon l'apparence de
    // la `NSWindow`, qui ignore `data-theme`. Sans cet appel, une application sombre garde un
    // liseré clair d'un pixel en haut de sa fenêtre. L'échec est avalé : c'est cosmétique, et
    // hors contexte Tauri l'appel ne fait rien.
    void this.system.setWindowTheme(theme === 'dark').catch(() => undefined);
  }
}
