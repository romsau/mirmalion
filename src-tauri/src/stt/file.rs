//! La seconde forme d'appel du moteur de transcription : une entrée fichier.
//!
//! [`crate::stt::SttEngine`] décrit un moteur de flux, qu'un tiers alimente. Un fichier n'a
//! rien de tout cela : une fin connue d'avance, une position à tout instant, et ce qu'on lui
//! demande n'est pas du texte mais des mots horodatés, sans quoi les sous-titres n'existent
//! pas. La polymorphie reste côté Swift ; ce trait-ci n'a qu'un rôle, offrir une couture de
//! test — progression, annulation et conversion des mots s'éprouvent sans média ni moteur.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas ajouter ici de seconde implémentation « réelle » : un moteur s'ajoute côté
//!   Swift. Ici, il n'y a que le pont et des doublures.

use serde::Deserialize;

use crate::{error::AppError, transcript::Word};

/// Ce qu'une transcription de fichier rend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscript {
  /// Les mots, horodatés, dans l'ordre.
  pub words: Vec<Word>,
  /// La durée du média — utile pour borner les repères de sous-titres.
  pub duration_ms: u64,
}

/// Le contrat d'un moteur de transcription de fichier.
pub trait FileSttEngine: Send + Sync {
  /// Transcrit `path` dans `locale` ; `progress` reçoit l'avancement de `0.0` à `1.0` et
  /// rend `false` pour interrompre.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Cancelled`] sur interruption, une autre [`AppError`] si le média est
  /// illisible ou le moteur en échec.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Bloquant, et longuement : à n'appeler que depuis `spawn_blocking`.
  /// - ⚠️ Mesure et sortie au même point : sinon la boucle ne serait pas interruptible.
  fn transcribe(
    &self,
    path: &str,
    locale: &str,
    progress: &mut dyn FnMut(f64) -> bool,
  ) -> Result<FileTranscript, AppError>;
}

/// L'implémentation réelle : le pont Swift.
pub struct AppleFileEngine;

impl FileSttEngine for AppleFileEngine {
  /// Transcrit le média par le pont Swift et relit sa réponse JSON.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si le pont échoue, ou [`AppError::Native`] si sa réponse ne se
  /// relit pas en [`FileTranscript`].
  fn transcribe(
    &self,
    path: &str,
    locale: &str,
    progress: &mut dyn FnMut(f64) -> bool,
  ) -> Result<FileTranscript, AppError> {
    let json = crate::native::file_transcribe(path, locale, progress)?;
    serde_json::from_str(&json)
      .map_err(|error| AppError::Native(format!("transcription de fichier illisible : {error}")))
  }
}

#[cfg(test)]
mod tests {
  use super::{AppleFileEngine, FileSttEngine, FileTranscript};
  use crate::{error::AppError, transcript::Word};
  use std::sync::Mutex;

  /// La doublure qui justifie l'existence du trait : elle déroule une progression choisie,
  /// sans qu'aucun média n'ait à exister.
  struct Fake {
    steps: Vec<f64>,
    seen: Mutex<Vec<f64>>,
  }

  impl FileSttEngine for Fake {
    fn transcribe(
      &self,
      _path: &str,
      _locale: &str,
      progress: &mut dyn FnMut(f64) -> bool,
    ) -> Result<FileTranscript, AppError> {
      for step in &self.steps {
        self.seen.lock().expect("verrou").push(*step);
        if !progress(*step) {
          return Err(AppError::Cancelled("transcription interrompue".into()));
        }
      }
      Ok(FileTranscript {
        words: vec![Word {
          text: "bonjour".into(),
          start_ms: 0,
          end_ms: 400,
        }],
        duration_ms: 400,
      })
    }
  }

  fn fake(steps: &[f64]) -> Fake {
    Fake {
      steps: steps.to_vec(),
      seen: Mutex::new(Vec::new()),
    }
  }

  #[test]
  fn an_engine_reports_its_progress_all_the_way_through() {
    let engine = fake(&[0.25, 0.5, 1.0]);
    let mut seen = Vec::new();
    let transcript = engine
      .transcribe("/tmp/x.mp4", "fr", &mut |ratio| {
        seen.push(ratio);
        true
      })
      .expect("transcription");

    assert_eq!(seen, vec![0.25, 0.5, 1.0]);
    assert_eq!(transcript.duration_ms, 400);
    assert_eq!(transcript.words.len(), 1);
  }

  #[test]
  fn refusing_to_continue_stops_the_work_rather_than_hiding_it() {
    // ⚠️ Ce que ce test fige : l'annulation **interrompt**. Un moteur qui continuerait à
    // dérouler le média après un `false` laisserait un cœur tourner pour rien, et l'écran
    // mentirait en annonçant l'arrêt.
    let engine = fake(&[0.1, 0.2, 0.3, 1.0]);
    let error = engine
      .transcribe("/tmp/x.mp4", "fr", &mut |ratio| ratio < 0.25)
      .expect_err("l'annulation doit remonter");

    assert_eq!(error.kind(), "cancelled");
    assert_eq!(
      *engine.seen.lock().expect("verrou"),
      vec![0.1, 0.2, 0.3],
      "le travail s'arrête SUR le refus — la mesure refusée a bien eu lieu, la suivante non"
    );
  }

  #[test]
  fn a_cancellation_is_not_a_failure() {
    // Elle a son propre discriminant : l'interface ne doit pas l'afficher en snackbar d'erreur.
    let engine = fake(&[0.5]);
    let error = engine
      .transcribe("/tmp/x.mp4", "fr", &mut |_| false)
      .expect_err("annulation");
    assert_ne!(error.kind(), "native");
    assert_eq!(error.kind(), "cancelled");
  }

  #[test]
  fn the_bridge_contract_is_camel_case_and_refuses_what_it_cannot_read() {
    let parsed: FileTranscript = serde_json::from_str(
      r#"{"words":[{"text":"bonjour","startMs":0,"endMs":400}],"durationMs":400}"#,
    )
    .expect("désérialisation");
    assert_eq!(parsed.words[0].start_ms, 0);
    assert_eq!(parsed.words[0].end_ms, 400);

    // Le pont et ce module portent le même schéma, écrit deux fois : si l'un dérive, on veut
    // une erreur franche plutôt qu'un transcript silencieusement vide.
    assert!(serde_json::from_str::<FileTranscript>(r#"{"words":[]}"#).is_err());
  }

  /// Le moteur réel existe et se substitue au trait — le vérifier ici évite qu'une signature
  /// diverge sans que rien ne le dise avant la première transcription réelle.
  #[test]
  fn the_real_engine_satisfies_the_contract() {
    let engine: &dyn FileSttEngine = &AppleFileEngine;
    let _ = engine;
  }
}
