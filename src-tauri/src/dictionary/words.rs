//! Le dictionnaire personnel appliqué à une suite de **mots horodatés**.
//!
//! Le module joint les mots par une espace, cherche **avec la recherche de `super`** — pas une
//! deuxième —, puis redécoupe sur les frontières qui ont survécu : une frontière disparaît
//! exactement quand une occurrence l'enjambe. Le mot qui en résulte porte le `start_ms` du
//! premier mot couvert et le `end_ms` du dernier.
//!
//! # Pièges
//!
//! - ⚠️ Concaténer, corriger, puis redécouper casserait la correspondance mot ↔ horodatage, et le
//!   cas d'usage principal est justement celui qui casse : une variante qui enjambe plusieurs
//!   mots — « git lab » → « GitLab ». Le redécoupage inventerait les millisecondes du mot fusionné.
//! - ⚠️ L'invariant qui tient l'ensemble : corriger les mots puis les rejoindre donne exactement
//!   le texte qu'aurait rendu [`super::apply`] sur les mots rejoints, sans quoi la dictée et les
//!   fichiers corrigeraient différemment.

use std::borrow::Cow;

use super::{Entry, Folded, Match, cased, needles};
use crate::transcript::Word;

/// L'espace qui sépare deux mots dans le texte joint.
///
/// # Pièges
///
/// - ⚠️ Un seul caractère d'un seul octet, et le raisonnement en dépend : une occurrence qui
///   enjambe une frontière couvre forcément l'intervalle **entier** entre les deux mots, ce qui
///   garantit qu'aucun séparateur ne subsiste au milieu d'un mot fusionné. Avec un séparateur
///   plus long, une occurrence pourrait n'en couvrir qu'une partie.
const SEPARATOR: char = ' ';

/// Remplace, dans `words`, toute variante connue par son terme — **frontières de mots
/// comprises**.
///
/// # Pièges
///
/// - ⚠️ Rend un [`Cow`] pour la même raison que [`super::apply`] : le dictionnaire est toujours
///   actif, donc cette fonction est appelée à chaque fichier transcrit. Sans entrée exploitable —
///   ou sans occurrence —, elle ne copie **aucun** des milliers de mots qu'on lui donne.
pub fn apply<'a>(words: &'a [Word], entries: &[Entry]) -> Cow<'a, [Word]> {
  let needles = needles(entries);
  if needles.is_empty() {
    return Cow::Borrowed(words);
  }

  let joined = Joined::of(words);
  let found = Folded::of(&joined.text).matches(&needles);
  if found.is_empty() {
    return Cow::Borrowed(words);
  }

  let mut out: Vec<Word> = Vec::with_capacity(words.len());
  let mut first = 0;
  while first < words.len() {
    // Le groupe s'étend tant que la frontière suivante est avalée par une occurrence.
    let mut last = first;
    while last + 1 < words.len() && joined.swallowed(last, &found) {
      last += 1;
    }
    out.push(Word {
      text: joined.rebuilt(first, last, &found),
      // ⚠️ Les bornes viennent des mots d'origine, jamais d'un calcul : le mot fusionné commence
      // quand le premier a commencé et finit quand le dernier a fini.
      start_ms: words[first].start_ms,
      end_ms: words[last].end_ms,
    });
    first = last + 1;
  }
  Cow::Owned(out)
}

/// Le même travail sur des mots qu'on **possède déjà**.
///
/// # Pièges
///
/// - ⚠️ Exister pour ne pas recopier : `apply(&words, …).into_owned()` clonerait les milliers de
///   mots d'un média — donc autant d'allocations de chaînes — dans le cas le plus fréquent de
///   tous, celui où le dictionnaire est vide. Le vecteur d'origine ressort tel quel.
pub fn corrected(words: Vec<Word>, entries: &[Entry]) -> Vec<Word> {
  // ⚠️ Le `let` intermédiaire n'est pas cosmétique : il termine l'emprunt de `words` avant qu'on
  // ne le rende, ce qu'un `match` direct sur le `Cow` interdirait.
  let fixed = match apply(&words, entries) {
    Cow::Owned(fixed) => Some(fixed),
    Cow::Borrowed(_) => None,
  };
  fixed.unwrap_or(words)
}

/// Les mots mis bout à bout, et le chemin de retour vers chacun d'eux.
struct Joined {
  /// Les mots joints par [`SEPARATOR`].
  text: String,
  /// Pour chaque mot, sa plage d'octets dans [`Joined::text`].
  spans: Vec<(usize, usize)>,
}

impl Joined {
  /// Met les mots bout à bout et retient la plage d'octets de chacun.
  fn of(words: &[Word]) -> Self {
    let mut text = String::new();
    let mut spans = Vec::with_capacity(words.len());
    for word in words {
      // ⚠️ Le test porte sur les plages, pas sur `text.is_empty()` : un premier mot vide
      // laisserait le texte vide et ferait sauter le séparateur du deuxième.
      if !spans.is_empty() {
        text.push(SEPARATOR);
      }
      let start = text.len();
      text.push_str(&word.text);
      spans.push((start, text.len()));
    }
    Self { text, spans }
  }

