//! L'état applicatif partagé, monté une seule fois au démarrage via `.manage()` et lu dans
//! les commandes via `State<'_, AppState>`.
//!
//! # Pièges
//!
//! - ⚠️ Les commandes sont `async` : un `std::sync::Mutex` tenu à travers un `.await` bloque
//!   le runtime. Tout champ mutable ajouté ici va derrière un verrou async
//!   (`tokio::sync::Mutex` / `RwLock`).
//! - ⚠️ Deux champs font exception, leur verrou synchrone n'étant jamais tenu à travers un
//!   `.await` : la base, dont toute opération passe par `spawn_blocking` (voir [`crate::db`]),
//!   et la langue d'interface, qu'un verrou async rendrait illisible depuis le code synchrone
//!   qui crée les fenêtres-documents.

use std::{
  path::{Path, PathBuf},
  sync::{Arc, RwLock},
};

use tauri::{AppHandle, Manager};

use crate::{db::Database, error::AppError, i18n, security::key};

/// Les données résolues au démarrage — dont une qui change ensuite.
#[derive(Debug)]
pub struct AppState {
  /// La racine de tout ce que l'application écrit, résolue au démarrage.
  data_dir: PathBuf,
  /// La base chiffrée, partagée par `Arc` avec les tâches bloquantes.
  database: Arc<Database>,
  /// La langue d'interface en vigueur.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Elle n'est pas figée au démarrage : elle se change à chaud, et c'est elle que
  ///   consultent les fenêtres créées ensuite. Figée, une fenêtre-document naîtrait dans
  ///   l'ancienne langue jusqu'au prochain démarrage.
  interface_locale: RwLock<&'static str>,
}

impl AppState {
  /// Construit l'état à partir du handle Tauri. Appelé une seule fois, dans `.setup()`.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le répertoire de données ne se résout pas,
  /// [`AppError::Keychain`] si le trousseau est inaccessible, [`AppError::Database`] si la base
  /// refuse de s'ouvrir. Dans ces trois cas l'application ne démarre pas.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La clé n'est pas conservée : elle déverrouille la base, puis sort de portée et son
  ///   contenu est effacé (`Zeroizing`). La garder en mémoire serait une exposition gratuite.
  pub fn from_app(app: &AppHandle) -> Result<Self, AppError> {
    let data_dir = app.path().app_data_dir()?;
    let encryption_key = key::load_or_create(&app.config().identifier)?;
    let database = Database::open(&crate::db::database_path(&data_dir), &encryption_key)?;

    // ⚠️ Le réglage l'emporte toujours ; le système n'est consulté qu'au tout premier
    // lancement, avant que quoi que ce soit n'ait été écrit.
    let interface_locale = i18n::resolve(
      i18n::stored_locale(&data_dir.join(i18n::SETTINGS_FILE)).as_deref(),
      i18n::system_locale(),
    );

    Ok(Self::new(data_dir, database, interface_locale))
  }

  /// Construit l'état depuis des valeurs déjà résolues. Sert aux tests et à `from_app`.
  pub fn new(data_dir: PathBuf, database: Database, interface_locale: &'static str) -> Self {
    Self {
      data_dir,
      database: Arc::new(database),
      interface_locale: RwLock::new(interface_locale),
    }
  }

  /// `~/Library/Application Support/<identifier>/` — racine de tout ce que l'app écrit.
  pub fn data_dir(&self) -> &Path {
    &self.data_dir
  }

  /// La langue de l'interface **en vigueur**.
  ///
  /// C'est **la même** que celle du bundle que chargera la prochaine fenêtre : le frontend la
  /// lit plutôt que de la redéduire, pour qu'il n'y ait qu'une seule source.
  pub fn interface_locale(&self) -> &'static str {
    *self
      .interface_locale
      .read()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  /// Change la langue d'interface en vigueur.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le type impose la validité : un `&'static str` ne se fabrique pas depuis une chaîne
  ///   du frontend, il vient de `i18n::SUPPORTED_LOCALES` via `i18n::known`. Le portier est en
  ///   amont ; cette fonction n'a rien à revalider.
  /// - ⚠️ Elle ne persiste rien. Le réglage est écrit par le frontend dans `settings.json`, et
  ///   c'est lui que relira le prochain démarrage.
  pub fn set_interface_locale(&self, locale: &'static str) {
    *self
      .interface_locale
      .write()
      .unwrap_or_else(|poisoned| poisoned.into_inner()) = locale;
  }

  /// La base chiffrée.
  ///
  /// Renvoie un `Arc` clonable : une commande le déplace dans `spawn_blocking`, où le
  /// travail bloquant de SQLite est légitime.
  pub fn database(&self) -> Arc<Database> {
    Arc::clone(&self.database)
  }
}

#[cfg(test)]
mod tests {
  use super::AppState;
  use crate::{db::Database, security::key::EncryptionKey};
  use std::path::PathBuf;

  struct TempDir(PathBuf);

  impl TempDir {
    fn new(name: &str) -> Self {
      let path = std::env::temp_dir().join(format!("mirmalion-state-test-{name}"));
      let _ = std::fs::remove_dir_all(&path);
      Self(path)
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn state(dir: &TempDir) -> AppState {
    let key = EncryptionKey::from_hex("a".repeat(64)).expect("clé valide");
    let database = Database::open(&crate::db::database_path(&dir.0), &key).expect("base");
    AppState::new(dir.0.clone(), database, "fr")
  }

  #[test]
  fn exposes_the_data_dir_it_was_built_with() {
    let dir = TempDir::new("data-dir");
    assert_eq!(state(&dir).data_dir(), dir.0);
  }

  #[test]
  fn hands_out_a_shareable_handle_on_the_database() {
    let dir = TempDir::new("database");
    let state = state(&dir);

    let first = state.database();
    let second = state.database();

    let expected = crate::db::schema::latest_version();
    assert_eq!(first.schema_version().expect("version"), expected);
    assert_eq!(second.schema_version().expect("version"), expected);
  }

  #[test]
  fn exposes_the_interface_locale_resolved_at_startup() {
    let dir = TempDir::new("locale");
    assert_eq!(state(&dir).interface_locale(), "fr");
  }

  /// C'est cette valeur que consultent les fenêtres créées **après** un changement de langue —
  /// une fenêtre-document, par exemple. Figée, elle les ferait naître dans l'ancienne.
  #[test]
  fn the_interface_locale_changes_for_the_windows_that_come_after() {
    let dir = TempDir::new("locale-change");
    let state = state(&dir);

    state.set_interface_locale("it");

    assert_eq!(state.interface_locale(), "it");
  }

  #[test]
  fn debug_reveals_neither_the_key_nor_the_database_contents() {
    let dir = TempDir::new("debug");
    let rendered = format!("{:?}", state(&dir));

    assert!(rendered.contains("Database(<ouverte>)"));
    assert!(!rendered.contains(&"a".repeat(8)));
  }
}
