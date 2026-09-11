//! Le Translation framework d'Apple, vu de Rust : un adaptateur, et rien de plus.
//!
//! Tout le travail est en Swift (`Translation.swift`) ; ce fichier traverse le pont et retype.
//!
//! # Pièges
//!
//! - ⚠️ Appeler depuis un fil de fond, jamais depuis le fil principal : le framework livre ses
//!   continuations par la boucle d'exécution principale et le pont attend sur un sémaphore.
//!   Bloquer le fil principal fige le processus pour de bon — `spawn_blocking` est
//!   obligatoire. Détail dans l'en-tête de `Translation.swift`, point 5.
//! - ⚠️ Ce module doit rester mince : s'il grossit, de la logique a glissé du mauvais côté.

use super::{TranslationAvailability, TranslationEngine, TranslationOutcome};
use crate::{error::AppError, native};

/// Le framework `Translation` d'Apple, 100 % local, sur les 6 langues du périmètre.
///
/// Sans état propre : chaque traduction crée sa session côté Swift et la laisse mourir. Il n'y
/// a rien à conserver entre deux appels — une session ne porte que sa paire de langues.
#[derive(Debug, Default, Clone, Copy)]
pub struct AppleTranslator;

impl TranslationEngine for AppleTranslator {
  /// La matrice des paires du périmètre, telle que le pont la déclare.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si le pont échoue, ou [`AppError::Native`] si sa réponse est
  /// illisible.
  fn availability(&self) -> Result<TranslationAvailability, AppError> {
    parse(&native::translation_availability()?)
  }

  /// Traduit `text` par le pont Swift et relit son issue.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::InvalidArgument`] sur un argument vide ou porteur d'un octet nul, une
  /// autre [`AppError`] si le pont échoue ou répond de façon illisible.
  fn translate(
    &self,
    source: &str,
    target: &str,
    text: &str,
  ) -> Result<TranslationOutcome, AppError> {
    parse(&native::translate(source, target, text)?)
  }
}

/// Relit une réponse du pont.
///
/// Le schéma est écrit deux fois, ici et en Swift : une dérive doit produire une erreur
/// franche, jamais une valeur devinée.
///
/// # Errors
///
/// Rend [`AppError::Native`] si `raw` ne se relit pas en `T`.
fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, AppError> {
  native::parse(raw, "la traduction")
}

#[cfg(test)]
mod tests {
  use super::{AppleTranslator, parse};
  use crate::translation::{TranslationAvailability, TranslationEngine, TranslationOutcome};

  // ⚠️ Aucun test d'ici n'atteint le framework Translation : sous `cargo test`, le fil
  // principal attend ses fils de test, donc aucune boucle d'exécution ne délivre les
  // continuations et l'appel bloque. Ce qui manque est une boucle principale vivante — celle
  // d'AppKit dans l'app Tauri suffit ; le bundle signé n'y change rien. Reste donc testable
  // ici tout ce qui se décide avant le framework : arguments, paire identité, relecture des
  // réponses du pont. La dégradation du pipeline est couverte par la doublure de
  // `crate::translation`.

  /// Traduire vers la langue de départ rend le texte inchangé **sans appeler le framework** —
  /// ce qui est aussi la raison pour laquelle ce test ne se bloque pas.
  ///
  /// Cas nominal du pipeline quand l'utilisateur dicte déjà dans la langue cible.
  #[test]
  fn translating_into_the_source_language_returns_the_text_untouched() {
    let outcome = AppleTranslator
      .translate("fr", "fr", "Bonjour, ceci est un essai.")
      .expect("la paire identité ne doit jamais échouer");
    assert_eq!(
      outcome,
      TranslationOutcome::Translated {
        text: "Bonjour, ceci est un essai.".into()
      }
    );
  }

