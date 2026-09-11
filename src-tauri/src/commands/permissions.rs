//! Les autorisations macOS (TCC) : lire leur état, et les demander.
//!
//! Ce module ne fait que traduire ; la règle se tient côté Swift, dans
//! `native/Sources/MirmalionNative/Permissions.swift`.
//!
//! # Pièges
//!
//! - ⚠️ Une lecture ne demande jamais rien : seules les commandes `request_*` font surgir un
//!   pop-up système, et seulement sur un geste explicite de l'utilisateur.
//! - ⚠️ Le schéma JSON est écrit deux fois, ici et en Swift : les deux fichiers évoluent
//!   ensemble, faute de quoi le pont rend un état que ce module refuse de relire.

use serde::{Deserialize, Serialize};

use crate::{blocking::off_thread, error::AppError, native};

/// L'état d'une autorisation.
///
/// # Pièges
///
/// - ⚠️ [`PermissionStatus::Unknown`] n'est pas du remplissage : il dit que macOS ne permet pas
///   de savoir sans déclencher l'opération elle-même. Le confondre avec `Denied` afficherait
///   « refusé » à qui n'a rien refusé ; avec `NotDetermined`, cela promettrait un prompt qu'on
///   ne sait pas déclencher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
  /// Accordée : la fonction qui en dépend peut s'exécuter.
  Granted,
  /// Refusée. ⚠️ **Aucune API ne peut la re-demander** — il faut les Réglages Système.
  Denied,
  /// Jamais demandée. Le **seul** état où un prompt peut encore partir.
  NotDetermined,
  /// macOS n'expose pas cet état sans déclencher l'opération elle-même.
  Unknown,
}

/// Une autorisation : son état, et de quoi l'expliquer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
  /// L'état lu auprès de macOS.
  pub status: PermissionStatus,
  /// De quoi expliquer la situation à l'utilisateur. Absent quand il n'y a rien à dire.
  pub detail: Option<String>,
}

/// Les quatre autorisations dont l'application dépend, lues d'un seul coup.
///
/// D'un seul coup et non une par une : l'écran d'autorisations les affiche ensemble, et son
/// bouton « Revérifier » les re-scanne toutes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsStatus {
  /// Capter la voix pour la dictée.
  pub microphone: Permission,
  /// Détecter le raccourci global (`CGEventTap`), et coller au curseur.
  ///
  /// ⚠️ Attachée à la signature de code : une re-signature l'invalide, et l'utilisateur doit
  /// la réaccorder.
  pub accessibility: Permission,
  /// Piloter System Events par Apple Events — la voie éprouvée du collage au curseur.
  ///
  /// Absente de l'onboarding : elle se demande au premier collage réel.
  pub automation: Permission,
  /// Capter l'audio des sessions via Core Audio Process Taps.
  ///
  /// ⚠️ Ce n'est pas l'enregistrement de l'écran, c'est une catégorie TCC distincte. Écrire
  /// « écran » enverrait l'utilisateur dans le mauvais volet des Réglages Système.
  pub audio_capture: Permission,
}

/// L'état des quatre autorisations, sans déclencher aucun prompt.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si le pont échoue, [`AppError::Native`] sur réponse illisible.
///
/// # Pièges
///
/// - ⚠️ À rappeler à chaque « Revérifier » : l'Accessibilité et l'Enregistrement audio
///   s'accordent hors de l'application, donc un état lu au démarrage est faux dès que
///   l'utilisateur bascule un interrupteur dans les Réglages Système.
#[tauri::command]
pub async fn get_permissions_status() -> Result<PermissionsStatus, AppError> {
  off_thread(|| native::parse(&native::permissions_status()?, "les autorisations")).await
}

/// Demande l'accès au micro et renvoie l'état obtenu.
///
/// Si l'état n'est plus [`PermissionStatus::NotDetermined`], aucun prompt ne part et l'état
/// courant est renvoyé tel quel.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si le pont échoue, [`AppError::Native`] sur réponse illisible.
///
/// # Pièges
///
/// - ⚠️ N'appeler qu'au clic explicite de l'utilisateur sur « Autoriser » : c'est un pop-up
///   système qui surgit.
#[tauri::command]
pub async fn request_microphone() -> Result<Permission, AppError> {
  off_thread(|| native::parse(&native::request_microphone()?, "le micro")).await
}

/// Demande l'enregistrement audio et renvoie l'état obtenu.
///
/// Une fois le choix fait, macOS ne réaffiche rien : rappeler cette commande rend le verdict
/// sans importuner personne, ce qui permet à « Revérifier » d'être honnête.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si le pont échoue, [`AppError::Native`] sur réponse illisible.
///
/// # Pièges
///
/// - ⚠️ N'appeler qu'au clic explicite de l'utilisateur : cette catégorie TCC n'a aucune API de
///   préflight, la seule façon de la demander est de créer un tap audio.
#[tauri::command]
pub async fn request_audio_capture() -> Result<Permission, AppError> {
  off_thread(|| native::parse(&native::request_audio_capture()?, "l'enregistrement audio")).await
}

/// Demande l'Accessibilité : inscrit l'application dans la liste, puis ouvre le volet.
///
/// L'état renvoyé est celui d'**avant** que l'utilisateur ne coche.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si le pont échoue, [`AppError::Native`] sur réponse illisible.
///
/// # Pièges
///
/// - ⚠️ Sans `AXIsProcessTrustedWithOptions`, l'utilisateur ouvre le volet et n'y trouve aucune
///   case à son nom. Réservé à ce chemin : [`get_permissions_status`] emploie la variante sans
///   options, qui n'inscrit rien.
#[tauri::command]
pub async fn request_accessibility() -> Result<Permission, AppError> {
  off_thread(|| native::parse(&native::request_accessibility()?, "l'accessibilité")).await
}

