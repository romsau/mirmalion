//! L'écho des haut-parleurs : « Moi » est la voix que le flux système ne connaît pas.
//!
//! Module pur — ni FluidAudio, ni audio, ni pont : on lui donne des distances entre empreintes de
//! voix, il rend un verdict. La question posée n'est pas « ces deux signaux se ressemblent-ils ? »
//! mais « cette voix du micro est-elle une voix que le flux système connaît déjà ? ».
//!
//! # Pièges
//!
//! - ⚠️ Sans casque, le micro réentend les interlocuteurs par les haut-parleurs, et les deux flux
//!   rendent la même phrase. Sans correction, la session entière revient à l'utilisateur.
//! - ⚠️ Une corrélation d'enveloppes dépendrait du délai, du volume et de l'acoustique de la
//!   pièce, qui changent d'un bureau à l'autre. Une identité de locuteur n'en dépend d'aucun.
//! - ⚠️ Ne pas re-tenter `setVoiceProcessingEnabled` : l'annulation d'écho d'Apple s'empare de la
//!   sortie audio, le périphérique même autour duquel notre agrégat est bâti. Mesuré deux fois.

use std::collections::BTreeSet;

/// La distance en deçà de laquelle deux voix sont la même personne.
///
/// Le fossé est mesuré : l'écho donne 0,084 à 0,166, des étrangers 0,365 à 0,669. Entre les deux,
/// rien — la borne se pose au milieu, jamais sur la valeur qui a échoué, comme [`super::SLIVER_MS`].
///
/// # Pièges
///
/// - ⚠️ Les étrangers ont été mesurés sur des enregistrements de studio ; deux voix réellement
///   proches — deux frères, deux collègues au timbre voisin — n'ont jamais été mesurées.
/// - ⚠️ Se tromper vers le haut efface une réplique de l'utilisateur, vers le bas rend la session
///   entière à l'utilisateur. Le second est le pire : on penche donc vers l'exclusion.
pub const ECHO_DISTANCE: f64 = 0.26;

/// Le fossé mesuré, figé à la compilation — voir [`super::SLIVER_MS`] pour le motif.
///
/// # Pièges
///
/// - ⚠️ Ce n'est pas un test qu'on peut ignorer : sortir la borne du fossé empêche de compiler.
const _: () = {
  assert!(
    ECHO_DISTANCE > 0.166,
    "sous 0,166, la borne laisserait passer de l'écho déjà mesuré"
  );
  assert!(
    ECHO_DISTANCE < 0.365,
    "au-dessus de 0,365, la borne prendrait des étrangers pour la même personne"
  );
};

/// Quelles voix du micro ne sont que l'écho de ce que jouent les haut-parleurs ?
///
/// `distances[i][j]` compare la voix `i` du système à la voix `j` du micro, `None` valant
/// incomparable ; `voices[j]` nomme la colonne `j`. Rend les numéros à écarter, le reste est « Moi ».
///
/// # Pièges
///
/// - ⚠️ Une colonne n'est pas un numéro de voix : le pont ne décrit que les voix à empreinte
///   lisible. Confondre les deux décale les verdicts, d'où `voices` (`VoiceMatchOutcome.second`).
/// - ⚠️ On n'écarte que sur preuve positive : ni une distance manquante, ni une colonne qu'aucun
///   numéro ne nomme, ni un système muet n'écartent quoi que ce soit.
pub fn echoes_of_the_room(distances: &[Vec<Option<f64>>], voices: &[u32]) -> BTreeSet<u32> {
  let mut echoed = BTreeSet::new();
  let columns = distances.iter().map(Vec::len).max().unwrap_or(0);

  for column in 0..columns {
    // ⚠️ Sans numéro, on ne conclut pas. Voir le piège ci-dessus.
    let Some(voice) = voices.get(column).copied() else {
      continue;
    };
    let closest = distances
      .iter()
      .filter_map(|row| row.get(column).copied().flatten())
      .fold(None, |best: Option<f64>, distance| {
        Some(best.map_or(distance, |current| current.min(distance)))
      });
    if closest.is_some_and(|distance| distance <= ECHO_DISTANCE) {
      echoed.insert(voice);
    }
  }

  echoed
}

#[cfg(test)]
mod tests {
  use super::{ECHO_DISTANCE, echoes_of_the_room};

  /// Le cas mesuré : le micro ne porte que de l'écho, et le système le reconnaît.
  #[test]
  fn a_voice_the_system_already_knows_is_an_echo() {
    // Deux voix système, deux voix micro — les deux micro sont l'écho des deux système.
    let echoed = echoes_of_the_room(
      &[
        vec![Some(0.084), Some(0.612)],
        vec![Some(0.598), Some(0.126)],
      ],
      &[0, 1],
    );
    assert_eq!(echoed.into_iter().collect::<Vec<_>>(), vec![0, 1]);
  }

