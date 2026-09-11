//! La barre de menus applicative, celle que macOS affiche quand l'application est dans le Dock.
//!
//! Le strict nécessaire : l'identité, Réglages et Quitter, puis l'Édition, que macOS attend pour
//! câbler ⌘C / ⌘V / ⌘Z dans les champs. Rien qui double le tray, qui reste le chemin normal.
//!
//! # Pièges
//!
//! - ⚠️ `ActivationPolicy::Regular` ne donne pas que l'icône du Dock, il donne aussi la barre de
//!   menus. Sans menu à nous, macOS en pose une par défaut où l'on ne peut ni quitter au clavier,
//!   ni copier-coller dans un champ.
//! - ⚠️ La barre est posée même hors du Dock : la politique bascule à chaud, construire le menu à
//!   ce moment-là obligerait à le faire dans les deux sens.
//! - ⚠️ Les libellés échappent à `$localize` — ce sont des `NSMenu` construits par Rust, hors de
//!   tout webview. Une septième langue se pose ici, et dans `tray.rs`.

use tauri::{
  AppHandle, Emitter,
  menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::{error::AppError, lifecycle};

/// L'identifiant de l'entrée « Réglages ». Comparé tel quel dans le gestionnaire.
const SETTINGS: &str = "settings";

/// Les libellés du menu, dans les 6 langues d'interface.
struct Labels {
  about: &'static str,
  settings: &'static str,
  quit: &'static str,
  edit: &'static str,
  undo: &'static str,
  redo: &'static str,
  cut: &'static str,
  copy: &'static str,
  paste: &'static str,
  select_all: &'static str,
}

/// Les libellés de `locale`, ou ceux du français si la langue est inconnue.
fn labels(locale: &str) -> Labels {
  match locale {
    "en" => Labels {
      about: "About Mirmalion",
      settings: "Settings…",
      quit: "Quit Mirmalion",
      edit: "Edit",
      undo: "Undo",
      redo: "Redo",
      cut: "Cut",
      copy: "Copy",
      paste: "Paste",
      select_all: "Select All",
    },
    "es" => Labels {
      about: "Acerca de Mirmalion",
      settings: "Ajustes…",
      quit: "Salir de Mirmalion",
      edit: "Edición",
      undo: "Deshacer",
      redo: "Rehacer",
      cut: "Cortar",
      copy: "Copiar",
      paste: "Pegar",
      select_all: "Seleccionar todo",
    },
    "de" => Labels {
      about: "Über Mirmalion",
      settings: "Einstellungen…",
      quit: "Mirmalion beenden",
      edit: "Bearbeiten",
      undo: "Widerrufen",
      redo: "Wiederholen",
      cut: "Ausschneiden",
      copy: "Kopieren",
      paste: "Einsetzen",
      select_all: "Alles auswählen",
    },
    "it" => Labels {
      about: "Informazioni su Mirmalion",
      settings: "Impostazioni…",
      quit: "Esci da Mirmalion",
      edit: "Modifica",
      undo: "Annulla",
      redo: "Ripristina",
      cut: "Taglia",
      copy: "Copia",
      paste: "Incolla",
      select_all: "Seleziona tutto",
    },
    "pt" => Labels {
      about: "Acerca do Mirmalion",
      settings: "Definições…",
      quit: "Sair do Mirmalion",
      edit: "Editar",
      undo: "Desfazer",
      redo: "Refazer",
      cut: "Cortar",
      copy: "Copiar",
      paste: "Colar",
      select_all: "Selecionar tudo",
    },
    _ => Labels {
      about: "À propos de Mirmalion",
      settings: "Réglages…",
      quit: "Quitter Mirmalion",
      edit: "Édition",
      undo: "Annuler",
      redo: "Rétablir",
      cut: "Couper",
      copy: "Copier",
      paste: "Coller",
      select_all: "Tout sélectionner",
    },
  }
}

/// Construit la barre de menus, l'installe, et branche son gestionnaire une seule fois.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire ou de poser le menu.
///
/// # Pièges
///
/// - ⚠️ Ne pas rappeler cette fonction pour changer de langue : c'est [`rebuild`] qui le fait.
///   `on_menu_event` empile ses gestionnaires au lieu de les remplacer, et un second appel
///   ouvrirait les réglages deux fois par clic, un troisième trois fois.
pub fn install(app: &AppHandle, locale: &str) -> Result<(), AppError> {
  rebuild(app, locale)?;
  app.on_menu_event(|app, event| {
    if event.id() == SETTINGS {
      open_settings(app);
    }
  });
  Ok(())
}

/// Repeint la barre de menus dans une langue donnée, sans toucher au gestionnaire.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire ou de poser le menu.
pub fn rebuild(app: &AppHandle, locale: &str) -> Result<(), AppError> {
  let text = labels(locale);

  // ⚠️ `Settings` porte son raccourci explicitement : c'est le seul de la barre que macOS ne
  // câble pas tout seul, les prédéfinis apportant le leur.
  let settings = MenuItem::with_id(app, SETTINGS, text.settings, true, Some("CmdOrCtrl+,"))?;

  let application = Submenu::with_items(
    app,
    // Le premier sous-menu prend le nom de l'application quoi qu'on écrive : macOS le
    // remplace. Le titre n'est donc pas à traduire.
    "Mirmalion",
    true,
    &[
      &PredefinedMenuItem::about(app, Some(text.about), Some(AboutMetadata::default()))?,
      &PredefinedMenuItem::separator(app)?,
      &settings,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::quit(app, Some(text.quit))?,
    ],
  )?;

  // ⚠️ Sans le sous-menu Édition, ⌘C, ⌘V et ⌘Z ne font rien dans les champs de saisie : sur
  // macOS ces raccourcis passent par le menu, et un menu qui ne les déclare pas les laisse
  // inertes.
  let edit = Submenu::with_items(
    app,
    text.edit,
    true,
    &[
      &PredefinedMenuItem::undo(app, Some(text.undo))?,
      &PredefinedMenuItem::redo(app, Some(text.redo))?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, Some(text.cut))?,
      &PredefinedMenuItem::copy(app, Some(text.copy))?,
      &PredefinedMenuItem::paste(app, Some(text.paste))?,
      &PredefinedMenuItem::select_all(app, Some(text.select_all))?,
    ],
  )?;

  let menu = Menu::with_items(app, &[&application, &edit])?;
  app.set_menu(menu)?;
  Ok(())
}

