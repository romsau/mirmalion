/**
 * Comment une langue s'écrit et se range dans l'interface.
 *
 * Ce module ne porte que l'affichage : ce qui est choisi vit dans `settings.ts`, ce qui est
 * installé vient du moteur.
 */

import { LANGUAGES, type Language, type TranslationTarget } from './settings';
import type { FormOption } from '../../shared/components/forms/form-option';

/**
 * Le nom de chaque langue, dans la langue de l'interface.
 *
 * @remarks
 * ⚠️ Toujours dans la langue de l'interface, jamais dans celle qu'on nomme : une liste où chaque
 * ligne est écrite dans sa propre langue ne se lit ni ne se trie.
 */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  fr: $localize`:@@language.fr:Français`,
  en: $localize`:@@language.en:Anglais`,
  es: $localize`:@@language.es:Espagnol`,
  de: $localize`:@@language.de:Allemand`,
  it: $localize`:@@language.it:Italien`,
  pt: $localize`:@@language.pt:Portugais`,
};

/**
 * Le nom de chaque langue accordé en adjectif, tel qu'il entre dans « Installer la langue
 * portugaise ? ». Le détour par « la langue … » évite l'article contracté — « l'allemand » mais
 * « le portugais ».
 *
 * @remarks
 * ⚠️ Six chaînes écrites en toutes lettres, chacune sa propre unité de traduction : cette forme
 * ne se compose pas en collant {@link LANGUAGE_NAMES} à une phrase, et le traducteur doit donner
 * celle que sa langue exige à cet endroit, pas une déclinaison devinée.
 */
export const LANGUAGE_ADJECTIVES: Readonly<Record<Language, string>> = {
  fr: $localize`:@@language.adjective.fr:française`,
  en: $localize`:@@language.adjective.en:anglaise`,
  es: $localize`:@@language.adjective.es:espagnole`,
  de: $localize`:@@language.adjective.de:allemande`,
  it: $localize`:@@language.adjective.it:italienne`,
  pt: $localize`:@@language.adjective.pt:portugaise`,
};

/**
 * Le nom de chaque langue en anglais. Employé par {@link interfaceLanguageOptions}, et par lui
 * seul.
 *
 * @remarks
 * ⚠️ Aucun `$localize` ici, et ce n'est pas un oubli : ces six chaînes doivent rester en anglais
 * quelle que soit la langue de l'interface, sans quoi qui a posé la sienne dans une langue qu'il
 * ne lit pas n'a plus aucun point d'appui pour retrouver son chemin.
 */
const LANGUAGE_NAMES_EN: Readonly<Record<Language, string>> = {
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
};

/**
 * Des codes de langue vers des options de menu, rangées par leur nom traduit.
 *
 * @param languages - Les codes à proposer, dans n'importe quel ordre.
 * @returns Les options triées sur le libellé affiché.
 *
 * @remarks
 * ⚠️ Le tri se refait à chaque lecture parce qu'il dépend de la langue d'interface : trier une
 * fois pour toutes donnerait un ordre juste dans une langue et faux dans les cinq autres.
 */
