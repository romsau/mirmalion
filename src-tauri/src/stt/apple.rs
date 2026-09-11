//! Le moteur d'Apple, vu de Rust : un adaptateur, et rien de plus.
//!
//! Tout le travail est en Swift (`SpeechEngine.swift`) ; ce fichier traverse le pont et
//! retype.
//!
//! # Pièges
//!
//! - ⚠️ Ce module doit rester mince : s'il grossit, c'est que de la logique a glissé du
//!   mauvais côté du pont.

use super::{EngineCapabilities, SttEngine};
use crate::{error::AppError, native};

/// `SpeechTranscriber` d'Apple, en flux, sur les 6 langues du périmètre.
///
/// Sans état propre : la session vit côté Swift, dans `SpeechSession`.
///
/// # Pièges
///
/// - ⚠️ Deux instances de cette structure pilotent la **même** session Swift. C'est correct
///   ici parce que la dictée est mono-source ; toute évolution vers plusieurs sessions
///   simultanées doit d'abord donner une identité de session au pont.
#[derive(Debug, Default, Clone, Copy)]
pub struct AppleEngine;

impl SttEngine for AppleEngine {
  /// Les capacités déclarées par le moteur Swift, sans démarrer de session.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Native`] si le pont échoue ou rend un JSON illisible.
  fn capabilities(&self) -> Result<EngineCapabilities, AppError> {
    parse(&native::stt_capabilities()?)
  }

  /// Ouvre une session de dictée dans `language`.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Native`] si la langue est hors périmètre ou si la session refuse de
  /// s'ouvrir.
  fn start(&self, language: &str) -> Result<(), AppError> {
    native::stt_start(language)
  }

  /// Clôt la session en cours et demande le texte définitif.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Native`] si le pont refuse la clôture.
  fn finish(&self) -> Result<(), AppError> {
    native::stt_finish()
  }

  /// Abandonne la session en cours sans rien produire.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Native`] si le pont refuse l'annulation.
  fn cancel(&self) -> Result<(), AppError> {
    native::stt_cancel()
  }
}

/// Relit la réponse JSON du pont en [`EngineCapabilities`].
///
/// # Errors
///
/// Rend [`AppError::Native`] si `raw` n'est pas du JSON conforme au schéma.
fn parse(raw: &str) -> Result<EngineCapabilities, AppError> {
  native::parse(raw, "les capacités du moteur")
}

#[cfg(test)]
mod tests {
  use super::{AppleEngine, parse};
  use crate::stt::SttEngine;

  /// Les capacités se lisent **sans rien démarrer** : aucun micro, aucune session, aucun
  /// prompt. C'est ce qui permet à l'interface de savoir si elle doit promettre des partiels
  /// avant même que l'utilisateur ait parlé.
  #[test]
  fn reading_the_capabilities_starts_nothing() {
    let capabilities = AppleEngine
      .capabilities()
      .expect("le pont doit répondre sans démarrer de session");

    assert_eq!(capabilities.id, "apple");
    assert!(
      capabilities.streaming,
      "le moteur d'Apple rend des partiels — c'est ce qui le distingue de Whisper"
    );
  }

  /// La langue est validée **côté Swift**, au plus près du moteur : une langue hors des 9 ne
  /// doit jamais atteindre `SpeechTranscriber`.
  #[test]
  fn a_language_outside_the_scope_is_refused_before_any_session_starts() {
    let error = AppleEngine
      .start("nl")
      .expect_err("le néerlandais est hors des six langues du périmètre");
    assert!(error.to_string().contains("nl"), "reçu : {error}");
  }

  /// Annuler sans avoir démarré ne casse rien : la commande est appelée sur des chemins
  /// d'erreur, où l'on ne sait pas toujours si une session existait.
  #[test]
  fn cancelling_an_idle_session_is_a_no_op() {
    for _ in 0..3 {
      AppleEngine
        .cancel()
        .expect("l'annulation doit être idempotente");
    }
  }

  #[test]
  fn a_malformed_bridge_answer_becomes_a_native_error() {
    let error = parse("{").expect_err("un JSON tronqué doit échouer");
    assert_eq!(error.kind(), "native");
  }
}
