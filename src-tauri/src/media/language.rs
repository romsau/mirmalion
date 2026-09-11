//! La langue parlée d'un média, décidée **avant** de le transcrire.
//!
//! Aucun réglage à l'import : la langue se **détecte**, et l'écran l'annonce en toutes lettres.
//! Ce module joint la brique, valide ce qu'elle rend, et le type.
//!
//! # Pièges
//!
//! - ⚠️ Aucune API Apple n'identifie une langue *parlée* : la méthode est à nous, dans
//!   `LanguageDetection.swift`, et elle coûte une transcription d'échantillon par langue
//!   installée.
//! - ⚠️ Un verdict indécis n'est pas une `Err` : « aucune parole », « langue inconnue » et
//!   « aucune langue installée » sont des réponses, avec leur motif. Une `Err` d'ici veut dire
//!   que la brique native est cassée.
//! - ⚠️ Le motif voyage en **code**, jamais en phrase : l'interface est localisée au build, et une
//!   phrase écrite ici sortirait en français sur un écran allemand.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Pourquoi la langue n'a pas pu être décidée.
///
/// # Pièges
///
/// - ⚠️ Les quatre cas demandent quatre gestes différents, d'où le refus de les fondre : sans
///   parole il n'y a rien à transcrire, trop court veut dire « choisissez la langue vous-même »,
///   langue inconnue veut dire « installez-la », aucune langue installée « installez-en une ».
///   Un message unique laisserait l'utilisateur sans issue dans trois cas sur quatre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LanguageProblem {
  /// Le média ne porte aucune parole exploitable.
  NoSpeech,
  /// Il y a de la parole, mais dans aucune des langues installées.
  UnsupportedLanguage,
  /// Il y a de la parole, mais trop peu pour trancher.
  TooShort,
  /// Aucune des six langues n'a ses ressources sur cette machine.
  NoInstalledLanguage,
}

/// Le verdict de détection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LanguageDetection {
  /// La langue parlée, en étiquette primaire (`fr`, `en`…).
  Detected { language: String },
  /// La langue n'a pas pu être décidée, et voici pourquoi.
  Undecided { problem: LanguageProblem },
}

/// Ce que le pont natif rend, mot pour mot. Miroir de `LanguageVerdict` côté Swift.
///
/// `confidence` et `tried` ne sont pas repris : ils servent aux mesures, pas à l'interface, qui
/// n'a qu'une décision à prendre — transcrire, ou dire pourquoi non.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeVerdict {
  language: Option<String>,
  problem: Option<String>,
}

/// L'appel à la brique, isolé derrière un trait.
///
/// # Pièges
///
/// - ⚠️ Même motif que [`super::MediaInspector`] : une couture de test, et rien d'autre. Les
///   trois indécisions doivent être éprouvées une par une, et il faudrait trois médias réels —
///   dont un dans une langue non installée — pour y arriver autrement. Ne pas y ajouter de
///   seconde implémentation réelle.
pub trait LanguageDetector: Send + Sync {
  /// Rend le JSON du verdict de langue.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si la brique native a échoué.
  fn detect(&self, path: &str) -> Result<String, AppError>;
}

/// L'implémentation réelle : le pont Swift.
pub struct NativeDetector;

impl LanguageDetector for NativeDetector {
  fn detect(&self, path: &str) -> Result<String, AppError> {
    crate::native::detect_language(path)
  }
}

/// Décide de la langue d'un média, ou dit pourquoi elle ne se décide pas.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou rend un verdict hors contrat.
///
/// # Pièges
///
/// - ⚠️ Un code de problème inconnu est une `Err`, pas un repli : un repli silencieux
///   transformerait une désynchronisation Swift/Rust en comportement plausible.
/// - ⚠️ Le portier `crate::i18n::known` est écrit pour les langues d'**interface** : le partage
///   est une économie, pas une identité, à revoir si les deux ensembles divergent.
pub fn detect(path: &str, detector: &dyn LanguageDetector) -> Result<LanguageDetection, AppError> {
  let json = detector.detect(path)?;
  let verdict: NativeVerdict = serde_json::from_str(&json)
    .map_err(|error| AppError::Native(format!("verdict de langue illisible : {error}")))?;

  if let Some(problem) = verdict.problem.as_deref() {
    return Ok(LanguageDetection::Undecided {
      problem: problem_of(problem)?,
    });
  }

  let language = verdict
    .language
    .ok_or_else(|| AppError::Native("verdict de langue sans langue ni motif".into()))?;
  let known = crate::i18n::known(&language)
    .ok_or_else(|| AppError::Native("langue détectée hors des neuf".into()))?;

  Ok(LanguageDetection::Detected {
    language: known.to_string(),
  })
}

