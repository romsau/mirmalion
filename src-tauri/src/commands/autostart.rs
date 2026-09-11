//! L'ouverture de l'application **à la session macOS** : deux commandes, un booléen.
//!
//! # Pièges
//!
//! - ⚠️ Ce réglage n'est pas dans le fichier de réglages : il vit dans macOS, sous forme
//!   d'élément d'ouverture de session. Le dupliquer chez nous donnerait deux sources de vérité
//!   pour un booléen, et l'interrupteur mentirait dès qu'on retire l'entrée depuis Réglages
//!   Système. L'état réel se relit à chaque affichage.
//! - ⚠️ Ne pas accorder d'ACL aux commandes de `tauri-plugin-autostart` : elles prennent un
//!   chemin et des arguments, donc le pouvoir de faire enregistrer *autre chose* au démarrage.
//!   Le frontend passe par les deux commandes de ce module, qui n'ont pas d'argument de chemin.

use tauri_plugin_autostart::ManagerExt;

use crate::error::AppError;

/// L'application est-elle inscrite à l'ouverture de session ?
///
/// La réponse est lue de macOS, jamais de nos réglages.
///
/// # Errors
///
/// Rend [`AppError::Io`] si l'état d'ouverture à la session est illisible.
#[tauri::command]
pub async fn get_launch_at_login(app: tauri::AppHandle) -> Result<bool, AppError> {
  app
    .autolaunch()
    .is_enabled()
    .map_err(|error| AppError::Io(format!("état d'ouverture à la session illisible : {error}")))
}

/// Inscrit ou retire l'application des ouvertures de session.
///
/// # Errors
///
/// Rend [`AppError::Io`] si macOS refuse l'inscription ou le retrait.
#[tauri::command]
pub async fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<(), AppError> {
  let manager = app.autolaunch();
  let outcome = if enabled {
    manager.enable()
  } else {
    manager.disable()
  };
  outcome.map_err(|error| AppError::Io(format!("ouverture à la session refusée : {error}")))
}
