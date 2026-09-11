//! La fenêtre-document d'une session terminée : la relire, la renommer, la fermer.
//!
//! # Pièges
//!
//! - ⚠️ Une fenêtre-document se ferme par `destroy()`, jamais par la fermeture polie de Tauri :
//!   celle-ci repose la question que l'utilisateur vient de trancher, et la fenêtre reste
//!   ouverte. `tests/document_windows.rs` le refuse — et ce commentaire-ci l'a déclenché.

use tauri::{AppHandle, Manager};

use super::finalise::mirror;
use crate::error::AppError;

/// Relit une session terminée. **Premier appel de chaque fenêtre à son démarrage.**
///
/// # Errors
///
/// Rend [`AppError::Io`] si l'identifiant n'est plus dans le magasin.
#[tauri::command]
pub fn get_live_document(
  id: String,
  documents: tauri::State<'_, crate::live::documents::LiveDocuments>,
) -> Result<crate::live::documents::LiveDocument, AppError> {
  documents.get(&id)
}

/// Renomme la session. Un titre vidé **ramène le repli** « Session du … ».
///
/// # Errors
///
/// Rend [`AppError::Io`] si l'identifiant n'est plus dans le magasin.
#[tauri::command]
pub async fn rename_live_document(
  app: AppHandle,
  id: String,
  title: String,
) -> Result<crate::live::documents::LiveDocument, AppError> {
  let renamed = app
    .state::<crate::live::documents::LiveDocuments>()
    .rename(&id, &title)?;
  mirror(&app, &renamed).await;
  Ok(renamed)
}

/// Ferme une session, libère sa mémoire, et ferme sa fenêtre.
///
/// # Errors
///
/// Rend [`AppError::Io`] si l'identifiant n'est plus dans le magasin.
///
/// # Pièges
///
/// - ⚠️ Idempotente : la fenêtre se ferme par la pastille rouge, par ⌘W et par le menu.
#[tauri::command]
pub fn close_live_document(
  app: AppHandle,
  id: String,
  documents: tauri::State<'_, crate::live::documents::LiveDocuments>,
) -> Result<(), AppError> {
  documents.close(&id)?;
  if let Some(window) = app.get_webview_window(&id) {
    // ⚠️ `destroy()` et non `close()` : `close()` émet `CloseRequested`, que la fenêtre-session
    // intercepte pour poser « arrêter la session ? ». On rentre alors dans une boucle fermée, et
    // le symptôme est le pire possible — il ne se passe rien, ni erreur ni modale. Ici on arrive
    // après la confirmation, donc `destroy()` est le geste juste.
    //
    // ⚠️ Le même défaut a été livré puis corrigé sur les fichiers (`filedoc.rs`) : toute
    // fenêtre-document ferme par `destroy()`.
    let _ = window.destroy();
  }
  Ok(())
}
