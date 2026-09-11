import { Component, computed, inject, signal } from '@angular/core';
import { Icon } from '../../../../shared/components/icon/icon';
import { OptionRow } from '../../components/option-row/option-row';
import { Segmented } from '../../../../shared/components/forms/segmented/segmented';
import { Switch } from '../../../../shared/components/forms/switch/switch';
import { Select } from '../../../../shared/components/forms/select/select';
import { DicteeStore } from '../../../../core/store/dictee/dictee.store';
import { SettingsStore } from '../../../../core/store/settings/settings.store';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import { Theme } from '../../../../core/services/theme/theme';
import { ACCENT_IDS, ACCENT_PALETTE, type AccentId } from '../../../../core/models/accent-palette';
import type { FormOption } from '../../../../shared/components/forms/form-option';
import type { ThemeName } from '../../../../core/models/settings';
import { SystemBridge } from '../../../../core/services/bridge/system/system.bridge';

/**
 * La catégorie de réglages Général : l'apparence d'abord, le comportement système ensuite.
 *
 * @remarks
 * - ⚠️ Pas de mode « Système » pour le thème : celui du système ne sert qu'au premier lancement,
 *   à choisir la valeur initiale. Ensuite seul le choix de l'utilisateur compte.
 * - ⚠️ Pas de réglage « Ouvrir la fenêtre au lancement » : la fenêtre principale naît toujours
 *   cachée et le tray est le point d'entrée. Ne pas le réintroduire.
 * - ⚠️ Les deux réglages système ne se persistent pas pareil : le Dock s'écrit chez nous,
 *   l'ouverture à la session vit dans macOS et se relit de lui.
 */
@Component({
  selector: 'app-options-general',
  imports: [Icon, OptionRow, Segmented, Switch, Select],
  templateUrl: './options-general.html',
  styleUrl: './options-general.scss',
})
export class OptionsGeneral {
  private readonly devices = inject(DicteeStore);
  private readonly themeService = inject(Theme);
  private readonly settings = inject(SettingsStore);
  private readonly system = inject(SystemBridge);
  private readonly snackbar = inject(Snackbar);

  /**
   * Les entrées audio proposées, avec le défaut système en tête.
   *
   * @remarks
   * ⚠️ `''` représente « celui du système », un `<select>` ne transportant que des chaînes. La
   * conversion en `null` se fait au bord, dans {@link OptionsGeneral.pickMicrophone} : laisser
   * fuir cette convention écrirait une chaîne vide là où le type dit `string | null`.
   */
  protected readonly microphoneOptions = computed<readonly FormOption[]>(() => [
    { value: '', label: $localize`:@@dictee.mic.system:Micro système (par défaut)` },
    ...this.devices
      .microphones()
      .filter((device) => !device.isDefault)
      .map((device) => ({ value: device.id, label: device.name })),
  ]);

  /** L'entrée retenue, `''` valant « celle du système ». */
  protected readonly microphoneValue = computed(() => this.settings.settings().microphoneId ?? '');

  /** Retient l'entrée audio choisie, partagée par la dictée et le Direct. */
  protected pickMicrophone(value: string): void {
    void this.settings.update({ microphoneId: value === '' ? null : value });
  }

  /** Les sons de départ et d'arrêt sont-ils actifs ? */
  protected readonly soundsEnabled = computed(() => this.settings.settings().soundsEnabled);

  /**
   * Allume ou éteint les sons.
   *
   * @remarks
   * ⚠️ Liaison à sens unique : le réglage vit dans le store, qui l'écrit sur le disque. Un
   * `[(checked)]` demanderait un signal local, donc une seconde vérité qui divergerait au
   * premier échec d'écriture.
   */
  protected setSounds(soundsEnabled: boolean): void {
    void this.settings.update({ soundsEnabled });
  }

  /** Toute la ligne est cliquable, pas seulement l'interrupteur. */
  protected toggleSounds(): void {
    this.setSounds(!this.soundsEnabled());
  }

  constructor() {
    // ⚠️ Sans cela, la liste n'aurait que le micro système : les entrées de la machine sont lues
    // par les écrans qui captent, et on peut arriver ici sans y être passé — au premier
    // lancement, par le menu du tray. L'appel est idempotent et ne rejette jamais.
    void this.devices.load();
    // L'état réel de l'élément d'ouverture de session, lu de macOS à l'affichage.
    void this.readLaunchAtLogin();
  }

  /** Les deux thèmes proposés par le segmenté, libellés compris. */
  protected readonly themes: readonly FormOption<ThemeName>[] = [
    { value: 'light', label: $localize`:@@options.theme.light:Clair`, icon: 'sun' },
    { value: 'dark', label: $localize`:@@options.theme.dark:Sombre`, icon: 'moon' },
  ];

  /** Le thème en vigueur. */
  protected readonly theme = this.themeService.theme;

  /**
   * Applique un thème.
   *
   * @remarks
   * ⚠️ Liaison à sens unique, jamais `[(value)]` : le thème vit dans les réglages, que `Theme`
   * écrit sur le disque. Une liaison bidirectionnelle demanderait une deuxième source de vérité.
   */
  protected setTheme(theme: ThemeName): void {
    void this.themeService.setTheme(theme);
  }

