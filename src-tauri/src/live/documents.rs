//! Les sessions ouvertes, et leurs fenêtres.
//!
//! Un document vit en deux temps : il commence — la fenêtre s'ouvre au démarrage de la session,
//! avant tout transcript, par [`LiveDocuments::begin`] — puis il se termine. Une fenêtre par
//! session, plusieurs en parallèle : l'étiquette porte l'identifiant (`directdoc-0`), que le
//! frontend lit pour savoir quoi afficher (voir `applyWindowRoute` dans `src/app/app.routes.ts`).
//!
//! # Pièges
//!
//! - ⚠️ Ce magasin n'est pas une persistance : il vit en mémoire, le temps de l'exécution, et ne
//!   garde que ce qu'une fenêtre ouverte a besoin de relire.
//! - ⚠️ Un seul fait dit lequel des deux temps on regarde : `ended_at_ms`. Un second champ
//!   booléen aurait pu diverger du premier ; il n'existe ni ici ni côté interface.
//! - ⚠️ Un document ne s'ouvre pas depuis le frontend : il naît au démarrage de la capture, qui
//!   le range et ouvre sa fenêtre d'un seul geste, sans faire repasser le transcript par le pont.

use std::{
  collections::HashMap,
  sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
  },
};

use serde::{Deserialize, Serialize};

use crate::{error::AppError, transcript::Transcript};

/// Le préfixe des étiquettes de fenêtre-session.
///
/// # Pièges
///
/// - ⚠️ Il doit rester aligné sur le joker `directdoc-*` de `capabilities/default.json` : une
///   fenêtre absente de cette liste n'a aucune permission, et le symptôme est muet.
pub const DIRECTDOC_PREFIX: &str = "directdoc-";

/// Une session, telle que sa fenêtre la lit — en cours d'enregistrement ou terminée.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDocument {
  /// L'étiquette de la fenêtre de cette session, `directdoc-` suivi d'un compteur.
  pub id: String,
  /// L'intitulé proposé par le modèle local, `None` s'il n'y avait rien à nommer.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le repli « Session du {date} » n'est pas ici : il se compose dans la langue de
  ///   l'interface, avec `Intl`. Voir `liveTitle` côté Angular.
  pub title: Option<String>,
  /// Ce qui était capté — « Microsoft Teams », « Tout le système ». Pour la ligne de méta.
  pub source_name: String,
  /// Quand la session a commencé, en millisecondes depuis l'époque.
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est lui qui date la session, et non sa fin : le titre par défaut s'affiche pendant
  ///   l'enregistrement, et une session datée de sa fin verrait son propre titre changer sous les
  ///   yeux de l'utilisateur au moment de l'arrêt.
  pub started_at_ms: u64,
  /// Quand la session s'est terminée, `None` tant qu'elle enregistre — le seul fait qui distingue
  /// les deux états, voir l'en-tête du module.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Relevé ici et non à l'affichage : la fenêtre peut rester ouverte des heures, et
  ///   « aujourd'hui » calculé au rendu finirait par désigner un autre jour que la session.
  pub ended_at_ms: Option<u64>,
  /// Le transcript consolidé de la session.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Vide pendant l'enregistrement : le transcript en direct arrive par évènements, et c'est
  ///   la consolidation qui le pose ici, corrigé, à l'arrêt.
  pub transcript: Transcript,
  /// Les rubriques du compte rendu, vides tant qu'il n'a pas été demandé.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Vide n'est pas un échec : le compte rendu se génère à la demande, et la fenêtre s'ouvre
  ///   bien avant qu'il existe. C'est l'écran qui distingue « pas encore » de « rien ».
  #[serde(default)]
  pub report: Vec<super::report::ReportSection>,
  /// La langue vers laquelle suivre la session, `None` s'il n'y en a pas.
  ///
  /// Le réglage `liveTranslationTarget` dit ce que le formulaire propose ; ce champ dit ce que
  /// cette session a demandé.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Propriété de la session, pas réglage de l'application : lire le réglage depuis la
  ///   fenêtre-session ferait changer de langue une session en cours dès que l'utilisateur touche
  ///   le formulaire pour la suivante — deux fenêtres, un réglage partagé.
  #[serde(default)]
  pub translation_target: Option<String>,
  /// La ligne d'historique de cette session, une fois qu'elle est archivée.
  ///
  /// Il vit ici plutôt que dans une table à côté : c'est ce document qu'on tient en main quand un
  /// compte rendu arrive ou qu'un titre change.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Il ne traverse pas le pont, d'où `#[serde(skip)]` : c'est de la comptabilité de
  ///   stockage, et l'exposer donnerait au WebView un identifiant de ligne à passer à une
  ///   commande — l'accès générique que le projet refuse.
  #[serde(skip)]
  pub archived: Option<i64>,
}

