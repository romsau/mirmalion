//! Le dictionnaire personnel — **pur, sans I/O, sans Tauri**.
//!
//! Il remplace, dans le texte **brut** du moteur, les graphies écrites à la place d'un terme
//! nommé par l'utilisateur : « git lab » → « **GitLab** ». La dictée corrige un texte ([`apply`]),
//! les fichiers des mots horodatés ([`words::apply`]) ; les deux passent par [`Folded::matches`].
//!
//! # Pièges
//!
//! - ⚠️ Aucune expression régulière : la recherche est une comparaison de caractères, donc il n'y
//!   a aucun échappement à oublier et aucun caractère spécial à recenser.
//! - ⚠️ Le repliage change les longueurs — `œ` devient `oe`, `ß` devient `ss`. On ne reconstruit
//!   jamais la sortie depuis le texte replié : [`Folded`] retient la plage d'octets d'origine de
//!   chaque caractère, et le reste est recopié verbatim depuis l'entrée.
//! - ⚠️ Une frontière de mot n'est exigée que du côté où la variante porte une lettre ou un
//!   chiffre : une variante encadrée de ponctuation n'en réclame aucune.

use std::borrow::Cow;

pub mod words;

/// Un terme correct et les graphies que le moteur écrit à sa place.
///
/// **Portée globale, pas par langue** : un nom propre ne dépend pas de la langue parlée. Une
/// entrée sans variante ne remplace rien — c'est le cas d'un terme que l'utilisateur vient de
/// créer et dont il n'a pas encore listé les graphies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
  /// La graphie correcte, telle que l'utilisateur l'a saisie.
  pub term: String,
  /// Les graphies que le moteur écrit à sa place.
  pub variants: Vec<String>,
}

/// Remplace, dans `text`, toute variante connue par son terme.
///
/// # Pièges
///
/// - ⚠️ Rend un [`Cow`], et l'emprunt n'est pas une coquetterie : le dictionnaire est toujours
///   actif, donc cette fonction est appelée à chaque dictée, y compris chez qui n'a jamais rien
///   saisi. Sans entrée exploitable, elle ne copie rien du tout.
pub fn apply<'a>(text: &'a str, entries: &[Entry]) -> Cow<'a, str> {
  let needles = needles(entries);
  if needles.is_empty() {
    return Cow::Borrowed(text);
  }

  let found = Folded::of(text).matches(&needles);
  if found.is_empty() {
    return Cow::Borrowed(text);
  }

  let mut out = String::with_capacity(text.len());
  // Position, en octets et **dans le texte d'origine**, de ce qui a déjà été recopié.
  let mut copied = 0;
  for occurrence in found {
    out.push_str(&text[copied..occurrence.start]);
    out.push_str(&cased(
      occurrence.term,
      &text[occurrence.start..occurrence.end],
    ));
    copied = occurrence.end;
  }
  out.push_str(&text[copied..]);
  Cow::Owned(out)
}

/// Une occurrence trouvée : **une plage d'octets du texte d'origine**, et le terme qui la
/// remplace.
///
/// # Pièges
///
/// - ⚠️ Des positions, et rien d'autre : c'est ce qui permet à la même recherche de servir un
///   texte et une suite de mots horodatés. Ce qu'on fait d'une occurrence — recopier autour,
///   fusionner des mots, reporter des millisecondes — n'appartient pas à la recherche.
struct Match<'t> {
  /// Début de la plage, en octets du texte d'origine.
  start: usize,
  /// Borne de fin **exclue**.
  end: usize,
  /// Le terme qui remplace cette plage.
  term: &'t str,
}

/// Les variantes repliées, **de la plus longue à la plus courte**.
///
/// # Pièges
///
/// - ⚠️ L'ordre est le sujet : deux entrées peuvent se chevaucher — « git » et « git lab » — et la
///   plus courte gagnerait par simple position, laissant « lab » en vrac derrière elle.
fn needles(entries: &[Entry]) -> Vec<(Vec<char>, &str)> {
  let mut needles: Vec<(Vec<char>, &str)> = entries
    .iter()
    .flat_map(|entry| {
      entry
        .variants
        .iter()
        .map(|variant| (fold(variant), entry.term.as_str()))
    })
    // Une variante vide, ou réduite à des blancs, se déclencherait partout.
    .filter(|(folded, _)| !folded.is_empty())
    .collect();
  needles.sort_by_key(|(folded, _)| std::cmp::Reverse(folded.len()));
  needles
}

