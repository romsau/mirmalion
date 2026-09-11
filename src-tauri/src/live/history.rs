//! L'historique des sessions : ce qui s'archive, ce qui se purge, et ce qui n'entre jamais.
//!
//! La purge tourne au lancement et à chaque ouverture du panneau — pas de tâche à réveiller.
//!
//! # Pièges
//!
//! - ⚠️ Aucun audio n'entre ici : les deux fichiers d'une session vivent dans le cache le temps de
//!   la consolidation, que `live::finalise` supprime même quand elle échoue. On n'archive donc que
//!   du texte.
//! - ⚠️ La rétention se compte en ancienneté, jamais en nombre — l'inverse de la dictée : un
//!   plafond en nombre dépendrait de la fréquence des sessions, donc purgerait un mois
//!   d'historique chez l'un et deux ans chez l'autre.
//! - ⚠️ Réduire le réglage s'applique tout de suite et en arrière. « Sans limite » ne purge rien et
//!   ne se traduit pas par une date très ancienne : une borne, même lointaine, serait atteinte.

use rusqlite::Connection;

use crate::{error::AppError, transcript::Transcript};

use super::{documents::LiveDocument, report::ReportSection};

/// Ce que le panneau d'historique lit d'une session archivée.
///
/// # Pièges
///
/// - ⚠️ `title` reste `Option` : `None` veut dire « l'utilisateur ne l'a pas nommée », et le repli
///   daté se compose côté écran avec `Intl`. L'écrire en base le figerait dans la langue du jour.
/// - ⚠️ Les instants voyagent en millisecondes alors que la base les range en ISO 8601 UTC : la
///   conversion se fait en SQL — voir [`archive`] —, une seule forme vivant dans la colonne.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSession {
  pub id: i64,
  pub title: Option<String>,
  pub source_name: String,
  pub started_at_ms: i64,
  pub ended_at_ms: i64,
  pub language: String,
  pub transcript: Transcript,
  /// Les rubriques du compte rendu, vides quand il n'y en a pas — et ce n'est pas un échec : le
  /// compte rendu est un geste, l'arrêt d'une session ne génère rien.
  pub report: Vec<ReportSection>,
  pub translation_target: Option<String>,
}

/// Ce que le panneau lit d'une session — et rien de plus.
///
/// La requête de [`summaries`] ne touche jamais aux colonnes `transcript` et `report` ; c'est
/// [`find`], sur une session, qui les lit, au moment où une fenêtre va les afficher.
///
/// # Pièges
///
/// - ⚠️ Le transcript ne traverse pas le pont pour remplir une liste : une session d'une heure pèse
///   quelques centaines de kilo-octets de JSON, le panneau en affiche deux lignes, et les rendre
///   entiers ferait transférer des dizaines de méga-octets à chaque ouverture de l'écran.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
  pub id: i64,
  pub title: Option<String>,
  pub source_name: String,
  pub started_at_ms: i64,
  pub ended_at_ms: i64,
  /// Le début du transcript, pour la recherche.
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est un début, pas une recherche plein texte : un mot prononcé à la quarantième minute
  ///   ne se trouve pas. Le plein texte demande FTS5 et un index à tenir à jour.
  /// - ⚠️ Le filtrage lui-même est côté écran, avec repli des accents : SQLCipher n'embarque pas
  ///   ICU, et SQLite ne sait donc pas rapprocher « résumé » de « resume ».
  pub preview: String,
  /// Y a-t-il un compte rendu ? ⚠️ Un booléen, jamais les rubriques — voir [`SessionSummary`].
  pub has_report: bool,
}

/// Combien de caractères du transcript entrent dans l'aperçu de recherche.
///
/// # Pièges
///
/// - ⚠️ Assez pour identifier une session, assez peu pour en tenir mille : six cents caractères,
///   c'est l'ouverture d'une réunion, et 600 Ko pour un historique de mille sessions.
const PREVIEW_CHARS: usize = 600;

