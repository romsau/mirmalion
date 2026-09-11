//! La traduction, côté Rust.
//!
//! Elle passe par le Translation framework d'Apple, 100 % local, jamais par le LLM. Tout le
//! travail est en Swift, dans `native/Sources/MirmalionNative/Translation.swift`, dont
//! l'en-tête porte les mesures : les lire avant de toucher à ce module. Le trait n'est pas une
//! abstraction moteur — Apple est le seul fournisseur prévu — mais une couture de test : il
//! rend provocable l'échec « paire absente », que le vrai moteur ne produirait qu'en
//! désinstallant une paire de langues sur la machine de l'utilisateur.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas ajouter ici de seconde implémentation « réelle » : le pont et des doublures,
//!   rien d'autre.

pub mod apple;
pub mod paragraphs;
pub mod report;
pub mod texts;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// L'état d'une paire de langues sur **cette** machine.
///
/// # Pièges
///
/// - ⚠️ Trois états, pas un booléen : une paire qu'Apple sait traduire et une paire déjà
///   téléchargée ne se traitent pas pareil. La première se propose au téléchargement, la
///   seconde s'utilise, la troisième s'affiche *Indisponible* définitivement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairStatus {
  /// Utilisable immédiatement, hors ligne.
  Installed,
  /// Apple sait la traduire, mais elle **n'est pas sur la machine**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Téléchargeable ne veut pas dire téléchargée : la paire se propose, jamais ne
  ///   s'engage en silence — le réseau ne sort que sur une action explicite.
  Supported,
  /// Apple ne la traduit pas. Aucun téléchargement ne la rendra disponible.
  Unsupported,
}

/// Une paire ordonnée et son état.
///
/// # Pièges
///
/// - ⚠️ Ordonnée : `fr→ja` et `ja→fr` sont deux paires, et rien ne garantit qu'elles aient le
///   même état.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairAvailability {
  /// La langue de départ, en code du périmètre.
  pub source: String,
  /// La langue d'arrivée, en code du périmètre.
  pub target: String,
  /// L'état de cette paire sur cette machine.
  pub status: PairStatus,
}

/// Ce que la traduction sait faire sur cette machine, ici et maintenant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationAvailability {
  /// Les langues du périmètre que le framework reconnaît.
  pub languages: Vec<String>,
  /// Les paires ordonnées du périmètre, chacune avec son état.
  pub pairs: Vec<PairAvailability>,
}

impl TranslationAvailability {
  /// L'état d'une paire, ou `None` si elle n'est pas dans le périmètre.
  ///
  /// Aucun appelant applicatif à ce jour : c'est le pipeline qui l'utilisera, pour proposer un
  /// téléchargement ou afficher *Indisponible* avant même de tenter la traduction. D'où
  /// l'`expect(dead_code)` hors test, que le compilateur réclamera de retirer le jour venu.
  #[cfg_attr(not(test), expect(dead_code))]
  pub fn status(&self, source: &str, target: &str) -> Option<PairStatus> {
    self
      .pairs
      .iter()
      .find(|pair| pair.source == source && pair.target == target)
      .map(|pair| pair.status)
  }
}

/// Ce que rend une demande de traduction.
///
/// Un type somme, et pas un `Option<String>` : les deux raisons de ne pas traduire ne se
/// traitent pas pareil — l'une se propose au téléchargement, l'autre s'affiche *Indisponible*.
/// L'appelant est forcé de les distinguer, ce qui rend la proposition de téléchargement
/// structurellement non silencieuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranslationOutcome {
  /// Le texte traduit.
  Translated { text: String },
  /// La paire est téléchargeable mais absente : le signal qui fait **proposer** le
  /// téléchargement, jamais l'engager.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le texte source n'est pas perdu : l'appelant le détient toujours, et le contrat du
  ///   pipeline est d'insérer le texte non traduit plutôt que rien.
  PairMissing { source: String, target: String },
  /// Apple ne traduit pas cette paire. État *Indisponible* définitif.
  PairUnsupported { source: String, target: String },
}

/// Le contrat de la traduction, vu de Rust.
pub trait TranslationEngine: Send + Sync {
  /// L'état de chaque paire du périmètre, sans rien traduire ni télécharger.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si la matrice de disponibilité ne peut pas être lue.
  fn availability(&self) -> Result<TranslationAvailability, AppError>;

  /// Traduit `text` de `source` vers `target`, ou dit pourquoi il ne l'a pas fait.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] sur une panne seulement.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Une paire absente n'est pas une erreur : c'est une issue nominale portée par
  ///   [`TranslationOutcome`]. Les confondre affiche une erreur là où le produit doit
  ///   proposer un téléchargement.
  fn translate(
    &self,
    source: &str,
    target: &str,
    text: &str,
  ) -> Result<TranslationOutcome, AppError>;
}

#[cfg(test)]
mod tests {
  use super::{
    PairAvailability, PairStatus, TranslationAvailability, TranslationEngine, TranslationOutcome,
  };
  use crate::error::AppError;
  use std::sync::Mutex;

  /// La doublure qui justifie l'existence du trait : elle rend à volonté les trois issues et
  /// la panne, ce que le vrai moteur ne sait pas faire sans désinstaller une paire.
  #[derive(Default)]
  struct FakeEngine {
    calls: Mutex<Vec<String>>,
    outcome: Option<TranslationOutcome>,
    fails: bool,
  }

