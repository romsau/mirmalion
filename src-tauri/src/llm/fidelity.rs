//! Le garde-fou de fidélité du nettoyage — pur, sans I/O, sans modèle.
//!
//! Le nettoyage ne doit que ponctuer, accentuer et capitaliser ; il substitue parfois un sosie
//! (« machins » → « machines »). On remet le mot d'origine en place : rejeter la passe entière
//! rendrait le texte brut, sans ponctuation ni majuscules, pour sauver un seul mot.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas y revenir par le prompt : borner la licence du modèle dans les consignes ne change
//!   rien, la borner dans le `@Guide` lui fait cesser de ponctuer.
//! - ⚠️ Une substitution qui change le nombre de mots échappe à la règle — « vite fait » ressort
//!   « vite-ci ». Ne pas l'élargir aux groupes de mots sans mesurer : aligner deux séquences fait
//!   grandir le risque de réparer à tort, donc d'abîmer un bon nettoyage.

/// Distance d'édition maximale pour tenir deux mots pour « le même, abîmé ».
///
/// # Pièges
///
/// - ⚠️ Un, et pas deux : à deux, « chien » et « chiens » deviennent suspects l'un de l'autre,
///   alors qu'une correction d'accord est du ressort du nettoyage.
const MAX_DISTANCE: usize = 1;

/// Longueur en deçà de laquelle on ne compare rien.
///
/// # Pièges
///
/// - ⚠️ Une lettre d'écart sur un mot court change de mot : « et » / « en », « ce » / « se »,
///   « a » / « à ». Ce sont des corrections légitimes ; les traquer ferait rejeter la moitié des
///   nettoyages français.
const MIN_LENGTH: usize = 5;

/// Remet en place les mots que le nettoyage a substitués, et laisse le reste intact.
///
/// Est suspect un mot de `cleaned` absent de `raw`, à une lettre près d'un mot de `raw` qui, lui,
/// a disparu. Retirer un tic, accentuer ou développer une abréviation reste donc admis :
/// « evenement » et « événement » se normalisent à l'identique, « cata » et « catastrophe » sont
/// à sept lettres l'un de l'autre.
///
/// Rend le texte nettoyé tel quel quand rien n'est suspect — le cas de loin le plus fréquent.
pub fn restore_substitutions(raw: &str, cleaned: &str) -> String {
  // ⚠️ Les mots de l'entrée qui ont disparu de la sortie : ce sont les seuls candidats à avoir
  // été remplacés. Un mot conservé quelque part n'a rien perdu, même si un sosie traîne ailleurs.
  let lost: Vec<&str> = raw
    .split_whitespace()
    .filter(|word| comparable(word) && !cleaned.split_whitespace().any(|out| same(word, out)))
    .collect();
  if lost.is_empty() {
    return cleaned.to_owned();
  }

  let mut repaired = String::with_capacity(cleaned.len());
  for (index, word) in cleaned.split_whitespace().enumerate() {
    if index > 0 {
      repaired.push(' ');
    }
    match culprit(word, &lost, raw) {
      // ⚠️ On rend le mot d'origine avec la ponctuation que le nettoyage lui a ajoutée :
      // « machines, » redevient « machins, », pas « machins ». Sans cela le garde-fou détruirait
      // la virgule qu'on vient de gagner.
      Some(original) => repaired.push_str(&swap(word, original)),
      None => repaired.push_str(word),
    }
  }
  repaired
}

/// Le nettoyage a-t-il changé la langue du texte ?
///
/// `expected` est la langue **parlée** ; `raw` et `cleaned` sont celles lues sur le texte brut
/// et sur la sortie, `None` quand le lecteur n'a pas tranché.
///
/// # Pièges
///
/// - ⚠️ Le doute ne rejette jamais : sortie illisible, `false`. Refuser sur une hésitation
///   coûterait la ponctuation de toutes les dictées brèves.
/// - ⚠️ On juge l'écart, pas la sortie seule : mesuré sur 390 dictées, juger la seule sortie
///   rejetait du français que le lecteur dit anglais. Un brut lu ainsi disculpe le nettoyage.
pub fn changed_language(expected: &str, raw: Option<&str>, cleaned: Option<&str>) -> bool {
  match cleaned {
    None => false,
    Some(seen) => seen != expected && raw != Some(seen),
  }
}

