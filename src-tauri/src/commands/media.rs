//! Le dépôt d'un média : dire, **avant tout traitement**, si on sait le traiter.
//!
//! Une seule commande, et elle ne fait qu'ouvrir un conteneur pour en lire l'en-tête. Ce
//! qu'elle décide est raconté dans [`crate::media`] ; ce module-ci ne fait que la rendre
//! joignable depuis le frontend, sans jamais bloquer l'interface.

use std::sync::Arc;

use tauri::{Manager, State};

use crate::{
  blocking::off_thread,
  error::AppError,
  media::{
    self, MediaInspection, MediaInspector, NativeInspector,
    language::{self, LanguageDetection, LanguageDetector, NativeDetector},
  },
};

/// Rend l'inspecteur et le détecteur joignables. Appelé une fois, au `.setup()`.
///
/// Ni état ni observateur : ils n'ont rien à préparer, seulement à être joignables — d'où un
/// simple `manage`, et aucun risque d'arriver trop tard.
///
/// # Pièges
///
/// - ⚠️ Deux `manage` et non un : Tauri range par type, et les deux `Arc<dyn …>` en sont deux
///   distincts.
pub fn setup(
  app: &tauri::AppHandle,
  inspector: Arc<dyn MediaInspector>,
  detector: Arc<dyn LanguageDetector>,
) {
  app.manage(inspector);
  app.manage(detector);
}

/// Les extensions que le sélecteur « Parcourir l'ordinateur » doit proposer.
///
/// # Pièges
///
/// - ⚠️ Ne pas redéclarer cette liste côté frontend : le filtre et la validation réelle doivent
///   parler du même périmètre, sinon le sélecteur finit par proposer un format que le moteur
///   refuse, ou par refuser un format qu'il sait lire.
#[tauri::command]
pub fn supported_media_extensions() -> Vec<String> {
  media::SUPPORTED_EXTENSIONS
    .iter()
    .map(|extension| (*extension).to_string())
    .collect()
}

/// Ouvre ce qui vient d'être déposé ou choisi, et rend le verdict.
///
/// # Errors
///
/// Rend [`AppError::Io`] si l'inspection est interrompue, ou l'erreur de la brique native.
///
/// # Pièges
///
/// - ⚠️ Un refus de média arrive en `Ok`, pas en `Err` : une `Err` d'ici veut dire que la brique
///   native est cassée, jamais que le fichier ne convient pas. Voir [`crate::media`].
/// - ⚠️ Garder le `spawn_blocking` : `AVURLAsset` lit le disque, et sur un volume réseau ou un
///   disque endormi l'ouverture prend le temps qu'elle prend.
#[tauri::command]
pub async fn inspect_media(
  paths: Vec<String>,
  inspector: State<'_, Arc<dyn MediaInspector>>,
) -> Result<MediaInspection, AppError> {
  let inspector = Arc::clone(&inspector);
  off_thread(move || media::inspect(&paths, inspector.as_ref())).await
}

/// Identifie la langue parlée du média, **avant** de le transcrire.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la détection est interrompue, ou l'erreur de la brique native.
///
/// # Pièges
///
/// - ⚠️ Une indécision arrive en `Ok`, pas en `Err` : une `Err` d'ici veut dire que la brique
///   native est cassée, jamais que le média est inexploitable. Voir [`crate::media::language`].
/// - ⚠️ L'appel est long — un échantillon de 30 s transcrit par langue installée, 3 s mesurées
///   sur le média de référence : le sortir du `spawn_blocking` figerait l'écran de progression.
#[tauri::command]
pub async fn detect_media_language(
  path: String,
  detector: State<'_, Arc<dyn LanguageDetector>>,
) -> Result<LanguageDetection, AppError> {
  let detector = Arc::clone(&detector);
  off_thread(move || language::detect(&path, detector.as_ref())).await
}

/// L'inspecteur réel, pour le `.setup()` de `lib.rs`.
pub fn native_inspector() -> Arc<dyn MediaInspector> {
  Arc::new(NativeInspector)
}

/// Le détecteur réel, pour le `.setup()` de `lib.rs`.
pub fn native_detector() -> Arc<dyn LanguageDetector> {
  Arc::new(NativeDetector)
}

#[cfg(test)]
mod tests {
  use super::supported_media_extensions;

  #[test]
  fn the_browse_filter_is_dictated_by_the_backend() {
    let extensions = supported_media_extensions();
    assert!(extensions.iter().any(|extension| extension == "mp4"));
    assert!(extensions.iter().any(|extension| extension == "mp3"));
    assert!(
      !extensions.is_empty(),
      "un sélecteur sans filtre laisserait choisir n'importe quoi"
    );
  }
}
