//! L'abstraction moteur de transcription, côté Rust.
//!
//! Le choix du moteur se fait là où vit l'audio, dans
//! `native/Sources/MirmalionNative/SpeechEngine.swift` : remonter le flux PCM jusqu'ici
//! coûterait une copie par tampon pour aboutir au même endroit. Ce trait-ci a un autre rôle,
//! et un seul — offrir une couture de test, pour exercer la machine à états de la dictée et
//! ses chemins d'échec sans micro ni moteur.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas ajouter ici une seconde implémentation « réelle » : un moteur s'ajoute côté
//!   Swift, derrière `TranscriptionEngine`. Ici, il n'y a que le pont et des doublures.

pub mod apple;
/// La seconde forme d'appel : une entrée fichier, une sortie de mots horodatés.
pub mod file;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Ce qu'un moteur déclare savoir faire. Miroir d'`EngineCapabilities` côté Swift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
  /// Identifiant stable du moteur — `apple`, plus tard `whisper`, `cohere`.
  pub id: String,
  /// Rend-il des partiels au fil de l'eau ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ Faux pour un moteur batch, qui reste muet jusqu'à la fin sans être en panne.
  ///   L'interface s'en sert pour choisir **ce qu'elle montre**, jamais **ce qu'elle
  ///   appelle** : les gestes sont les mêmes partout.
  pub streaming: bool,
  /// Les langues du périmètre que ce moteur couvre.
  pub locales: Vec<String>,
  /// Celles dont les ressources sont **réellement présentes sur cette machine**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ L'écart avec [`EngineCapabilities::locales`] est la règle : une langue couverte
  ///   dont les ressources manquent ne transcrit rien — le moteur démarre et reste muet.
  ///   C'est cette liste que consomme le sélecteur de langue, et elle qui dit quand proposer
  ///   un téléchargement (opération réseau explicite).
  pub installed_locales: Vec<String>,
  /// Ce qui empêche de l'utiliser tout de suite, quand quelque chose l'empêche.
  pub detail: Option<String>,
}

/// Ce qu'un moteur émet au fil d'une session.
///
/// # Pièges
///
/// - ⚠️ `Partial` remplace, il ne s'ajoute pas : le texte porté est toujours l'intégralité de
///   ce qu'il faut afficher. Concaténer les partiels répète chaque bout de phrase à chaque
///   révision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranscriptionEvent {
  /// Texte provisoire. Il y en a autant que le moteur en produit — zéro pour un moteur batch.
  Partial { text: String },
  /// Texte définitif. **Une fois et une seule** par session.
  Final { text: String },
  /// Le moteur a renoncé. Termine la session au même titre qu'un final.
  Failed { text: String },
}

/// Le contrat d'un moteur de transcription, vu de Rust.
///
/// L'alimentation en audio n'en fait pas partie : les tampons ne traversent pas le pont, ils
/// vont de la capture au moteur en Swift.
pub trait SttEngine: Send + Sync {
  /// Ce que le moteur déclare savoir faire, sans rien démarrer.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si le moteur ne peut pas être interrogé.
  fn capabilities(&self) -> Result<EngineCapabilities, AppError>;

  /// Ouvre une session de transcription dans `language`.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si la langue est hors périmètre ou la session impossible à ouvrir.
  fn start(&self, language: &str) -> Result<(), AppError>;

  /// Clôt la session et demande le texte définitif.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si la clôture échoue.
  fn finish(&self) -> Result<(), AppError>;

  /// Abandonne la session en cours.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si l'annulation échoue.
  ///
  /// # Pièges
  ///
  /// - ⚠️ `cancel` ne produit rien : une dictée abandonnée ne doit laisser ni texte, ni
  ///   évènement, ni entrée d'historique. C'est ce qui le distingue de
  ///   [`SttEngine::finish`].
  fn cancel(&self) -> Result<(), AppError>;
}

#[cfg(test)]
mod tests {
  use super::{EngineCapabilities, SttEngine, TranscriptionEvent};
  use crate::error::AppError;
  use std::sync::Mutex;