export function sortedByName<Value extends Language>(
  languages: readonly Value[],
): readonly FormOption<Value>[] {
  return [...languages]
    .map((language) => ({ value: language, label: LANGUAGE_NAMES[language] }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Les cibles du menu « Traduire » d'une fenêtre-document : « Langue d'origine », puis les six.
 * Partagée par les deux fenêtres-documents, qui la veulent à l'identique.
 *
 * @remarks
 * ⚠️ Les six, et pas seulement celles activées : ce menu ne choisit pas ce qu'on parle, il
 * demande une traduction. La maquette liste bien les six, dans les deux fenêtres.
 * ⚠️ Une fonction et non une constante : le tri suit le nom traduit, donc la langue de
 * l'interface — voir {@link sortedByName}.
 */
export function translationTargetOptions(): readonly FormOption<TranslationTarget>[] {
  return [
    { value: 'none', label: $localize`:@@filedoc.translate.original:Langue d'origine` },
    ...sortedByName(LANGUAGES),
  ];
}

/**
 * Pourquoi la dernière langue parlée ne se décoche pas.
 *
 * @remarks
 * ⚠️ Une seule déclaration pour l'onboarding et les Options : les deux listes portent la même
 * règle, et deux textes pour une même contrainte se rendraient différemment.
 */
export const LAST_SPOKEN_LANGUAGE_REASON = $localize`:@@options.languages.lastOne:Au moins une langue parlée est nécessaire.`;

/**
 * Le libellé de la ligne qui mène là où les listes de langues se composent.
 *
 * @remarks
 * ⚠️ Une seule déclaration pour les deux menus — dictée et Direct : c'est le même geste, et deux
 * `$localize` pour une phrase identique se rendraient différemment sans qu'aucun traducteur voie
 * le rapport.
 */
export const LANGUAGE_OPTIONS_ACTION = $localize`:@@dictee.language.seeOptions:Voir les options de langues`;

/**
 * Les six langues d'interface, chacune doublée de son équivalent anglais — « Allemand
 * (German) ». Seule la langue d'interface courante n'est pas doublée, la parenthèse y répétant
 * le libellé.
 *
 * @param displayedLocale - La langue dans laquelle l'écran est écrit à cet instant.
 *
 * @remarks
 * ⚠️ Le seul contrôle de l'application qui double ses noms : un mauvais choix ici rend toute
 * l'interface illisible, et l'anglais est le point d'appui qui permet d'en revenir. Le tri suit
 * le nom de gauche, celui de l'interface — trier sur la parenthèse mêlerait les deux systèmes.
 */
export function interfaceLanguageOptions(displayedLocale: string): readonly FormOption<Language>[] {
  // ⚠️ La langue affichée, pas le réglage enregistré : les deux divergent entre le choix et le
  // redémarrage — le réglage dit déjà « allemand » quand l'écran est encore en français. Ce
  // doublon existe pour qui ne sait plus lire ce qu'il voit, donc c'est ce qui est sous ses yeux
  // qui décide.
  const inEnglish = displayedLocale.split('-')[0] === 'en';
  return sortedByName(LANGUAGES).map((option) =>
    inEnglish
      ? option
      : { ...option, label: `${option.label} (${LANGUAGE_NAMES_EN[option.value]})` },
  );
}

/**
 * La langue qu'on ne peut pas éteindre — la dernière activée —, ou `null` s'il y en a plusieurs.
 *
 * @remarks
 * ⚠️ La seule règle qui pèse sur les langues parlées : ni plafond, ni quota, ni compteur, juste
 * qu'une application de dictée sans langue ne dicte rien. Elle vaut pour l'onboarding comme pour
 * les Options, d'où sa place ici.
 */
export function lockedSpokenLanguage(spoken: readonly Language[]): Language | null {
  const [only, ...rest] = spoken;
  return only !== undefined && rest.length === 0 ? only : null;
}

/** « Installer la langue portugaise ? » — la question posée avant tout téléchargement. */
export function installConfirmHeading(language: Language): string {
  return $localize`:@@language.install.confirm:Installer la langue ${LANGUAGE_ADJECTIVES[language]}:name: ?`;
}

/**
 * Le libellé d'une installation en cours, pour la modale des Options comme pour l'étape
 * d'onboarding.
 *
 * @remarks
 * ⚠️ Deux libellés, et le pluriel n'est pas un accord de plus : à une seule langue on la nomme, à
 * plusieurs on ne les énumère pas — une liste de cinq noms sous une barre unique laisserait
 * croire qu'on suit celle du haut.
 */
export function installProgressLabel(languages: readonly Language[]): string {
  const [only, ...rest] = languages;
  if (only === undefined || rest.length > 0) {
    return $localize`:@@language.install.progress.many:Installation des langues`;
  }
  return $localize`:@@language.install.progress:Installation de la langue ${LANGUAGE_ADJECTIVES[only]}:name:`;
}

/**
 * « Aucune », « 1 langue », « 3 langues » — l'indication de bout de ligne d'un sous-écran.
 *
 * @remarks
 * ⚠️ Trois cas suffisent aux six langues du périmètre, dont aucune n'a de duel ni de paucal. Y
 * ajouter une langue à plus de deux formes — polonais, russe — obligerait à passer à une
 * expression ICU dans un gabarit.
 * ⚠️ Zéro se dit « Aucune », pas « 0 langue » : le compte nu à côté d'une liste vide se lit
 * comme une donnée manquante, le mot dit que c'est un choix.
 */
export function languageCount(count: number): string {
  if (count === 0) {
    return $localize`:@@languages.count.zero:Aucune`;
  }
  if (count === 1) {
    return $localize`:@@languages.count.one:1 langue`;
  }
  return $localize`:@@languages.count.other:${count}:count: langues`;
}
