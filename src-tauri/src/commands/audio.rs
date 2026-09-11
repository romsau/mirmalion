//! La capture micro : énumérer les entrées, démarrer, arrêter, savoir où l'on en est.
//!
//! Ce module **pilote** la capture, il ne la transporte pas : le flux PCM va d'`AVAudioEngine`
//! au moteur de transcription, tous deux en Swift
//! (`native/Sources/MirmalionNative/AudioCapture.swift`).
//!
//! # Pièges
//!
//! - ⚠️ Ne pas faire transiter les échantillons par Rust : ce serait une copie par tampon toutes
//!   les quelques millisecondes, sans bénéfice.
//! - ⚠️ Rien n'est écrit sur le disque, jamais : c'est une promesse produit, pas un détail
//!   d'implémentation.

use serde::{Deserialize, Serialize};

use crate::{
  blocking::off_thread,
  commands::permissions::{PermissionStatus, PermissionsStatus},
  error::AppError,
  native,
};

/// Une entrée audio de la machine, telle que le sélecteur de micro la présentera.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
  /// L'`AudioDeviceID` de Core Audio, en texte. **Opaque** : le frontend le renvoie tel quel,
  /// il n'a rien à en déduire.
  pub id: String,
  /// Le nom affiché par le sélecteur de micro.
  pub name: String,
  /// L'entrée que macOS utilise par défaut — la valeur retenue tant que l'utilisateur n'a
  /// rien choisi.
  pub is_default: bool,
}

/// Où en est la capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
  /// Le moteur de capture est monté et branché.
  pub running: bool,
  /// L'entrée **réellement** utilisée. Elle diffère de celle demandée après un repli — un
  /// périphérique débranché fait basculer sur le micro système sans interrompre la capture.
  pub device_id: Option<String>,
  /// Le nom de l'entrée réellement utilisée.
  pub device_name: Option<String>,
  /// Le nombre d'échantillons captés depuis le démarrage.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Seule preuve que le flux coule : sur un périphérique muet ou coupé au niveau matériel,
  ///   `running` vaut `true` et ce compteur reste figé. Un test de bon fonctionnement regarde le
  ///   compteur, pas le drapeau.
  pub captured_frames: u64,
  /// La fréquence d'échantillonnage du flux ouvert, en hertz.
  pub sample_rate: f64,
}

/// Les entrées audio disponibles, sans déclencher de prompt ni ouvrir de micro.
///
/// Utilisable **avant** que l'autorisation soit accordée : c'est ce qui permet au sélecteur
/// de micro de se remplir dès l'affichage de l'écran Dictée.
///
/// # Errors
///
/// Rend [`AppError::Native`] si la HAL ne répond pas ou si sa réponse est illisible.
#[tauri::command]
pub async fn list_input_devices() -> Result<Vec<InputDevice>, AppError> {
  off_thread(|| native::parse(&native::list_input_devices()?, "les entrées audio")).await
}

/// Démarre la capture ; `device_id` absent vaut micro système, relancer change de périphérique.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si le micro n'est pas autorisé, [`AppError::Native`] si le
/// pont refuse d'ouvrir le périphérique.
///
/// # Pièges
///
/// - ⚠️ La garde d'autorisation existe deux fois, et les deux comptent : ici pour rendre une
///   erreur `permission` exploitable, côté Swift pour que la règle tienne quel que soit
///   l'appelant.
#[tauri::command]
pub async fn start_capture(device_id: Option<String>) -> Result<(), AppError> {
  off_thread(move || {
    let status: PermissionsStatus =
      native::parse(&native::permissions_status()?, "les autorisations")?;
    if status.microphone.status != PermissionStatus::Granted {
      return Err(AppError::Permission(
        "le micro n'est pas autorisé : la capture ne peut pas démarrer".into(),
      ));
    }
    native::start_capture(device_id.as_deref())
  })
  .await
}

/// Arrête la capture, sans effet si rien ne tourne.
///
/// Idempotente : appelable sur un chemin d'erreur sans savoir où l'on en était.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue à démonter le moteur.
#[tauri::command]
pub async fn stop_capture() -> Result<(), AppError> {
  off_thread(native::stop_capture).await
}

