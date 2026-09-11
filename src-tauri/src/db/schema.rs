//! Les migrations du schéma, et la mécanique qui les applique.
//!
//! Pour en ajouter une : créer `migrations/00N_<nom>.sql`, puis l'inscrire en fin de
//! [`MIGRATIONS`] avec le numéro suivant. Chaque migration s'applique dans sa propre
//! transaction, avec l'inscription de sa version : une migration interrompue à mi-chemin ne
//! laisse jamais une base à moitié convertie.
//!
//! # Pièges
//!
//! - ⚠️ Ne jamais modifier une migration déjà livrée : elle a été appliquée sur les machines
//!   des utilisateurs, la réécrire ne la rejouera pas — elle ne ferait diverger que les bases
//!   créées après.

use rusqlite::Connection;

use crate::error::AppError;

/// Une migration embarquée dans le binaire.
pub struct Migration {
  /// Son numéro, qui sert aussi de repère d'avancement en base.
  pub version: i64,
  /// Son nom court, inscrit tel quel dans `schema_migrations`.
  pub name: &'static str,
  /// Le SQL, inclus au build depuis `migrations/`.
  pub sql: &'static str,
}

/// Les migrations connues de ce build, dans leur ordre d'application.
///
/// # Pièges
///
/// - ⚠️ L'ordre du tableau est l'ordre d'application, et les numéros se suivent depuis 1 sans
///   trou : un trou ferait sauter une migration sur les bases déjà installées.
pub const MIGRATIONS: &[Migration] = &[
  Migration {
    version: 1,
    name: "initial",
    sql: include_str!("migrations/001_initial.sql"),
  },
  Migration {
    version: 2,
    name: "user_prompts",
    sql: include_str!("migrations/002_user_prompts.sql"),
  },
  Migration {
    version: 3,
    name: "live_rename",
    sql: include_str!("migrations/003_live_rename.sql"),
  },
  Migration {
    version: 4,
    name: "drop_voices",
    sql: include_str!("migrations/004_drop_voices.sql"),
  },
  Migration {
    version: 5,
    name: "live_sessions_shape",
    sql: include_str!("migrations/005_live_sessions_shape.sql"),
  },
  Migration {
    version: 6,
    name: "live_sessions_preview",
    sql: include_str!("migrations/006_live_sessions_preview.sql"),
  },
  Migration {
    version: 7,
    name: "drop_retired_languages",
    sql: include_str!("migrations/007_drop_retired_languages.sql"),
  },
  Migration {
    version: 8,
    name: "report_prompts",
    sql: include_str!("migrations/008_report_prompts.sql"),
  },
];

/// Crée la table qui dit ce qui a déjà été appliqué, et quand.
///
/// Une table plutôt que `PRAGMA user_version` : elle garde l'historique complet des
/// migrations, ce qui vaut cher pour comprendre l'état d'une base chez un utilisateur.
const CREATE_MIGRATIONS_TABLE: &str = "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )";

/// Amène la base à la version la plus récente que ce build connaisse.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la table des migrations ne peut être créée, si la base est
/// plus récente que le code, ou si une migration échoue — sa transaction est alors annulée et
/// sa version n'est pas inscrite.
///
/// # Pièges
///
/// - ⚠️ Une base plus récente que le code est refusée, jamais ouverte : c'est le retour en
///   arrière après mise à jour, et y écrire produirait ce que l'ancienne version ne relit pas.
pub fn migrate(connection: &mut Connection, migrations: &[Migration]) -> Result<(), AppError> {
  connection
    .execute_batch(CREATE_MIGRATIONS_TABLE)
    .map_err(|error| AppError::Database(format!("table des migrations : {error}")))?;

  let applied = applied_version(connection)?;
  let latest = migrations.last().map_or(0, |migration| migration.version);

  if applied > latest {
    return Err(AppError::Database(format!(
      "la base est en version {applied}, cette version de l'application ne connaît que la \
       {latest} — installer une version plus récente de Mirmalion"
    )));
  }

  for migration in migrations
    .iter()
    .filter(|migration| migration.version > applied)
  {
    let transaction = connection
      .transaction()
      .map_err(|error| AppError::Database(format!("ouverture de transaction : {error}")))?;

    transaction.execute_batch(migration.sql).map_err(|error| {
      AppError::Database(format!(
        "migration {} ({}) : {error}",
        migration.version, migration.name
      ))
    })?;

    transaction
      .execute(
        "INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
        (migration.version, migration.name),
      )
      .map_err(|error| AppError::Database(format!("inscription de la migration : {error}")))?;

    transaction
      .commit()
      .map_err(|error| AppError::Database(format!("validation de la migration : {error}")))?;
  }

  Ok(())
}

/// La version du schéma en base, `0` si aucune migration n'a jamais été appliquée.
///
/// # Errors
///
/// Rend [`AppError::Database`] si `schema_migrations` ne peut pas être lue — table absente ou
/// base non déverrouillée.
pub fn applied_version(connection: &Connection) -> Result<i64, AppError> {
  connection
    .query_row(
      "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
      [],
      |row| row.get(0),
    )
    .map_err(|error| AppError::Database(format!("lecture de la version du schéma : {error}")))
}

/// La version que ce build sait produire.
pub fn latest_version() -> i64 {
  MIGRATIONS.last().map_or(0, |migration| migration.version)
}
