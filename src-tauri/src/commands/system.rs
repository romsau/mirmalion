//! Ce dont la machine dispose : version d'OS, architecture, et l'état de chaque brique native.
//!
//! # Pièges
//!
//! - ⚠️ Le reste de l'application consomme les drapeaux d'ici, jamais un numéro de version : le
//!   jour où Apple rétroporte, retire ou renomme une brique, il y a un endroit à corriger et
//!   non cinquante conditions dispersées.
//! - ⚠️ Le schéma JSON est produit par `native/Sources/MirmalionNative/Capabilities.swift` : les
//!   deux fichiers évoluent ensemble, faute de quoi la lecture échoue en bloc.

use serde::{Deserialize, Serialize};

use crate::{error::AppError, native};

/// Variable d'environnement de simulation de socle. Voir [`simulate_stack`].
pub const FORCED_STACK_ENV: &str = "MIRMALION_FORCE_STACK";

/// La seule valeur reconnue : simule un Mac sous macOS 15–25.
const LEGACY_STACK: &str = "legacy";

/// L'état d'une brique native.
///
/// # Pièges
///
/// - ⚠️ « Présente » et « utilisable » sont deux choses différentes : un framework peut être là
///   sans que son modèle soit téléchargé. Les confondre oblige à tout reprendre au premier
///   écran qui propose un téléchargement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityStatus {
  /// La brique n'existe pas sur cet OS, ou l'utilisateur l'a désactivée.
  Unavailable,
  /// Présente, mais son modèle n'est pas encore installé.
  NeedsDownload,
  /// Utilisable tout de suite.
  Ready,
}

/// Une brique native : son état, et de quoi l'expliquer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
  /// L'état lu auprès du pont.
  pub status: CapabilityStatus,
  /// De quoi expliquer la situation à l'utilisateur. Absent quand tout va bien.
  pub detail: Option<String>,
}

impl Capability {
  /// Une brique absente, avec le motif à afficher.
  fn unavailable(detail: &str) -> Self {
    Self {
      status: CapabilityStatus::Unavailable,
      detail: Some(detail.to_owned()),
    }
  }
}

/// Ce dont la machine dispose, tel que le frontend le reçoit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCapabilities {
  /// La version de macOS, en texte.
  pub os_version: String,
  /// L'architecture du processeur, `"arm64"` sur les machines visées.
  pub architecture: String,
  /// Audio → texte natif. Absent, c'est Whisper qui prend le relais.
  pub speech_transcriber: Capability,
  /// LLM local d'Apple. Absent, c'est le LLM MLX qui prend le relais.
  pub foundation_models: Capability,
  /// Framework `Translation`, natif depuis macOS 14.4 : présent sur tout notre socle.
  pub translation: Capability,
}

/// Les simulations de socle ne sont acceptées qu'en développement.
///
/// Fonction plutôt que `cfg!` en ligne : c'est ce qui rend le comportement de production
/// vérifiable par un test exécuté, dans chaque profil, plutôt que par relecture.
fn overrides_allowed() -> bool {
  cfg!(debug_assertions)
}

/// Simule un socle macOS 15–25 sur une machine qui n'en est pas un.
///
/// `allowed` est un paramètre, et non un `cfg!` lu sur place, pour que les deux comportements
/// soient couverts par des tests.
///
/// # Pièges
///
/// - ⚠️ `Translation` n'est jamais simulé absent : le framework est natif depuis macOS 14.4,
///   donc présent sur tout le socle. Le retirer donnerait une simulation fausse.
fn simulate_stack(
  mut capabilities: SystemCapabilities,
  forced: Option<&str>,
  allowed: bool,
) -> SystemCapabilities {
  if !allowed || forced != Some(LEGACY_STACK) {
    return capabilities;
  }
  const REASON: &str = "socle macOS 15–25 simulé (MIRMALION_FORCE_STACK=legacy)";
  capabilities.speech_transcriber = Capability::unavailable(REASON);
  capabilities.foundation_models = Capability::unavailable(REASON);
  capabilities
}

/// Lit ce dont la machine dispose, simulation de socle appliquée si elle est permise.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou si sa réponse n'est pas lisible comme un
/// [`SystemCapabilities`].
#[tauri::command]
pub fn get_system_capabilities() -> Result<SystemCapabilities, AppError> {
  capabilities_with(std::env::var(FORCED_STACK_ENV).ok().as_deref())
}

/// La même lecture, la simulation reçue plutôt que lue.
///
/// # Errors
///
/// Voir [`get_system_capabilities`].
///
/// # Pièges
///
/// - ⚠️ La coupure n'est pas cosmétique : depuis l'edition 2024, poser une variable
///   d'environnement est `unsafe`, parce qu'un autre fil qui en lirait une au même instant relit
///   une zone libérée. Les tests parallèles de cargo sont exactement ce cas — passer la valeur
///   les dispense d'y toucher.
fn capabilities_with(forced: Option<&str>) -> Result<SystemCapabilities, AppError> {
  let raw = native::capabilities()?;
  let capabilities: SystemCapabilities = serde_json::from_str(&raw).map_err(|error| {
    AppError::Native(format!(
      "les capacités renvoyées par le pont sont illisibles : {error}"
    ))
  })?;

  Ok(simulate_stack(capabilities, forced, overrides_allowed()))
}

