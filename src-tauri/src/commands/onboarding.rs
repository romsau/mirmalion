//! La sortie du premier lancement.
//!
//! Une commande de domaine, sans argument, plutôt que le droit donné au WebView de piloter les
//! fenêtres lui-même.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas remplacer ce geste par des appels de fenêtre côté frontend : il faudrait accorder
//!   `core:window:allow-show`, `allow-set-focus` et `allow-close` à **toutes** les fenêtres de
//!   `capabilities/default.json`, donc le droit permanent d'en fermer n'importe laquelle.

use crate::{error::AppError, lifecycle};

/// Termine l'onboarding : la fenêtre principale s'ouvre, celle du premier lancement se ferme.
///
/// # Errors
///
/// Rend une [`AppError`] si l'une des deux fenêtres est introuvable ou refuse le geste.
///
/// # Pièges
///
/// - ⚠️ N'écrit pas le drapeau `onboardingCompleted` : le frontend doit l'avoir enregistré dans
///   les réglages **avant** d'appeler, sinon le premier lancement se rejoue au démarrage suivant.
///   L'ordre des deux gestes est décrit dans [`lifecycle::finish_onboarding`].
#[tauri::command]
pub async fn finish_onboarding(app: tauri::AppHandle) -> Result<(), AppError> {
  lifecycle::finish_onboarding(&app)
}
