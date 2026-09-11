//! La consolidation d'une session : tisser les deux flux, archiver, refléter.
//!
//! La logique vit dans [`crate::live::finalise`] ; ce module l'orchestre et en rend compte.
//!
//! # Pièges
//!
//! - ⚠️ Elle tourne **après** l'arrêt du tap et peut durer : la session existe encore alors que
//!   la capture est close, ce que [`super::capture::get_live_capture_status`] ne dit pas.

use tauri::{AppHandle, Manager};

use super::{LIVE_FINALISED_EVENT, announce, capture::live_audio_directory, now_ms, progressed};
use crate::{blocking::off_thread, error::AppError};

/// Consolide la session qui vient de s'arrêter, **supprime son audio**, et annonce le document.
///
/// # Pièges
///
/// - ⚠️ Rien n'est rendu à personne : tout passe par l'évènement. Ce travail n'a pas d'appelant
///   qui l'attende et peut survivre à la fenêtre qui l'a déclenché ; un `Result` ici n'aurait
///   personne pour le lire.
pub(super) async fn consolidate(app: AppHandle, id: String) {
  match consolidated(&app, &id).await {
    Ok(document) => {
      archive(&app, &document).await;
      announce(&app, LIVE_FINALISED_EVENT, &document);
    }
    Err(error) => {
      // ⚠️ Un échec de consolidation laisse quand même le document se terminer : sans cela, la
      // fenêtre resterait sous son voile pour toujours. Le transcript vide est mauvais, le voile
      // perpétuel est sans issue.
      log::error!("la consolidation de la session a échoué : {}", error.kind());
      let ended = app.state::<crate::live::documents::LiveDocuments>().finish(
        &id,
        None,
        crate::transcript::Transcript::of(&[], ""),
        now_ms(),
      );
      match ended {
        // ⚠️ On archive même un transcript vide : la session a bien eu lieu, et une ligne
        // d'historique vaut mieux qu'un trou que personne ne peut expliquer.
        Ok(document) => {
          archive(&app, &document).await;
          announce(&app, LIVE_FINALISED_EVENT, &document);
        }
        Err(error) => log::error!("session introuvable à sa clôture : {}", error.kind()),
      }
    }
  }
  app
    .state::<std::sync::Arc<crate::live::LiveSession>>()
    .close();
}

/// Range la session dans l'historique, et retient sa ligne.
///
/// # Pièges
///
/// - ⚠️ À la consolidation, pas à la fermeture de la fenêtre : attendre la fermeture ferait perdre
///   toute session dont la fenêtre reste ouverte quand l'application s'arrête — et c'est son cas
///   normal. Ce qui suit — compte rendu, renommage — met la ligne à jour.
/// - ⚠️ Un échec d'archivage n'empêche pas la session d'arriver à l'écran : le document est déjà
///   en mémoire et sa fenêtre l'attend.
async fn archive(app: &AppHandle, document: &crate::live::documents::LiveDocument) {
  let Some(state) = app.try_state::<crate::state::AppState>() else {
    return;
  };
  let database = state.database();
  let stored = document.clone();
  let archived = tauri::async_runtime::spawn_blocking(move || {
    let connection = database.lock()?;
    crate::live::history::archive(&connection, &stored)
  })
  .await;

  match archived {
    Ok(Ok(id)) => {
      // ⚠️ Le chemin nominal se trace, et son absence a coûté une enquête : seuls les échecs
      // parlaient ici, si bien qu'un historique vide était indiscernable de trois causes — session
      // non archivée, archivée mais invisible à la lecture, ou écran qui ne demande rien.
      log::debug!("session archivée en base");
      if let Err(error) = app
        .state::<crate::live::documents::LiveDocuments>()
        .set_archived(&document.id, id)
      {
        log::warn!("ligne d'historique non retenue : {}", error.kind());
      }
    }
    Ok(Err(error)) => log::warn!("session non archivée : {}", error.kind()),
    Err(error) => log::warn!("archivage interrompu : {error}"),
  }
}

/// Reporte dans l'historique ce qui vient de changer sur un document déjà archivé.
///
/// # Pièges
///
/// - ⚠️ Sans effet tant que la session n'est pas archivée — pendant l'enregistrement, par exemple,
///   où l'on peut déjà la renommer. Elle le sera avec sa valeur à la consolidation.
/// - ⚠️ Un échec ne remonte pas : ce qui compte est ce que l'écran montre, et l'historique se
///   rattrape à la prochaine génération.
pub(super) async fn mirror(app: &AppHandle, document: &crate::live::documents::LiveDocument) {
  let (Some(state), Some(archived)) =
    (app.try_state::<crate::state::AppState>(), document.archived)
  else {
    return;
  };
  let database = state.database();
  let title = document.title.clone();
  let report = document.report.clone();
  let mirrored = tauri::async_runtime::spawn_blocking(move || {
    let connection = database.lock()?;
    crate::live::history::rename(&connection, archived, title.as_deref())?;
    crate::live::history::set_report(&connection, archived, &report)
  })
  .await;

  if let Ok(Err(error)) = mirrored {
    log::warn!("historique non mis à jour : {}", error.kind());
  }
}

/// Le travail lui-même — séparé de son annonce pour que le chemin d'erreur reste lisible.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le cache est illisible ou la session introuvable,
/// [`AppError::Native`] si la consolidation échoue.
async fn consolidated(
  app: &AppHandle,
  id: &str,
) -> Result<crate::live::documents::LiveDocument, AppError> {
  let directory = live_audio_directory(&app.path().app_cache_dir()?);
  let session = app
    .state::<std::sync::Arc<crate::live::LiveSession>>()
    .inner()
    .clone();
  // ⚠️ Le rappel traverse le fil bloquant, d'où les copies : la consolidation dure plusieurs
  // secondes et ne peut pas tenir la boucle de l'IPC.
  let watcher = app.clone();
  let watched = id.to_owned();
  let woven = off_thread(move || {
    crate::live::finalise::consolidate(&session, &directory, move |step, done, total| {
      progressed(&watcher, &watched, step, done, total);
    })
  })
  .await?;

  // ⚠️ L'instant de fin est relevé ici, pas à l'affichage : la fenêtre peut rester ouverte des
  // heures, et « aujourd'hui » calculé au rendu finirait par désigner un autre jour.
  app.state::<crate::live::documents::LiveDocuments>().finish(
    id,
    woven.title,
    woven.transcript,
    now_ms(),
  )
}