/// Le fragment SQL qui rend un instant en millisecondes depuis une colonne ISO.
///
/// # Pièges
///
/// - ⚠️ `'%s'` rend des secondes : la session perd ses millisecondes en traversant la base. C'est
///   sans conséquence — date et durée s'affichent à la seconde — et c'est le prix de la forme ISO,
///   qui rend la colonne triable sans conversion, donc la purge possible en une seule requête.
const MS_FROM_ISO: &str = "CAST(strftime('%s', {column}) AS INTEGER) * 1000";

/// [`MS_FROM_ISO`] appliqué à une colonne nommée.
fn ms_from(column: &str) -> String {
  MS_FROM_ISO.replace("{column}", column)
}

/// Le modificateur SQLite d'un palier de rétention, ou `None` pour « sans limite ».
///
/// # Pièges
///
/// - ⚠️ Une valeur inconnue retombe sur le défaut, elle ne désactive pas la purge : le fichier de
///   réglages est un JSON en clair, éditable à la main, et traduire une faute de frappe en « sans
///   limite » en ferait une désactivation silencieuse.
/// - ⚠️ Seul `"unlimited"`, écrit exactement, désactive la purge.
pub fn retention_cutoff(retention: &str) -> Option<&'static str> {
  match retention {
    "unlimited" => None,
    "30d" => Some("-30 days"),
    "3m" => Some("-3 months"),
    "1y" => Some("-1 year"),
    // ⚠️ `"6m"` **et** tout le reste : six mois est le défaut, et un réglage abîmé doit s'y
    // ramener plutôt que d'ouvrir une porte.
    _ => Some("-6 months"),
  }
}

/// Archive une session terminée, et rend l'identifiant de sa ligne.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la sérialisation ou l'insertion échoue.
///
/// # Pièges
///
/// - ⚠️ Appelée à la consolidation, pas à la fermeture de la fenêtre : une fenêtre-session reste
///   ouverte, et attendre perdrait toute session encore affichée à l'arrêt de l'application.
/// - ⚠️ La conversion des instants se fait en SQL : `strftime` rend la même forme ISO 8601 UTC que
///   le reste du schéma, sans dépendance de temps ni second format dans la colonne.
pub fn archive(connection: &Connection, document: &LiveDocument) -> Result<i64, AppError> {
  let transcript = json(&document.transcript, "le transcript de la session")?;
  let report = report_json(&document.report)?;

  connection
    .execute(
      "INSERT INTO live_sessions
         (title, source_name, started_at, ended_at, language, transcript, report,
          translation_target, preview)
       VALUES (?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%SZ', ?3 / 1000, 'unixepoch'),
               strftime('%Y-%m-%dT%H:%M:%SZ', ?4 / 1000, 'unixepoch'),
               ?5, ?6, ?7, ?8, ?9)",
      rusqlite::params![
        document.title,
        document.source_name,
        document.started_at_ms as i64,
        // ⚠️ **Une session non terminée n'a pas à être archivée**, et le repli sur son début
        // est là pour qu'un appel fautif range une durée nulle plutôt qu'une date de 1970.
        document.ended_at_ms.unwrap_or(document.started_at_ms) as i64,
        document.transcript.language,
        transcript,
        report,
        document.translation_target,
        // ⚠️ **Calculé à l'archivage, une fois pour toutes.** Le transcript ne change plus après
        // la consolidation : le recalculer à chaque ouverture du panneau reviendrait à relire
        // tout ce que cette colonne existe précisément pour ne plus relire.
        preview(&document.transcript),
      ],
    )
    // ⚠️ **Aucun contenu de session dans le message**, pas même par l'erreur SQL : un transcript
    // est du contenu utilisateur, et un journal dit ce qui a échoué, jamais sur quoi.
    .map_err(|_| AppError::Database("archivage de la session".to_owned()))?;

  Ok(connection.last_insert_rowid())
}

/// Met à jour le compte rendu d'une session déjà archivée.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la sérialisation ou l'écriture échoue.
///
/// # Pièges
///
/// - ⚠️ Sans effet si la ligne n'existe plus : elle a pu être purgée entre-temps, et refuser ici
///   ferait échouer une génération qui, elle, a parfaitement réussi.
pub fn set_report(
  connection: &Connection,
  id: i64,
  report: &[ReportSection],
) -> Result<(), AppError> {
  let report = report_json(report)?;
  connection
    .execute(
      "UPDATE live_sessions SET report = ?2 WHERE id = ?1",
      rusqlite::params![id, report],
    )
    .map(|_| ())
    .map_err(|_| AppError::Database("mise à jour du compte rendu".to_owned()))
}

