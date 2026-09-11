//! La langue de l'interface : la lire, et en changer **sans quitter l'application**.
//!
//! L'interface est localisée au build — un bundle complet par langue —, donc changer de langue
//! revient à faire charger un autre `index.html` : un frontend ne peut pas le faire pour
//! lui-même. Pendant de [`i18n::window_path`], qui tranche pareil à la création d'une fenêtre.
//!
//! # Pièges
//!
//! - ⚠️ Deux fenêtres seulement se retraduisent, la principale et la pilule. Recharger une
//!   fenêtre-session en cours d'enregistrement viderait les traductions déjà affichées, que le
//!   frontend accumule ligne par ligne et que le backend ne conserve pas.
//! - ⚠️ Un document finit donc sa vie dans la langue où il est né ; l'onboarding est exclu lui
//!   aussi, le recharger renverrait à sa première page un parcours déjà entamé.

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::{
  commands::overlay::{OVERLAY_WINDOW, OverlayHandle},
  error::AppError,
  i18n, lifecycle, menu,
  state::AppState,
  tray,
};

/// La langue de l'interface **en vigueur**.
///
/// # Pièges
///
/// - ⚠️ Le frontend la lit au lieu de la redéduire : c'est elle qui a décidé quel bundle
///   localisé la fenêtre a chargé, et deux détections indépendantes finiraient par diverger.
#[tauri::command]
pub fn get_interface_locale(state: tauri::State<'_, AppState>) -> String {
  state.interface_locale().to_owned()
}

/// Change la langue de l'interface, tout de suite.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `locale` n'est pas une des langues livrées.
///
/// # Pièges
///
/// - ⚠️ N'écrit pas le réglage : le frontend doit l'avoir enregistré **avant** d'appeler, sinon
///   un rechargement plus rapide que l'écriture ramène l'ancienne langue.
/// - ⚠️ Une langue inconnue est refusée, sans repli : l'appelant est notre propre interface, et
///   un repli masquerait un défaut de programmation. Le repli vit dans [`i18n::resolve`].
#[tauri::command]
pub async fn set_interface_language(
  app: AppHandle,
  state: tauri::State<'_, AppState>,
  locale: String,
) -> Result<(), AppError> {
  let locale = i18n::known(&locale)
    .ok_or_else(|| AppError::InvalidArgument(format!("langue d'interface inconnue : {locale}")))?;

  state.set_interface_locale(locale);

  // Les textes natifs, qui n'ont pas d'unité de traduction et que `$localize` n'atteint pas.
  // Ni l'un ni l'autre ne peut faire échouer la bascule — voir `tray::relabel`.
  if let Err(error) = menu::rebuild(&app, locale) {
    log::warn!("barre de menus non retraduite : {error}");
  }
  tray::relabel(&app, locale);

  retarget(&app, locale);
  Ok(())
}

/// Fait charger à chaque fenêtre concernée le bundle de la nouvelle langue.
fn retarget(app: &AppHandle, locale: &str) {
  if let Some(window) = app.get_webview_window(lifecycle::MAIN_WINDOW) {
    navigate(&window, locale);
  }

  // ⚠️ La pilule ne se recharge qu'au repos : en pleine dictée, sa coquille porte l'état que le
  // pipeline lui a poussé, et la recharger l'effacerait alors qu'elle est le seul témoin d'un
  // micro ouvert. Le prix du saut : elle garde son ancienne langue jusqu'au prochain démarrage,
  // n'étant jamais détruite (`overlay::ensure`).
  let idle = app
    .state::<OverlayHandle>()
    .0
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .is_none();
  match (idle, app.get_webview_window(OVERLAY_WINDOW)) {
    (true, Some(window)) => navigate(&window, locale),
    (false, _) => {
      log::debug!("pilule en cours d'usage : elle gardera sa langue jusqu'au prochain démarrage")
    }
    (true, None) => {}
  }
}

/// Pousse une fenêtre vers le bundle de `locale`.
///
/// # Pièges
///
/// - ⚠️ Sans échec, et volontairement : l'application a déjà changé de langue quand on arrive
///   ici. Une fenêtre qui refuse de naviguer se journalise, elle ne fait pas remonter d'erreur
///   à un écran qui vient d'enregistrer le réglage.
fn navigate(window: &WebviewWindow, locale: &str) {
  let current = match window.url() {
    Ok(url) => url,
    Err(error) => {
      log::warn!("URL de fenêtre illisible, langue non appliquée : {error}");
      return;
    }
  };
  if let Err(error) = window.navigate(i18n::navigation_url(
    &current,
    locale,
    !cfg!(debug_assertions),
  )) {
    log::warn!("fenêtre non redirigée vers sa nouvelle langue : {error}");
  }
}