/// Le texte replié, et le chemin de retour vers l'original.
struct Folded {
  /// Les caractères repliés, dans l'ordre.
  chars: Vec<char>,
  /// Pour chaque caractère replié, la plage d'octets du caractère **d'origine** dont il
  /// provient. Deux caractères repliés issus d'un même `œ` portent la même plage.
  spans: Vec<(usize, usize)>,
}

impl Folded {
  /// Replie `text` en retenant, pour chaque caractère replié, sa plage d'octets d'origine.
  fn of(text: &str) -> Self {
    let mut chars = Vec::with_capacity(text.len());
    let mut spans = Vec::with_capacity(text.len());
    for (index, character) in text.char_indices() {
      fold_into(character, &mut chars);
      spans.resize(chars.len(), (index, index + character.len_utf8()));
    }
    Self { chars, spans }
  }

  /// Toutes les occurrences, de gauche à droite et **sans recouvrement**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ On repart **après** chaque occurrence, et la sortie n'est jamais relue : une variante ne
  ///   peut donc pas se redéclencher à l'intérieur du terme qu'on vient d'écrire.
  fn matches<'n>(&self, needles: &'n [(Vec<char>, &'n str)]) -> Vec<Match<'n>> {
    let mut found = Vec::new();
    let mut cursor = 0;
    while cursor < self.chars.len() {
      let Some((needle, term)) = self.matching(cursor, needles) else {
        cursor += 1;
        continue;
      };
      let (start, _) = self.spans[cursor];
      let (_, end) = self.spans[cursor + needle.len() - 1];
      found.push(Match { start, end, term });
      cursor += needle.len();
    }
    found
  }

  /// La première variante qui s'ancre exactement à `cursor`, frontières comprises.
  fn matching<'n>(
    &self,
    cursor: usize,
    needles: &'n [(Vec<char>, &'n str)],
  ) -> Option<(&'n [char], &'n str)> {
    needles.iter().find_map(|(needle, term)| {
      let end = cursor + needle.len();
      (end <= self.chars.len()
        && self.chars[cursor..end] == needle[..]
        && self.free_before(cursor, needle[0])
        && self.free_after(end, needle[needle.len() - 1]))
      .then_some((needle.as_slice(), *term))
    })
  }

  /// La frontière de gauche est-elle libre pour une variante commençant par `edge` ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ `edge` est le caractère de la **variante**, pas du texte : c'est lui qui décide si une
  ///   frontière est seulement exigible, et une variante ouverte par de la ponctuation n'en
  ///   réclame aucune.
  fn free_before(&self, cursor: usize, edge: char) -> bool {
    !edge.is_alphanumeric() || cursor == 0 || !self.chars[cursor - 1].is_alphanumeric()
  }

  /// La frontière de droite est-elle libre pour une variante finissant par `edge` ?
  fn free_after(&self, end: usize, edge: char) -> bool {
    !edge.is_alphanumeric() || end == self.chars.len() || !self.chars[end].is_alphanumeric()
  }
}

/// Le texte replié, sans carte de retour : pour une variante, qu'on ne rend jamais telle quelle.
fn fold(text: &str) -> Vec<char> {
  let mut folded = Vec::with_capacity(text.len());
  for character in text.chars() {
    fold_into(character, &mut folded);
  }
  folded
}

/// Minuscules **et** sans diacritique — « MIRMALIÔN » et « mirmalion » se valent.
///
/// # Pièges
///
/// - ⚠️ Les trois ligatures sont traitées à part, et elles ne sont pas anecdotiques en français :
///   `to_lowercase` sait rendre `Œ` en `œ`, il ne sait pas que « cœur » et « coeur » désignent le
///   même mot. Un utilisateur tape l'un, le moteur écrit l'autre.
fn fold_into(character: char, out: &mut Vec<char>) {
  match character {
    'œ' | 'Œ' => out.extend(['o', 'e']),
    'æ' | 'Æ' => out.extend(['a', 'e']),
    'ß' => out.extend(['s', 's']),
    _ => out.extend(character.to_lowercase().map(strip)),
  }
}

/// Le caractère latin dépouillé de son signe diacritique.
///
/// Couvre les six langues du périmètre (français, anglais, espagnol, allemand, italien,
/// portugais) plus les diacritiques voisins d'Extended-A, qu'un copier-coller amène sans
/// prévenir.
fn strip(character: char) -> char {
  match character {
    'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
    'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
    'ď' | 'đ' => 'd',
    'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
    'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
    'ĥ' | 'ħ' => 'h',
    'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
    'ĵ' => 'j',
    'ķ' => 'k',
    'ĺ' | 'ļ' | 'ľ' | 'ł' => 'l',
    'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
    'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
    'ŕ' | 'ŗ' | 'ř' => 'r',
    'ś' | 'ŝ' | 'ş' | 'š' => 's',
    'ţ' | 'ť' | 'ŧ' => 't',
    'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
    'ŵ' => 'w',
    'ý' | 'ÿ' | 'ŷ' => 'y',
    'ź' | 'ż' | 'ž' => 'z',
    other => other,
  }
}