/// Met à jour le titre d'une session déjà archivée. Sans effet si la ligne n'existe plus.
///
/// # Errors
///
/// Rend [`AppError::Database`] si l'écriture échoue.
pub fn rename(connection: &Connection, id: i64, title: Option<&str>) -> Result<(), AppError> {
  connection
    .execute(
      "UPDATE live_sessions SET title = ?2 WHERE id = ?1",
      rusqlite::params![id, title],
    )
    .map(|_| ())
    .map_err(|_| AppError::Database("renommage de la session".to_owned()))
}

/// Supprime les sessions plus anciennes que le palier, et rend le nombre de lignes parties.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la suppression échoue.
///
/// # Pièges
///
/// - ⚠️ Un vrai `DELETE`, jamais un drapeau : un `deleted = 1` laisserait le transcript sur le
///   disque, dans un fichier qu'on présente comme purgé.
/// - ⚠️ La borne se calcule par SQLite à partir de `'now'`, avec la même horloge et le même format
///   que ceux qui ont écrit la colonne : aucune dérive possible entre les deux.
pub fn purge(connection: &Connection, retention: &str) -> Result<usize, AppError> {
  let Some(cutoff) = retention_cutoff(retention) else {
    return Ok(0);
  };
  connection
    .execute(
      "DELETE FROM live_sessions
        WHERE started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)",
      rusqlite::params![cutoff],
    )
    .map_err(|error| AppError::Database(format!("purge de l'historique : {error}")))
}

/// L'historique du panneau, du plus récent au plus ancien.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la lecture échoue.
///
/// # Pièges
///
/// - ⚠️ Rendu en entier, mais en résumés : la purge borne cette liste dans le temps, et la recherche
///   filtre côté écran, tolérante aux accents là où SQLite ne rapproche pas « résumé » de
///   « resume » sans ICU. Les transcripts, eux, ne franchissent pas le pont — [`SessionSummary`].
pub fn summaries(connection: &Connection) -> Result<Vec<SessionSummary>, AppError> {
  let sql = format!(
    "SELECT id, title, source_name, {started}, {ended}, preview, report IS NOT NULL
       FROM live_sessions
      ORDER BY started_at DESC, id DESC",
    started = ms_from("started_at"),
    ended = ms_from("ended_at"),
  );
  let mut statement = connection
    .prepare(&sql)
    .map_err(|error| AppError::Database(format!("lecture de l'historique : {error}")))?;

  let rows = statement
    .query_map([], |row| {
      Ok(SessionSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        source_name: row.get(2)?,
        started_at_ms: row.get(3)?,
        ended_at_ms: row.get(4)?,
        preview: row.get(5)?,
        has_report: row.get(6)?,
      })
    })
    .map_err(|error| AppError::Database(format!("lecture de l'historique : {error}")))?;

  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| AppError::Database(format!("lecture de l'historique : {error}")))
}