  /// La frontière entre le mot `left` et son suivant est-elle **avalée** par une occurrence ?
  ///
  /// C'est la seule question qui décide de la fusion : deux mots n'en font plus qu'un
  /// exactement quand une occurrence commence avant la fin du second et finit après la fin du
  /// premier.
  fn swallowed(&self, left: usize, found: &[Match<'_>]) -> bool {
    let (_, left_end) = self.spans[left];
    let (right_start, _) = self.spans[left + 1];
    found
      .iter()
      .any(|occurrence| occurrence.start < right_start && occurrence.end > left_end)
  }

  /// Le texte du mot que forment les mots `first..=last`, corrections appliquées.
  ///
  /// Les occurrences retenues sont celles que la plage contient : une occurrence qui la
  /// déborderait aurait avalé une frontière, et le groupe serait plus large.
  fn rebuilt(&self, first: usize, last: usize, found: &[Match<'_>]) -> String {
    let (start, end) = (self.spans[first].0, self.spans[last].1);
    let mut out = String::with_capacity(end - start);
    let mut copied = start;
    for occurrence in found
      .iter()
      .filter(|occurrence| occurrence.start >= start && occurrence.end <= end)
    {
      out.push_str(&self.text[copied..occurrence.start]);
      out.push_str(&cased(
        occurrence.term,
        &self.text[occurrence.start..occurrence.end],
      ));
      copied = occurrence.end;
    }
    out.push_str(&self.text[copied..end]);
    out
  }
}

#[cfg(test)]
mod tests {
  use super::{Entry, Word, apply, corrected};
  use std::borrow::Cow;

  fn entry(term: &str, variants: &[&str]) -> Entry {
    Entry {
      term: term.to_owned(),
      variants: variants
        .iter()
        .map(|variant| (*variant).to_owned())
        .collect(),
    }
  }

  /// Des mots d'une seconde chacun, collés bout à bout : les bornes se lisent d'un coup d'œil.
  fn words(texts: &[&str]) -> Vec<Word> {
    texts
      .iter()
      .enumerate()
      .map(|(index, text)| Word {
        text: (*text).to_owned(),
        start_ms: index as u64 * 1_000,
        end_ms: index as u64 * 1_000 + 1_000,
      })
      .collect()
  }

  /// Ce qu'on vérifie presque partout : le texte et les bornes de chaque mot rendu.
  fn shape(words: &[Word]) -> Vec<(&str, u64, u64)> {
    words
      .iter()
      .map(|word| (word.text.as_str(), word.start_ms, word.end_ms))
      .collect()
  }

  #[test]
  fn a_variant_inside_a_single_word_keeps_its_bounds() {
    let source = words(&["j'ai", "poussé", "sur", "guitlab", "hier"]);
    let result = apply(&source, &[entry("GitLab", &["guitlab"])]);
    assert_eq!(
      shape(&result),
      [
        ("j'ai", 0, 1_000),
        ("poussé", 1_000, 2_000),
        ("sur", 2_000, 3_000),
        ("GitLab", 3_000, 4_000),
        ("hier", 4_000, 5_000),
      ]
    );
  }

  /// ⚠️ Le cas qui justifie le module : deux mots n'en font plus qu'un, et le mot fusionné
  /// prend le **début du premier** et la **fin du dernier**. Rien n'est inventé, rien n'est
  /// perdu.
  #[test]
  fn a_variant_spanning_two_words_yields_one_word_from_the_first_start_to_the_last_end() {
    let source = words(&["sur", "git", "lab", "hier"]);
    let result = apply(&source, &[entry("GitLab", &["git lab"])]);
    assert_eq!(
      shape(&result),
      [
        ("sur", 0, 1_000),
        ("GitLab", 1_000, 3_000),
        ("hier", 3_000, 4_000),
      ]
    );
  }

  #[test]
  fn a_variant_spanning_three_words_yields_one_word_covering_the_three() {
    let source = words(&["dis", "mir", "ma", "lion", "vite"]);
    let result = apply(&source, &[entry("Mirmalion", &["mir ma lion"])]);
    assert_eq!(
      shape(&result),
      [
        ("dis", 0, 1_000),
        ("Mirmalion", 1_000, 4_000),
        ("vite", 4_000, 5_000),
      ]
    );
  }

  #[test]
  fn two_corrections_in_the_same_sequence_are_both_applied() {
    let source = words(&["mir", "maleon", "sur", "git", "lab"]);
    let result = apply(
      &source,
      &[
        entry("GitLab", &["git lab"]),
        entry("Mirmalion", &["mir maleon"]),
      ],
    );
    assert_eq!(
      shape(&result),
      [
        ("Mirmalion", 0, 2_000),
        ("sur", 2_000, 3_000),
        ("GitLab", 3_000, 5_000),
      ]
    );
  }

  /// Le cas de très loin le plus fréquent : personne n'a rien saisi. **Aucune copie.**
  #[test]
  fn without_any_entry_the_words_are_returned_untouched_and_borrowed() {
    let source = words(&["rien", "à", "corriger"]);
    let result = apply(&source, &[]);
    assert!(matches!(result, Cow::Borrowed(_)));
  }

  /// ⚠️ Un fichier de dix mille mots ne doit pas être recopié parce qu'un dictionnaire existe.
  #[test]
  fn a_sequence_where_nothing_matches_is_returned_borrowed() {
    let source = words(&["aucune", "occurrence", "ici"]);
    let result = apply(&source, &[entry("GitLab", &["git lab"])]);
    assert!(matches!(result, Cow::Borrowed(_)));
    assert_eq!(shape(&result), shape(&source));
  }

  /// Sans le tri par longueur de `super::needles`, « git » gagnerait par position et laisserait
  /// « lab » en vrac derrière lui.
  #[test]
  fn the_longest_variant_wins_over_a_shorter_one_that_starts_alike() {
    let source = words(&["git", "lab", "et", "git"]);
    let result = apply(
      &source,
      &[entry("Git", &["git"]), entry("GitLab", &["git lab"])],
    );
    assert_eq!(
      shape(&result),
      [
        ("GitLab", 0, 2_000),
        ("et", 2_000, 3_000),
        ("Git", 3_000, 4_000),
      ]
    );
  }

  /// ⚠️ Le garde-fou qui empêche le dictionnaire de saboter le transcript : une variante latine
  /// ne se déclenche jamais au milieu d'un mot.
  #[test]
  fn a_latin_variant_never_matches_inside_a_longer_word() {
    let source = words(&["un", "mirroir", "et", "un", "mirage"]);
    let result = apply(&source, &[entry("Mirmalion", &["mir"])]);
    assert!(matches!(result, Cow::Borrowed(_)));
  }

  /// Deux occurrences **dans le même mot** : le mot est reconstruit d'un bloc, et ses bornes
  /// restent les siennes.
  #[test]
  fn two_occurrences_inside_one_word_are_both_replaced() {
    let source = words(&["gitlab,gitlab", "enfin"]);
    let result = apply(&source, &[entry("GitLab", &["gitlab"])]);
    assert_eq!(
      shape(&result),
      [("GitLab,GitLab", 0, 1_000), ("enfin", 1_000, 2_000)]
    );
  }

  /// La casse suit la règle de `super::cased` : un terme tout en minuscules prend la majuscule
  /// de l'occurrence qu'il remplace, un terme qui porte une majuscule est rendu verbatim.
  #[test]
  fn the_stored_case_rules_the_merged_word_too() {
    let source = words(&["Git", "Lab", "puis", "Aïfone"]);
    let result = apply(
      &source,
      &[entry("GitLab", &["git lab"]), entry("iPhone", &["aïfone"])],
    );
    assert_eq!(
      shape(&result),
      [
        ("GitLab", 0, 2_000),
        ("puis", 2_000, 3_000),
        ("iPhone", 3_000, 4_000),
      ]
    );
  }

  /// ⚠️ **L'invariant qui relie les deux applications.** Ce que la fenêtre-document affiche est
  /// le texte des mots rejoints : il doit être, au caractère près, celui qu'aurait rendu la
  /// dictée sur la même phrase. Sinon le dictionnaire corrigerait « selon l'écran ».
  #[test]
  fn correcting_the_words_agrees_with_correcting_their_joined_text() {
    let entries = [
      entry("GitLab", &["git lab"]),
      entry("Mirmalion", &["mir ma lion"]),
      entry("e-mail", &["imel"]),
    ];
    let source = words(&[
      "Imel", "reçu", ":", "mir", "ma", "lion", "tourne", "sur", "git", "lab", ".",
    ]);

    let joined = source
      .iter()
      .map(|word| word.text.as_str())
      .collect::<Vec<_>>()
      .join(" ");
    let rejoined = apply(&source, &entries)
      .iter()
      .map(|word| word.text.as_str())
      .collect::<Vec<_>>()
      .join(" ");

    assert_eq!(rejoined, crate::dictionary::apply(&joined, &entries));
  }

  /// Les mots d'un média vide : rien à corriger, et surtout rien qui panique.
  #[test]
  fn an_empty_sequence_is_returned_borrowed() {
    let result = apply(&[], &[entry("GitLab", &["git lab"])]);
    assert!(matches!(result, Cow::Borrowed(_)));
  }

  /// ⚠️ Le vecteur d'origine ressort **tel quel** quand rien ne correspond — c'est la raison
  /// d'être de `corrected`. On le prouve par l'adresse de ses données, pas par son contenu.
  #[test]
  fn correcting_owned_words_without_a_match_reuses_the_very_same_allocation() {
    let source = words(&["aucune", "occurrence", "ici"]);
    let address = source.as_ptr();
    let result = corrected(source, &[entry("GitLab", &["git lab"])]);
    assert!(std::ptr::eq(result.as_ptr(), address));
  }

  #[test]
  fn correcting_owned_words_applies_the_dictionary() {
    let result = corrected(
      words(&["sur", "git", "lab"]),
      &[entry("GitLab", &["git lab"])],
    );
    assert_eq!(
      shape(&result),
      [("sur", 0, 1_000), ("GitLab", 1_000, 3_000)]
    );
  }
}
