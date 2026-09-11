//! La base SQLCipher : ouverture, déverrouillage, migrations.
//!
//! Le fichier `.db` entier est chiffré. La clé vient du trousseau
//! ([`crate::security::key`]) et part en clé brute hexadécimale (`PRAGMA key = "x'…'"`) : pas
//! de dérivation, pas de mot de passe.
//!
//! # Pièges
//!
//! - ⚠️ `PRAGMA key` doit être la toute première instruction après l'ouverture. Toute requête
//!   émise avant laisse la base en clair, silencieusement.
//! - ⚠️ Le `Mutex` autour de la connexion est synchrone — `rusqlite::Connection` n'est pas
//!   `Sync` — et ne doit jamais être tenu à travers un `.await`. Toute opération passe par
//!   `spawn_blocking`, où le blocage est légitime ; voir `commands/db.rs`.
//! - ⚠️ La base est en WAL, donc **trois fichiers** : `.db`, `-wal` et `-shm`. Le mode s'inscrit
//!   dans l'en-tête, pas dans le code — voir [`PRAGMAS`].

pub mod schema;

use std::{
  path::{Path, PathBuf},
  sync::Mutex,
};

use rusqlite::Connection;

use crate::{error::AppError, security::key::EncryptionKey};

/// Le nom du fichier, dans `app_data_dir()`.
pub const DATABASE_FILE: &str = "mirmalion.db";

/// Les réglages posés sur la connexion, une fois la base déverrouillée.
///
/// # Pièges
///
/// - ⚠️ **L'ordre est imposé.** `journal_mode` lit la base pour changer de mode : sur une base
///   chiffrée il doit venir après `PRAGMA key` et après la lecture de contrôle d'[`unlock`].
/// - ⚠️ `journal_mode` rend une ligne de résultat. `execute_batch` l'accepte, `execute` refuse.
/// - ⚠️ En WAL, la base n'est plus un fichier mais trois : `-wal` et `-shm` la suivent. Aucun
///   code du crate n'y touche un par un — tout passe par le répertoire —, et c'est cette
///   propriété qu'il faudra revérifier avant d'écrire une sauvegarde ou une désinstallation.
const PRAGMAS: &str = "PRAGMA foreign_keys = ON;
   PRAGMA busy_timeout = 5000;
   PRAGMA journal_mode = WAL;";

/// La base ouverte et déverrouillée.
pub struct Database {
  connection: Mutex<Connection>,
}

/// Masqué à dessein : ni le chemin ni la clé n'ont à paraître dans une trace.
impl std::fmt::Debug for Database {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str("Database(<ouverte>)")
  }
}

impl Database {
  /// Ouvre la base — en la créant au premier lancement — et applique les migrations.
  ///
  /// Le répertoire parent est créé si besoin : `app_data_dir()` n'existe pas avant le premier
  /// écrit.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le répertoire parent ne peut être créé, et
  /// [`AppError::Database`] si le fichier ne s'ouvre pas, si la clé ne le déverrouille pas ou
  /// si une migration échoue.
  pub fn open(path: &Path, key: &EncryptionKey) -> Result<Self, AppError> {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)?;
    }

    let mut connection = Connection::open(path)
      .map_err(|error| AppError::Database(format!("ouverture de la base : {error}")))?;

    unlock(&connection, key)?;
    connection
      .execute_batch(PRAGMAS)
      .map_err(|error| AppError::Database(format!("réglage de la connexion : {error}")))?;

    schema::migrate(&mut connection, schema::MIGRATIONS)?;

    Ok(Self {
      connection: Mutex::new(connection),
    })
  }

  /// La version du schéma en base.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Database`] si le verrou est empoisonné ou si la table des migrations ne
  /// se lit pas.
  pub fn schema_version(&self) -> Result<i64, AppError> {
    let connection = self.lock()?;
    schema::applied_version(&connection)
  }

  /// Prend le verrou et rend la connexion.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Database`] si le `Mutex` est empoisonné, c'est-à-dire si un porteur du
  /// verrou a paniqué.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le verrou est synchrone : ne l'appeler que depuis un contexte bloquant, et ne jamais
  ///   garder le garde à travers un `.await`.
  pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AppError> {
    self
      .connection
      .lock()
      .map_err(|_| AppError::Database("la connexion à la base est empoisonnée".into()))
  }
}