  impl TranslationEngine for FakeEngine {
    fn availability(&self) -> Result<TranslationAvailability, AppError> {
      Ok(TranslationAvailability {
        languages: vec!["fr".into(), "en".into()],
        pairs: vec![PairAvailability {
          source: "fr".into(),
          target: "en".into(),
          status: PairStatus::Installed,
        }],
      })
    }

    fn translate(
      &self,
      source: &str,
      target: &str,
      _text: &str,
    ) -> Result<TranslationOutcome, AppError> {
      if self.fails {
        return Err(AppError::Native("moteur en panne".into()));
      }
      self
        .calls
        .lock()
        .expect("verrou")
        .push(format!("{source}->{target}"));
      Ok(
        self
          .outcome
          .clone()
          .unwrap_or(TranslationOutcome::Translated {
            text: "traduit".into(),
          }),
      )
    }
  }

  /// Ce que le trait doit rendre possible : le pipeline de dictée, qui **n'insère jamais moins
  /// que du texte**. C'est la règle que la doublure existe pour vérifier.
  fn traduire_ou_garder(engine: &dyn TranslationEngine, original: &str) -> String {
    match engine.translate("fr", "en", original) {
      Ok(TranslationOutcome::Translated { text }) => text,
      // Les trois autres cas dégradent vers le texte d'origine, jamais vers rien.
      Ok(_) | Err(_) => original.to_string(),
    }
  }

  #[test]
  fn a_successful_translation_replaces_the_text() {
    let engine = FakeEngine::default();
    assert_eq!(traduire_ou_garder(&engine, "bonjour"), "traduit");
    assert_eq!(*engine.calls.lock().expect("verrou"), vec!["fr->en"]);
  }

  /// Le chemin qui ne serait **jamais** testable sans couture : une paire absente. Le
  /// provoquer sur le vrai moteur demanderait de désinstaller une paire sur la machine de
  /// l'utilisateur — ce que le produit s'interdit.
  #[test]
  fn a_missing_pair_keeps_the_untranslated_text() {
    let engine = FakeEngine {
      outcome: Some(TranslationOutcome::PairMissing {
        source: "fr".into(),
        target: "en".into(),
      }),
      ..Default::default()
    };
    assert_eq!(traduire_ou_garder(&engine, "bonjour"), "bonjour");
  }

  #[test]
  fn an_unsupported_pair_keeps_the_untranslated_text() {
    let engine = FakeEngine {
      outcome: Some(TranslationOutcome::PairUnsupported {
        source: "fr".into(),
        target: "en".into(),
      }),
      ..Default::default()
    };
    assert_eq!(traduire_ou_garder(&engine, "bonjour"), "bonjour");
  }

  /// Une panne du moteur ne fait pas perdre le texte non plus.
  #[test]
  fn a_failing_engine_keeps_the_untranslated_text() {
    let engine = FakeEngine {
      fails: true,
      ..Default::default()
    };
    assert_eq!(traduire_ou_garder(&engine, "bonjour"), "bonjour");
    assert!(engine.calls.lock().expect("verrou").is_empty());
  }

  #[test]
  fn outcomes_carry_their_kind_in_camel_case() {
    let json = serde_json::to_value(TranslationOutcome::Translated {
      text: "hello".into(),
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "translated");
    assert_eq!(json["text"], "hello");

    let json = serde_json::to_value(TranslationOutcome::PairMissing {
      source: "it".into(),
      target: "pt".into(),
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "pairMissing");
    assert_eq!(json["source"], "it");
    assert_eq!(json["target"], "pt");

    let json = serde_json::to_value(TranslationOutcome::PairUnsupported {
      source: "it".into(),
      target: "pt".into(),
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "pairUnsupported");
  }

  /// Le pont et ce module portent le même schéma, écrit deux fois. Si l'un dérive, on veut une
  /// erreur franche plutôt qu'une issue silencieusement mal interprétée.
  #[test]
  fn an_unknown_outcome_kind_is_refused_rather_than_guessed() {
    let error = serde_json::from_str::<TranslationOutcome>(r#"{"kind":"peutEtre","text":""}"#)
      .expect_err("un genre inconnu doit échouer");
    assert!(error.to_string().contains("peutEtre"), "reçu : {error}");
  }

  #[test]
  fn pair_status_round_trips_in_camel_case() {
    for (status, expected) in [
      (PairStatus::Installed, "installed"),
      (PairStatus::Supported, "supported"),
      (PairStatus::Unsupported, "unsupported"),
    ] {
      let json = serde_json::to_value(status).expect("sérialisation");
      assert_eq!(json, expected);
      let back: PairStatus = serde_json::from_value(json).expect("désérialisation");
      assert_eq!(back, status);
    }
  }

  #[test]
  fn availability_finds_a_pair_and_admits_when_it_has_none() {
    let availability = FakeEngine::default()
      .availability()
      .expect("les capacités sont toujours lisibles");
    assert_eq!(
      availability.status("fr", "en"),
      Some(PairStatus::Installed),
      "la paire déclarée doit se retrouver"
    );
    assert_eq!(
      availability.status("en", "fr"),
      None,
      "une paire absente du périmètre ne doit pas être devinée"
    );
  }
}
