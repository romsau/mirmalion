//! État de la base, exposé au frontend.
//!
//! Module de référence pour le **motif d'accès à la base** : commande `async`, clone du
//! `Arc<Database>`, travail SQLite déplacé dans `spawn_blocking`.
//!
//! # Pièges
//!
//! - ⚠️ Le WebView est non fiable : aucune commande n'expose de SQL générique, ni la clé, ni le
//!   chemin du fichier. Les accès arrivent par domaine (`save_dictation`, `list_live_sessions`…),
//!   chacun avec ses arguments validés.
//! - ⚠️ SQLite bloque le thread qui l'appelle : le sortir de la boucle asynchrone est la seule
//!   façon de garder l'interface réactive.

use tauri::State;

use crate::{blocking::off_thread, db::schema, error::AppError, state::AppState};

/// L'état du schéma de la base, tel que le frontend le reçoit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
  /// La version du schéma effectivement appliquée au fichier.
  pub schema_version: i64,
  /// La version que cette build de l'application sait produire.
  pub expected_schema_version: i64,
}

/// Compare la version du schéma inscrite dans le fichier à celle que cette build sait produire.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la lecture de la version échoue, [`AppError::Io`] si la tâche
/// n'est pas revenue.
#[tauri::command]
pub async fn get_database_status(state: State<'_, AppState>) -> Result<DatabaseStatus, AppError> {
  let database = state.database();

  let schema_version = off_thread(move || database.schema_version()).await?;

  Ok(DatabaseStatus {
    schema_version,
    expected_schema_version: schema::latest_version(),
  })
}

#[cfg(test)]
mod tests {
  use super::DatabaseStatus;

  #[test]
  fn serializes_in_camel_case() {
    let status = DatabaseStatus {
      schema_version: 1,
      expected_schema_version: 1,
    };
    let json = serde_json::to_value(status).expect("sérialisation");
    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["expectedSchemaVersion"], 1);
    assert_eq!(
      json.as_object().expect("objet").len(),
      2,
      "ni chemin, ni clé, ni rien d'autre ne doit sortir"
    );
  }
}
