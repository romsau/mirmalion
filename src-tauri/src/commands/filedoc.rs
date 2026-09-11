//! La fenêtre-document d'une transcription de fichier : la lire, la renommer, la refermer.
//!
//! Une fenêtre par document, plusieurs en parallèle : l'étiquette de la fenêtre **est**
//! l'identifiant du document, et c'est elle que le frontend lit pour savoir quoi afficher
//! (`applyWindowRoute`, `src/app/app.routes.ts`).
//!
//! # Pièges
//!
//! - ⚠️ Un document ne s'ouvre pas depuis ici : il naît au bout de `transcribe_media`, qui le
//!   range et ouvre sa fenêtre d'un seul geste. Une commande d'ouverture séparée ferait
//!   retraverser le pont aux mots horodatés que le frontend vient de recevoir.
//! - ⚠️ Fermer la fenêtre perd le document, définitivement. D'où une commande explicite plutôt
//!   que l'évènement de fenêtre : l'interface doit pouvoir demander confirmation avant.

use tauri::{Manager, State};

use crate::{
  error::AppError,
  filedoc::{Documents, FileDocument},
};

/// Rend le magasin joignable. Appelé une fois, au `.setup()`.
pub fn setup(app: &tauri::AppHandle) {
  app.manage(Documents::default());
}

/// Relit un document ; c'est le premier appel de chaque fenêtre à son démarrage.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `id` ne désigne aucun document ouvert.
#[tauri::command]
pub fn get_file_document(
  id: String,
  documents: State<'_, Documents>,
) -> Result<FileDocument, AppError> {
  documents.get(&id)
}

/// Renomme le document ; un titre vidé retombe sur le nom du fichier, extension retirée.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `id` ne désigne aucun document ouvert.
#[tauri::command]
pub fn rename_file_document(
  id: String,
  title: String,
  documents: State<'_, Documents>,
) -> Result<FileDocument, AppError> {
  documents.rename(&id, &title)
}

/// Ferme un document, libère sa mémoire, et ferme sa fenêtre.
///
/// Idempotente : la fenêtre se ferme par la pastille rouge, par ⌘W et par le menu, et un
/// second appel n'est pas une erreur.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le magasin des documents est devenu inutilisable. Une fenêtre qui
/// refuse de disparaître ne fait pas échouer l'appel : le document est déjà perdu.
#[tauri::command]
pub fn close_file_document(
  app: tauri::AppHandle,
  id: String,
  documents: State<'_, Documents>,
) -> Result<(), AppError> {
  documents.close(&id)?;
  if let Some(window) = app.get_webview_window(&id) {
    // ⚠️ `destroy()` et non `close()` : `close()` émet `CloseRequested`, que le frontend
    // intercepte pour demander « voulez-vous perdre cette transcription ? » — la question
    // rouvrirait donc en boucle, sur une fenêtre qui ne se ferme jamais. On arrive ici après la
    // confirmation, il n'y a plus rien à demander.
    let _ = window.destroy();
  }
  Ok(())
}