#[cfg(test)]
mod tests {
  use super::{
    Capability, CapabilityStatus, SystemCapabilities, capabilities_with, get_system_capabilities,
    overrides_allowed, simulate_stack,
  };

  fn modern_stack() -> SystemCapabilities {
    let ready = Capability {
      status: CapabilityStatus::Ready,
      detail: None,
    };
    SystemCapabilities {
      os_version: "26.5.2".into(),
      architecture: "arm64".into(),
      speech_transcriber: ready.clone(),
      foundation_models: ready.clone(),
      translation: ready,
    }
  }

  /// La chaîne complète, du pont jusqu'à la simulation, dans ses deux cas. La variable est
  /// **passée** et non posée : voir le piège de [`capabilities_with`].
  #[test]
  fn the_command_reads_the_machine_then_honours_the_environment_override() {
    let natural = capabilities_with(None).expect("le pont doit répondre");

    assert_eq!(natural.architecture, "arm64");
    assert!(natural.os_version.starts_with("26."));
    assert_eq!(natural.speech_transcriber.status, CapabilityStatus::Ready);
    assert_eq!(natural.translation.status, CapabilityStatus::Ready);
    // FoundationModels dépend d'Apple Intelligence, que l'utilisateur peut désactiver : on
    // n'exige donc pas `Ready`, seulement une réponse cohérente.
    assert!(matches!(
      natural.foundation_models.status,
      CapabilityStatus::Ready | CapabilityStatus::NeedsDownload | CapabilityStatus::Unavailable
    ));

    let forced = capabilities_with(Some("legacy")).expect("le pont doit répondre");

    if overrides_allowed() {
      assert_eq!(
        forced.speech_transcriber.status,
        CapabilityStatus::Unavailable,
        "en développement, la variable doit simuler le socle 15–25"
      );
    } else {
      assert_eq!(
        forced.speech_transcriber.status,
        CapabilityStatus::Ready,
        "en production, la variable doit être sans effet"
      );
    }
    assert_eq!(
      forced.translation.status,
      CapabilityStatus::Ready,
      "Translation n'est jamais simulé absent : il est natif depuis macOS 14.4"
    );
  }

  /// La lecture de la variable, que le test ci-dessus contourne pour rester sûr. Elle n'est
  /// éprouvée que dans un sens : ce que la machine rend d'elle-même ne dépend d'aucune
  /// simulation.
  #[test]
  fn the_command_still_goes_through_the_environment() {
    let capabilities = get_system_capabilities().expect("le pont doit répondre");
    assert_eq!(capabilities.architecture, "arm64");
    assert!(capabilities.os_version.starts_with("26."));
  }

  #[test]
  fn the_legacy_simulation_removes_the_apple_engines_but_keeps_translation() {
    let simulated = simulate_stack(modern_stack(), Some("legacy"), true);
    assert_eq!(
      simulated.speech_transcriber.status,
      CapabilityStatus::Unavailable
    );
    assert_eq!(
      simulated.foundation_models.status,
      CapabilityStatus::Unavailable
    );
    assert_eq!(
      simulated.translation.status,
      CapabilityStatus::Ready,
      "Translation est natif depuis macOS 14.4 : il est présent sur tout le socle"
    );
    assert!(
      simulated
        .speech_transcriber
        .detail
        .expect("un motif explicite")
        .contains("simulé")
    );
  }

  #[test]
  fn no_override_leaves_the_capabilities_untouched() {
    assert_eq!(simulate_stack(modern_stack(), None, true), modern_stack());
  }

  #[test]
  fn an_unknown_override_value_is_ignored() {
    assert_eq!(
      simulate_stack(modern_stack(), Some("moderne"), true),
      modern_stack()
    );
  }

  #[test]
  fn the_override_is_inert_when_it_is_not_allowed() {
    assert_eq!(
      simulate_stack(modern_stack(), Some("legacy"), false),
      modern_stack(),
      "en build de production, la simulation ne doit rien changer"
    );
  }

  /// Ces deux tests sont la preuve **exécutée** que la simulation ne franchit pas la
  /// frontière du développement. Chacun ne tourne que dans son profil, et chacun affirme une
  /// valeur en dur — pas `cfg!`, sinon l'assertion ne prouverait rien.
  #[cfg(debug_assertions)]
  #[test]
  fn overrides_are_allowed_in_a_development_build() {
    assert!(overrides_allowed());
  }

  #[cfg(not(debug_assertions))]
  #[test]
  fn overrides_are_refused_in_a_production_build() {
    assert!(!overrides_allowed());
  }

  #[test]
  fn serializes_in_camel_case() {
    let json = serde_json::to_value(modern_stack()).expect("sérialisation");
    assert_eq!(json["osVersion"], "26.5.2");
    assert_eq!(json["speechTranscriber"]["status"], "ready");
    assert_eq!(json["foundationModels"]["detail"], serde_json::Value::Null);
  }

  #[test]
  fn every_status_round_trips_through_json() {
    for (status, expected) in [
      (CapabilityStatus::Unavailable, "unavailable"),
      (CapabilityStatus::NeedsDownload, "needsDownload"),
      (CapabilityStatus::Ready, "ready"),
    ] {
      let json = serde_json::to_value(status).expect("sérialisation");
      assert_eq!(json, expected);
      assert_eq!(
        serde_json::from_value::<CapabilityStatus>(json).expect("désérialisation"),
        status
      );
    }
  }
}