/// Où en est la capture.
///
/// Voir [`CaptureStatus::captured_frames`] : c'est le champ qui dit si le flux coule vraiment.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont ne répond pas ou si sa réponse est illisible.
#[tauri::command]
pub async fn get_capture_status() -> Result<CaptureStatus, AppError> {
  off_thread(|| native::parse(&native::capture_status()?, "l'état de la capture")).await
}

#[cfg(test)]
mod tests {
  use super::{CaptureStatus, InputDevice};
  use crate::native::parse;

  /// ⚠️ **Aucun test n'ouvre le micro, et ce n'est pas un oubli.** Démarrer une capture dans
  /// `cargo test` reviendrait à enregistrer la pièce de qui lance la suite, et à faire
  /// exactement ce que la règle du priming interdit : se servir d'une ressource protégée pour
  /// voir si on y a droit. Les vingt cycles démarrage/arrêt de la definition of done sont une
  /// vérification **manuelle**, sur l'application empaquetée.
  ///
  /// Ce qui se teste ici est donc la frontière : énumération sans autorisation, lecture
  /// d'état, et refus des charges utiles mal formées.
  #[test]
  fn listing_the_inputs_never_needs_a_permission() {
    let devices = tauri::async_runtime::block_on(super::list_input_devices())
      .expect("la HAL doit répondre sans autorisation");

    // Une machine sans aucune entrée est un cas réel (Mac mini nu) : on n'exige pas qu'il y
    // en ait. Ce qu'on exige, c'est que **le défaut système soit unique** — c'est lui qui
    // sert de valeur par défaut au sélecteur de micro.
    assert!(
      devices.iter().filter(|device| device.is_default).count() <= 1,
      "il ne peut y avoir qu'une entrée par défaut"
    );
    for device in &devices {
      assert!(
        !device.id.is_empty(),
        "une entrée sans identifiant est inutilisable"
      );
      assert!(
        !device.name.is_empty(),
        "une entrée sans nom n'est pas affichable"
      );
    }
  }

  #[test]
  fn nothing_is_running_until_someone_asks() {
    let status = tauri::async_runtime::block_on(super::get_capture_status())
      .expect("l'état doit être lisible à tout moment");

    assert!(!status.running, "aucune capture ne démarre d'elle-même");
    assert_eq!(status.captured_frames, 0);
    assert_eq!(status.device_id, None);
  }

  /// Arrêter deux fois de suite ne doit rien casser : la commande est appelée sur les chemins
  /// d'erreur, où l'on ne sait pas toujours si quelque chose tournait.
  #[test]
  fn stopping_an_idle_capture_is_a_no_op() {
    for _ in 0..3 {
      tauri::async_runtime::block_on(super::stop_capture()).expect("l'arrêt doit être idempotent");
    }
  }

  #[test]
  fn serializes_in_camel_case() {
    let device = InputDevice {
      id: "42".into(),
      name: "Micro intégré".into(),
      is_default: true,
    };
    let json = serde_json::to_value(&device).expect("sérialisation");
    assert_eq!(json["isDefault"], true);

    let status = CaptureStatus {
      running: true,
      device_id: Some("42".into()),
      device_name: Some("Micro intégré".into()),
      captured_frames: 48_000,
      sample_rate: 48_000.0,
    };
    let json = serde_json::to_value(&status).expect("sérialisation");
    assert_eq!(json["capturedFrames"], 48_000);
    assert_eq!(json["sampleRate"], 48_000.0);
    assert_eq!(json["deviceId"], "42");
  }

  #[test]
  fn a_malformed_bridge_answer_becomes_a_native_error() {
    let error = parse::<Vec<InputDevice>>("{", "les entrées audio")
      .expect_err("un JSON tronqué doit échouer");
    assert_eq!(error.kind(), "native");
    assert!(
      error.to_string().contains("les entrées audio"),
      "le message doit dire ce qui n'a pas pu être lu, reçu : {error}"
    );
  }
}