  /// La doublure qui justifie l'existence du trait.
  ///
  /// Si elle compile et se substitue au moteur réel, alors le pipeline de dictée pourra être
  /// exercé de bout en bout — y compris ses chemins d'échec — sans micro ni moteur.
  #[derive(Default)]
  struct FakeEngine {
    calls: Mutex<Vec<String>>,
    fails: bool,
  }

  impl SttEngine for FakeEngine {
    fn capabilities(&self) -> Result<EngineCapabilities, AppError> {
      Ok(EngineCapabilities {
        id: "fake".into(),
        streaming: false,
        locales: vec!["fr".into()],
        installed_locales: vec!["fr".into()],
        detail: None,
      })
    }

    fn start(&self, language: &str) -> Result<(), AppError> {
      if self.fails {
        return Err(AppError::Native("moteur en panne".into()));
      }
      self
        .calls
        .lock()
        .expect("verrou")
        .push(format!("start:{language}"));
      Ok(())
    }

    fn finish(&self) -> Result<(), AppError> {
      self.calls.lock().expect("verrou").push("finish".into());
      Ok(())
    }

    fn cancel(&self) -> Result<(), AppError> {
      self.calls.lock().expect("verrou").push("cancel".into());
      Ok(())
    }
  }

  /// Ce que le trait doit rendre possible : piloter un moteur **sans savoir lequel**.
  fn dicter(engine: &dyn SttEngine) -> Result<(), AppError> {
    engine.start("fr")?;
    engine.finish()
  }

  #[test]
  fn an_engine_is_substitutable_without_the_caller_knowing() {
    let engine = FakeEngine::default();
    dicter(&engine).expect("le pilotage doit aboutir");
    assert_eq!(
      *engine.calls.lock().expect("verrou"),
      vec!["start:fr".to_string(), "finish".to_string()]
    );
  }

  /// Le chemin qui ne serait **jamais** testable sans couture : un moteur qui refuse de
  /// démarrer. Le provoquer sur le vrai moteur demanderait de casser le micro.
  #[test]
  fn a_failing_engine_surfaces_its_error_untouched() {
    let engine = FakeEngine {
      fails: true,
      ..Default::default()
    };
    let error = dicter(&engine).expect_err("un moteur en panne doit échouer");
    assert_eq!(error.kind(), "native");
    assert!(engine.calls.lock().expect("verrou").is_empty());
  }

  /// Un moteur **batch** déclare `streaming: false`, et c'est la seule chose qui distingue
  /// Whisper d'Apple pour l'appelant. Le reste du contrat est identique.
  #[test]
  fn a_batch_engine_says_so_in_its_capabilities() {
    let capabilities = FakeEngine::default()
      .capabilities()
      .expect("les capacités sont toujours lisibles");
    assert!(!capabilities.streaming);
  }

  #[test]
  fn events_carry_their_kind_in_camel_case() {
    let partial = TranscriptionEvent::Partial {
      text: "bonjour".into(),
    };
    let json = serde_json::to_value(&partial).expect("sérialisation");
    assert_eq!(json["kind"], "partial");
    assert_eq!(json["text"], "bonjour");

    // Le pont écrit exactement cette forme : elle doit se relire sans perte.
    let from_bridge: TranscriptionEvent =
      serde_json::from_str(r#"{"kind":"final","text":"bonjour"}"#).expect("désérialisation");
    assert_eq!(
      from_bridge,
      TranscriptionEvent::Final {
        text: "bonjour".into()
      }
    );
  }

  #[test]
  fn an_unknown_event_kind_is_refused_rather_than_guessed() {
    // Le pont et ce module portent le même schéma, écrit deux fois. Si l'un dérive, on veut
    // une erreur franche plutôt qu'un évènement silencieusement ignoré.
    let error = serde_json::from_str::<TranscriptionEvent>(r#"{"kind":"peutEtre","text":""}"#)
      .expect_err("un genre inconnu doit échouer");
    assert!(error.to_string().contains("peutEtre"), "reçu : {error}");
  }
}
