//! Le diariseur vu de Rust : une couture de test, et le pont Swift derrière.
//!
//! Le trait [`Diarizer`] rend le calibrage et l'alignement éprouvables sans média ni modèle
//! CoreML — un `extern "C"` n'est pas substituable, un trait l'est. Même motif que
//! [`crate::stt::SttEngine`] et [`crate::media::MediaInspector`].
//!
//! # Pièges
//!
//! - ⚠️ Pas de seconde implémentation « réelle » côté Rust : un autre diariseur s'ajoute côté
//!   Swift, derrière le même pont.

use serde::Deserialize;

use crate::{diarization::DiarizationSegment, error::AppError};

/// Ce que le pont rend. Miroir de `DiarizationOutcome` côté Swift.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diarization {
  /// Les intervalles attribués à une voix, dans l'ordre du média.
  pub segments: Vec<DiarizationSegment>,
  /// Le nombre de voix distinctes trouvées.
  ///
  /// Redondant avec `segments`, mais c'est lui que lit le calibrage : recompter à chaque essai
  /// referait le travail du diariseur.
  pub speakers: usize,
}

/// Comment on décide du nombre de locuteurs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeakerMode {
  /// Personne n'a rien dit : on prend le seuil de la détection automatique.
  Automatic,
  /// L'utilisateur a donné un nombre : on calibre pour l'atteindre.
  ///
  /// # Pièges
  ///
  /// - ⚠️ `Exactly(1)` n'est pas un cas dégénéré mais une commande — « ce média n'a qu'une voix,
  ///   rends-moi du texte brut ». On ne calibre alors rien du tout.
  Exactly(usize),
}

/// Ce qui sait regrouper les voix d'un média, réel ou doublé en test.
pub trait Diarizer: Send + Sync {
  /// Diarise `path` au seuil de similarité donné.
  ///
  /// # Errors
  ///
  /// Rend [`AppError`] si le pont natif échoue ou si sa réponse est illisible.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Bloquant, et le média entre entièrement en mémoire : à n'appeler que depuis
  ///   `spawn_blocking`.
  fn diarize(&self, path: &str, threshold: f64) -> Result<Diarization, AppError>;
}

/// L'implémentation réelle : le pont Swift.
pub struct NativeDiarizer;

impl Diarizer for NativeDiarizer {
  fn diarize(&self, path: &str, threshold: f64) -> Result<Diarization, AppError> {
    let json = crate::native::diarize(path, threshold)?;
    serde_json::from_str(&json)
      .map_err(|error| AppError::Native(format!("diarisation illisible : {error}")))
  }
}