/// Une session entière, transcript et compte rendu compris. `None` si la ligne n'existe plus.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la lecture échoue ou si le transcript stocké est illisible.
///
/// # Pièges
///
/// - ⚠️ `None` et non une erreur : la ligne a pu être purgée depuis que le panneau l'a listée, et
///   c'est un cas normal — l'écran le dira, il n'y a rien à réparer.
/// - ⚠️ Un transcript illisible fait échouer cette lecture seule, et le message ne nomme pas la
///   session : ce serait du contenu utilisateur.
pub fn find(connection: &Connection, id: i64) -> Result<Option<ArchivedSession>, AppError> {
  let sql = format!(
    "SELECT id, title, source_name, {started}, {ended}, language, transcript, report,
            translation_target
       FROM live_sessions
      WHERE id = ?1",
    started = ms_from("started_at"),
    ended = ms_from("ended_at"),
  );

  let found = connection
    .query_row(&sql, rusqlite::params![id], |row| {
      let transcript: String = row.get(6)?;
      let report: Option<String> = row.get(7)?;
      Ok((
        ArchivedSession {
          id: row.get(0)?,
          title: row.get(1)?,
          source_name: row.get(2)?,
          started_at_ms: row.get(3)?,
          ended_at_ms: row.get(4)?,
          language: row.get(5)?,
          transcript: Transcript::of(&[], ""),
          report: Vec::new(),
          translation_target: row.get(8)?,
        },
        transcript,
        report,
      ))
    })
    .map(Some)
    .or_else(|error| match error {
      rusqlite::Error::QueryReturnedNoRows => Ok(None),
      _ => Err(AppError::Database("lecture d'une session".to_owned())),
    })?;

  let Some((mut session, transcript, report)) = found else {
    return Ok(None);
  };
  session.transcript = serde_json::from_str::<Transcript>(&transcript)
    .map_err(|_| AppError::Database("le transcript de cette session est illisible".to_owned()))?;
  session.report = report
    .and_then(|raw| serde_json::from_str::<Vec<ReportSection>>(&raw).ok())
    .unwrap_or_default();
  Ok(Some(session))
}

/// Supprime une session. Rend `true` si une ligne est partie.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la suppression échoue.
///
/// # Pièges
///
/// - ⚠️ Supprimer ce qui n'existe plus n'est pas une erreur : le panneau peut cliquer sur une ligne
///   que la purge vient d'emporter, et une snackbar rouge sur un historique à jour serait fausse.
pub fn delete(connection: &Connection, id: i64) -> Result<bool, AppError> {
  connection
    .execute(
      "DELETE FROM live_sessions WHERE id = ?1",
      rusqlite::params![id],
    )
    .map(|rows| rows > 0)
    .map_err(|_| AppError::Database("suppression d'une session".to_owned()))
}

/// Vide l'historique, et rend le nombre de sessions parties.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la suppression échoue.
///
/// # Pièges
///
/// - ⚠️ La question se pose à l'écran, pas ici : cette fonction ne demande rien et ne peut pas être
///   annulée, c'est la modale de confirmation qui protège ce geste.
pub fn clear(connection: &Connection) -> Result<usize, AppError> {
  connection
    .execute("DELETE FROM live_sessions", [])
    .map_err(|_| AppError::Database("vidage de l'historique".to_owned()))
}

/// Ce qu'un « copier » met dans le presse-papier : le compte rendu s'il existe, sinon le
/// transcript.
///
/// # Pièges
///
/// - ⚠️ Jamais rien : le presse-papier ne donne aucun retour, et un bouton qui y met le vide est
///   indiscernable d'un bouton cassé. Une session sans compte rendu est le cas par défaut.
/// - ⚠️ Sans retour à la ligne final : coller ajouterait une ligne vide au milieu du message où
///   l'on colle, là où un fichier exporté, lui, se termine par une fin de ligne.
pub fn copyable_text(session: &ArchivedSession) -> String {
  let text = if session.report.is_empty() {
    crate::export::plain_text("", &session.transcript.rendered())
  } else {
    // ⚠️ **Le même rendu que l'export**, et non un second à côté : deux façons d'écrire le même
    // compte rendu divergeraient à la première correction, et c'est celle qu'on n'a pas mise à
    // jour qui finirait dans le presse-papier.
    crate::export::report::plain_text("", &session.report)
  };
  text.trim_end().to_owned()
}

/// Le début du transcript, borné à [`PREVIEW_CHARS`] caractères — jamais octets.
///
/// # Pièges
///
/// - ⚠️ Couper sur des octets casserait un caractère accentué en deux, et la colonne porterait une
///   chaîne invalide : cinq des six langues s'écrivent avec des accents.
fn preview(transcript: &Transcript) -> String {
  transcript
    .plain_text()
    .chars()
    .take(PREVIEW_CHARS)
    .collect()
}

/// Sérialise le compte rendu, ou `None` quand il n'y en a pas.
///
/// # Errors
///
/// Rend [`AppError::Database`] si les rubriques ne se sérialisent pas.
///
/// # Pièges
///
/// - ⚠️ `NULL` et non `"[]"` : la colonne dit « il n'y en a pas », là où une liste vide de
///   rubriques dirait « il y en a un, il est vide » — deux états que l'écran distingue.
fn report_json(report: &[ReportSection]) -> Result<Option<String>, AppError> {
  if report.is_empty() {
    return Ok(None);
  }
  json(report, "le compte rendu de la session").map(Some)
}

