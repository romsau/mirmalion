import { Component, LOCALE_ID, computed, inject, input, model, output } from '@angular/core';
import { formatElapsed } from '../../../../core/services/live/live';
import { ComboSelect } from '../../../../shared/components/forms/combo-select/combo-select';
import { Switch } from '../../../../shared/components/forms/switch/switch';
import type { FormOption } from '../../../../shared/components/forms/form-option';
import { LANGUAGE_OPTIONS_ACTION, sortedByName } from '../../../../core/models/language';
import type { Language, TranslationTarget } from '../../../../core/models/settings';
import type { AudioSource } from '../../../../core/services/bridge/live/live.bridge';

/**
 * La colonne de configuration de l'écran Direct : source, micro, langue, traduction, bouton.
 *
 * Il n'écrit aucun réglage et ne démarre rien : il rend ce qu'on lui donne et émet ce que
 * l'utilisateur choisit. Seule la source audio porte l'astérisque, faute de valeur par défaut.
 *
 * @remarks
 * - ⚠️ Pendant une session, le formulaire est `disabled` et non masqué : on doit pouvoir relire
 *   ce qu'on a choisi. `disabled` et non un grisé — lui seul s'annonce et sort de la tabulation.
 * - ⚠️ L'état d'attente du bouton n'est pas du confort : ouvrir le tap prend ~2,7 s, et sans lui
 *   le second clic partirait sur une capture en train de s'ouvrir.
 */
@Component({
  selector: 'app-direct-config',
  imports: [ComboSelect, Switch],
  templateUrl: './direct-config.html',
  styleUrl: './direct-config.scss',
})
export class DirectConfig {
  /** Les sources captables, « Tout le système » en tête. Peut être vide. */
  readonly sources = input.required<readonly AudioSource[]>();

  /** Les langues activées pour parler. Jamais vide — le modèle s'en porte garant. */
  readonly spokenLanguages = input.required<readonly Language[]>();

  /** Les langues activées pour traduire. Peut être vide — on ne traduit alors rien. */
  readonly translationLanguages = input.required<readonly Language[]>();

  /** La source choisie, `null` tant que rien ne l'est. */
  readonly sourceId = model.required<string | null>();

  /**
   * Ma voix est-elle enregistrée ?
   *
   * @remarks
   * ⚠️ Pas « quel micro » : l'appareil se choisit dans Options ▸ Général, une fois pour toute
   * l'application. Ici on décide seulement si l'on parle pendant cette session.
   */
  readonly includeMicrophone = model.required<boolean>();

  /** La langue parlée de la session. */
  readonly language = model.required<Language>();

  /**
   * La langue vers laquelle suivre la session, `'none'` pour ne rien traduire.
   *
   * @remarks
   * ⚠️ La paire se vérifie avant « Démarrer », jamais pendant : Apple présente sa propre feuille
   * d'installation, qui exige une fenêtre visible. C'est l'écran qui la demande au changement de
   * valeur — ce composant ne fait qu'émettre le choix.
   */
  readonly translationTarget = model.required<TranslationTarget>();

  /** Le formulaire est-il complet ? Calculé par l'écran, jamais ici. */
  readonly canStart = input.required<boolean>();

  /** Une session tourne-t-elle ? Le formulaire se fige et le bouton devient « Arrêter ». */
  readonly recording = input.required<boolean>();

  /** Le démarrage ou l'arrêt est-il en vol ? Voir l'état d'attente, en tête de fichier. */
  readonly busy = input(false);

  /** Depuis combien de secondes on enregistre. Ignoré hors session. */
  readonly elapsedSeconds = input(0);

  /** L'utilisateur demande le démarrage. L'écran seul décide de ce qui suit. */
  readonly start = output<void>();

  /** L'utilisateur demande l'arrêt. */
  readonly stop = output<void>();

  /**
   * L'utilisateur veut composer ses listes de langues, et le paramètre dit laquelle.
   *
   * @remarks
   * ⚠️ Ce composant ne connaît aucune route : il nomme la liste, l'écran choisit l'URL.
   */
  readonly languageOptionsRequested = output<'spoken' | 'translation'>();

  /** Le libellé de la ligne de sortie vers les options de langues. */
  protected readonly actionLabel = LANGUAGE_OPTIONS_ACTION;

  /**
   * Le placeholder du sélecteur de source.
   *
   * @remarks
   * ⚠️ Il redit « obligatoire » en toutes lettres : l'astérisque est `aria-hidden`, et un lecteur
   * d'écran ne l'annoncerait pas.
   */

  /** Les sources captables, telles que le sélecteur les attend. */
  protected readonly sourceOptions = computed<readonly FormOption<string>[]>(() =>
    this.sources().map((source) => ({ value: source.id, label: source.name })),
  );

  /** Les langues parlées activées, par ordre alphabétique de leur nom traduit. */
  protected readonly languageOptions = computed<readonly FormOption<Language>[]>(() =>
    sortedByName(this.spokenLanguages()),
  );

  /**
   * Les cibles de traduction, « Pas de traduction » en tête. Exactement la liste de la dictée —
   * même geste, même ordre, même dernière ligne vers les Options.
   *
   * @remarks
   * ⚠️ La tête de liste est offerte même sans aucune cible activée : ne rien traduire doit rester
   * possible quoi qu'il arrive, et c'est le défaut.
   * ⚠️ La langue de la session est retirée des cibles : traduire vers ce qu'on parle n'est pas
   * une traduction. C'est `liveLanguage` ici, jamais celle de la dictée.
   */
  protected readonly translationOptions = computed<readonly FormOption<TranslationTarget>[]>(() => [
    { value: 'none', label: $localize`:@@dictee.translation.none:Pas de traduction` },
    ...sortedByName(this.translationLanguages().filter((target) => target !== this.language())),
  ]);

  /**
   * Le minuteur discret, à côté du bouton.
   *
   * @remarks
   * ⚠️ Même mise en forme que celui de la fenêtre-session (`formatElapsed`), l'utilisateur ayant
   * les deux sous les yeux : deux formules divergeraient au premier arrondi.
   */
  protected readonly elapsed = computed(() => formatElapsed(this.elapsedSeconds(), this.locale));

  /**
   * Le bouton refuse-t-il le clic ? Deux raisons pour un seul état visible : rien n'est encore
   * choisi, ou un geste est déjà en vol. Arrêter ne demande aucun choix, d'où la branche qui ne
   * regarde plus {@link DirectConfig.canStart}.
   */
  protected readonly inert = computed(() =>
    this.recording() ? this.busy() : !this.canStart() || this.busy(),
  );

  private readonly locale = inject(LOCALE_ID);
}