/// Les sessions terminées dont une fenêtre est ouverte.
#[derive(Default)]
pub struct LiveDocuments {
  entries: Mutex<HashMap<String, LiveDocument>>,
  next: AtomicUsize,
}

impl LiveDocuments {
  /// Range une session qui commence et rend le document, identifiant compris.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La langue est posée dès le départ, sur un transcript vide : la fenêtre-session en a
  ///   besoin pour traduire au fil de l'eau, bien avant que la consolidation pose le vrai
  ///   transcript — que [`LiveDocuments::finish`] remplace en entier, langue comprise.
  pub fn begin(
    &self,
    source_name: String,
    started_at_ms: u64,
    language: &str,
    translation_target: Option<String>,
  ) -> Result<LiveDocument, AppError> {
    let id = format!(
      "{DIRECTDOC_PREFIX}{}",
      self.next.fetch_add(1, Ordering::SeqCst)
    );
    let document = LiveDocument {
      id: id.clone(),
      title: None,
      source_name,
      started_at_ms,
      ended_at_ms: None,
      transcript: Transcript::of(&[], language),
      report: Vec::new(),
      translation_target,
      archived: None,
    };
    self
      .entries
      .lock()
      .map_err(poisoned)?
      .insert(id, document.clone());
    Ok(document)
  }

  /// Pose le transcript consolidé sur une session qui se termine.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si l'identifiant est inconnu ou si le verrou a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Idempotente par construction : l'arrêt part de trois endroits, et une seconde
  ///   consolidation rendrait un document vide, les mots ayant déjà été emportés.
  /// - ⚠️ Le titre n'écrase pas un renommage : ce que l'utilisateur a écrit pendant que ça
  ///   enregistrait est plus sûr que ce que le modèle propose.
  pub fn finish(
    &self,
    id: &str,
    title: Option<String>,
    transcript: Transcript,
    ended_at_ms: u64,
  ) -> Result<LiveDocument, AppError> {
    let mut entries = self.entries.lock().map_err(poisoned)?;
    let document = entries
      .get_mut(id)
      .ok_or_else(|| AppError::Io(format!("session introuvable : {id}")))?;
    if document.ended_at_ms.is_some() {
      return Ok(document.clone());
    }
    document.title = document.title.take().or(title);
    document.transcript = transcript;
    document.ended_at_ms = Some(ended_at_ms);
    Ok(document.clone())
  }

  /// Remet en mémoire une session relue dans l'historique, et rend son document.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Elle garde son lien vers sa ligne (`archived`) : sans lui, la renommer ou lui générer
  ///   un compte rendu écrirait dans le vide, sans que rien ne le dise avant la réouverture.
  /// - ⚠️ Un identifiant de fenêtre neuf, jamais celui d'avant : c'est un compteur de processus,
  ///   pas une clé persistante. L'unicité de la fenêtre tient à [`LiveDocuments::of_archive`].
  pub fn reopen(&self, session: super::history::ArchivedSession) -> Result<LiveDocument, AppError> {
    let id = format!(
      "{DIRECTDOC_PREFIX}{}",
      self.next.fetch_add(1, Ordering::SeqCst)
    );
    let document = LiveDocument {
      id: id.clone(),
      title: session.title,
      source_name: session.source_name,
      started_at_ms: session.started_at_ms.max(0) as u64,
      ended_at_ms: Some(session.ended_at_ms.max(0) as u64),
      transcript: session.transcript,
      report: session.report,
      translation_target: session.translation_target,
      archived: Some(session.id),
    };
    self
      .entries
      .lock()
      .map_err(poisoned)?
      .insert(id, document.clone());
    Ok(document)
  }

