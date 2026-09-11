import { Component, computed, input, model, output } from '@angular/core';
import { ComboSelect } from '../../../../shared/components/forms/combo-select/combo-select';
import { PromptField } from '../../../../shared/components/forms/prompt-field/prompt-field';
import { ModeSelector } from '../mode-selector/mode-selector';
import type { FormOption } from '../../../../shared/components/forms/form-option';
import {
  LANGUAGE_NAMES,
  LANGUAGE_OPTIONS_ACTION,
  sortedByName,
} from '../../../../core/models/language';
import {
  REPHRASING_MODES,
  type DictationMode,
  type Language,
  type RephrasingMode,
  type TranslationTarget,
} from '../../../../core/models/settings';

/**
 * La langue vers laquelle ⌃⌥⌘ traduit quand le champ « Traduction » ne demande rien.
 *
 * @remarks
 * ⚠️ Miroir de `DEFAULT_TRANSLATION` (`src-tauri/src/commands/dictation.rs`). Les deux qui
 * divergeraient donneraient un indice qui annonce une langue et un texte qui en écrit une autre.
 */
const DEFAULT_TRANSLATION: Language = 'en';

/** Le nom affiché de chaque style de reformulation. */
const REPHRASING_LABELS: Readonly<Record<RephrasingMode, string>> = {
  none: $localize`:@@dictee.rephrasing.none:Pas de reformulation`,
  standard: $localize`:@@dictee.rephrasing.standard:Standard`,
  professional: $localize`:@@dictee.rephrasing.professional:Professionnel`,
  concise: $localize`:@@dictee.rephrasing.concise:Concis`,
  detailed: $localize`:@@dictee.rephrasing.detailed:Détaillé`,
  friendly: $localize`:@@dictee.rephrasing.friendly:Amical`,
  custom: $localize`:@@common.custom:Personnalisé…`,
};

/**
 * La colonne de contrôles de l'écran Dictée : mode, langue parlée, traduction, reformulation.
 *
 * Il n'écrit aucun réglage : il rend ce qu'on lui donne et émet ce que l'utilisateur choisit.
 *
 * @remarks
 * - ⚠️ Les deux menus ne montrent que les langues activées ; installer une langue vit à
 *   l'onboarding et dans Options ▸ Langues, et nulle part ici.
 * - ⚠️ Aucune visualisation d'enregistrement : le retour visuel passe par l'overlay, et une
 *   seconde forme d'onde dans la fenêtre entrerait en concurrence avec lui.
 */
@Component({
  selector: 'app-dictee-controls',
  imports: [ComboSelect, ModeSelector, PromptField],
  templateUrl: './dictee-controls.html',
  styleUrl: './dictee-controls.scss',
})
export class DicteeControls {
  /** Les langues activées pour parler. Jamais vide — le modèle s'en porte garant. */
  readonly spokenLanguages = input.required<readonly Language[]>();

  /** Les langues activées comme cibles de traduction. Peut être vide. */
  readonly translationLanguages = input.required<readonly Language[]>();

  /**
   * La dernière ligne d'un des deux menus a été choisie, et le paramètre dit lequel — c'est une
   * commande, pas une valeur : rien n'est écrit avant l'émission.
   *
   * @remarks
   * ⚠️ Ce composant ne connaît aucune route : il nomme la liste, l'hôte choisit l'URL. Un
   * paramètre plutôt que deux sorties, l'hôte en faisant la même chose des deux côtés.
   */
  readonly languageOptionsRequested = output<'spoken' | 'translation'>();

  /** Le mode de déclenchement, en aller-retour avec l'hôte. */
  readonly mode = model.required<DictationMode>();

  /** La langue parlée retenue. */
  readonly language = model.required<Language>();

  /** La langue de traduction, ou « aucune ». */
  readonly translationTarget = model.required<TranslationTarget>();

  /** Le style de reformulation. */
  readonly rephrasingMode = model.required<RephrasingMode>();

  /** Le prompt libre, utile au seul mode `custom`. */
  readonly customPrompt = model.required<string>();

  /** Le libellé de la ligne de sortie vers les options de langues. */
  protected readonly actionLabel = LANGUAGE_OPTIONS_ACTION;

  /**
   * Les langues parlées activées, par ordre alphabétique de leur nom traduit — un ordre qui
   * change avec la langue de l'interface, et qu'aucune constante ne peut figer.
   */
  protected readonly languageOptions = computed<readonly FormOption<Language>[]>(() =>
    sortedByName(this.spokenLanguages()),
  );

  /**
   * « Pas de traduction » en tête, verrouillé : on doit toujours pouvoir ne rien traduire.
   *
   * @remarks
   * ⚠️ La langue parlée est retirée des cibles : traduire vers ce qu'on parle n'est pas une
   * traduction, et le pont rend alors le texte inchangé. La liste suit donc la langue parlée et
   * ne peut pas être figée sur les seules cibles activées.
   */
  protected readonly translationOptions = computed<readonly FormOption<TranslationTarget>[]>(() => [
    { value: 'none', label: $localize`:@@dictee.translation.none:Pas de traduction` },
    ...sortedByName(this.translationLanguages().filter((target) => target !== this.language())),
  ]);

  /**
   * Le nom de la langue que ⌃⌥⌘ écrira, ou `null` quand il ne ferait rien de plus que ⌃⌥.
   *
   * @remarks
   * ⚠️ `null` n'est pas un cas tordu : un anglophone sans cible réglée est exactement dans ce
   * cas, et le second raccourci n'a alors rien à traduire. Annoncer « Traduit en anglais » à
   * qui parle anglais promettrait une différence qui n'existe pas.
   */
  protected readonly translatedInto = computed<string | null>(() => {
    const target = this.translationTarget();
    const written = target === 'none' ? DEFAULT_TRANSLATION : target;
    return written === this.language() ? null : LANGUAGE_NAMES[written];
  });

  /**
   * Les styles de reformulation, dans l'ordre de `REPHRASING_MODES` et non l'alphabet : « Pas de
   * reformulation » d'abord, puis du plus neutre au plus marqué, « Personnalisé… » en dernier.
   */
  protected readonly rephrasingOptions = computed<readonly FormOption<RephrasingMode>[]>(() =>
    REPHRASING_MODES.map((mode) => ({ value: mode, label: REPHRASING_LABELS[mode] })),
  );

  /** Le champ de prompt libre n'apparaît que sur le style « Personnalisé… ». */
  protected readonly showsPrompt = computed(() => this.rephrasingMode() === 'custom');

  /** Remonte la frappe du champ de prompt dans {@link DicteeControls.customPrompt}. */
  protected writePrompt(prompt: string): void {
    this.customPrompt.set(prompt);
  }
}