/// Sérialise une valeur pour la base, `what` nommant ce qui est en cause — jamais son contenu.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la sérialisation échoue.
fn json<T: serde::Serialize + ?Sized>(value: &T, what: &str) -> Result<String, AppError> {
  serde_json::to_string(value).map_err(|_| AppError::Database(format!("{what} est illisible")))
}

#[cfg(test)]
mod tests {
  use super::{
    archive, clear, copyable_text, delete, find, purge, rename, retention_cutoff, set_report,
    summaries,
  };
  use crate::db::schema;
  use crate::live::documents::LiveDocument;
  use crate::live::report::ReportSection;
  use crate::transcript::{Transcript, Word};
  use rusqlite::Connection;

  /// Une base au dernier schéma, en mémoire.
  fn base() -> Connection {
    let mut connection = Connection::open_in_memory().expect("base en mémoire");
    schema::migrate(&mut connection, schema::MIGRATIONS).expect("schéma");
    connection
  }

  fn word(text: &str, start: u64) -> Word {
    Word {
      text: text.to_owned(),
      start_ms: start,
      end_ms: start + 400,
    }
  }

  /// Une session terminée, telle que la consolidation la rend.
  fn finished() -> LiveDocument {
    LiveDocument {
      id: "directdoc-0".into(),
      title: None,
      source_name: "Microsoft Teams".into(),
      started_at_ms: 1_754_300_000_000,
      ended_at_ms: Some(1_754_303_600_000),
      transcript: Transcript::of(&[word("Bon,", 0), word("on", 500)], "fr"),
      report: Vec::new(),
      translation_target: Some("en".into()),
      archived: None,
    }
  }

  /// Écrit une session **datée**, sans passer par le document : la purge se mesure sur des
  /// dates, et forcer la date est la seule façon de l'éprouver sans attendre six mois.
  fn dated(connection: &Connection, started_at: &str) {
    connection
      .execute(
        "INSERT INTO live_sessions
           (title, source_name, started_at, ended_at, language, transcript)
         VALUES (NULL, 'Tout le système', ?1, ?1, 'fr', '{\"language\":\"fr\",\"paragraphs\":[]}')",
        rusqlite::params![started_at],
      )
      .expect("session datée");
  }

  /// La session entière, telle qu'une fenêtre la rouvrirait.
  fn read(connection: &Connection, id: i64) -> super::ArchivedSession {
    find(connection, id)
      .expect("relecture")
      .expect("la session")
  }

  fn count(connection: &Connection) -> i64 {
    connection
      .query_row("SELECT COUNT(*) FROM live_sessions", [], |row| row.get(0))
      .expect("compte")
  }

  /// ⚠️ Une session s'archive entière, et sans un octet d'audio. Le transcript garde ses mots
  /// horodatés : c'est ce dont l'export a besoin pour rendre du SRT et du VTT, et les mettre à
  /// plat le perdrait sans que rien ne le dise.
  #[test]
  fn a_finished_session_comes_back_exactly_as_it_went_in() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");
    let session = find(&connection, id)
      .expect("relecture")
      .expect("la session");

