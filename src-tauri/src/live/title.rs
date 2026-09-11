//! Le titre d'une session : ce qu'on soumet au modèle, et quand on ne demande rien.
//!
//! Module pur — ni modèle, ni pont : on lui donne un transcript, il rend l'extrait à soumettre,
//! ou rien.
//!
//! # Pièges
//!
//! - ⚠️ Le sujet d'une session s'annonce dans ses premières minutes, pas dans sa conclusion : on
//!   n'envoie que l'ouverture. Soumettre l'heure entière exigerait un map-reduce — plusieurs
//!   passes, plusieurs secondes — pour cinq mots que l'ouverture donnait déjà.
//! - ⚠️ Ce n'est pas le map-reduce du compte rendu : celui-là doit tout lire, une décision prise
//!   à la cinquante-cinquième minute en fait partie. Un titre, non.

/// Combien de mots au maximum partent au modèle.
///
/// 300 mots couvrent largement l'ouverture d'une session, tour de table compris.
///
/// # Pièges
///
/// - ⚠️ Un compte de mots et non de tokens : l'estimation des tokens et son propre plafond
///   (`maxTitleInputTokens`) appartiennent au pont. Ici on borne ce qu'on choisit d'envoyer.
pub const TITLE_WORDS: usize = 300;

/// En deçà de ce nombre de mots, on ne demande rien.
///
/// Le chiffre est un jugement, pas une mesure : soixante mots font une trentaine de secondes de
/// parole — assez pour qu'un ordre du jour ait été annoncé, trop peu pour qu'un bonjour suffise.
///
/// # Pièges
///
/// - ⚠️ Sur vingt secondes de parole, le modèle rend un titre qui répète les seuls mots qu'il a
///   lus : un écho qui a l'air d'un résumé. Le repli « Session du 4 août » ne prétend rien.
pub const ENOUGH_WORDS: usize = 60;

/// Le seuil se juge sur le transcript entier, l'extrait est borné : vérifié à la compilation.
///
/// # Pièges
///
/// - ⚠️ Si le seuil passait au-dessus de ce qu'on envoie, aucune session ne pourrait à la fois
///   le dépasser et être tronquée : le seuil ne trancherait plus rien, silencieusement.
const _: () = {
  assert!(
    ENOUGH_WORDS < TITLE_WORDS,
    "le seuil doit rester sous ce qu'on envoie, sinon il ne tranche plus rien"
  );
};

/// L'ouverture d'une session, à soumettre au modèle — ou `None` s'il n'y a rien à nommer.
///
/// # Pièges
///
/// - ⚠️ Les mots se comptent sur le transcript entier avant de couper, jamais sur l'extrait :
///   autrement toute session de plus de `TITLE_WORDS` mots passerait le seuil par construction,
///   et le seuil ne trancherait plus rien.
pub fn opening(transcript: &str) -> Option<String> {
  let mut words = transcript.split_whitespace();
  let opening: Vec<&str> = words.by_ref().take(TITLE_WORDS).collect();
  // ⚠️ Assez long ou tronqué : un transcript qui déborde `TITLE_WORDS` a forcément plus de
  // `ENOUGH_WORDS` mots. Le revérifier en épuisant l'itérateur ne coûterait que du temps sur les
  // sessions longues, précisément celles qui n'ont aucun doute à lever.
  if opening.len() < ENOUGH_WORDS {
    return None;
  }
  Some(opening.join(" "))
}

#[cfg(test)]
mod tests {
  use super::{ENOUGH_WORDS, TITLE_WORDS, opening};

  fn words(count: usize) -> String {
    (0..count)
      .map(|index| format!("mot{index}"))
      .collect::<Vec<_>>()
      .join(" ")
  }

  /// ⚠️ **Le cas de la DoD** : une session de vingt secondes doit retomber sur « Session du … ».
  #[test]
  fn a_session_too_short_to_have_a_subject_gets_no_title_asked() {
    assert_eq!(opening("Bonjour. On se rappelle demain, merci."), None);
    assert_eq!(opening(""), None);
    assert_eq!(opening(&words(ENOUGH_WORDS - 1)), None);
  }

  #[test]
  fn a_session_long_enough_hands_over_its_opening() {
    let asked = opening(&words(ENOUGH_WORDS)).expect("assez de matière pour nommer");
    assert_eq!(asked.split_whitespace().count(), ENOUGH_WORDS);
  }

  /// ⚠️ On n'envoie que l'ouverture, même sur une session d'une heure : le sujet est annoncé au
  /// début, tout envoyer coûterait un map-reduce pour cinq mots déjà disponibles.
  #[test]
  fn a_long_session_only_hands_over_its_beginning() {
    let asked = opening(&words(TITLE_WORDS * 10)).expect("une longue session a un sujet");
    assert_eq!(asked.split_whitespace().count(), TITLE_WORDS);
    assert!(
      asked.starts_with("mot0 mot1 "),
      "c'est le DÉBUT qu'on envoie, pas un extrait quelconque"
    );
  }

  /// Les sauts de ligne d'un transcript par tours de parole ne comptent pas pour des mots.
  #[test]
  fn turn_breaks_are_not_words() {
    let transcript = words(ENOUGH_WORDS - 1).replace(' ', "\n\n");
    assert_eq!(
      opening(&transcript),
      None,
      "des retours à la ligne n'ajoutent rien"
    );
  }

  // ⚠️ Le rapport entre les deux bornes n'est pas éprouvé ici mais **à la compilation**, juste
  // sous `ENOUGH_WORDS` : une porte qu'on ne peut pas franchir vaut mieux qu'un test qu'on peut
  // ignorer.
}
