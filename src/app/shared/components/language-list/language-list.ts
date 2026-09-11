import { Component, booleanAttribute, computed, input, output } from '@angular/core';
import { Switch } from '../forms/switch/switch';
import { sortedByName } from '../../../core/models/language';
import { LANGUAGES, type Language } from '../../../core/models/settings';

/** Ce qui manque, dit d'une seule façon : la marque visible et le nom accessible le partagent. */
const MISSING_LABEL = $localize`:@@languages.switch.missing:à télécharger`;

/** À quoi servent les langues qu'on coche ici. Décide du nom accessible, et rien d'autre. */
export type LanguagePurpose = 'dictation' | 'translation';

/** Une rangée prête à peindre : nom visible, nom accessible, état. */
interface LanguageRow {
  readonly language: Language;
  readonly name: string;
  readonly ariaLabel: string;
  readonly hint: string;
  readonly on: boolean;
  readonly locked: boolean;
  readonly missingWhileOn: boolean;
}

/**
 * Les six langues, une par carte, un interrupteur chacune.
 *
 * Un seul composant pour deux hôtes, les Options et l'onboarding. Il ne décide de rien : les
 * règles — au moins une langue parlée, installer avant d'activer — appartiennent à l'hôte.
 *
 * @remarks
 * - ⚠️ Ses interrupteurs sont contrôlés, voir `Switch` : sans cela, une langue dont les
 *   ressources manquent resterait allumée sur une installation refusée.
 * - ⚠️ Une langue non choisie ne se marque pas : l'allumer EST le téléchargement. Choisie ET
 *   absente, elle se marque — l'interrupteur dit le choix de l'utilisateur, pas le moteur.
 */
@Component({
  selector: 'app-language-list',
  imports: [Switch],
  templateUrl: './language-list.html',
  styleUrl: './language-list.scss',
  host: {
    '[class.is-filling]': 'fill()',
  },
})
export class LanguageList {
  /** À quoi servent les langues cochées ici. */
  readonly purpose = input.required<LanguagePurpose>();

  /**
   * La liste occupe toute la hauteur qu'on lui donne, et ses rangées s'y répartissent.
   *
   * @remarks
   * ⚠️ L'onboarding seul : une étape lui laisse la hauteur exacte entre le sous-titre et le
   * bouton, quand le panneau des Options est nettement plus haut et la liste y paraît diluée.
   * Ne pas « harmoniser » les deux hôtes sur ce point.
   */
  readonly fill = input(false, { transform: booleanAttribute });

  /** Les langues activées. */
  readonly selected = input.required<readonly Language[]>();

  /**
   * Les langues dont les ressources sont présentes.
   *
   * @remarks
   * ⚠️ `null` veut dire « ne rien dire de l'installation », là où une liste vide dirait
   * « aucune n'est là ». La liste de traduction passe `null` : Apple y installe des paires
   * ordonnées, et prétendre un état par langue mentirait sur la granularité.
   */
  readonly installed = input<readonly Language[] | null>(null);

  /**
   * La langue dont l'interrupteur est figé.
   *
   * @remarks
   * ⚠️ Un contrôle inerte sans motif est un défaut, pas une protection : la raison va dans
   * l'infobulle et dans le nom accessible, pour qui ne survole rien.
   */
  readonly locked = input<Language | null>(null);

  /** La raison du verrou, en toutes lettres. */
  readonly lockedReason = input('');

  /** La langue dont l'interrupteur vient d'être actionné. */
  readonly toggled = output<Language>();

  /** Le nom accessible de la liste entière, qui donne son sens à chaque interrupteur. */
  protected readonly groupLabel = computed(() =>
    this.purpose() === 'dictation'
      ? $localize`:@@languages.list.spoken:Langues parlées`
      : $localize`:@@languages.list.translation:Langues de traduction`,
  );

  /** Les six rangées, triées par nom dans la langue de l'interface. */
  protected readonly rows = computed<readonly LanguageRow[]>(() => {
    const selected = this.selected();
    const installed = this.installed();
    const locked = this.locked();
    const reason = this.lockedReason();

    return sortedByName(LANGUAGES).map(({ value: language, label: name }) => {
      const isLocked = language === locked;
      const hint = isLocked ? reason : '';
      const missing = installed !== null && !installed.includes(language);
      const on = selected.includes(language);
      return {
        language,
        name,
        ariaLabel: this.nameFor(name, missing, hint),
        hint,
        on,
        locked: isLocked,
        missingWhileOn: missing && on,
      };
    });
  });

  /**
   * La marque portée par une langue choisie dont les ressources manquent.
   *
   * @remarks
   * ⚠️ Le même texte que le suffixe du nom accessible, et la MÊME unité de traduction : deux
   * unités laisseraient l'écran et le lecteur d'écran diverger d'une langue d'interface à
   * l'autre.
   */
  protected readonly missingLabel = MISSING_LABEL;

  /** Signale la bascule d'une rangée, sauf si elle est figée. */
  protected request(row: LanguageRow): void {
    if (!row.locked) {
      this.toggled.emit(row.language);
    }
  }

  /**
   * Le nom accessible d'un interrupteur : ce qu'il fait, puis ce qui l'empêche ou lui manque.
   *
   * @remarks
   * - ⚠️ La phrase se compose avec la préposition invariable « en », jamais avec un article :
   *   « vers le portugais » mais « vers l'allemand » exigerait six variantes écrites à la main
   *   par langue d'interface. Ne pas y réintroduire d'article.
   * - ⚠️ Le nom garde sa majuscule : la forcer en minuscule serait fautif en allemand, qui
   *   capitalise tous ses noms, comme en anglais. Un nom accessible est prononcé, jamais lu.
   */
  private nameFor(name: string, missing: boolean, hint: string): string {
    const base =
      this.purpose() === 'dictation'
        ? $localize`:@@languages.switch.spoken:Dicter en ${name}:name:`
        : $localize`:@@languages.switch.translation:Traduire en ${name}:name:`;
    const missingSuffix = missing ? MISSING_LABEL : '';
    return [base, hint, missingSuffix].filter(Boolean).join(' — ');
  }
}