/// Le terme, dans la casse qu'il doit porter à cet endroit du texte.
///
/// Un terme portant **une majuscule quelque part** est rendu verbatim : c'est une graphie voulue.
/// Un terme **entièrement en minuscules** n'exprime aucune intention de casse, et prend la
/// majuscule si l'occurrence qu'il remplace en portait une.
///
/// # Pièges
///
/// - ⚠️ La casse stockée fait foi, et la majuscule de début de phrase est l'exception : mettre une
///   majuscule dès que l'occurrence en portait une donnerait « IPhone », « MacOS » et « EBay » en
///   tête de phrase — exactement les marques qu'on inscrit dans un dictionnaire personnel.
fn cased<'t>(term: &'t str, occurrence: &str) -> Cow<'t, str> {
  if term.chars().any(char::is_uppercase) {
    return Cow::Borrowed(term);
  }
  let starts_upper = occurrence.chars().next().is_some_and(char::is_uppercase);
  if !starts_upper {
    return Cow::Borrowed(term);
  }
  let mut characters = term.chars();
  match characters.next() {
    Some(first) => Cow::Owned(first.to_uppercase().chain(characters).collect()),
    None => Cow::Borrowed(term),
  }
}

#[cfg(test)]
mod tests {
  use super::{Entry, apply};

  fn entry(term: &str, variants: &[&str]) -> Entry {
    Entry {
      term: term.to_owned(),
      variants: variants
        .iter()
        .map(|variant| (*variant).to_owned())
        .collect(),
    }
  }

  /// Le cas de très loin le plus fréquent : personne n'a rien saisi. **Aucune copie.**
  #[test]
  fn without_any_entry_the_text_is_returned_untouched_and_borrowed() {
    let text = "rien à corriger ici";
    let result = apply(text, &[]);
    assert_eq!(result, text);
    assert!(matches!(result, std::borrow::Cow::Borrowed(_)));
  }

  /// Une entrée sans variante ne remplace rien — cas d'un terme tout juste créé.
  #[test]
  fn an_entry_without_a_variant_replaces_nothing() {
    let result = apply("mir maleon", &[entry("Mirmalion", &[])]);
    assert!(matches!(result, std::borrow::Cow::Borrowed(_)));
  }

  /// Une variante réduite à des blancs se déclencherait partout : elle est écartée.
  #[test]
  fn a_blank_variant_is_ignored() {
    let result = apply("un texte", &[entry("Mirmalion", &["   "])]);
    assert_eq!(result, "un texte");
  }

  #[test]
  fn a_known_variant_becomes_its_term() {
    let entries = [entry("GitLab", &["git lab"])];
    assert_eq!(
      apply("j'ai poussé sur git lab hier", &entries),
      "j'ai poussé sur GitLab hier"
    );
  }

  #[test]
  fn matching_ignores_case() {
    let entries = [entry("GitLab", &["git lab"])];
    assert_eq!(apply("Git Lab est lent", &entries), "GitLab est lent");
  }

  #[test]
  fn matching_ignores_diacritics_in_either_direction() {
    let entries = [entry("Mirmalion", &["mir maléon"])];
    assert_eq!(
      apply("teste mir maleon vite", &entries),
      "teste Mirmalion vite"
    );

    let entries = [entry("Mirmalion", &["mir maleon"])];
    assert_eq!(
      apply("teste mir maléon vite", &entries),
      "teste Mirmalion vite"
    );
  }

  /// `to_lowercase` sait rendre `Œ` en `œ` ; il ne sait pas que « cœur » et « coeur » sont
  /// le même mot. Le moteur écrit l'un, l'utilisateur tape l'autre.
  #[test]
  fn the_oe_ligature_matches_its_two_letter_spelling() {
    let entries = [entry("Cœur de Ville", &["coeur de ville"])];
    assert_eq!(
      apply("le cœur de ville est fermé", &entries),
      "le Cœur de Ville est fermé"
    );
  }

  #[test]
  fn the_sharp_s_matches_its_two_letter_spelling() {
    let entries = [entry("Weißbier", &["weissbier"])];
    assert_eq!(
      apply("un Weißbier s'il vous plaît", &entries),
      "un Weißbier s'il vous plaît"
    );
  }