#[cfg(test)]
mod tests {
  use super::{Permission, PermissionStatus, PermissionsStatus, get_permissions_status};
  use crate::native::parse;

  fn sample() -> PermissionsStatus {
    PermissionsStatus {
      microphone: Permission {
        status: PermissionStatus::Granted,
        detail: None,
      },
      accessibility: Permission {
        status: PermissionStatus::NotDetermined,
        detail: Some("s'accorde dans les Réglages Système".into()),
      },
      automation: Permission {
        status: PermissionStatus::Denied,
        detail: Some("refusée".into()),
      },
      audio_capture: Permission {
        status: PermissionStatus::Unknown,
        detail: Some("macOS n'expose pas cet état".into()),
      },
    }
  }

  /// La vérification qui compte le plus de ce module : **lire l'état ne demande rien**.
  ///
  /// Un test ne peut pas prouver l'absence de pop-up — il faudrait un œil humain. Ce qu'il
  /// prouve, c'est que l'appel **rend la main** : s'il attendait une réponse à un prompt,
  /// la suite de tests ne se terminerait jamais. C'est un contrôle partiel, et la
  /// vérification complète est celle de la DoD, faite à la main sur une machine vierge.
  #[test]
  fn reading_the_status_returns_without_waiting_for_anyone() {
    let status =
      tauri::async_runtime::block_on(get_permissions_status()).expect("le pont doit répondre");

    // L'Enregistrement audio est structurellement illisible : macOS n'a pas d'API de
    // préflight pour cette catégorie TCC. Si un jour ce test échoue, c'est qu'Apple en a
    // ajouté une — il faudra corriger `Permissions.swift`, pas ce test.
    assert_eq!(
      status.audio_capture.status,
      PermissionStatus::Unknown,
      "l'enregistrement audio ne se lit pas sans déclencher la capture"
    );

    // Micro et Accessibilité, en revanche, se lisent **toujours** : leurs accesseurs
    // répondent quel que soit l'état de la machine. Un `Unknown` ici trahirait une lecture
    // qui a échoué en silence.
    for (name, permission) in [
      ("micro", &status.microphone),
      ("accessibilité", &status.accessibility),
    ] {
      assert_ne!(
        permission.status,
        PermissionStatus::Unknown,
        "{name} doit être lisible sans prompt"
      );
    }

    // ⚠️ L'automatisation, elle, peut légitimement être inconnue : System Events se lance à
    // la demande, et le préflight ne peut rien dire d'un processus absent. On n'exige donc
    // pas un état lisible — seulement qu'un état inconnu **dise pourquoi**, partout.
    for (name, permission) in [
      ("micro", &status.microphone),
      ("accessibilité", &status.accessibility),
      ("automatisation", &status.automation),
      ("enregistrement audio", &status.audio_capture),
    ] {
      if permission.status == PermissionStatus::Unknown {
        assert!(
          permission.detail.is_some(),
          "{name} : un état inconnu doit toujours dire pourquoi"
        );
      }
    }
  }

  #[test]
  fn serializes_in_camel_case() {
    let json = serde_json::to_value(sample()).expect("sérialisation");
    assert_eq!(json["audioCapture"]["status"], "unknown");
    assert_eq!(json["accessibility"]["status"], "notDetermined");
    assert_eq!(json["microphone"]["detail"], serde_json::Value::Null);
    assert_eq!(
      json.as_object().expect("objet").len(),
      4,
      "quatre autorisations, et rien d'autre"
    );
  }

  #[test]
  fn every_status_round_trips_through_json() {
    for (status, expected) in [
      (PermissionStatus::Granted, "granted"),
      (PermissionStatus::Denied, "denied"),
      (PermissionStatus::NotDetermined, "notDetermined"),
      (PermissionStatus::Unknown, "unknown"),
    ] {
      let json = serde_json::to_value(status).expect("sérialisation");
      assert_eq!(json, expected);
      assert_eq!(
        serde_json::from_value::<PermissionStatus>(json).expect("désérialisation"),
        status
      );
    }
  }

  /// ⚠️ `native` et non `permission` : une réponse du pont qu'on n'arrive pas à relire dit que
  /// le pont est cassé, pas que l'utilisateur a refusé quelque chose.
  #[test]
  fn a_malformed_bridge_answer_is_a_bridge_error() {
    let error = parse::<PermissionsStatus>("{", "les autorisations")
      .expect_err("un JSON tronqué doit échouer");
    assert_eq!(error.kind(), "native");
    assert!(
      error.to_string().contains("les autorisations"),
      "le message doit dire ce qui n'a pas pu être lu, reçu : {error}"
    );
  }

  #[test]
  fn an_unknown_status_from_the_bridge_is_refused() {
    // Le pont et ce module portent le même schéma, écrit deux fois. Si l'un dérive, on veut
    // une erreur franche plutôt qu'un état silencieusement remplacé par un défaut.
    let error = parse::<Permission>(r#"{"status":"peutEtre","detail":null}"#, "le micro")
      .expect_err("un état inconnu doit échouer");
    assert_eq!(error.kind(), "native");
  }
}