/// Le mot d'origine que ce mot de sortie a remplacé, s'il y en a un.
///
/// # Pièges
///
/// - ⚠️ Un mot déjà présent dans l'entrée n'est jamais coupable : le nettoyage l'a conservé,
///   c'est un sosie fortuit. Sans cette garde, un texte parlant de « machins » et de « machines »
///   verrait le second réécrit en premier.
fn culprit<'a>(word: &str, lost: &[&'a str], raw: &str) -> Option<&'a str> {
  if !comparable(word) || raw.split_whitespace().any(|source| same(source, word)) {
    return None;
  }
  lost
    .iter()
    .copied()
    .find(|original| distance(&fold(original), &fold(word)) <= MAX_DISTANCE)
}

/// Ce mot peut-il entrer dans la comparaison ? Écarte le trop court — voir [`MIN_LENGTH`].
fn comparable(word: &str) -> bool {
  fold(word).len() >= MIN_LENGTH
}

/// Deux mots sont « les mêmes » à la casse, aux accents et à la ponctuation près.
///
/// # Pièges
///
/// - ⚠️ Les accents sont ignorés à dessein : les rétablir est le travail du nettoyage, pas une
///   substitution. « evenement » et « événement » sont le même mot.
fn same(left: &str, right: &str) -> bool {
  fold(left) == fold(right)
}

/// La forme comparable d'un mot : minuscules, sans accents, sans ponctuation.
fn fold(word: &str) -> Vec<char> {
  word
    .chars()
    .flat_map(char::to_lowercase)
    .map(strip)
    .filter(|character| character.is_alphanumeric())
    .collect()
}

/// Retire l'accent des lettres latines courantes.
///
/// Table volontairement courte : elle ne sert qu'à rapprocher deux graphies du même mot, pas à
/// translittérer.
fn strip(character: char) -> char {
  match character {
    'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => 'a',
    'ç' => 'c',
    'è' | 'é' | 'ê' | 'ë' => 'e',
    'ì' | 'í' | 'î' | 'ï' => 'i',
    'ñ' => 'n',
    'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
    'ù' | 'ú' | 'û' | 'ü' => 'u',
    'ý' | 'ÿ' => 'y',
    other => other,
  }
}

/// Distance de Levenshtein, bornée à [`MAX_DISTANCE`] pour s'arrêter tôt.
///
/// La sortie anticipée sur la différence de longueur évite d'allouer une matrice pour comparer
/// « cata » à « catastrophe », qui n'ont aucune chance de tomber sous le seuil.
fn distance(left: &[char], right: &[char]) -> usize {
  if left.len().abs_diff(right.len()) > MAX_DISTANCE {
    return MAX_DISTANCE + 1;
  }
  let mut previous: Vec<usize> = (0..=right.len()).collect();
  let mut current = vec![0; right.len() + 1];
  for (i, a) in left.iter().enumerate() {
    current[0] = i + 1;
    for (j, b) in right.iter().enumerate() {
      let substitution = previous[j] + usize::from(a != b);
      current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
    }
    std::mem::swap(&mut previous, &mut current);
  }
  previous[right.len()]
}

/// Remplace la partie alphanumérique de `word` par `original`, en gardant ce qui l'entoure.
///
/// # Pièges
///
/// - ⚠️ La ponctuation conservée est celle du mot nettoyé : c'est justement ce que le nettoyage a
///   apporté, et la lui reprendre au nom de la fidélité détruirait son travail.
fn swap(word: &str, original: &str) -> String {
  let leading: String = word.chars().take_while(|c| !c.is_alphanumeric()).collect();
  let trailing: String = word
    .chars()
    .rev()
    .take_while(|c| !c.is_alphanumeric())
    .collect::<Vec<_>>()
    .into_iter()
    .rev()
    .collect();
  format!("{leading}{original}{trailing}")
}

#[cfg(test)]
mod tests {
  use super::{changed_language, restore_substitutions};

  /// Le défaut mesuré : une dictée française ressortie en anglais du nettoyage, insérée telle
  /// quelle au curseur parce qu'aucun garde-fou ne regardait la langue.
  #[test]
  fn a_cleanup_that_switches_language_is_refused() {
    assert!(changed_language("fr", Some("fr"), Some("en")));
  }