  /// ⚠️ Le garde-fou qui empêche le dictionnaire de saboter le texte.
  #[test]
  fn a_variant_never_matches_inside_a_longer_word() {
    let entries = [entry("Mirmalion", &["mir"])];
    assert_eq!(
      apply("un mirroir et un mirage", &entries),
      "un mirroir et un mirage"
    );
    assert_eq!(
      apply("dis mir maintenant", &entries),
      "dis Mirmalion maintenant"
    );
  }

  /// Sans le tri par longueur, « git » gagnerait par position et laisserait « lab » derrière.
  #[test]
  fn the_longest_variant_wins_over_a_shorter_one_that_starts_alike() {
    let entries = [entry("Git", &["git"]), entry("GitLab", &["git lab"])];
    assert_eq!(apply("git lab et git", &entries), "GitLab et Git");
  }

  #[test]
  fn every_occurrence_is_replaced_and_the_tail_is_kept() {
    let entries = [entry("GitLab", &["git lab"])];
    assert_eq!(
      apply("git lab puis git lab, fin", &entries),
      "GitLab puis GitLab, fin"
    );
  }

  #[test]
  fn several_entries_apply_in_the_same_pass() {
    let entries = [
      entry("GitLab", &["git lab"]),
      entry("Mirmalion", &["mir maleon"]),
    ];
    assert_eq!(
      apply("mir maleon sur git lab", &entries),
      "Mirmalion sur GitLab"
    );
  }

  /// ⚠️ Le cas qui a fait écarter la consigne d'origine : « iPhone » ne devient pas
  /// « IPhone » sous prétexte qu'il ouvre la phrase.
  #[test]
  fn a_term_with_an_uppercase_letter_is_never_recased() {
    let entries = [entry("iPhone", &["aïfone"])];
    assert_eq!(
      apply("Aïfone ou Android ?", &entries),
      "iPhone ou Android ?"
    );
    assert_eq!(apply("un aïfone neuf", &entries), "un iPhone neuf");
  }

  /// L'exception, et elle est étroite : le terme n'exprime aucune intention de casse.
  #[test]
  fn an_all_lowercase_term_takes_the_capital_of_the_occurrence_it_replaces() {
    let entries = [entry("e-mail", &["imel"])];
    assert_eq!(
      apply("Imel reçu ce matin", &entries),
      "E-mail reçu ce matin"
    );
    assert_eq!(apply("un imel reçu", &entries), "un e-mail reçu");
  }

  /// ⚠️ Le motif de l'utilisateur n'est jamais compilé : il n'y a rien à échapper. Ce test
  /// vaut donc pour **tous** les caractères spéciaux à la fois, pas pour une liste.
  #[test]
  fn a_variant_full_of_regex_metacharacters_matches_literally() {
    let entries = [entry("C++", &[".*+?[](){}|^$\\"])];
    assert_eq!(
      apply("le langage .*+?[](){}|^$\\ est vieux", &entries),
      "le langage C++ est vieux"
    );
  }

  /// Une variante entièrement faite de caractères spéciaux n'a aucune frontière à exiger :
  /// elle doit se remplacer même collée à du texte.
  #[test]
  fn a_variant_without_any_letter_needs_no_word_boundary() {
    let entries = [entry("→", &["->"])];
    assert_eq!(apply("a->b", &entries), "a→b");
  }

  #[test]
  fn a_text_where_nothing_matches_is_returned_borrowed() {
    let entries = [entry("GitLab", &["git lab"])];
    let result = apply("aucune occurrence ici", &entries);
    assert!(matches!(result, std::borrow::Cow::Borrowed(_)));
  }

  #[test]
  fn an_occurrence_at_the_very_start_and_at_the_very_end_is_replaced() {
    let entries = [entry("GitLab", &["git lab"])];
    assert_eq!(apply("git lab", &entries), "GitLab");
  }

  /// Ce qui n'est pas remplacé est recopié **verbatim** : les accents et la casse du reste du
  /// texte ne doivent rien au repliage, qui ne sert qu'à chercher.
  #[test]
  fn the_untouched_text_keeps_its_own_case_and_accents() {
    let entries = [entry("GitLab", &["git lab"])];
    assert_eq!(
      apply(
        "ÉTÉ 1998 : git lab n'existait pas, Œuvre inédite.",
        &entries
      ),
      "ÉTÉ 1998 : GitLab n'existait pas, Œuvre inédite."
    );
  }
}