  /// L'identifiant du document ouvert sur cette ligne d'historique, s'il y en a un.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est ce qui empêche deux fenêtres sur une même session : deux documents portant le
  ///   même `archived` écriraient tour à tour dans la même ligne, et celle qui n'a pas écrit en
  ///   dernier afficherait pour toujours un état qui n'existe plus.
  pub fn of_archive(&self, archived: i64) -> Result<Option<String>, AppError> {
    Ok(
      self
        .entries
        .lock()
        .map_err(poisoned)?
        .values()
        .find(|document| document.archived == Some(archived))
        .map(|document| document.id.clone()),
    )
  }

  /// Relit un document.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si l'identifiant est inconnu ou si le verrou a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un identifiant inconnu est une erreur, pas un `None` silencieux : ne rien trouver veut
  ///   dire que le magasin et les fenêtres ont divergé, et le taire donnerait une fenêtre vide
  ///   sans explication.
  pub fn get(&self, id: &str) -> Result<LiveDocument, AppError> {
    self
      .entries
      .lock()
      .map_err(poisoned)?
      .get(id)
      .cloned()
      .ok_or_else(|| AppError::Io(format!("session introuvable : {id}")))
  }

  /// Renomme la session.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si l'identifiant est inconnu ou si le verrou a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un titre vidé ramène le repli, il n'écrit pas un titre vide : c'est le geste « je me
  ///   ravise » de l'édition en ligne, et l'en-tête doit retomber sur « Session du {date} »
  ///   plutôt que de rester blanc.
  pub fn rename(&self, id: &str, title: &str) -> Result<LiveDocument, AppError> {
    let mut entries = self.entries.lock().map_err(poisoned)?;
    let document = entries
      .get_mut(id)
      .ok_or_else(|| AppError::Io(format!("session introuvable : {id}")))?;
    let trimmed = title.trim();
    document.title = if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.to_owned())
    };
    Ok(document.clone())
  }

  /// Retient la ligne d'historique d'une session qu'on vient d'archiver.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sans effet si le document a déjà été fermé : sa fenêtre peut disparaître pendant la
  ///   consolidation, et l'archivage doit aboutir quand même — c'est le transcript qu'on met à
  ///   l'abri, pas l'écran qui l'affichait.
  pub fn set_archived(&self, id: &str, archived: i64) -> Result<(), AppError> {
    if let Some(document) = self.entries.lock().map_err(poisoned)?.get_mut(id) {
      document.archived = Some(archived);
    }
    Ok(())
  }

  /// Range le compte rendu d'une session.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si l'identifiant est inconnu ou si le verrou a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Il remplace le précédent : régénérer avec un autre type doit rendre un document, pas
  ///   deux comptes rendus empilés que rien ne distinguerait à l'écran.
  pub fn set_report(
    &self,
    id: &str,
    report: Vec<super::report::ReportSection>,
  ) -> Result<LiveDocument, AppError> {
    let mut entries = self.entries.lock().map_err(poisoned)?;
    let document = entries
      .get_mut(id)
      .ok_or_else(|| AppError::Io(format!("session introuvable : {id}")))?;
    document.report = report;
    Ok(document.clone())
  }

  /// Ferme un document et libère sa mémoire, idempotent : la fenêtre se ferme par la pastille
  /// rouge, par ⌘W et par le menu.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin a été empoisonné.
  pub fn close(&self, id: &str) -> Result<(), AppError> {
    self.entries.lock().map_err(poisoned)?.remove(id);
    Ok(())
  }

  /// Combien de sessions sont ouvertes.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin a été empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sous `cfg(test)` : rien du produit ne compte les documents. Le laisser en production
  ///   laisserait croire qu'une décision s'y appuie — la cascade des fenêtres, elle, compte les
  ///   fenêtres.
  #[cfg(test)]
  pub fn len(&self) -> Result<usize, AppError> {
    Ok(self.entries.lock().map_err(poisoned)?.len())
  }
}

