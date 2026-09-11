//! À quelle voix appartient chaque mot — au mot, jamais au segment.
//!
//! Module pur : deux tranches en entrée, une liste de numéros de voix en sortie. Aucun audio,
//! aucun moteur, aucun `unsafe`, aucune horloge. Son unique client est le filtre d'écho, le
//! module `echo` voisin, qui s'en sert pour jeter les mots du micro qui redisent le flux
//! système. Rien de ce qu'il calcule n'est montré ni conservé.
//!
//! # Pièges
//!
//! - ⚠️ Les deux moteurs ne se parlent pas : la transcription découpe sur des frontières
//!   linguistiques, le diariseur sur des frontières acoustiques. Attribuer au segment produit
//!   donc des erreurs en milieu de phrase — pour le filtre, une demi-réplique effacée.
//! - ⚠️ Le filtre porte sur les mots, pas sur les segments : retirer les tours d'écho avant
//!   d'attribuer ferait retomber chaque mot d'écho sur le segment voisin, celui de l'utilisateur.

use crate::transcript::Word;

use super::DiarizationSegment;

/// De quelle voix vient chaque mot, sans renumérotation : les numéros sont ceux du diariseur.
///
/// # Pièges
///
/// - ⚠️ Chaque flux est attribué contre ses propres tours de parole, jamais contre les deux
///   concaténés : le système et le micro sont diarisés séparément, et leurs numéros ne désignent
///   pas les mêmes personnes. Les mélanger fausse tout recouvrement, donc toute session.
pub fn attribute(words: &[Word], segments: &[DiarizationSegment]) -> Vec<u32> {
  words.iter().map(|word| voice_of(word, segments)).collect()
}

/// De quelle voix vient ce mot ?
///
/// Trois issues, dans cet ordre : le segment qui contient le milieu du mot (voir
/// [`Word::midpoint_ms`] pour le motif du milieu plutôt que du début) ; à défaut, le segment le
/// plus proche de ce milieu ; à défaut de tout segment, la voix `0`.
///
/// # Pièges
///
/// - ⚠️ Le repli sur le plus proche est une nécessité : les diariseurs laissent des trous, et
///   sans lui ces mots tomberaient dans une voix fictive que le filtre d'écho jugerait en bloc.
fn voice_of(word: &Word, segments: &[DiarizationSegment]) -> u32 {
  let at = word.midpoint_ms();

  if let Some(segment) = segments.iter().find(|segment| segment.contains(at)) {
    return segment.speaker;
  }

  segments
    .iter()
    .min_by_key(|segment| segment.distance_ms(at))
    .map_or(0, |segment| segment.speaker)
}

#[cfg(test)]
mod tests {
  use super::attribute;
  use crate::diarization::DiarizationSegment;
  use crate::transcript::Word;

  /// Un mot horodaté, écrit court parce que ces tests en alignent beaucoup.
  fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
    Word {
      text: text.into(),
      start_ms,
      end_ms,
    }
  }

  /// Un segment de voix, écrit court pour la même raison.
  fn segment(speaker: u32, start_ms: u64, end_ms: u64) -> DiarizationSegment {
    DiarizationSegment {
      speaker,
      start_ms,
      end_ms,
    }
  }

  #[test]
  fn without_any_segment_every_word_falls_to_the_same_voice() {
    // Le cas nominal d'un flux à une seule voix : la diarisation n'a rien à distinguer.
    let words = vec![word("Bonjour", 0, 400), word("à", 400, 500)];
    assert_eq!(attribute(&words, &[]), vec![0, 0]);
  }

  #[test]
  fn no_words_yields_no_attribution() {
    assert!(attribute(&[], &[segment(0, 0, 1_000)]).is_empty());
  }

  #[test]
  fn each_word_takes_the_voice_of_the_segment_it_falls_in() {
    let words = vec![word("Bonjour", 0, 400), word("Salut", 1_100, 1_500)];
    let segments = vec![segment(0, 0, 1_000), segment(1, 1_000, 3_000)];
    assert_eq!(attribute(&words, &segments), vec![0, 1]);
  }

  /// ⚠️ Le mot court de 800 à 1 200 ms, la bascule de voix est à 1 000 ms : son début est chez la
  /// voix 0, sa fin chez la voix 1, et les deux arbitrages naïfs se trompent une fois sur deux.
  /// Son milieu tombe dans le second segment, borne de début incluse.
  #[test]
  fn a_word_straddling_a_change_goes_where_its_middle_falls() {
    let words = vec![word("chevauchant", 800, 1_200)];
    let segments = vec![segment(0, 0, 1_000), segment(1, 1_000, 2_000)];
    assert_eq!(
      attribute(&words, &segments),
      vec![1],
      "attribué sur son début, ce mot serait resté sur la voix 0"
    );
  }

  #[test]
  fn a_word_in_a_gap_falls_to_the_nearest_voice() {
    // Les diariseurs laissent des trous. Sans repli, ce mot n'appartiendrait à personne.
    let words = vec![word("orphelin", 1_400, 1_600)];
    let segments = vec![segment(0, 0, 1_000), segment(1, 1_800, 3_000)];
    assert_eq!(attribute(&words, &segments), vec![1]);
  }

  #[test]
  fn a_word_before_the_first_segment_falls_to_it() {
    let words = vec![word("avance", 0, 100)];
    assert_eq!(attribute(&words, &[segment(7, 5_000, 6_000)]), vec![7]);
  }

  /// ⚠️ Les numéros ne sont pas renumérotés, et c'est ce que le filtre d'écho attend : il compare
  /// les voix du micro à celles du système par les numéros que le pont lui a rendus. Renuméroter
  /// ici décalerait la matrice des distances.
  #[test]
  fn the_raw_numbers_of_the_diariser_are_kept_as_they_are() {
    let words = vec![word("Premier", 100, 200), word("Second", 1_100, 1_200)];
    let segments = vec![segment(5, 0, 1_000), segment(2, 1_000, 2_000)];
    assert_eq!(attribute(&words, &segments), vec![5, 2]);
  }
}
