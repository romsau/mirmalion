//! L'historique des sessions : lister, ouvrir, supprimer, copier, purger.
//!
//! # Pièges
//!
//! - ⚠️ La rétention se relit à chaque geste et ne se met jamais en cache : elle peut changer
//!   dans une fenêtre pendant qu'une autre liste.

use tauri::{AppHandle, Manager};

use super::read_settings;
use crate::{blocking::off_thread, error::AppError};

/// Applique la rétention à l'historique des sessions.
///
/// # Pièges
///
/// - ⚠️ Continue et sans tâche planifiée : au lancement et à chaque lecture du panneau. Une purge
///   « mensuelle » manquerait son rendez-vous dès que l'application ne tourne pas ce jour-là.
/// - ⚠️ Le réglage est relu à chaque fois, jamais mémorisé : le réduire doit s'appliquer
///   rétroactivement, dès l'ouverture suivante.
/// - ⚠️ À appeler **après** `app.manage(state)` : montée plus tôt, la purge ne trouve pas la base
///   et ne fait rien, en silence. Un échec ne remonte à personne, le ménage n'ayant rien demandé.
pub fn purge_history_on_launch(app: &AppHandle) {
  let Some(state) = app.try_state::<crate::state::AppState>() else {
    // ⚠️ On se tait plutôt que d'avertir : le seul cas est un démarrage qui a déjà échoué plus
    // haut, et il a déjà dit pourquoi.
    return;
  };
  let retention = read_settings(app).live_retention;
  let database = state.database();
  let purged = database
    .lock()
    .and_then(|connection| crate::live::history::purge(&connection, &retention));
  match purged {
    Ok(0) => {}
    Ok(count) => log::debug!("historique des sessions : {count} purgée(s)"),
    Err(error) => log::warn!("purge de l'historique impossible : {}", error.kind()),
  }
}

/// L'historique des sessions, **purgé puis lu**.
///
/// # Errors
///
/// Rend l'erreur de la base si la lecture échoue, ou [`AppError::Io`] si la tâche n'est pas
/// revenue.
///
/// # Pièges
///
/// - ⚠️ La purge précède la lecture, et c'est ce qui la rend rétroactive : lire d'abord montrerait
///   une fois de plus ce que le réglage vient d'exclure.
#[tauri::command]
pub async fn list_live_sessions(
  app: AppHandle,
  state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<crate::live::history::SessionSummary>, AppError> {
  let database = state.database();
  let retention = read_settings(&app).live_retention;
  off_thread(move || {
    let connection = database.lock()?;
    // ⚠️ Un ménage raté ne prive pas de l'historique : on journalise et on lit quand même.
    if let Err(error) = crate::live::history::purge(&connection, &retention) {
      log::warn!("purge de l'historique impossible : {}", error.kind());
    }
    let summaries = crate::live::history::summaries(&connection);
    // ⚠️ On trace ce qui est rendu, y compris zéro : « l'écran n'a rien demandé » et « on lui a
    // répondu une liste vide » sont deux défauts opposés, sans cette ligne indiscernables.
    match &summaries {
      Ok(rows) => log::debug!("historique des sessions : {} résumé(s) rendus", rows.len()),
      Err(error) => log::warn!("historique des sessions illisible : {}", error.kind()),
    }
    summaries
  })
  .await
}

/// Rouvre une session archivée : son document, puis sa fenêtre.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la ligne n'est plus dans l'historique, ou l'erreur de la base.
///
/// # Pièges
///
/// - ⚠️ Une session n'a qu'une fenêtre, même rouverte deux fois : deux fenêtres seraient deux
///   documents portant le même `archived`, et la base garderait celui qui a écrit en dernier.
/// - ⚠️ C'est le document qui porte le lien, pas une table : `LiveDocument.archived` retient sa
///   ligne, sans quoi il faudrait la chercher par sa date — deux sessions se confondraient.
#[tauri::command]
pub async fn open_live_session(
  app: AppHandle,
  id: i64,
  state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), AppError> {
  let documents = app.state::<crate::live::documents::LiveDocuments>();
  if let Some(open) = documents.of_archive(id)? {
    if let Some(window) = app.get_webview_window(&open) {
      let _ = window.show();
      let _ = window.set_focus();
      return Ok(());
    }
    // La fenêtre est partie sans que le document le soit — on repart du document, sans le
    // relire en base.
    documents.close(&open)?;
  }

  let database = state.database();
  let found = off_thread(move || {
    let connection = database.lock()?;
    crate::live::history::find(&connection, id)
  })
  .await?;

  let session = found.ok_or_else(|| {
    // ⚠️ Un message pour l'utilisateur, pas un code : la ligne vient d'être purgée ou supprimée,
    // et le panneau doit pouvoir le dire tel quel.
    AppError::Io("cette session n'est plus dans l'historique".to_owned())
  })?;
  let document = app
    .state::<crate::live::documents::LiveDocuments>()
    .reopen(session)?;
  crate::lifecycle::create_live_window(&app, &document.id)?;
  Ok(())
}

/// Supprime une session de l'historique, **et ferme sa fenêtre si elle en avait une**.
///
/// # Errors
///
/// Rend l'erreur de la base, ou [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ Fermer la fenêtre fait partie de la suppression : la laisser ouverte offrirait de renommer
///   et de régénérer une session qui n'existe plus, sans effet et sans un mot.
#[tauri::command]
pub async fn delete_live_session(
  app: AppHandle,
  id: i64,
  state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    crate::live::history::delete(&connection, id).map(|_| ())
  })
  .await?;

  let documents = app.state::<crate::live::documents::LiveDocuments>();
  if let Some(open) = documents.of_archive(id)? {
    documents.close(&open)?;
    if let Some(window) = app.get_webview_window(&open) {
      // `destroy()` : la question a déjà été posée par la modale du panneau — voir
      // `close_live_document`, qui explique pourquoi `close()` ne ferme rien ici.
      let _ = window.destroy();
    }
  }
  Ok(())
}

/// Vide l'historique des sessions. **Rend le nombre de sessions parties.**
///
/// # Errors
///
/// Rend l'erreur de la base, ou [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ Les fenêtres ouvertes ne sont pas fermées ici, contrairement à une suppression unitaire :
///   « Tout supprimer » vise l'historique. Ce qui reste ouvert reste lisible, ce qui s'y écrira
///   ensuite ne trouvera plus sa ligne.
#[tauri::command]
pub async fn clear_live_sessions(
  state: tauri::State<'_, crate::state::AppState>,
) -> Result<usize, AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    crate::live::history::clear(&connection)
  })
  .await
}

/// Le texte d'une session, prêt pour le presse-papier.
///
/// Le compte rendu s'il existe, le transcript sinon : un bouton « copier » qui ne copie rien
/// serait pire qu'absent, et l'absence de compte rendu est le cas par défaut.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la session n'est plus dans l'historique, ou l'erreur de la base.
///
/// # Pièges
///
/// - ⚠️ Le texte se compose ici et non à l'écran : le rendu en texte brut est déjà écrit et
///   éprouvé (`export::plain_text`), le refaire en TypeScript donnerait deux vérités.
#[tauri::command]
pub async fn copy_live_session(
  id: i64,
  state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, AppError> {
  let database = state.database();
  let found = off_thread(move || {
    let connection = database.lock()?;
    crate::live::history::find(&connection, id)
  })
  .await?;

  let session =
    found.ok_or_else(|| AppError::Io("cette session n'est plus dans l'historique".to_owned()))?;
  Ok(crate::live::history::copyable_text(&session))
}