/// L'erreur d'un verrou empoisonné, journalisée au passage.
///
/// # Pièges
///
/// - ⚠️ Un verrou empoisonné n'efface pas une session : l'état n'est qu'une table de documents,
///   et refuser de la lire perdrait un transcript que rien ne rend incohérent.
fn poisoned<T>(error: std::sync::PoisonError<T>) -> AppError {
  log::warn!("magasin de sessions repris après une panne dans un autre fil");
  let _ = error;
  AppError::Io("magasin de sessions momentanément indisponible".into())
}

#[cfg(test)]
mod tests {
  use super::{DIRECTDOC_PREFIX, LiveDocuments};
  use crate::transcript::Transcript;

  const STARTED_AT_MS: u64 = 1_754_300_000_000;
  const ENDED_AT_MS: u64 = 1_754_303_600_000;

  fn transcript() -> Transcript {
    Transcript::of(&[], "fr")
  }

  /// Une session **commencée puis terminée** — l'état dans lequel la plupart de ces tests la
  /// prennent.
  fn opened(store: &LiveDocuments) -> super::LiveDocument {
    let begun = store
      .begin("Microsoft Teams".into(), STARTED_AT_MS, "fr", None)
      .expect("ouverture");
    store
      .finish(
        &begun.id,
        Some("Session produit hebdo".into()),
        transcript(),
        ENDED_AT_MS,
      )
      .expect("clôture")
  }

  /// Une session **archivée**, telle que l'historique la rend.
  fn archived(id: i64) -> crate::live::history::ArchivedSession {
    crate::live::history::ArchivedSession {
      id,
      title: Some("Point client".into()),
      source_name: "Tout le système".into(),
      started_at_ms: STARTED_AT_MS as i64,
      ended_at_ms: ENDED_AT_MS as i64,
      language: "fr".into(),
      transcript: transcript(),
      report: Vec::new(),
      translation_target: None,
    }
  }

  /// ⚠️ Une session rouverte garde le lien vers sa ligne, sinon elle écrit dans le vide : sans
  /// `archived`, la renommer ou lui générer un compte rendu ne rejoindrait aucune ligne, et
  /// l'utilisateur ne s'en apercevrait qu'à la réouverture suivante.
  #[test]
  fn a_reopened_session_comes_back_terminated_and_still_tied_to_its_row() {
    let store = LiveDocuments::default();
    let document = store.reopen(archived(7)).expect("réouverture");

    assert!(document.id.starts_with(DIRECTDOC_PREFIX));
    assert_eq!(document.archived, Some(7));
    assert_eq!(document.title.as_deref(), Some("Point client"));
    assert_eq!(
      document.ended_at_ms,
      Some(ENDED_AT_MS),
      "une session d'historique est terminée par construction — sinon sa fenêtre croirait \
       qu'elle enregistre"
    );
  }

  /// ⚠️ Une ligne d'historique n'a jamais deux fenêtres : deux documents portant le même
  /// `archived` écriraient tour à tour dans la même ligne, et celle qui n'a pas écrit en dernier
  /// afficherait pour toujours un état qui n'existe plus. Cette recherche l'empêche en amont.
  #[test]
  fn a_row_already_open_is_found_before_a_second_window_is_born() {
    let store = LiveDocuments::default();
    let first = store.reopen(archived(7)).expect("réouverture");
    store.reopen(archived(8)).expect("une autre session");

    assert_eq!(store.of_archive(7).expect("recherche"), Some(first.id));
    assert_eq!(store.of_archive(404).expect("recherche"), None);
  }

  /// ⚠️ Une session en cours n'appartient à aucune ligne : elle n'est archivée qu'à la
  /// consolidation. La chercher par une ligne ne doit donc jamais la trouver.
  #[test]
  fn a_running_session_belongs_to_no_row() {
    let store = LiveDocuments::default();
    opened(&store);

    assert_eq!(store.of_archive(1).expect("recherche"), None);
  }