/// Le chemin du fichier de base dans le répertoire de données de l'application.
pub fn database_path(data_dir: &Path) -> PathBuf {
  data_dir.join(DATABASE_FILE)
}

/// Déverrouille la base, puis vérifie que la clé était la bonne par une première lecture.
///
/// # Errors
///
/// Rend [`AppError::Database`] si `PRAGMA key` échoue, ou si la lecture de contrôle échoue —
/// fichier corrompu ou clé changée. Le message ne cite ni la clé ni le chemin.
///
/// # Pièges
///
/// - ⚠️ `PRAGMA key` ne signale rien par lui-même : sans la lecture de contrôle, une mauvaise
///   clé passerait inaperçue jusqu'à la première requête métier.
fn unlock(connection: &Connection, key: &EncryptionKey) -> Result<(), AppError> {
  connection
    .execute_batch(&format!("PRAGMA key = \"x'{}'\"", key.as_sqlcipher_hex()))
    .map_err(|error| AppError::Database(format!("déverrouillage : {error}")))?;

  connection
    .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
      row.get::<_, i64>(0)
    })
    .map_err(|_| {
      // ⚠️ Le message ne cite ni la clé ni le chemin : une trace ne porte pas de secret.
      AppError::Database(
        "la base est illisible avec la clé du trousseau — fichier corrompu ou clé changée".into(),
      )
    })?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{DATABASE_FILE, Database, database_path, schema};
  use crate::{error::AppError, security::key::EncryptionKey};
  use rusqlite::Connection;
  use std::path::PathBuf;

  /// Un répertoire de base jetable, supprimé à la fin du test.
  struct TempDir(PathBuf);

  impl TempDir {
    fn new(name: &str) -> Self {
      let path = std::env::temp_dir().join(format!("mirmalion-db-test-{name}"));
      let _ = std::fs::remove_dir_all(&path);
      Self(path)
    }

    fn db_path(&self) -> PathBuf {
      database_path(&self.0)
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn key(byte: char) -> EncryptionKey {
    EncryptionKey::from_hex(byte.to_string().repeat(64)).expect("clé valide")
  }

  /// Les trois réglages doivent être **en vigueur**, pas seulement envoyés : un `PRAGMA` mal
  /// placé ou refusé ne remonte aucune erreur, il est simplement sans effet.
  #[test]
  fn the_three_pragmas_are_really_in_force() {
    let dir = TempDir::new("pragmas");
    let database = Database::open(&dir.db_path(), &key('d')).expect("ouverture");
    let connection = database.lock().expect("verrou");

    let foreign_keys: i64 = connection
      .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
      .expect("lecture de foreign_keys");
    assert_eq!(foreign_keys, 1, "les clés étrangères doivent être actives");

    let busy_timeout: i64 = connection
      .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
      .expect("lecture de busy_timeout");
    assert_eq!(busy_timeout, 5_000);

    let journal_mode: String = connection
      .query_row("PRAGMA journal_mode", [], |row| row.get(0))
      .expect("lecture de journal_mode");
    assert_eq!(journal_mode, "wal", "le mode WAL doit avoir pris");
  }

  /// ⚠️ **Le fichier `-wal` porte les écritures récentes**, et il vit à côté de la base. S'il
  /// n'était pas chiffré, le mode WAL déposerait en clair sur le disque ce que la base protège —
  /// c'est-à-dire tout ce que l'utilisateur a dicté.
  #[test]
  fn the_wal_file_is_encrypted_like_the_base_itself() {
    let dir = TempDir::new("wal-secret");
    let secret = "rendez-vous mardi chez le notaire";

    let database = Database::open(&dir.db_path(), &key('e')).expect("ouverture");
    let connection = database.lock().expect("verrou");
    connection
      .execute_batch("CREATE TABLE fuite (texte TEXT);")
      .expect("création");
    connection
      .execute("INSERT INTO fuite (texte) VALUES (?1)", [secret])
      .expect("écriture");

    // ⚠️ Lu **connexion ouverte** : la fermeture replie le WAL dans la base et efface le fichier.
    // Le lire après ne prouverait rien — il n'existerait plus.
    let wal = dir.db_path().with_extension("db-wal");
    let bytes = std::fs::read(&wal).expect("le fichier -wal doit exister");
    assert!(!bytes.is_empty(), "le -wal doit porter l'écriture");
    assert!(
      !bytes
        .windows(secret.len())
        .any(|window| window == secret.as_bytes()),
      "le texte de l'utilisateur se lit en clair dans le fichier -wal"
    );
  }

  #[test]
  fn opening_creates_the_file_the_directory_and_the_schema() {
    let dir = TempDir::new("creation");
    let database = Database::open(&dir.db_path(), &key('a')).expect("ouverture");

    assert!(dir.db_path().exists(), "le fichier doit être créé");
    assert_eq!(
      database.schema_version().expect("version"),
      schema::latest_version()
    );
  }

  #[test]
  fn the_file_is_unreadable_without_the_key() {
    let dir = TempDir::new("encrypted");
    Database::open(&dir.db_path(), &key('b')).expect("ouverture");

    // Une connexion SQLite ordinaire, sans clé : le fichier ne doit pas se laisser lire.
    let plain = Connection::open(dir.db_path()).expect("ouverture brute");
    let read = plain.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
      row.get::<_, i64>(0)
    });
    assert!(
      read.is_err(),
      "un SQLite sans clé ne doit rien pouvoir lire"
    );

    // Et l'en-tête n'est pas celui d'un fichier SQLite en clair.
    let bytes = std::fs::read(dir.db_path()).expect("lecture du fichier");
    assert_ne!(
      &bytes[..15],
      b"SQLite format 3".as_slice(),
      "un fichier chiffré ne commence pas par l'en-tête SQLite"
    );
  }

  #[test]
  fn the_wrong_key_is_refused_with_a_clear_message() {
    let dir = TempDir::new("wrong-key");
    Database::open(&dir.db_path(), &key('c')).expect("création");

    let error = Database::open(&dir.db_path(), &key('d')).expect_err("clé différente");
    assert!(matches!(error, AppError::Database(_)));
    assert!(error.to_string().contains("illisible"));
    // Le message ne doit contenir aucune trace de la clé.
    assert!(!error.to_string().contains(&"c".repeat(8)));
    assert!(!error.to_string().contains(&"d".repeat(8)));
  }

  #[test]
  fn reopening_does_not_replay_the_migrations() {
    let dir = TempDir::new("idempotent");

    let first = Database::open(&dir.db_path(), &key('e')).expect("première ouverture");
    let applied: i64 = first
      .lock()
      .expect("verrou")
      .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
        row.get(0)
      })
      .expect("compte");
    drop(first);

    let second = Database::open(&dir.db_path(), &key('e')).expect("seconde ouverture");
    let applied_again: i64 = second
      .lock()
      .expect("verrou")
      .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
        row.get(0)
      })
      .expect("compte");

    assert_eq!(applied, applied_again, "les migrations ne se rejouent pas");
  }

  #[test]
  fn a_database_newer_than_the_code_is_refused_without_being_touched() {
    let dir = TempDir::new("from-the-future");
    let database = Database::open(&dir.db_path(), &key('f')).expect("création");

    // Simule une base écrite par une version ultérieure de l'application.
    database
      .lock()
      .expect("verrou")
      .execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'futur', 'x')",
        [],
      )
      .expect("insertion");
    drop(database);

    let error = Database::open(&dir.db_path(), &key('f')).expect_err("version trop récente");
    assert!(error.to_string().contains("version 99"));
    assert!(error.to_string().contains("plus récente"));

    // Le fichier n'a pas été abîmé : il reste ouvrable une fois la ligne retirée.
    let connection = Connection::open(dir.db_path()).expect("ouverture brute");
    connection
      .execute_batch(&format!("PRAGMA key = \"x'{}'\"", "f".repeat(64)))
      .expect("déverrouillage");
    connection
      .execute("DELETE FROM schema_migrations WHERE version = 99", [])
      .expect("retrait");
    drop(connection);

    assert_eq!(
      Database::open(&dir.db_path(), &key('f'))
        .expect("réouverture")
        .schema_version()
        .expect("version"),
      schema::latest_version()
    );
  }

  #[test]
  fn a_failing_migration_leaves_nothing_behind() {
    let dir = TempDir::new("failing-migration");
    let database = Database::open(&dir.db_path(), &key('1')).expect("création");
    let mut connection = database.lock().expect("verrou");

    let broken = [schema::Migration {
      // ⚠️ **Au-dessus du dernier numéro livré, et pas « le suivant ».** Une migration dont
      // le numéro est déjà appliqué n'est pas rejouée : le test passerait sans rien exercer.
      version: 999,
      name: "cassee",
      // La première instruction passe, la seconde échoue : sans transaction, la table
      // resterait derrière.
      sql: "CREATE TABLE moitie (id INTEGER); CECI N'EST PAS DU SQL;",
    }];

    let error = schema::migrate(&mut connection, &broken).expect_err("la migration doit échouer");
    assert!(matches!(error, AppError::Database(_)));

    let leftover: i64 = connection
      .query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'moitie'",
        [],
        |row| row.get(0),
      )
      .expect("compte");
    assert_eq!(leftover, 0, "la transaction doit avoir tout annulé");

    let version = schema::applied_version(&connection).expect("version");
    assert_eq!(
      version,
      schema::latest_version(),
      "une migration échouée ne s'inscrit pas : la base reste où elle était"
    );
  }

  #[test]
  fn deleting_a_dictionary_term_takes_its_variants_with_it() {
    let dir = TempDir::new("dictionary-cascade");
    let database = Database::open(&dir.db_path(), &key('4')).expect("création");
    let connection = database.lock().expect("verrou");

    connection
      .execute_batch(
        "INSERT INTO dictionary_terms (id, term, created_at)
           VALUES (1, 'Mirmalion', '2026-07-28T00:00:00Z');
         INSERT INTO dictionary_variants (term_id, variant) VALUES (1, 'mirmalyon');",
      )
      .expect("jeu d'essai");

    connection
      .execute("DELETE FROM dictionary_terms WHERE id = 1", [])
      .expect("suppression");

    let variants: i64 = connection
      .query_row("SELECT count(*) FROM dictionary_variants", [], |row| {
        row.get(0)
      })
      .expect("compte");
    assert_eq!(variants, 0);
  }

  #[test]
  fn every_table_of_the_schema_exists() {
    let dir = TempDir::new("schema-shape");
    let database = Database::open(&dir.db_path(), &key('5')).expect("création");
    let connection = database.lock().expect("verrou");

    for table in [
      "dictations",
      "dictionary_terms",
      "dictionary_variants",
      "live_sessions",
      "report_prompts",
      "user_prompts",
    ] {
      assert_eq!(
        compte_table(&connection, table),
        1,
        "la table {table} doit exister"
      );
    }
  }

  /// ⚠️ **L'unicité des titres est SANS CASSE**, et c'est l'index qui la tient : « Client » et
  /// « client » sont le même titre dans un menu déroulant, et deux lignes indistinguables à
  /// l'œil rendraient le choix du prompt par défaut incompréhensible.
  #[test]
  fn two_prompt_titles_cannot_differ_by_case_alone() {
    let dir = TempDir::new("report-prompts-title");
    let database = Database::open(&dir.db_path(), &key('6')).expect("création");
    let connection = database.lock().expect("verrou");

    connection
      .execute(
        "INSERT INTO report_prompts (title, prompt, created_at, updated_at)
         VALUES ('Client', 'Décisions et tâches.', '2026-09-07T10:00:00Z', '2026-09-07T10:00:00Z')",
        [],
      )
      .expect("premier titre");

    let second = connection.execute(
      "INSERT INTO report_prompts (title, prompt, created_at, updated_at)
       VALUES ('client', 'Autre chose.', '2026-09-07T10:01:00Z', '2026-09-07T10:01:00Z')",
      [],
    );

    assert!(
      second.is_err(),
      "le même titre à la casse près doit être refusé"
    );
  }

  /// ⚠️ Aucune empreinte vocale ne peut être écrite : la table n'existe plus. Une table vide
  /// aurait laissé la porte ouverte ; ce test exige qu'il n'y ait plus de porte, ce qui est la
  /// seule façon de rendre vraie sans exception la promesse « aucune donnée biométrique n'est
  /// conservée ». Il vaut aussi pour `live_session_participants`, qui portait « Locuteur 1 » et
  /// le nom que l'utilisateur donnait à chacun.
  #[test]
  fn the_biometric_tables_are_gone_and_cannot_come_back_unnoticed() {
    let dir = TempDir::new("no-biometrics");
    let database = Database::open(&dir.db_path(), &key('9')).expect("création");
    let connection = database.lock().expect("verrou");

    for table in ["voices", "live_session_participants"] {
      assert_eq!(
        compte_table(&connection, table),
        0,
        "la table {table} doit avoir disparu"
      );
    }
  }

  /// Combien de tables portent ce nom — `0` ou `1`.
  fn compte_table(connection: &rusqlite::Connection, table: &str) -> i64 {
    connection
      .query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
      )
      .expect("recherche")
  }

  /// ⚠️ La migration `003` est la seule qui pouvait détruire un historique : un
  /// `ALTER TABLE … RENAME` est censé tout conserver — données, contraintes, clés étrangères —
  /// mais « censé » ne suffit pas quand l'historique de l'utilisateur est en jeu.
  ///
  /// ⚠️ On part d'une base en version 2, comme celles déjà installées, et non d'une base
  /// neuve : une base neuve appliquerait les trois migrations d'affilée et ne prouverait rien
  /// sur la reprise.
  #[test]
  fn the_rename_migration_carries_an_existing_history_across() {
    let mut connection = Connection::open_in_memory().expect("base en mémoire");
    schema::migrate(&mut connection, &schema::MIGRATIONS[..2]).expect("base en version 2");
    assert_eq!(schema::applied_version(&connection).expect("version"), 2);

    connection
      .execute_batch(
        "INSERT INTO meetings (id, title, started_at, duration_seconds, language, transcript)
           VALUES (7, 'Point produit', '2026-08-05T14:30:00Z', 1800, 'fr', 'Bonjour à tous.');
         INSERT INTO meeting_participants (meeting_id, speaker_label, display_name)
           VALUES (7, 'Locuteur 1', 'Alice');
         INSERT INTO user_prompts (usage, prompt, updated_at)
           VALUES ('meeting_report', 'En trois parties.', '2026-08-05T14:31:00Z');",
      )
      .expect("historique d'avant le renommage");

    // ⚠️ **On s'arrête à la version 3**, celle que ce test éprouve : la 4 supprime la table des
    // participants, dont on veut précisément vérifier ici qu'elle a traversé le renommage.
    schema::migrate(&mut connection, &schema::MIGRATIONS[..3]).expect("montée en version 3");
    assert_eq!(schema::applied_version(&connection).expect("version"), 3);

    let (title, transcript): (String, String) = connection
      .query_row(
        "SELECT title, transcript FROM live_sessions WHERE id = 7",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
      )
      .expect("la session a survécu");
    assert_eq!(title, "Point produit");
    assert_eq!(transcript, "Bonjour à tous.");

    // La colonne de rattachement a changé de nom **sans lâcher sa ligne**.
    let name: String = connection
      .query_row(
        "SELECT display_name FROM live_session_participants WHERE live_session_id = 7",
        [],
        |row| row.get(0),
      )
      .expect("le participant a survécu");
    assert_eq!(name, "Alice");

    // Et le prompt personnalisé a suivi son usage, sans être réécrit.
    let prompt: String = connection
      .query_row(
        "SELECT prompt FROM user_prompts WHERE usage = 'live_report'",
        [],
        |row| row.get(0),
      )
      .expect("le prompt a suivi");
    assert_eq!(prompt, "En trois parties.");
  }

  /// ⚠️ La migration 4 supprime des tables sur une base qui en contient déjà, et l'ordre des
  /// deux `DROP` n'est pas indifférent : `live_session_participants` référence `voices`, et
  /// `PRAGMA foreign_keys` est actif à chaque ouverture. Retirer la référencée d'abord ferait
  /// échouer la migration — sur les bases déjà installées seulement, donc jamais en
  /// développement.
  #[test]
  fn the_drop_migration_applies_to_a_base_that_carried_rows() {
    let mut connection = Connection::open_in_memory().expect("base en mémoire");
    connection
      .execute_batch("PRAGMA foreign_keys = ON;")
      .expect("clés étrangères");
    schema::migrate(&mut connection, &schema::MIGRATIONS[..3]).expect("base en version 3");

    connection
      .execute_batch(
        "INSERT INTO voices (id, display_name, embedding, created_at)
           VALUES (1, 'Alice', x'0102', '2026-08-05T00:00:00Z');
         INSERT INTO live_sessions (id, title, started_at, duration_seconds, language, transcript)
           VALUES (1, 'Point hebdo', '2026-08-05T09:00:00Z', 600, 'fr', 'Bonjour.');
         INSERT INTO live_session_participants (live_session_id, speaker_label, display_name, voice_id)
           VALUES (1, 'Locuteur 1', 'Alice', 1);",
      )
      .expect("historique d'avant le retrait");

    schema::migrate(&mut connection, &schema::MIGRATIONS[..4]).expect("montée en version 4");

    // ⚠️ **La session, elle, survit AU RETRAIT DES LOCUTEURS** : on retire les étiquettes, pas
    // l'historique. ⚠️ **On s'arrête donc à la version 4** : la 5 reforme cette table, et elle
    // a sa propre raison de le pouvoir — aucune ligne n'a jamais été écrite par le produit.
    let title: String = connection
      .query_row("SELECT title FROM live_sessions WHERE id = 1", [], |row| {
        row.get(0)
      })
      .expect("la session a survécu");
    assert_eq!(title, "Point hebdo");
  }

  /// ⚠️ La migration 5 reforme `live_sessions` en la recréant plutôt qu'en l'altérant, et elle
  /// ne le peut que parce que rien n'y avait jamais été écrit. Le test part d'une base déjà
  /// installée par la 4 : l'écrire à froid ne prouverait rien de ce qui arrivera sur les
  /// machines.
  #[test]
  fn the_reshape_migration_gives_the_table_the_columns_the_product_writes() {
    let mut connection = Connection::open_in_memory().expect("base en mémoire");
    schema::migrate(&mut connection, &schema::MIGRATIONS[..4]).expect("base en version 4");
    schema::migrate(&mut connection, schema::MIGRATIONS).expect("montée au dernier schéma");

    let mut statement = connection
      .prepare("SELECT name FROM pragma_table_info('live_sessions') ORDER BY cid")
      .expect("colonnes");
    let columns: Vec<String> = statement
      .query_map([], |row| row.get(0))
      .expect("colonnes")
      .collect::<Result<_, _>>()
      .expect("colonnes");

    assert_eq!(
      columns,
      vec![
        "id",
        "title",
        "source_name",
        "started_at",
        "ended_at",
        "language",
        "transcript",
        "report",
        "translation_target",
        // ⚠️ **En queue, parce que la 6 l'AJOUTE** : `ALTER TABLE … ADD COLUMN` pose toujours la
        // colonne en dernier. L'ordre attendu ici est donc celui de l'histoire des migrations,
        // pas celui du `CREATE TABLE` de la 5.
        "preview"
      ]
    );

    // ⚠️ **Le titre doit pouvoir être NULL** : « l'utilisateur ne l'a pas nommée » est le cas
    // courant, et le repli daté se compose à l'écran, dans la langue de l'interface.
    connection
      .execute(
        "INSERT INTO live_sessions
           (title, source_name, started_at, ended_at, language, transcript)
         VALUES (NULL, 'Tout le système', '2026-08-05T09:00:00Z', '2026-08-05T09:10:00Z',
                 'fr', '{}')",
        [],
      )
      .expect("une session sans titre s'écrit");
  }

  /// ⚠️ La migration 7 **supprime des lignes de l'utilisateur**, ce qu'aucune autre ne fait. Elle
  /// part donc d'une base déjà remplie : appliquée à froid, elle passerait sur une base vide et
  /// ne prouverait rien de ce qui arrivera sur les machines.
  ///
  /// ⚠️ Les deux moitiés comptent autant l'une que l'autre. Une ligne **parlée** dans une langue
  /// retirée s'en va ; une ligne parlée dans une langue du périmètre et seulement **traduite**
  /// vers une langue retirée reste, allégée de sa traduction. Sans la seconde assertion, une
  /// migration qui effacerait tout passerait ce test.
  #[test]
  fn the_retired_languages_migration_drops_them_without_touching_the_rest() {
    let mut connection = Connection::open_in_memory().expect("base en mémoire");
    schema::migrate(&mut connection, &schema::MIGRATIONS[..6]).expect("base en version 6");

    connection
      .execute_batch(
        "INSERT INTO dictations (id, created_at, language, raw_text)
           VALUES (1, '2026-08-05T09:00:00Z', 'ja', 'dictée en langue retirée');
         INSERT INTO dictations
           (id, created_at, language, raw_text, translated_text, translated_language)
           VALUES (2, '2026-08-05T09:01:00Z', 'fr', 'Bonjour', 'traduite ailleurs', 'ja');
         INSERT INTO dictations (id, created_at, language, raw_text)
           VALUES (3, '2026-08-05T09:02:00Z', 'fr', 'Intacte');
         INSERT INTO live_sessions
           (id, source_name, started_at, ended_at, language, transcript, translation_target)
           VALUES (1, 'Teams', '2026-08-05T10:00:00Z', '2026-08-05T10:10:00Z', 'ko', '{}', NULL);
         INSERT INTO live_sessions
           (id, source_name, started_at, ended_at, language, transcript, translation_target)
           VALUES (2, 'Teams', '2026-08-05T11:00:00Z', '2026-08-05T11:10:00Z', 'fr', '{}', 'zh');",
      )
      .expect("une base d'avant le retrait");

    schema::migrate(&mut connection, schema::MIGRATIONS).expect("montée au dernier schéma");

    let dictations: Vec<(i64, String, Option<String>, Option<String>)> = connection
      .prepare(
        "SELECT id, language, translated_text, translated_language FROM dictations ORDER BY id",
      )
      .expect("requête")
      .query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
      })
      .expect("dictées")
      .collect::<Result<_, _>>()
      .expect("dictées");
    assert_eq!(
      dictations,
      vec![
        // La dictée 1, parlée dans une langue retirée, n'est plus là.
        (2, "fr".to_owned(), None, None),
        (3, "fr".to_owned(), None, None),
      ],
      "la dictée française garde son texte et perd sa seule traduction"
    );

    let sessions: Vec<(i64, String, Option<String>)> = connection
      .prepare("SELECT id, language, translation_target FROM live_sessions ORDER BY id")
      .expect("requête")
      .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
      .expect("sessions")
      .collect::<Result<_, _>>()
      .expect("sessions");
    assert_eq!(sessions, vec![(2, "fr".to_owned(), None)]);
  }

  #[test]
  fn latest_version_matches_the_embedded_migrations() {
    // Le nombre est écrit en toutes lettres à dessein : ajouter une migration doit être un
    // geste conscient, pas un test qui se met à jour tout seul.
    assert_eq!(schema::latest_version(), 8);

    // Et les numéros se suivent depuis 1, sans trou ni doublon — un trou ferait sauter une
    // migration sur les bases déjà installées.
    let versions: Vec<i64> = schema::MIGRATIONS
      .iter()
      .map(|migration| migration.version)
      .collect();
    assert_eq!(
      versions,
      (1..=schema::latest_version()).collect::<Vec<_>>(),
      "les migrations doivent être numérotées 1, 2, 3… sans trou"
    );
  }

  #[test]
  fn the_database_lives_next_to_the_other_application_data() {
    let path = database_path(&PathBuf::from("/tmp/données"));
    assert_eq!(path, PathBuf::from("/tmp/données").join(DATABASE_FILE));
  }
}