  /** Le clic sur la ligne bascule vers l'autre thème — il n'y en a que deux. */
  protected toggleTheme(): void {
    this.setTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  /** La teinte du thème courant — changer de thème réaffiche celle qui lui est propre. */
  protected readonly accent = this.themeService.accent;

  /**
   * Les seize pastilles de teinte, dans l'ordre de la roue chromatique.
   *
   * @remarks
   * - ⚠️ La couleur affichée est lue dans `ACCENT_PALETTE` pour le thème courant, jamais recopiée
   *   ici : la table est générée, et un double figerait l'aperçu à la première régénération.
   * - ⚠️ Chaque pastille porte un nom accessible : un bouton dont le seul contenu est une couleur
   *   de fond est muet, et seize boutons muets d'affilée sont intraversables au clavier.
   */
  protected readonly tints = computed(() =>
    ACCENT_IDS.map((id) => ({
      id,
      color: ACCENT_PALETTE[id][this.theme()].accent,
      label: ACCENT_LABELS[id],
    })),
  );

  /** Applique une teinte d'accent. */
  protected setAccent(accent: AccentId): void {
    void this.themeService.setAccent(accent);
  }

  /** L'application figure-t-elle dans le Dock ? */
  protected readonly showInDock = computed(() => this.settings.settings().showInDock);

  /**
   * Montre ou retire l'application du Dock.
   *
   * @remarks
   * ⚠️ Le réglage est écrit d'abord, appliqué ensuite : si l'application échoue, le choix se
   * retrouve au prochain démarrage, qui relit ce fichier. L'inverse laisserait une session dans
   * le Dock et un réglage qui dit le contraire.
   */
  protected setDock(showInDock: boolean): void {
    void this.settings.update({ showInDock }).then(() => this.system.setDockVisible(showInDock));
  }

  /** Toute la ligne est cliquable, pas seulement l'interrupteur. */
  protected toggleDock(): void {
    this.setDock(!this.showInDock());
  }

  /**
   * L'ouverture à la session — le seul réglage de l'application qui ne soit pas dans le fichier
   * de réglages.
   *
   * @remarks
   * ⚠️ Il vit dans macOS, où l'utilisateur peut le retirer sans nous prévenir. D'où ce signal
   * local, alimenté par une lecture de l'état réel, plutôt qu'un `computed` sur des réglages qui
   * mentiraient. Voir `commands/autostart.rs`.
   */
  protected readonly launchAtLogin = signal(false);

  /**
   * Inscrit ou retire l'élément d'ouverture de session.
   *
   * @remarks
   * ⚠️ L'interrupteur suit le résultat, pas le geste : l'écriture peut échouer — dossier en
   * lecture seule, profil géré —, et basculer sans rien faire promettrait un démarrage qui
   * n'arrive pas. D'où la relecture de l'état réel, qui fait de `Switch` un contrôle contrôlé.
   */
  protected async setLaunchAtLogin(enabled: boolean): Promise<void> {
    try {
      await this.system.setLaunchAtLogin(enabled);
    } catch {
      // ⚠️ Un interrupteur contrôlé qui ne bouge pas n'explique rien : sans ce message, le seul
      // retour d'un échec serait l'absence de mouvement, indiscernable d'un clic mal visé. Les
      // motifs étant hors de portée de l'utilisateur, il réessaierait indéfiniment.
      this.snackbar.error(
        $localize`:@@options.launchAtLogin.failed:macOS a refusé de modifier l'ouverture à la session.`,
      );
    }
    await this.readLaunchAtLogin();
  }

  /** Toute la ligne est cliquable, pas seulement l'interrupteur. */
  protected toggleLaunchAtLogin(): void {
    this.setLaunchAtLogin(!this.launchAtLogin());
  }

  /**
   * Relit l'état réel de l'élément d'ouverture de session. Hors contexte Tauri, la lecture rend
   * `null` : l'interrupteur s'affiche éteint.
   *
   * @remarks
   * ⚠️ Une lecture en échec, elle, ne change rien : écrire « éteint » faute d'avoir su lire
   * affirmerait sur une absence de preuve. L'interrupteur garde ce qu'il montrait, et l'échec
   * d'écriture a déjà eu sa snackbar.
   */
  private async readLaunchAtLogin(): Promise<void> {
    try {
      this.launchAtLogin.set((await this.system.getLaunchAtLogin()) === true);
    } catch {
      // Rien : voir ci-dessus.
    }
  }
}

/**
 * Les noms des seize teintes.
 *
 * @remarks
 * ⚠️ Ils ne peuvent pas vivre dans `accent-palette.ts`, qui est généré : `$localize` y serait
 * effacé à la prochaine exécution du script.
 */
const ACCENT_LABELS: Readonly<Record<AccentId, string>> = {
  red: $localize`:@@options.accent.red:Rouge`,
  orange: $localize`:@@options.accent.orange:Orange`,
  amber: $localize`:@@options.accent.amber:Ambre`,
  gold: $localize`:@@options.accent.gold:Or`,
  olive: $localize`:@@options.accent.olive:Olive`,
  green: $localize`:@@options.accent.green:Vert`,
  emerald: $localize`:@@options.accent.emerald:Émeraude`,
  teal: $localize`:@@options.accent.teal:Sarcelle`,
  cyan: $localize`:@@options.accent.cyan:Cyan`,
  klein: $localize`:@@options.accent.klein:Bleu Klein`,
  blue: $localize`:@@options.accent.blue:Bleu`,
  indigo: $localize`:@@options.accent.indigo:Indigo`,
  violet: $localize`:@@options.accent.violet:Violet`,
  magenta: $localize`:@@options.accent.magenta:Magenta`,
  fuchsia: $localize`:@@options.accent.fuchsia:Fuchsia`,
  rose: $localize`:@@options.accent.rose:Rose`,
};