  /// ⚠️ **Deux sessions ouvertes en parallèle sont indépendantes** — c'est une ligne de la DoD,
  /// et elle tient par l'identifiant : deux documents ne doivent jamais se partager le leur.
  #[test]
  fn two_sessions_never_share_an_identifier() {
    let store = LiveDocuments::default();
    let first = opened(&store);
    let second = opened(&store);

    assert_ne!(first.id, second.id);
    assert!(first.id.starts_with(DIRECTDOC_PREFIX));
    assert_eq!(store.len().expect("compte"), 2);
  }

  /// ⚠️ Une session qui commence est déjà un document lisible : sa fenêtre s'ouvre à cet
  /// instant-là, et un `begin` qui ne rangerait rien laisserait une fenêtre demander un
  /// identifiant introuvable pendant toute la session.
  #[test]
  fn a_session_that_begins_is_readable_and_says_it_is_not_over() {
    let store = LiveDocuments::default();
    let begun = store
      .begin("Tout le système".into(), STARTED_AT_MS, "fr", None)
      .expect("ouverture");

    assert_eq!(begun.ended_at_ms, None, "elle enregistre");
    assert_eq!(begun.started_at_ms, STARTED_AT_MS);
    assert_eq!(begun.title, None);
    assert!(begun.transcript.paragraphs.is_empty());
    assert_eq!(store.get(&begun.id).expect("relecture"), begun);
  }

  /// ⚠️ La langue est lisible dès le départ, sur un transcript vide : la fenêtre-session en a
  /// besoin pour traduire au fil de l'eau, et la consolidation ne pose le vrai transcript qu'à
  /// l'arrêt — sans elle, une session entière passerait avant qu'on sache depuis quelle langue.
  #[test]
  fn a_session_carries_its_language_and_its_translation_target_from_the_start() {
    let store = LiveDocuments::default();
    let begun = store
      .begin(
        "Microsoft Teams".into(),
        STARTED_AT_MS,
        "fr",
        Some("en".into()),
      )
      .expect("ouverture");

    assert_eq!(begun.transcript.language, "fr");
    assert_eq!(begun.translation_target.as_deref(), Some("en"));
  }

  /// ⚠️ La cible est une propriété de la session et elle lui survit : le réglage dit ce que le
  /// formulaire propose, ce champ dit ce que cette session a demandé. La consolidation remplace
  /// son transcript, pas son intention.
  #[test]
  fn finishing_a_session_never_forgets_what_it_was_being_followed_in() {
    let store = LiveDocuments::default();
    let begun = store
      .begin("Google Meet".into(), STARTED_AT_MS, "en", Some("it".into()))
      .expect("ouverture");
    let ended = store
      .finish(
        &begun.id,
        None,
        Transcript::of(&[], "en"),
        STARTED_AT_MS + 60_000,
      )
      .expect("clôture");

    assert_eq!(ended.translation_target.as_deref(), Some("it"));
  }

  /// ⚠️ Le test qui protège d'une consolidation deux fois : trois gestes mènent à l'arrêt, et le
  /// second passage rendrait un transcript vide — exact, puisque les mots ont été emportés — en
  /// effaçant celui de la session.
  #[test]
  fn finishing_twice_keeps_the_first_transcript_rather_than_emptying_it() {
    let store = LiveDocuments::default();
    let begun = store
      .begin("Microsoft Teams".into(), STARTED_AT_MS, "fr", None)
      .expect("ouverture");

    let word = crate::transcript::Word {
      text: "Bonjour".into(),
      start_ms: 0,
      end_ms: 400,
    };
    let first = store
      .finish(&begun.id, None, Transcript::of(&[word], "fr"), ENDED_AT_MS)
      .expect("clôture");
    let second = store
      .finish(&begun.id, None, transcript(), ENDED_AT_MS + 60_000)
      .expect("seconde clôture");

    assert_eq!(second, first, "la seconde clôture ne change rien");
    assert_eq!(second.ended_at_ms, Some(ENDED_AT_MS));
    assert!(!second.transcript.paragraphs.is_empty());
    assert!(
      store
        .finish("directdoc-404", None, transcript(), 0)
        .is_err()
    );
  }