    assert_eq!(session.id, id);
    assert_eq!(session.title, None);
    assert_eq!(session.source_name, "Microsoft Teams");
    assert_eq!(session.language, "fr");
    assert_eq!(session.translation_target.as_deref(), Some("en"));
    assert_eq!(session.transcript.paragraphs.len(), 1);
    assert_eq!(session.transcript.paragraphs[0].words.len(), 2);
    assert_eq!(session.transcript.paragraphs[0].words[0].start_ms, 0);
    assert!(session.report.is_empty());
  }

  /// ⚠️ **Les instants font l'aller-retour**, à la seconde près : la colonne est en ISO, ce qui
  /// la rend triable et comparable sans conversion — donc purgeable en une requête.
  #[test]
  fn the_instants_survive_the_round_trip_through_iso() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");
    let session = find(&connection, id)
      .expect("relecture")
      .expect("la session");

    assert_eq!(session.started_at_ms, 1_754_300_000_000);
    assert_eq!(session.ended_at_ms, 1_754_303_600_000);
  }

  /// ⚠️ Le compte rendu arrive après, et il doit rejoindre la ligne : archiver à la consolidation
  /// et ne jamais revenir laisserait dans l'historique une session dont le compte rendu n'existe
  /// qu'à l'écran.
  #[test]
  fn a_report_generated_later_joins_the_archived_session() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");

    assert!(read(&connection, id).report.is_empty());

    let sections = vec![ReportSection {
      heading: "Résumé".into(),
      lines: vec!["Point hebdomadaire.".into()],
      bullets: false,
    }];
    set_report(&connection, id, &sections).expect("compte rendu");

    assert_eq!(read(&connection, id).report, sections);
  }

  /// ⚠️ **Un renommage rejoint la ligne lui aussi**, et un titre effacé y remet `NULL` — le
  /// repli daté se recompose alors à l'écran, dans la langue de l'interface.
  #[test]
  fn a_rename_joins_the_archived_session_and_an_erased_title_goes_back_to_nothing() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");

    rename(&connection, id, Some("Point client")).expect("renommage");
    assert_eq!(read(&connection, id).title.as_deref(), Some("Point client"));

    rename(&connection, id, None).expect("effacement");
    assert_eq!(read(&connection, id).title, None);
  }

  /// ⚠️ **Une mise à jour sur une ligne purgée ne casse rien** : la génération, elle, a réussi.
  #[test]
  fn updating_a_session_that_is_gone_is_not_an_error() {
    let connection = base();
    set_report(&connection, 404, &[]).expect("sans effet");
    rename(&connection, 404, Some("Fantôme")).expect("sans effet");
    assert_eq!(count(&connection), 0);
  }

  /// L'historique se lit du plus récent au plus ancien — c'est l'ordre du panneau.
  #[test]
  fn the_history_reads_newest_first() {
    let connection = base();
    dated(&connection, "2026-01-05T09:00:00Z");
    dated(&connection, "2026-08-05T09:00:00Z");
    dated(&connection, "2026-04-05T09:00:00Z");

    let dates: Vec<i64> = summaries(&connection)
      .expect("relecture")
      .iter()
      .map(|session| session.started_at_ms)
      .collect();
    assert!(dates[0] > dates[1] && dates[1] > dates[2]);
  }

  /// ⚠️ Les paliers s'éprouvent sur des dates forcées, seule façon de les mesurer sans attendre un
  /// an. La borne est calculée par SQLite à partir de `'now'`, avec la même horloge et le même
  /// format que ceux qui ont écrit la colonne : aucune dérive possible entre les deux.
  #[test]
  fn every_retention_tier_keeps_what_it_promises_and_drops_the_rest() {
    for (tier, kept) in [("30d", 1), ("3m", 2), ("6m", 3), ("1y", 4)] {
      let connection = base();
      for age in [
        "-10 days",
        "-2 months",
        "-5 months",
        "-11 months",
        "-2 years",
      ] {
        let started: String = connection
          .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)",
            rusqlite::params![age],
            |row| row.get(0),
          )
          .expect("date");
        dated(&connection, &started);
      }

      purge(&connection, tier).expect("purge");
      assert_eq!(count(&connection), kept, "palier « {tier} »");
    }
  }

  /// ⚠️ « Sans limite » ne purge rien, et ne se traduit pas par une date très ancienne : une
  /// borne, même lointaine, finirait par être atteinte.
  #[test]
  fn unlimited_never_deletes_anything() {
    let connection = base();
    dated(&connection, "1999-01-01T00:00:00Z");

    assert_eq!(purge(&connection, "unlimited").expect("purge"), 0);
    assert_eq!(count(&connection), 1);
    assert_eq!(retention_cutoff("unlimited"), None);
  }

  /// ⚠️ Un réglage abîmé retombe sur six mois, il ne désactive pas la purge. Le fichier de
  /// réglages est un JSON en clair, éditable à la main : traduire une faute de frappe en « sans
  /// limite » en ferait une désactivation silencieuse de la purge.
  #[test]
  fn an_unknown_tier_falls_back_to_the_default_and_still_purges() {
    for absurd in ["", "42j", "illimité", "unlimited ", "UNLIMITED"] {
      assert_eq!(
        retention_cutoff(absurd),
        Some("-6 months"),
        "« {absurd} » doit valoir le défaut"
      );
    }

    let connection = base();
    dated(&connection, "1999-01-01T00:00:00Z");
    assert_eq!(purge(&connection, "42j").expect("purge"), 1);
  }

  /// ⚠️ **Réduire le réglage s'applique RÉTROACTIVEMENT** : qui passe d'un an à trente jours
  /// voit partir onze mois à la prochaine ouverture — c'est exactement ce qu'il vient de
  /// demander, et une purge qui n'agirait qu'à l'avenir ne servirait à rien.
  #[test]
  fn shortening_the_retention_applies_to_what_is_already_there() {
    let connection = base();
    for age in ["-10 days", "-6 months"] {
      let started: String = connection
        .query_row(
          "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)",
          rusqlite::params![age],
          |row| row.get(0),
        )
        .expect("date");
      dated(&connection, &started);
    }

    assert_eq!(purge(&connection, "1y").expect("purge"), 0);
    assert_eq!(purge(&connection, "30d").expect("purge"), 1);
    assert_eq!(count(&connection), 1);
  }

  /// ⚠️ Une ligne illisible se liste quand même, et ne refuse qu'à l'ouverture. Le panneau n'a pas
  /// besoin du transcript — il montre un titre et une date —, et la faire disparaître priverait
  /// l'utilisateur de la seule trace qui lui reste, sans le dire.
  #[test]
  fn an_unreadable_row_still_lists_and_only_refuses_to_open() {
    let connection = base();
    archive(&connection, &finished()).expect("archivage");
    connection
      .execute(
        "INSERT INTO live_sessions
           (title, source_name, started_at, ended_at, language, transcript)
         VALUES (NULL, 'X', '2026-08-06T09:00:00Z', '2026-08-06T09:01:00Z', 'fr', 'pas du json')",
        [],
      )
      .expect("ligne abîmée");

    // La ligne abîmée se liste — le panneau n'a pas besoin de son transcript — mais elle refuse
    // de s'ouvrir, ce qui est le seul moment où l'illisibilité compte.
    assert_eq!(summaries(&connection).expect("relecture").len(), 2);
    assert!(find(&connection, 2).is_err());
  }

  /// ⚠️ **Un compte rendu illisible ne perd que lui** : la session reste dans l'historique avec
  /// son transcript, qui est l'essentiel.
  #[test]
  fn an_unreadable_report_loses_only_itself() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");
    connection
      .execute(
        "UPDATE live_sessions SET report = 'pas du json' WHERE id = ?1",
        rusqlite::params![id],
      )
      .expect("compte rendu abîmé");

    let session = read(&connection, id);
    assert!(session.report.is_empty());
    assert_eq!(session.transcript.paragraphs.len(), 1);
  }

  /// ⚠️ **`NULL` et non `"[]"`** : la colonne dit « il n'y en a pas », là où une liste vide
  /// dirait « il y en a un, il est vide ».
  #[test]
  fn a_session_without_a_report_stores_nothing_rather_than_an_empty_list() {
    let connection = base();
    archive(&connection, &finished()).expect("archivage");

    let report: Option<String> = connection
      .query_row("SELECT report FROM live_sessions", [], |row| row.get(0))
      .expect("relecture");
    assert_eq!(report, None);
  }

  /// ⚠️ Le panneau ne lit ni le transcript ni le compte rendu — c'est tout son intérêt. Une
  /// session d'une heure pèse quelques centaines de kilo-octets et la liste en affiche deux
  /// lignes : le résumé porte un aperçu borné et un booléen, jamais les rubriques.
  #[test]
  fn a_summary_carries_an_excerpt_and_a_flag_never_the_whole_session() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");

    let listed = summaries(&connection).expect("relecture");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].preview, "Bon, on");
    assert!(
      !listed[0].has_report,
      "pas de compte rendu, et c'est le défaut"
    );

    set_report(
      &connection,
      id,
      &[ReportSection {
        heading: "Résumé".into(),
        lines: vec!["Point hebdomadaire.".into()],
        bullets: false,
      }],
    )
    .expect("compte rendu");
    assert!(summaries(&connection).expect("relecture")[0].has_report);
  }

  /// ⚠️ **L'aperçu se coupe en CARACTÈRES.** Couper sur des octets casserait un caractère
  /// accentué en deux, et la colonne porterait une chaîne invalide — cinq de nos six langues
  /// s'écrivent avec des accents, ce n'est pas un cas de bord.
  #[test]
  fn the_excerpt_is_bounded_in_characters_and_never_splits_one() {
    let connection = base();
    let mut long = finished();
    let words: Vec<Word> = (0..400)
      .map(|index| word("éàü", index as u64 * 100))
      .collect();
    long.transcript = Transcript::of(&words, "fr");
    let id = archive(&connection, &long).expect("archivage");

    let excerpt = &summaries(&connection).expect("relecture")[0].preview;
    assert_eq!(excerpt.chars().count(), super::PREVIEW_CHARS);
    assert!(
      read(&connection, id).transcript.plain_text().len() > excerpt.len(),
      "l'aperçu est un début, pas le transcript"
    );
  }

  /// ⚠️ **Une ligne absente rend `None`, pas une erreur** : la purge a pu passer entre la liste
  /// et le clic, et c'est un cas normal.
  #[test]
  fn opening_a_session_that_is_gone_says_so_without_failing() {
    let connection = base();
    assert!(find(&connection, 404).expect("lecture").is_none());
  }

  /// ⚠️ **Supprimer ce qui n'existe plus n'est pas une erreur** : le panneau peut cliquer sur une
  /// ligne que la purge vient d'emporter, et une snackbar rouge sur un historique à jour serait
  /// un mensonge.
  #[test]
  fn deleting_removes_one_session_and_forgives_a_second_try() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");
    archive(&connection, &finished()).expect("archivage");

    assert!(delete(&connection, id).expect("suppression"));
    assert_eq!(count(&connection), 1);
    assert!(!delete(&connection, id).expect("seconde suppression"));
  }

  #[test]
  fn clearing_empties_the_whole_history_and_says_how_many_went() {
    let connection = base();
    archive(&connection, &finished()).expect("archivage");
    archive(&connection, &finished()).expect("archivage");

    assert_eq!(clear(&connection).expect("vidage"), 2);
    assert_eq!(count(&connection), 0);
    assert_eq!(clear(&connection).expect("second vidage"), 0);
  }

  /// ⚠️ Copier rend le compte rendu s'il existe, le transcript sinon — jamais rien. Le
  /// presse-papier ne donne aucun retour : un bouton qui y met le vide est indiscernable d'un
  /// bouton cassé, et une session sans compte rendu est le cas par défaut.
  #[test]
  fn copying_falls_back_to_the_transcript_when_there_is_no_report() {
    let connection = base();
    let id = archive(&connection, &finished()).expect("archivage");

    assert_eq!(copyable_text(&read(&connection, id)), "Bon, on");

    set_report(
      &connection,
      id,
      &[ReportSection {
        heading: "Tâches".into(),
        lines: vec!["Corriger les deux bugs.".into()],
        bullets: true,
      }],
    )
    .expect("compte rendu");

    assert_eq!(
      copyable_text(&read(&connection, id)),
      "Tâches\n\n- Corriger les deux bugs.",
      "le presse-papier reçoit exactement ce que l'export écrirait"
    );
  }

  /// ⚠️ **Une session qu'on archiverait sans fin range une durée nulle**, jamais une date de
  /// 1970 : le cas ne doit pas arriver, et s'il arrive il ne doit pas mentir.
  #[test]
  fn a_session_without_an_end_is_archived_as_lasting_nothing() {
    let connection = base();
    let mut running = finished();
    running.ended_at_ms = None;
    let id = archive(&connection, &running).expect("archivage");

    let session = read(&connection, id);
    assert_eq!(session.ended_at_ms, session.started_at_ms);
  }
}