  /// ⚠️ L'utilisateur parle pendant que les autres parlent : sa voix doit survivre à côté de
  /// l'écho, sans quoi il disparaît de son propre transcript.
  #[test]
  fn the_user_survives_next_to_the_echo_of_the_others() {
    // Voix micro 0 = écho du système ; voix micro 1 = personne que le système ne connaît pas.
    let echoed = echoes_of_the_room(&[vec![Some(0.128), Some(0.929)]], &[0, 1]);
    assert_eq!(echoed.into_iter().collect::<Vec<_>>(), vec![0]);
  }

  /// ⚠️ Le pont ne décrit que les voix ayant une empreinte lisible : ici la voix 1 du micro n'en
  /// a pas, les colonnes valent donc les voix 0 et 2. Lire la colonne comme un numéro écartait la
  /// voix 1 — l'utilisateur — et gardait la 2 — l'écho —, sans que le transcript le montre.
  #[test]
  fn a_missing_profile_shifts_no_verdict_onto_the_wrong_voice() {
    // Colonne 0 → voix 0 (étrangère) ; colonne 1 → voix 2 (l'écho). La voix 1 n'a pas de profil.
    let echoed = echoes_of_the_room(&[vec![Some(0.91), Some(0.11)]], &[0, 2]);
    assert_eq!(
      echoed.into_iter().collect::<Vec<_>>(),
      vec![2],
      "le verdict doit nommer la voix, pas sa place dans la matrice"
    );
  }

  /// Sans casque ni parole de l'utilisateur, tout part et « Moi » n'existe pas. C'est exact :
  /// personne n'a parlé de ce côté.
  #[test]
  fn a_silent_user_leaves_no_voice_behind() {
    let echoed = echoes_of_the_room(&[vec![Some(0.09)]], &[0]);
    assert_eq!(echoed.len(), 1);
  }

  /// ⚠️ Un système muet n'écarte rien : sans voix côté système, il n'y a rien à écho.
  #[test]
  fn nothing_is_dropped_when_the_system_said_nothing() {
    assert!(echoes_of_the_room(&[], &[0, 1]).is_empty());
  }

  /// ⚠️ Une distance manquante n'est pas de l'écho : une empreinte illisible ne doit pas effacer
  /// une réplique de l'utilisateur.
  #[test]
  fn an_unmeasurable_voice_is_never_dropped() {
    let echoed = echoes_of_the_room(&[vec![None, None]], &[0, 1]);
    assert!(
      echoed.is_empty(),
      "l'absence de mesure n'est pas une preuve"
    );
  }

  /// ⚠️ Une colonne qu'aucun numéro ne nomme n'écarte personne : ne pas savoir de qui parle une
  /// mesure interdit d'agir sur elle.
  #[test]
  fn a_column_without_a_voice_number_decides_nothing() {
    let echoed = echoes_of_the_room(&[vec![Some(0.05), Some(0.05)]], &[7]);
    assert_eq!(echoed.into_iter().collect::<Vec<_>>(), vec![7]);
  }

  /// Une seule mesure lisible suffit à trancher, même si les autres manquent.
  #[test]
  fn one_readable_distance_is_enough_to_decide() {
    let echoed = echoes_of_the_room(&[vec![None], vec![Some(0.1)]], &[0]);
    assert_eq!(echoed.into_iter().collect::<Vec<_>>(), vec![0]);
  }

  /// ⚠️ Les lignes de longueurs différentes ne perdent pas de colonne : un pont qui rendrait une
  /// ligne tronquée ne doit pas faire disparaître une voix du micro sans le dire.
  #[test]
  fn a_ragged_matrix_still_examines_every_microphone_voice() {
    let echoed = echoes_of_the_room(&[vec![Some(0.9)], vec![Some(0.9), Some(0.05)]], &[0, 1]);
    assert_eq!(echoed.into_iter().collect::<Vec<_>>(), vec![1]);
  }

  /// La borne est inclusive : à distance exactement égale, c'est de l'écho. Un cas limite qui ne
  /// se rencontrera jamais en flottant, et qu'on fige pour que personne n'ait à deviner.
  #[test]
  fn the_boundary_itself_counts_as_an_echo() {
    assert_eq!(
      echoes_of_the_room(&[vec![Some(ECHO_DISTANCE)]], &[0]).len(),
      1
    );
  }
}