  /// ⚠️ **On renomme sa session pendant qu'elle enregistre** — c'est même le moment où l'on sait
  /// de quoi elle parle. Ce que l'utilisateur a écrit doit survivre à la consolidation.
  #[test]
  fn a_title_written_during_the_recording_survives_the_consolidation() {
    let store = LiveDocuments::default();
    let begun = store
      .begin("Microsoft Teams".into(), STARTED_AT_MS, "fr", None)
      .expect("ouverture");
    store
      .rename(&begun.id, "Point client Dupont")
      .expect("renommage");

    let finished = store
      .finish(
        &begun.id,
        Some("Réunion hebdomadaire".into()),
        transcript(),
        ENDED_AT_MS,
      )
      .expect("clôture");

    assert_eq!(finished.title.as_deref(), Some("Point client Dupont"));
  }

  #[test]
  fn a_document_reads_back_exactly_as_it_was_stored() {
    let store = LiveDocuments::default();
    let document = opened(&store);
    assert_eq!(store.get(&document.id).expect("relecture"), document);
  }

  /// ⚠️ **Un identifiant inconnu est une erreur**, pas un silence : une fenêtre vide sans
  /// explication serait pire.
  #[test]
  fn an_unknown_session_is_an_error_rather_than_a_silent_nothing() {
    let store = LiveDocuments::default();
    let error = store.get("directdoc-404").expect_err("erreur attendue");
    assert!(error.to_string().contains("directdoc-404"));
    assert!(store.rename("directdoc-404", "x").is_err());
  }

  #[test]
  fn renaming_replaces_the_title() {
    let store = LiveDocuments::default();
    let document = opened(&store);
    let renamed = store
      .rename(&document.id, "  Point client  ")
      .expect("renommage");
    assert_eq!(renamed.title.as_deref(), Some("Point client"));
  }

  /// ⚠️ Un titre vidé ramène le repli, il n'écrit pas un titre vide : c'est le geste « je me
  /// ravise » de l'édition en ligne, et l'en-tête doit retomber sur « Session du {date} », pas
  /// rester blanc.
  #[test]
  fn emptying_the_title_brings_back_the_fallback() {
    let store = LiveDocuments::default();
    let document = opened(&store);
    let renamed = store.rename(&document.id, "   ").expect("renommage");
    assert_eq!(renamed.title, None);
  }

  /// ⚠️ **Régénérer REMPLACE**, il n'empile pas : deux comptes rendus dans un document ne se
  /// distingueraient pas à l'écran.
  #[test]
  fn a_regenerated_report_replaces_the_previous_one() {
    let store = LiveDocuments::default();
    let document = opened(&store);
    let section = |heading: &str| super::super::report::ReportSection {
      heading: heading.into(),
      lines: vec!["Deux points.".into()],
      bullets: false,
    };

    store
      .set_report(&document.id, vec![section("Résumé"), section("Décisions")])
      .expect("premier compte rendu");
    let second = store
      .set_report(&document.id, vec![section("Notions clés")])
      .expect("régénération");

    assert_eq!(second.report.len(), 1);
    assert_eq!(second.report[0].heading, "Notions clés");
    assert!(store.set_report("directdoc-404", Vec::new()).is_err());
  }

  /// Fermer libère la mémoire, et fermer deux fois n'est pas une erreur — la fenêtre se ferme
  /// par trois chemins.
  #[test]
  fn closing_frees_the_memory_and_closing_twice_is_not_an_error() {
    let store = LiveDocuments::default();
    let document = opened(&store);

    store.close(&document.id).expect("fermeture");
    assert_eq!(store.len().expect("compte"), 0);
    store.close(&document.id).expect("fermeture idempotente");
    assert!(store.get(&document.id).is_err());
  }
}