/// Le motif natif, traduit en variante. Voir l'avertissement de [`detect`].
fn problem_of(code: &str) -> Result<LanguageProblem, AppError> {
  match code {
    "noSpeech" => Ok(LanguageProblem::NoSpeech),
    "unsupportedLanguage" => Ok(LanguageProblem::UnsupportedLanguage),
    "tooShort" => Ok(LanguageProblem::TooShort),
    "noInstalledLanguage" => Ok(LanguageProblem::NoInstalledLanguage),
    other => Err(AppError::Native(format!(
      "motif de détection inconnu : {other}"
    ))),
  }
}

#[cfg(test)]
mod tests {
  use super::{LanguageDetection, LanguageDetector, LanguageProblem, detect};
  use crate::error::AppError;

  struct Fixed(&'static str);

  impl LanguageDetector for Fixed {
    fn detect(&self, _path: &str) -> Result<String, AppError> {
      Ok(self.0.to_string())
    }
  }

  struct Broken;

  impl LanguageDetector for Broken {
    fn detect(&self, _path: &str) -> Result<String, AppError> {
      Err(AppError::Native("pont cassé".into()))
    }
  }

  fn verdict(json: &'static str) -> Result<LanguageDetection, AppError> {
    detect("média", &Fixed(json))
  }

  #[test]
  fn a_recognised_language_comes_back_typed() {
    assert_eq!(
      verdict(r#"{"language":"en","problem":null,"confidence":0.98,"tried":["fr","en"]}"#).unwrap(),
      LanguageDetection::Detected {
        language: "en".into()
      }
    );
  }

  #[test]
  fn the_four_indecisions_are_answers_not_failures() {
    for (code, expected) in [
      ("noSpeech", LanguageProblem::NoSpeech),
      ("unsupportedLanguage", LanguageProblem::UnsupportedLanguage),
      ("tooShort", LanguageProblem::TooShort),
      ("noInstalledLanguage", LanguageProblem::NoInstalledLanguage),
    ] {
      let json: &'static str = Box::leak(
        format!(r#"{{"language":null,"problem":"{code}","confidence":0,"tried":[]}}"#)
          .into_boxed_str(),
      );
      assert_eq!(
        verdict(json).unwrap(),
        LanguageDetection::Undecided { problem: expected },
        "{code}"
      );
    }
  }

  #[test]
  fn an_unknown_problem_code_is_a_bridge_fault() {
    // ⚠️ Le jour où Swift renomme un motif sans prévenir Rust, cela doit se voir tout de
    // suite — pas se replier sur un « indécis » plausible.
    let error = verdict(r#"{"language":null,"problem":"whatever"}"#).unwrap_err();
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn a_language_outside_the_nine_is_a_bridge_fault() {
    let error = verdict(r#"{"language":"nl","problem":null}"#).unwrap_err();
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn a_verdict_with_neither_language_nor_problem_is_a_bridge_fault() {
    let error = verdict(r#"{"language":null,"problem":null}"#).unwrap_err();
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn unreadable_json_is_a_bridge_fault() {
    let error = verdict("pas du json").unwrap_err();
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn a_broken_bridge_propagates() {
    let error = detect("média", &Broken).unwrap_err();
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn a_regional_variant_is_reduced_to_its_language() {
    // `installedLocales` rend des locales complètes — `es_MX` désigne bien l'espagnol.
    assert_eq!(
      verdict(r#"{"language":"es_MX","problem":null}"#).unwrap(),
      LanguageDetection::Detected {
        language: "es".into()
      }
    );
  }
}