/// Ramène la fenêtre et l'amène sur les réglages.
///
/// # Pièges
///
/// - ⚠️ `reveal` d'abord : la fenêtre peut être cachée, et pousser une navigation dans un webview
///   invisible laisserait l'utilisateur devant rien. Tant que l'onboarding est ouvert, `reveal`
///   ramène lui — on ne contourne pas un parcours qui n'a accordé aucune autorisation.
/// - ⚠️ `Front::Main`, et pas le défaut du tray : un rappel ordinaire laisse la fenêtre de la
///   session en cours au-dessus de la principale, où l'on va justement écrire.
fn open_settings(app: &AppHandle) {
  if let Err(error) = lifecycle::reveal(app, lifecycle::Front::Main) {
    log::warn!("fenêtre non rappelée ({}) : {error}", error.kind());
    return;
  }
  if let Err(error) = app.emit_to(lifecycle::MAIN_WINDOW, OPEN_SETTINGS_EVENT, ()) {
    log::warn!("réglages non ouverts : {error}");
  }
}

/// L'évènement qui demande au frontend d'aller sur l'écran des réglages.
pub const OPEN_SETTINGS_EVENT: &str = "menu://settings";

#[cfg(test)]
mod tests {
  use super::{OPEN_SETTINGS_EVENT, SETTINGS, labels};

  /// Les six langues d'interface. Elles ne sont pas relues depuis `i18n::SUPPORTED_LOCALES` à
  /// dessein : ce test doit échouer le jour où une langue est ajoutée sans traduction, et une
  /// liste qui suivrait la constante grandirait avec elle sans rien exiger. Même raison que
  /// `tray.rs`, et `settings.rs` lie les deux périmètres pour que rien ne se perde entre eux.
  const LOCALES: [&str; 6] = ["fr", "en", "es", "de", "it", "pt"];

  #[test]
  fn every_interface_language_has_its_own_menu() {
    // ⚠️ Ces libellés échappent à `$localize` : rien d'autre ne garantit qu'ils suivent les
    // six langues. Le même test existe pour le tray, et pour la même raison.
    let quits: Vec<&str> = LOCALES.iter().map(|locale| labels(locale).quit).collect();
    let unique: std::collections::HashSet<&&str> = quits.iter().collect();
    assert_eq!(
      unique.len(),
      quits.len(),
      "deux langues partagent le même « Quitter » : une traduction manque"
    );
  }

  #[test]
  fn an_unknown_locale_falls_back_to_the_source_language() {
    assert_eq!(labels("klingon").settings, "Réglages…");
    assert_eq!(labels("fr").settings, "Réglages…");
  }

  #[test]
  fn identifiers_are_stable() {
    // Comparés tels quels dans le gestionnaire : les renommer sans toucher au test casserait
    // le menu en silence.
    assert_eq!(SETTINGS, "settings");
    assert_eq!(OPEN_SETTINGS_EVENT, "menu://settings");
  }
}