  /// La cible d'une traduction n'entre pas ici : c'est la langue **parlée** qu'on compare, et le
  /// nettoyage précède toujours la traduction.
  #[test]
  fn a_cleanup_that_keeps_the_language_is_kept() {
    assert!(!changed_language("fr", Some("fr"), Some("fr")));
  }

  /// ⚠️ Le doute ne rejette pas : sur un texte court le lecteur ne tranche pas, et refuser un
  /// nettoyage sur son silence coûterait la ponctuation de toutes les dictées brèves.
  #[test]
  fn an_undecided_reading_never_refuses() {
    assert!(!changed_language("fr", Some("fr"), None));
  }

  /// ⚠️ Le cas qui interdit de juger la seule sortie : « On continue. » est du français que le
  /// lecteur dit anglais. Le brut se lisant déjà ainsi, le nettoyage n'a rien changé — et le
  /// rejeter perdrait un nettoyage correct.
  #[test]
  fn a_raw_text_already_read_as_another_language_is_not_the_cleanups_doing() {
    assert!(!changed_language("fr", Some("en"), Some("en")));
  }

  /// Un brut trop court pour être lu, une sortie franchement étrangère : la dérive est née du
  /// nettoyage. Mesuré sur « Évolution cé » rendu « Evolution of the ».
  #[test]
  fn a_drift_from_an_unreadable_raw_text_is_refused() {
    assert!(changed_language("fr", None, Some("en")));
  }

  /// Le défaut qui a motivé ce module, mot pour mot.
  #[test]
  fn a_word_swapped_for_a_look_alike_is_put_back() {
    let raw = "Y a des machins qui marchent pas du tout";
    let cleaned = "Il y a des machines qui marchent pas du tout.";

    assert_eq!(
      restore_substitutions(raw, cleaned),
      "Il y a des machins qui marchent pas du tout."
    );
  }

  /// ⚠️ La ponctuation gagnée par le nettoyage doit survivre à la réparation.
  #[test]
  fn the_punctuation_the_cleanup_added_survives_the_repair() {
    assert_eq!(
      restore_substitutions("des machins", "Des machines, oui."),
      "Des machins, oui."
    );
  }

  #[test]
  fn an_untouched_cleanup_comes_back_unchanged() {
    let raw = "bon alors euh je voulais te dire";
    let cleaned = "Bon alors, je voulais te dire.";

    assert_eq!(restore_substitutions(raw, cleaned), cleaned);
  }

  /// ⚠️ **Ce que le nettoyage a le DROIT de faire.** Une règle qui rejetterait ces cas serait pire
  /// que le défaut qu'elle corrige : elle abîmerait de bons nettoyages.
  #[test]
  fn what_the_cleanup_is_allowed_to_do_passes_through() {
    // Accentuation : les deux graphies se normalisent à l'identique.
    assert_eq!(
      restore_substitutions("un evenement de rentree", "Un événement de rentrée."),
      "Un événement de rentrée."
    );
    // Abréviation développée : sept lettres d'écart, hors de portée du seuil.
    assert_eq!(
      restore_substitutions("ça va être la cata", "Ça va être la catastrophe."),
      "Ça va être la catastrophe."
    );
    // Tic de langage retiré : le mot disparaît, rien ne le remplace.
    assert_eq!(
      restore_substitutions("bon euh alors voilà", "Bon, alors voilà."),
      "Bon, alors voilà."
    );
  }

  /// ⚠️ Un mot court change de sens à une lettre près — « et » / « en » — et le corriger est
  /// légitime. Les traquer ferait rejeter la moitié des nettoyages français.
  #[test]
  fn short_words_are_never_second_guessed() {
    assert_eq!(
      restore_substitutions("il et la", "Il est là."),
      "Il est là."
    );
  }

  /// ⚠️ **Le sosie fortuit** : un texte qui parle des deux ne doit pas voir le second réécrit en
  /// premier. Sans cette garde, « machins » présent ET « machines » ajouté déclencherait à tort.
  #[test]
  fn a_word_the_cleanup_kept_is_never_treated_as_a_culprit() {
    let raw = "les machins et les machines";
    let cleaned = "Les machins et les machines.";

    assert_eq!(restore_substitutions(raw, cleaned), cleaned);
  }

  /// Un nettoyage qui rend le vide ne doit pas faire paniquer la réparation.
  #[test]
  fn an_empty_cleanup_stays_empty() {
    assert_eq!(restore_substitutions("des machins", ""), "");
  }
}