/// Diarise un média selon le mode demandé, et rend ses segments de voix.
///
/// `passed` reçoit le nombre de passages déjà faits — un en détection automatique, de deux à cinq
/// pour un nombre forcé. C'est la seule information d'avancement de cette phase.
///
/// # Errors
///
/// Rend l'erreur du diariseur, y compris survenue pendant le calibrage.
///
/// # Pièges
///
/// - ⚠️ Une seule voix demandée ne lance aucune diarisation : le résultat est connu d'avance, et
///   l'alignement reçoit alors une liste vide.
pub fn analyse(
  path: &str,
  mode: SpeakerMode,
  diarizer: &dyn Diarizer,
  passed: &mut dyn FnMut(usize),
) -> Result<Vec<DiarizationSegment>, AppError> {
  let mut passes = 0;
  // ⚠️ Les voix parasites sont écartées ici, avant tout comptage, et c'est le seul endroit
  // possible : le calibrage vise un nombre de voix, filtrer plus loin le laisserait converger
  // sur un compte gonflé. Voir `super::without_slivers`.
  let mut run = |threshold: f64| -> Result<Diarization, AppError> {
    let result = diarizer.diarize(path, threshold);
    passes += 1;
    passed(passes);
    result.map(|found| {
      let segments = super::without_slivers(found.segments);
      // ⚠️ On recompte, on ne décrémente pas : le diariseur numérote ses voix comme il veut, et
      // rien ne garantit que ses identifiants soient contigus.
      let speakers = segments
        .iter()
        .map(|segment| segment.speaker)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
      Diarization { segments, speakers }
    })
  };

  match mode {
    SpeakerMode::Exactly(1) => Ok(Vec::new()),
    SpeakerMode::Automatic => Ok(run(super::AUTO_THRESHOLD)?.segments),
    SpeakerMode::Exactly(target) => {
      // ⚠️ Le calibrage rappelle le diariseur à chaque essai, et chaque essai re-regroupe le
      // média entier : d'où le budget de quatre.
      let mut failure = None;
      let calibration = super::calibrate(target, |threshold| match run(threshold) {
        Ok(result) => result.speakers,
        Err(error) => {
          // Un échec du moteur ne doit pas passer pour « zéro voix » : on le retient et on
          // laisse la recherche se terminer, plutôt que d'abandonner au milieu.
          failure.get_or_insert(error);
          0
        }
      });
      if let Some(error) = failure {
        return Err(error);
      }
      Ok(run(calibration.threshold)?.segments)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{Diarization, Diarizer, SpeakerMode, analyse};
  use crate::{diarization::DiarizationSegment, error::AppError};
  use std::sync::Mutex;

  /// Une doublure monotone, comme le vrai diariseur : plus le seuil monte, moins il rend de voix.
  struct Fake {
    asked: Mutex<Vec<f64>>,
    fails: bool,
  }

  impl Fake {
    fn new() -> Self {
      Self {
        asked: Mutex::new(Vec::new()),
        fails: false,
      }
    }
  }

  impl Diarizer for Fake {
    fn diarize(&self, _path: &str, threshold: f64) -> Result<Diarization, AppError> {
      if self.fails {
        return Err(AppError::Native("modèle absent".into()));
      }
      self.asked.lock().expect("verrou").push(threshold);
      let speakers = if threshold < 0.62 {
        6
      } else if threshold < 0.68 {
        5
      } else {
        3
      };
      Ok(Diarization {
        segments: (0..speakers)
          .map(|index| DiarizationSegment {
            speaker: u32::try_from(index).unwrap_or(u32::MAX),
            start_ms: index as u64 * 1_000,
            end_ms: index as u64 * 1_000 + 900,
          })
          .collect(),
        speakers,
      })
    }
  }

  /// Un diariseur qui rend **une voix parasite en plus**, comme le vrai le fait sur presque
  /// tous les médias : deux locuteurs d'une minute, plus un tour isolé de 1,8 s.
  struct WithSliver;

  impl Diarizer for WithSliver {
    fn diarize(&self, _path: &str, _threshold: f64) -> Result<Diarization, AppError> {
      Ok(Diarization {
        segments: vec![
          DiarizationSegment {
            speaker: 0,
            start_ms: 0,
            end_ms: 60_000,
          },
          DiarizationSegment {
            speaker: 1,
            start_ms: 60_000,
            end_ms: 120_000,
          },
          DiarizationSegment {
            speaker: 2,
            start_ms: 120_000,
            end_ms: 121_800,
          },
        ],
        speakers: 3,
      })
    }
  }

  #[test]
  fn the_voice_count_that_reaches_the_calibration_excludes_the_slivers() {
    // ⚠️ Le diariseur annonce trois voix ; la troisième tient 1,8 s. Si ce compte remontait tel
    // quel, demander deux voix ferait chercher un seuil qui en fusionne deux vraies.
    let segments =
      analyse("/tmp/x", SpeakerMode::Automatic, &WithSliver, &mut |_| {}).expect("analyse");

    assert_eq!(
      segments
        .iter()
        .map(|segment| segment.speaker)
        .collect::<std::collections::BTreeSet<_>>()
        .len(),
      2,
      "le parasite ne doit atteindre ni le compte, ni l'alignement"
    );
  }

  #[test]
  fn asking_for_one_voice_never_runs_the_model() {
    // ⚠️ Le résultat est connu d'avance ; faire tourner le modèle pour l'apprendre coûterait
    // plusieurs secondes pour rien.
    let diarizer = Fake::new();
    let segments =
      analyse("/tmp/x", SpeakerMode::Exactly(1), &diarizer, &mut |_| {}).expect("analyse");
    assert!(segments.is_empty());
    assert!(diarizer.asked.lock().expect("verrou").is_empty());
  }

  #[test]
  fn automatic_mode_runs_once_at_the_automatic_threshold() {
    let diarizer = Fake::new();
    let segments =
      analyse("/tmp/x", SpeakerMode::Automatic, &diarizer, &mut |_| {}).expect("analyse");
    assert!(!segments.is_empty());
    assert_eq!(
      *diarizer.asked.lock().expect("verrou"),
      vec![super::super::AUTO_THRESHOLD],
      "la détection automatique ne calibre pas : un seul passage"
    );
  }

  #[test]
  fn a_forced_count_calibrates_then_runs_once_more_at_the_chosen_threshold() {
    let diarizer = Fake::new();
    let segments =
      analyse("/tmp/x", SpeakerMode::Exactly(5), &diarizer, &mut |_| {}).expect("analyse");
    assert_eq!(segments.len(), 5);

    let asked = diarizer.asked.lock().expect("verrou").clone();
    assert!(asked.len() >= 2, "calibrage puis passage final : {asked:?}");
    // ⚠️ Le dernier appel rejoue le seuil **retenu** par le calibrage, il n'en cherche pas un
    // nouveau : sans cela, les segments rendus ne seraient pas ceux qu'on a validés.
    let chosen = asked.last().copied().expect("un seuil final");
    assert!(
      asked[..asked.len() - 1].contains(&chosen),
      "le seuil final doit avoir été essayé pendant le calibrage : {asked:?}"
    );
  }

  #[test]
  fn a_failing_model_surfaces_its_error_instead_of_pretending_zero_voices() {
    // ⚠️ Sans cette règle, une panne du modèle ressemblerait à « aucune voix trouvée », et le
    // calibrage chercherait indéfiniment un seuil qui n'existe pas.
    let diarizer = Fake {
      fails: true,
      ..Fake::new()
    };
    let error =
      analyse("/tmp/x", SpeakerMode::Exactly(3), &diarizer, &mut |_| {}).expect_err("erreur");
    assert_eq!(error.kind(), "native");

    let error =
      analyse("/tmp/x", SpeakerMode::Automatic, &diarizer, &mut |_| {}).expect_err("erreur");
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn the_real_diarizer_satisfies_the_contract() {
    let diarizer: &dyn Diarizer = &super::NativeDiarizer;
    let _ = diarizer;
  }
}
