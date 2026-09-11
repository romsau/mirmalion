//! Le passage du fil de l'IPC à un fil de travail, écrit une fois.
//!
//! Une commande Tauri tourne sur le fil de l'IPC ; y bloquer fige la fenêtre, prompt système
//! compris. Tout ce qui attend — le pont Swift, la base, le disque — passe donc par
//! [`off_thread`].
//!
//! # Pièges
//!
//! - ⚠️ Le piège n'est **jamais** ici : chaque appelant sait pourquoi *son* travail bloque
//!   (`coreaudiod` qui répond en dizaines de millisecondes, un prompt TCC sans délai maximal,
//!   un fichier qui traverse le disque). Ces raisons vivent sur les fonctions concernées.

use crate::error::AppError;

/// Exécute `work` sur un fil de travail, et rend son résultat.
///
/// # Errors
///
/// Rend l'erreur de `work` telle quelle, ou [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ `Io` et pas `Native` : une tâche qui ne revient pas n'est ni une panne du pont, ni un
///   refus de la base — c'est la plomberie, que `error.rs` range déjà là.
/// - ⚠️ Le choix se fait ici et nulle part ailleurs : refait par site, il donnait quatre
///   variantes pour un seul évènement.
pub async fn off_thread<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
  tauri::async_runtime::spawn_blocking(work)
    .await
    .map_err(|error| AppError::Io(format!("tâche interrompue : {error}")))?
}

#[cfg(test)]
mod tests {
  use super::off_thread;
  use crate::error::AppError;
  use tauri::async_runtime::block_on;

  #[test]
  fn the_result_of_the_work_comes_back_untouched() {
    assert_eq!(block_on(off_thread(|| Ok(6 * 7))).ok(), Some(42));
  }

  #[test]
  fn the_work_really_leaves_the_calling_thread() {
    let here = std::thread::current().id();
    let there = block_on(off_thread(move || Ok(std::thread::current().id())));
    assert_ne!(there.ok(), Some(here));
  }

  #[test]
  fn the_error_of_the_work_passes_through_with_its_own_variant() {
    // ⚠️ Ce que le helper ne doit surtout pas faire : ré-étiqueter l'échec du travail. Un refus
    // d'autorisation reste un refus d'autorisation, il ne devient pas une panne de plomberie.
    let failed: Result<(), AppError> = block_on(off_thread(|| {
      Err(AppError::Permission("micro refusé".to_owned()))
    }));
    let error = failed.expect_err("le travail a échoué");
    assert_eq!(error.kind(), "permission");
    assert_eq!(error.to_string(), "micro refusé");
  }

  #[test]
  fn a_task_that_never_comes_back_is_an_io_error() {
    // Seule façon de provoquer un `JoinError` : faire paniquer la tâche. C'est le seul chemin
    // que le `map_err` couvre, et il n'a aucun autre déclencheur.
    let lost: Result<(), AppError> = block_on(off_thread(|| panic!("la tâche s'arrête net")));
    let error = lost.expect_err("la tâche n'est pas revenue");
    assert_eq!(error.kind(), "io");
    assert!(error.to_string().starts_with("tâche interrompue"));
  }
}