  /// Une langue hors des 9 est refusée **côté Swift**, avant toute session — au plus près du
  /// framework, comme la garde équivalente du STT.
  #[test]
  fn a_language_outside_the_scope_is_refused() {
    let error = AppleTranslator
      .translate("nl", "fr", "Hallo.")
      .expect_err("le néerlandais est hors des six langues du périmètre");
    assert!(error.to_string().contains("nl"), "reçu : {error}");

    let error = AppleTranslator
      .translate("fr", "tr", "Bonjour.")
      .expect_err("le turc est hors périmètre");
    assert!(error.to_string().contains("tr"), "reçu : {error}");
  }

  /// Un argument vide est refusé **côté Rust**, avant même de traverser le pont.
  #[test]
  fn an_empty_argument_is_refused_before_crossing_the_bridge() {
    for (source, target, text) in [
      ("", "en", "Bonjour."),
      ("fr", "", "Bonjour."),
      ("fr", "en", ""),
    ] {
      let error = AppleTranslator
        .translate(source, target, text)
        .expect_err("un argument vide doit être refusé");
      assert_eq!(error.kind(), "invalidArgument", "reçu : {error}");
    }
  }

  /// Un octet nul ne peut pas traverser une chaîne C : il est refusé, pas tronqué.
  #[test]
  fn an_interior_nul_is_refused_rather_than_truncated() {
    let error = AppleTranslator
      .translate("fr", "en", "avant\0après")
      .expect_err("un octet nul doit être refusé");
    assert_eq!(error.kind(), "invalidArgument");
  }

  #[test]
  fn a_malformed_bridge_answer_becomes_a_native_error() {
    let error = parse::<TranslationAvailability>("{").expect_err("un JSON tronqué doit échouer");
    assert_eq!(error.kind(), "native");

    let error =
      parse::<TranslationOutcome>(r#"{"kind":"peutEtre"}"#).expect_err("un genre inconnu échoue");
    assert_eq!(error.kind(), "native");
  }

  /// Les réponses que le pont écrit réellement doivent se relire **sans perte**. C'est le seul
  /// garde-fou contre une dérive entre le schéma Swift et le schéma Rust, puisque le framework
  /// lui-même n'est pas joignable d'ici.
  #[test]
  fn the_shapes_the_bridge_writes_are_read_back_faithfully() {
    let outcome: TranslationOutcome =
      parse(r#"{"kind":"translated","text":"Hello"}"#).expect("issue traduite");
    assert_eq!(
      outcome,
      TranslationOutcome::Translated {
        text: "Hello".into()
      }
    );

    let outcome: TranslationOutcome =
      parse(r#"{"kind":"pairMissing","source":"it","target":"pt"}"#).expect("paire absente");
    assert_eq!(
      outcome,
      TranslationOutcome::PairMissing {
        source: "it".into(),
        target: "pt".into()
      }
    );

    let outcome: TranslationOutcome =
      parse(r#"{"kind":"pairUnsupported","source":"it","target":"pt"}"#).expect("paire absente");
    assert_eq!(
      outcome,
      TranslationOutcome::PairUnsupported {
        source: "it".into(),
        target: "pt".into()
      }
    );

    let availability: TranslationAvailability = parse(
      r#"{"languages":["fr","en"],"pairs":[{"source":"fr","target":"en","status":"installed"}]}"#,
    )
    .expect("matrice");
    assert_eq!(availability.languages, vec!["fr", "en"]);
    assert_eq!(availability.pairs.len(), 1);
    assert_eq!(
      availability.status("fr", "en"),
      Some(crate::translation::PairStatus::Installed)
    );
  }

  /// ⚠️ Le message d'erreur ne doit **jamais** contenir le texte de l'utilisateur.
  #[test]
  fn a_parse_error_never_leaks_the_payload() {
    let secret = "rendez-vous confidentiel a dix-sept heures";
    let error = parse::<TranslationOutcome>(&format!(r#"{{"kind":"translated","text":"{secret}"#))
      .expect_err("un JSON tronqué doit échouer");
    assert!(
      !error.to_string().contains(secret),
      "le contenu utilisateur a fui dans le message : {error}"
    );
  }
}
