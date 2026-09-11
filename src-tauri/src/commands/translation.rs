//! Traduire un texte, et dire ce que la machine sait traduire.
//!
//! La traduction passe par le **Translation framework** d'Apple, 100 % local — **jamais par
//! le LLM**. Les mesures qui fondent ce module sont dans l'en-tête de
//! `native/Sources/MirmalionNative/Translation.swift`.
//!
//! # Pièges
//!
//! - ⚠️ Une seule commande d'ici touche au réseau, [`prepare_translation`], et elle ne part qu'à
//!   un clic. Une paire absente est *rapportée*, jamais comblée d'office.
//! - ⚠️ Traduire coûte ~4,5 ms par caractère, et le framework livre ses continuations par la
//!   boucle principale : tout travail part en `spawn_blocking`, ce n'est pas un confort.
//! - ⚠️ Une traduction ne remplace jamais le transcript rangé : c'est une vue rendue à
//!   l'appelant, d'où le retour instantané à « Langue d'origine » et les horodatages intacts.

use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::{
  blocking::off_thread,
  error::AppError,
  filedoc::Documents,
  jobs::Jobs,
  translation::{
    PairAvailability, PairStatus, TranslationAvailability, TranslationEngine, TranslationOutcome,
    paragraphs::{TranscriptTranslation, translate_paragraphs},
    report::{ReportTranslation, translate_report},
  },
};

/// La variable qui force une paire de mesure. **Développement uniquement.**
pub const PROBE_ENV: &str = "MIRMALION_TRANSLATION_PROBE";

/// Les paires forcées ne sont acceptées qu'en développement.
///
/// Fonction plutôt que `cfg!` en ligne : c'est ce qui rend le comportement de production
/// vérifiable par un test exécuté, dans chaque profil, plutôt que par relecture.
fn probe_allowed() -> bool {
  cfg!(debug_assertions)
}

/// La paire de mesure, si elle est posée **et autorisée**.
///
/// Format : `MIRMALION_TRANSLATION_PROBE=<source>-<cible>`, par exemple `fr-pl`.
///
/// # Pièges
///
/// - ⚠️ Les 72 paires du périmètre sont installées sur la machine de développement : sans une
///   paire hors périmètre, la feuille d'Apple ne surgit jamais et la greffe reste invérifiable.
/// - ⚠️ Elle court-circuite le **choix de la paire**, pas la seule garde de périmètre : posée en
///   aval de la décision, elle ne serait jamais atteinte — « rien ne manque », donc rien d'appelé.
fn probe_pair(forced: Option<String>, allowed: bool) -> Option<(String, String)> {
  if !allowed {
    return None;
  }
  forced
    .as_deref()
    .and_then(|value| value.split_once('-'))
    .filter(|(source, target)| !source.is_empty() && !target.is_empty())
    .map(|(source, target)| (source.to_owned(), target.to_owned()))
}

/// **Une** paire à faire valoir pour rendre `target` utilisable, ou `None` si tout est là.
///
/// # Pièges
///
/// - ⚠️ Une seule paire, jamais plusieurs : la feuille d'Apple liste des langues, pas des paires,
///   et plusieurs sessions ne se mutualisent pas — elles s'empilent, une feuille et un *Done*.
/// - ⚠️ Ce choix appartient au backend : l'écran de traduction ne parle jamais de paires, et lui
///   faire porter cette logique l'obligerait à connaître ce qu'on a décidé de lui cacher.
/// - ⚠️ [`PairStatus::Unsupported`] n'est pas `Supported` : une paire qu'Apple ne fera jamais ne
///   se propose pas au téléchargement.
fn representative_missing_pair<'a>(
  availability: &'a TranslationAvailability,
  target: &str,
  spoken: &[String],
) -> Option<&'a PairAvailability> {
  availability.pairs.iter().find(|pair| {
    pair.target == target
      && pair.source != target
      && pair.status == PairStatus::Supported
      && spoken.iter().any(|language| language == &pair.source)
  })
}

/// L'évènement d'avancement d'une traduction de document, écouté par la fenêtre-document.
///
/// ⚠️ Miroir de `DOCUMENT_TRANSLATION_EVENT` côté Angular : rien ne vérifie l'égalité des deux
/// chaînes à la compilation, et une divergence donnerait une barre qui n'avance jamais.
pub const TRANSLATION_EVENT: &str = "document-translation";

/// Ce que la fenêtre-document reçoit pendant qu'on traduit son transcript.
///
/// # Pièges
///
/// - ⚠️ L'identifiant du document n'est pas décoratif : plusieurs fenêtres vivent en parallèle
///   et un évènement Tauri est diffusé à tout le monde. Émettre vers une seule étiquette ne
///   suffirait pas — un écouteur posé sans cible reçoit tout.
/// - ⚠️ Le pourcentage est un entier, pas un ratio, même contrat que
///   [`crate::commands::transcription::TranscriptionProgress`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProgress {
  /// Le document dont la traduction avance.
  pub document_id: String,
  /// L'avancement, de `0` à `100`.
  pub percent: u8,
}

/// Le traducteur monté au démarrage. Voir [`crate::translation`] pour le rôle du trait.
pub struct TranslationHandle(pub Arc<dyn TranslationEngine>);

/// Les traductions de documents en cours, et le drapeau qui arrête chacune.
///
/// La mécanique vit dans [`crate::jobs`], partagée avec la génération de compte rendu.
///
/// # Pièges
///
/// - ⚠️ Enveloppe de rangement, et rien d'autre : `.manage()` classe par type, et deux tables du
///   même type se marcheraient dessus.
#[derive(Default)]
pub struct TranslationJobs(pub Jobs);

/// Monte le traducteur et la table des traductions en cours. Appelé une fois, dans `.setup()`.
pub fn setup(app: &tauri::AppHandle, engine: Arc<dyn TranslationEngine>) {
  app.manage(TranslationHandle(engine));
  app.manage(TranslationJobs::default());
}

/// L'état de chaque paire de langues du périmètre, sans rien traduire ni télécharger.
///
/// L'interface s'en sert pour savoir ce qu'elle peut promettre : `installed` traduit hors ligne
/// immédiatement, `supported` demande un téléchargement à **proposer**, `unsupported` s'affiche
/// *Indisponible*.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue, ou [`AppError::Io`] si la tâche n'est pas revenue.
#[tauri::command]
pub async fn get_translation_availability(
  engine: State<'_, TranslationHandle>,
) -> Result<TranslationAvailability, AppError> {
  let engine = engine.0.clone();
  off_thread(move || engine.availability()).await
}

/// Traduit un texte de `source` vers `target`.
///
/// # Errors
///
/// Rend [`AppError::Native`] sur une défaillance du framework, [`AppError::Io`] sur tâche perdue.
///
/// # Pièges
///
/// - ⚠️ Rend `Ok` même quand rien n'a été traduit : une paire absente ou non supportée est une
///   issue nominale, portée par [`TranslationOutcome`] que l'appelant est forcé de traiter.
/// - ⚠️ Le texte source n'est jamais perdu : l'appelant le détient toujours et l'insère tel quel
///   si la traduction n'a pas eu lieu.
#[tauri::command]
pub async fn translate_text(
  engine: State<'_, TranslationHandle>,
  source: String,
  target: String,
  text: String,
) -> Result<TranslationOutcome, AppError> {
  let engine = engine.0.clone();
  off_thread(move || engine.translate(&source, &target, &text)).await
}

/// Fait présenter à Apple **sa** feuille de téléchargement pour la langue cible, s'il en manque.
///
/// # Errors
///
/// Rend [`AppError::Native`] si la lecture de disponibilité échoue ou si la greffe ne peut pas
/// être planifiée sur le fil principal.
///
/// # Pièges
///
/// - ⚠️ Seul appel du projet qui engage un téléchargement, et il ne part qu'à un clic. Le retour
///   ne promet rien : le téléchargement est asynchrone, relire [`get_translation_availability`].
/// - ⚠️ La lecture de disponibilité est bloquante, la greffe doit tourner sur le fil principal.
#[tauri::command]
pub async fn prepare_translation(
  engine: State<'_, TranslationHandle>,
  window: tauri::WebviewWindow,
  target: String,
  spoken: Vec<String>,
) -> Result<(), AppError> {
  let probe = probe_pair(std::env::var(PROBE_ENV).ok(), probe_allowed());
  let pair = match probe {
    Some(pair) => Some(pair),
    None => {
      let engine = engine.0.clone();
      let availability = off_thread(move || engine.availability()).await?;
      representative_missing_pair(&availability, &target, &spoken)
        .map(|pair| (pair.source.clone(), pair.target.clone()))
    }
  };
  let Some((source, target)) = pair else {
    log::debug!("aucune paire à préparer : rien à télécharger");
    return Ok(());
  };

  // ⚠️ Le succès se trace autant que l'échec : sans cette ligne, « jamais appelée » et « appelée,
  // mais Apple n'a rien montré » sont indiscernables. Aucun nom de langue dans le message.
  log::debug!("préparation de traduction demandée");
  // ⚠️ Aucun nom de langue dans le message d'échec : il dit ce qui a raté, pas sur quoi. C'est
  // `on_native_window` qui l'écrit, à partir de cette seule phrase.
  let scheduled = super::window::on_native_window(
    &window,
    "feuille de traduction non présentée",
    move |native| {
      crate::native::prepare_translation(native, &target, &source)?;
      log::debug!("hôte de la feuille de traduction greffé");
      Ok(())
    },
  );
  if scheduled {
    Ok(())
  } else {
    Err(AppError::Native("feuille non planifiée".to_owned()))
  }
}

/// Traduit le **transcript d'un document ouvert** vers `target`, et rend ses paragraphes traduits.
///
/// # Errors
///
/// [`AppError::InvalidArgument`] sur un document inconnu, [`AppError::Native`] sur une panne du
/// framework. Paire absente, non supportée et annulation restent des `Ok`.
///
/// # Pièges
///
/// - ⚠️ La langue source n'est pas un paramètre : c'est celle du transcript, détectée au dépôt du
///   média. La laisser choisir permettrait `en→ja` sur un transcript français, auquel le
///   framework répondrait n'importe quoi.
#[tauri::command]
pub async fn translate_document(
  app: tauri::AppHandle,
  engine: State<'_, TranslationHandle>,
  documents: State<'_, Documents>,
  jobs: State<'_, TranslationJobs>,
  id: String,
  target: String,
) -> Result<TranscriptTranslation, AppError> {
  let document_id = id.clone();
  let flag = jobs.0.begin(&id);
  let outcome = translate_document_inner(
    engine.0.clone(),
    &documents,
    &id,
    &target,
    Arc::clone(&flag),
    emitter(app, document_id),
  )
  .await;
  // ⚠️ Quelle que soit l'issue, panne comprise : une entrée laissée derrière ferait qu'un clic
  // tardif sur « Annuler » armerait un drapeau que plus personne ne lit.
  jobs.0.end(&id, &flag);
  outcome
}

/// Demande l'arrêt de la traduction du document `id`.
///
/// Idempotente et sans échec : annuler ce qui n'existe plus n'est pas une erreur, l'interface
/// peut cliquer juste après la fin.
///
/// # Pièges
///
/// - ⚠️ Nommée `cancel_document_translation` parce que les noms de commandes Tauri sont globaux
///   au crate, pas au module ; la collision ne se voit qu'à la compilation.
/// - ⚠️ L'arrêt est constaté au prochain cran de progression, jamais au milieu d'un paragraphe :
///   c'est [`TranscriptTranslation::Cancelled`] qui dit qu'il a eu lieu, pas ce retour.
#[tauri::command]
pub fn cancel_document_translation(jobs: State<'_, TranslationJobs>, id: String) {
  jobs.0.cancel(&id);
}

/// Le rapporteur d'avancée d'un document, prêt à traverser le fil bloquant.
///
/// # Pièges
///
/// - ⚠️ L'identifiant voyage avec le pourcentage : l'évènement est diffusé à toutes les fenêtres,
///   et sans lui la barre de l'une afficherait l'avancée de la voisine.
/// - ⚠️ Un évènement perdu n'arrête pas une traduction : le travail vaut plusieurs dizaines de
///   secondes de moteur.
fn emitter(app: tauri::AppHandle, document_id: String) -> impl Fn(u8) + Send + 'static {
  move |percent| {
    // ⚠️ Le résultat s'écarte, et il ne passe pas par `commands::announce` : celui-ci
    // journalise chaque échec, et cent pour cent perdus d'affilée noieraient le journal pour
    // une barre qui rattrapera au pourcentage suivant.
    let _ = app.emit(
      TRANSLATION_EVENT,
      TranslationProgress {
        document_id: document_id.clone(),
        percent,
      },
    );
  }
}

/// Traduit le **transcript d'une session ouverte** vers `target`, et rend ses paragraphes.
///
/// Jumelle de [`translate_document`] : Tauri range `State` par type, une seule commande ne peut
/// donc pas lire `Documents` et `LiveDocuments`. Tout ce qui suit la lecture est partagé.
///
/// # Errors
///
/// [`AppError::Io`] si la session est inconnue, [`AppError::Native`] sur une panne du framework.
///
/// # Pièges
///
/// - ⚠️ La langue source n'est pas un paramètre : c'est celle du transcript, posée sur le document
///   dès `begin`. La laisser choisir permettrait `en→ja` sur une session française.
#[tauri::command]
pub async fn translate_live_transcript(
  app: tauri::AppHandle,
  engine: State<'_, TranslationHandle>,
  documents: State<'_, crate::live::documents::LiveDocuments>,
  jobs: State<'_, TranslationJobs>,
  id: String,
  target: String,
) -> Result<TranscriptTranslation, AppError> {
  let document = documents.get(&id)?;
  let flag = jobs.0.begin(&id);
  let outcome = translate_live_transcript_inner(
    engine.0.clone(),
    document.transcript,
    &target,
    Arc::clone(&flag),
    emitter(app, id.clone()),
  )
  .await;
  // ⚠️ Quelle que soit l'issue, panne comprise : une entrée laissée derrière ferait qu'un clic
  // tardif sur « Annuler » armerait un drapeau que plus personne ne lit.
  jobs.0.end(&id, &flag);
  outcome
}

/// Traduit le **compte rendu d'une session ouverte** vers `target`, **intitulés compris**.
///
/// Une session sans compte rendu rend une liste vide, pas une erreur.
///
/// # Errors
///
/// [`AppError::Io`] si la session est inconnue, [`AppError::Native`] sur une panne du framework.
///
/// # Pièges
///
/// - ⚠️ Les intitulés (« Résumé », « Décisions ») sont écrits par le modèle dans la langue du
///   transcript, pas pris dans une table de l'interface : voir [`crate::translation::report`].
#[tauri::command]
pub async fn translate_live_report(
  app: tauri::AppHandle,
  engine: State<'_, TranslationHandle>,
  documents: State<'_, crate::live::documents::LiveDocuments>,
  jobs: State<'_, TranslationJobs>,
  id: String,
  target: String,
) -> Result<ReportTranslation, AppError> {
  let document = documents.get(&id)?;
  let flag = jobs.0.begin(&id);
  let outcome = translate_live_report_inner(
    engine.0.clone(),
    document.report,
    document.transcript.language,
    &target,
    Arc::clone(&flag),
    emitter(app, id.clone()),
  )
  .await;
  jobs.0.end(&id, &flag);
  outcome
}

/// Le corps de [`translate_live_transcript`], **sans `State`** — donc éprouvable.
///
/// # Errors
///
/// Rend [`AppError::Native`] sur une panne du pont, ou [`AppError::Io`] si la tâche n'est pas
/// revenue.
async fn translate_live_transcript_inner(
  engine: Arc<dyn TranslationEngine>,
  transcript: crate::transcript::Transcript,
  target: &str,
  cancelled: Arc<AtomicBool>,
  report: impl Fn(u8) + Send + 'static,
) -> Result<TranscriptTranslation, AppError> {
  let paragraphs = transcript.rendered();
  let source = transcript.language;
  // ⚠️ Aucun contenu utilisateur, pas même les langues. Le succès se trace autant que l'échec :
  // sinon « pas appelée » et « appelée, rendant des paragraphes que rien n'affiche » se confondent.
  log::debug!(
    "traduction de transcript de session demandée : {} paragraphes",
    paragraphs.len()
  );
  let target = target.to_owned();
  off_thread(move || {
    translate_paragraphs(
      engine.as_ref(),
      &source,
      &target,
      &paragraphs,
      &mut |percent| {
        report(percent);
        !cancelled.load(Ordering::SeqCst)
      },
    )
  })
  .await
}

/// Le corps de [`translate_live_report`], **sans `State`** — donc éprouvable.
///
/// # Errors
///
/// Rend [`AppError::Native`] sur une panne du pont, ou [`AppError::Io`] si la tâche n'est pas
/// revenue.
async fn translate_live_report_inner(
  engine: Arc<dyn TranslationEngine>,
  sections: Vec<crate::live::report::ReportSection>,
  source: String,
  target: &str,
  cancelled: Arc<AtomicBool>,
  report: impl Fn(u8) + Send + 'static,
) -> Result<ReportTranslation, AppError> {
  log::debug!(
    "traduction de compte rendu demandée : {} rubriques",
    sections.len()
  );
  let target = target.to_owned();
  off_thread(move || {
    translate_report(
      engine.as_ref(),
      &source,
      &target,
      &sections,
      &mut |percent| {
        report(percent);
        !cancelled.load(Ordering::SeqCst)
      },
    )
  })
  .await
}

/// Le corps de [`translate_document`], **sans `State`** — donc éprouvable.
///
/// # Errors
///
/// [`AppError::InvalidArgument`] sur un document inconnu, [`AppError::Native`] sur une panne.
///
/// # Pièges
///
/// - ⚠️ Le magasin est relu puis relâché avant le travail : son verrou est synchrone (voir
///   [`crate::filedoc`]), le tenir trente secondes gèlerait renommage, export et fermeture.
/// - ⚠️ Le rappel de progression répond aussi « faut-il continuer ? », d'après `cancelled` : point
///   de mesure et point de sortie sont le même, un second lecteur serait un oubli de plus.
async fn translate_document_inner(
  engine: Arc<dyn TranslationEngine>,
  documents: &Documents,
  id: &str,
  target: &str,
  cancelled: Arc<AtomicBool>,
  report: impl Fn(u8) + Send + 'static,
) -> Result<TranscriptTranslation, AppError> {
  let document = documents.get(id)?;
  let paragraphs = document.transcript.rendered();
  let source = document.transcript.language;
  // ⚠️ Aucun contenu utilisateur, pas même les langues. Le succès se trace autant que l'échec :
  // sinon « pas appelée » et « appelée, rendant des paragraphes que rien n'affiche » se confondent.
  log::debug!(
    "traduction de transcript demandée : {} paragraphes",
    paragraphs.len()
  );
  let target = target.to_owned();
  let outcome = off_thread(move || {
    translate_paragraphs(
      engine.as_ref(),
      &source,
      &target,
      &paragraphs,
      &mut |percent| {
        report(percent);
        !cancelled.load(Ordering::SeqCst)
      },
    )
  })
  .await?;
  log::debug!(
    "traduction de transcript : issue « {} »",
    match outcome {
      TranscriptTranslation::Translated { .. } => "traduit",
      TranscriptTranslation::PairMissing { .. } => "paire absente",
      TranscriptTranslation::PairUnsupported { .. } => "paire non supportée",
      TranscriptTranslation::Cancelled => "annulé",
    }
  );
  Ok(outcome)
}

#[cfg(test)]
mod tests {
  use super::{
    ReportTranslation, TRANSLATION_EVENT, TranslationProgress, off_thread, probe_allowed,
    probe_pair, representative_missing_pair, translate_document_inner, translate_live_report_inner,
    translate_live_transcript_inner,
  };
  use crate::error::AppError;
  use crate::filedoc::Documents;
  use crate::live::report::ReportSection;
  use crate::transcript::{Transcript, Word};
  use crate::translation::{
    PairAvailability, PairStatus, TranslationAvailability, TranslationEngine, TranslationOutcome,
    paragraphs::TranscriptTranslation,
  };
  use std::sync::{Arc, Mutex, atomic::AtomicBool};

  /// La doublure du moteur — la couture qui rend le chemin « paire absente » atteignable sans
  /// désinstaller une paire de langues sur la machine.
  #[derive(Default)]
  struct FakeEngine {
    calls: Mutex<usize>,
    outcome: Option<TranslationOutcome>,
    fails: bool,
  }

  impl TranslationEngine for FakeEngine {
    fn availability(&self) -> Result<TranslationAvailability, AppError> {
      Ok(TranslationAvailability {
        languages: vec![],
        pairs: vec![],
      })
    }

    fn translate(
      &self,
      _source: &str,
      _target: &str,
      text: &str,
    ) -> Result<TranslationOutcome, AppError> {
      if self.fails {
        return Err(AppError::Native("moteur en panne".into()));
      }
      *self.calls.lock().expect("verrou") += 1;
      Ok(
        self
          .outcome
          .clone()
          .unwrap_or(TranslationOutcome::Translated {
            text: text.to_uppercase(),
          }),
      )
    }
  }

  /// Un document français à deux paragraphes, rangé dans un magasin neuf.
  fn a_document(store: &Documents) -> String {
    let word = |text: &str, start_ms: u64, end_ms: u64| Word {
      text: text.into(),
      start_ms,
      end_ms,
    };
    // ⚠️ Le silence de 3 s ouvre le second paragraphe : c'est la seule frontière du modèle.
    let transcript = Transcript::of(
      &[word("Bonjour", 0, 400), word("Merci.", 3_500, 3_900)],
      "fr",
    );
    store
      .open(
        "/tmp/plateau.mp4".into(),
        "plateau.mp4".into(),
        "fr".into(),
        900,
        transcript,
      )
      .expect("ouverture")
      .id
  }

  fn translate(
    engine: Arc<FakeEngine>,
    store: &Documents,
    id: &str,
    target: &str,
  ) -> Result<TranscriptTranslation, AppError> {
    translate_while(engine, store, id, target, Arc::new(AtomicBool::new(false)))
  }

  /// Traduit avec un drapeau d'annulation donné — la seule différence avec [`translate`].
  fn translate_while(
    engine: Arc<FakeEngine>,
    store: &Documents,
    id: &str,
    target: &str,
    cancelled: Arc<AtomicBool>,
  ) -> Result<TranscriptTranslation, AppError> {
    tauri::async_runtime::block_on(translate_document_inner(
      engine,
      store,
      id,
      target,
      cancelled,
      |_| {},
    ))
  }

  /// Traduit en collectant **ce que la commande aurait émis**. Le rapporteur traverse le fil
  /// bloquant, d'où le partage par `Arc<Mutex<…>>`.
  fn reported(engine: Arc<FakeEngine>, store: &Documents, id: &str, target: &str) -> Vec<u8> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let collector = Arc::clone(&seen);
    tauri::async_runtime::block_on(translate_document_inner(
      engine,
      store,
      id,
      target,
      Arc::new(AtomicBool::new(false)),
      move |percent| collector.lock().expect("verrou").push(percent),
    ))
    .expect("succès");
    seen.lock().expect("verrou").clone()
  }

  #[test]
  fn a_document_is_translated_turn_by_turn_and_keeps_its_timings() {
    let store = Documents::default();
    let id = a_document(&store);
    let engine = Arc::new(FakeEngine::default());

    let outcome = translate(Arc::clone(&engine), &store, &id, "en").expect("succès");
    let TranscriptTranslation::Translated { paragraphs } = outcome else {
      panic!("la traduction devait aboutir");
    };
    assert_eq!(paragraphs.len(), 2);
    assert_eq!(paragraphs[0].text, "BONJOUR");
    assert_eq!(paragraphs[0].start_ms, 0);
    assert_eq!(paragraphs[1].end_ms, 3_900);
    assert_eq!(*engine.calls.lock().expect("verrou"), 2);
  }

  /// ⚠️ L'avancée est pondérée par les caractères : « Bonjour » pèse sept caractères sur les
  /// treize du document, la barre passe donc par 53 %, pas par 50 %.
  #[test]
  fn the_command_reports_what_the_engine_has_really_gone_through() {
    let store = Documents::default();
    let id = a_document(&store);
    assert_eq!(
      reported(Arc::new(FakeEngine::default()), &store, &id, "en"),
      vec![53, 100]
    );
  }

  /// ⚠️ **« Langue d'origine » ne rapporte rien** : aucun travail n'a lieu, et une barre qui
  /// sauterait à 100 % laisserait croire qu'on a traduit.
  #[test]
  fn the_documents_own_language_reports_nothing() {
    let store = Documents::default();
    let id = a_document(&store);
    assert_eq!(
      reported(Arc::new(FakeEngine::default()), &store, &id, "fr"),
      Vec::<u8>::new()
    );
  }

  /// ⚠️ L'identifiant voyage avec le pourcentage : un évènement Tauri est diffusé à toutes les
  /// fenêtres, et sans lui la barre d'un document afficherait l'avancée du voisin. Le nom des
  /// champs est un contrat, le frontend type cette structure.
  #[test]
  fn progress_travels_named_after_its_document() {
    let json = serde_json::to_value(TranslationProgress {
      document_id: "filedoc-2".into(),
      percent: 62,
    })
    .expect("sérialisation");
    assert_eq!(json["documentId"], "filedoc-2");
    assert_eq!(json["percent"], 62);
    assert_eq!(TRANSLATION_EVENT, "document-translation");
  }

  /// ⚠️ La source vient du document, jamais de l'écran : demander la langue du transcript
  /// n'appelle rien, c'est « Langue d'origine ».
  #[test]
  fn asking_for_the_documents_own_language_calls_nothing() {
    let store = Documents::default();
    let id = a_document(&store);
    let engine = Arc::new(FakeEngine::default());

    let outcome = translate(Arc::clone(&engine), &store, &id, "fr").expect("succès");
    let TranscriptTranslation::Translated { paragraphs } = outcome else {
      panic!("la traduction devait aboutir");
    };
    assert_eq!(paragraphs[0].text, "Bonjour");
    assert_eq!(*engine.calls.lock().expect("verrou"), 0);
  }

  /// ⚠️ Une paire absente est une **issue nominale** : `Ok`, jamais `Err`. La confondre avec une
  /// panne ferait afficher une erreur là où le produit doit proposer un téléchargement.
  #[test]
  fn a_missing_pair_comes_back_as_an_outcome_not_an_error() {
    let store = Documents::default();
    let id = a_document(&store);
    let engine = Arc::new(FakeEngine {
      outcome: Some(TranslationOutcome::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      }),
      ..Default::default()
    });

    assert_eq!(
      translate(engine, &store, &id, "it").expect("pas une panne"),
      TranscriptTranslation::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      }
    );
  }

  #[test]
  fn an_unsupported_pair_comes_back_as_an_outcome_too() {
    let store = Documents::default();
    let id = a_document(&store);
    let engine = Arc::new(FakeEngine {
      outcome: Some(TranslationOutcome::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      }),
      ..Default::default()
    });

    assert_eq!(
      translate(engine, &store, &id, "pt").expect("pas une panne"),
      TranscriptTranslation::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      }
    );
  }

  /// ⚠️ Une annulation est une issue, pas une panne, et elle ne rend aucun paragraphe : l'écran
  /// garde ce qu'il affichait plutôt qu'un document à moitié traduit.
  #[test]
  fn a_cancelled_translation_comes_back_as_an_outcome_without_a_single_turn() {
    let store = Documents::default();
    let id = a_document(&store);
    let engine = Arc::new(FakeEngine::default());

    let outcome = translate_while(
      Arc::clone(&engine),
      &store,
      &id,
      "en",
      Arc::new(AtomicBool::new(true)),
    )
    .expect("pas une panne");

    assert_eq!(outcome, TranscriptTranslation::Cancelled);
    assert_eq!(
      *engine.calls.lock().expect("verrou"),
      1,
      "le drapeau est lu au premier cran : le second paragraphe ne part pas"
    );
  }

  /// Une vraie panne du moteur remonte en `Err`, **intacte** : le frontend branche sur `kind`,
  /// et une panne de traduction reste une panne native même au travers du fil bloquant.
  #[test]
  fn a_failing_engine_surfaces_its_error_through_the_blocking_thread() {
    let store = Documents::default();
    let id = a_document(&store);
    let engine = Arc::new(FakeEngine {
      fails: true,
      ..Default::default()
    });

    let error = translate(engine, &store, &id, "en").expect_err("une panne");
    assert_eq!(error.kind(), "native");
    assert_eq!(error.to_string(), "moteur en panne");
  }

  /// Un identifiant inconnu veut dire que le magasin et les fenêtres ont divergé : on le dit,
  /// on ne rend pas un transcript vide.
  #[test]
  fn an_unknown_document_is_refused_before_any_engine_call() {
    let store = Documents::default();
    let engine = Arc::new(FakeEngine::default());
    let error = translate(Arc::clone(&engine), &store, "filedoc-404", "en").expect_err("erreur");
    assert_eq!(error.kind(), "invalidArgument");
    assert_eq!(*engine.calls.lock().expect("verrou"), 0);
  }

  // La session : les deux commandes qui traduisent transcript et compte rendu.

  /// La doublure vue comme le trait — la coercition ne se fait pas au travers d'`Arc::clone`.
  fn shared(engine: &Arc<FakeEngine>) -> Arc<dyn TranslationEngine> {
    engine.clone()
  }

  /// Le transcript d'une session, tel que `begin` puis la consolidation le posent.
  fn a_session_transcript() -> Transcript {
    let word = |text: &str, start_ms: u64, end_ms: u64| Word {
      text: text.into(),
      start_ms,
      end_ms,
    };
    Transcript::of(
      &[word("Bonjour", 0, 400), word("Merci.", 3_500, 3_900)],
      "fr",
    )
  }

  fn a_session_report() -> Vec<ReportSection> {
    vec![ReportSection {
      heading: "Résumé".into(),
      lines: vec!["Deux points.".into()],
      bullets: false,
    }]
  }

  /// ⚠️ La langue source vient du document, comme pour un fichier : la laisser choisir à l'écran
  /// permettrait de demander `en→ja` sur une session française.
  #[test]
  fn a_session_transcript_is_translated_paragraph_by_paragraph() {
    let engine = Arc::new(FakeEngine::default());
    let outcome = tauri::async_runtime::block_on(translate_live_transcript_inner(
      shared(&engine),
      a_session_transcript(),
      "en",
      Arc::new(AtomicBool::new(false)),
      |_| {},
    ))
    .expect("succès");

    let TranscriptTranslation::Translated { paragraphs } = outcome else {
      panic!("la traduction devait aboutir");
    };
    assert_eq!(paragraphs.len(), 2);
    assert_eq!(paragraphs[0].text, "BONJOUR");
    assert_eq!(paragraphs[1].end_ms, 3_900, "les bornes ne bougent pas");
    assert_eq!(*engine.calls.lock().expect("verrou"), 2);
  }

  /// ⚠️ « Langue d'origine » ne coûte pas un appel, ici comme ailleurs.
  #[test]
  fn a_session_asked_for_its_own_language_calls_nothing() {
    let engine = Arc::new(FakeEngine::default());
    tauri::async_runtime::block_on(translate_live_transcript_inner(
      shared(&engine),
      a_session_transcript(),
      "fr",
      Arc::new(AtomicBool::new(false)),
      |_| {},
    ))
    .expect("succès");
    assert_eq!(*engine.calls.lock().expect("verrou"), 0);
  }

  /// ⚠️ Le compte rendu traduit ses intitulés : le modèle les a écrits, pas une table.
  #[test]
  fn a_session_report_is_translated_headings_included() {
    let engine = Arc::new(FakeEngine::default());
    let outcome = tauri::async_runtime::block_on(translate_live_report_inner(
      shared(&engine),
      a_session_report(),
      "fr".into(),
      "en",
      Arc::new(AtomicBool::new(false)),
      |_| {},
    ))
    .expect("succès");

    assert_eq!(
      outcome,
      ReportTranslation::Translated {
        sections: vec![ReportSection {
          heading: "RÉSUMÉ".into(),
          lines: vec!["DEUX POINTS.".into()],
          bullets: false,
        }],
      }
    );
    assert_eq!(
      *engine.calls.lock().expect("verrou"),
      2,
      "l’intitulé traverse le pont comme sa ligne"
    );
  }

  /// ⚠️ Le drapeau d'annulation est partagé avec la traduction de transcript — même table
  /// `TranslationJobs`, même identifiant de document. Il doit donc être lu ici aussi.
  #[test]
  fn a_cancelled_session_translation_gives_back_nothing() {
    let engine = Arc::new(FakeEngine::default());
    let outcome = tauri::async_runtime::block_on(translate_live_report_inner(
      shared(&engine),
      a_session_report(),
      "fr".into(),
      "en",
      Arc::new(AtomicBool::new(true)),
      |_| {},
    ))
    .expect("pas une panne");

    assert_eq!(outcome, ReportTranslation::Cancelled);
  }

  /// ⚠️ Un document sans compte rendu n'est pas une erreur : la fenêtre s'ouvre sur le
  /// transcript, et le compte rendu est un geste à part.
  #[test]
  fn a_session_without_a_report_translates_to_an_empty_one() {
    let engine = Arc::new(FakeEngine::default());
    let outcome = tauri::async_runtime::block_on(translate_live_report_inner(
      shared(&engine),
      Vec::new(),
      "fr".into(),
      "en",
      Arc::new(AtomicBool::new(false)),
      |_| {},
    ))
    .expect("succès");

    assert_eq!(outcome, ReportTranslation::Translated { sections: vec![] });
    assert_eq!(*engine.calls.lock().expect("verrou"), 0);
  }

  /// Une panne du moteur remonte **intacte** depuis les deux commandes de session.
  #[test]
  fn a_failing_engine_surfaces_its_error_from_both_session_commands() {
    let engine = || -> Arc<dyn TranslationEngine> {
      Arc::new(FakeEngine {
        fails: true,
        ..Default::default()
      })
    };
    let transcript = tauri::async_runtime::block_on(translate_live_transcript_inner(
      engine(),
      a_session_transcript(),
      "en",
      Arc::new(AtomicBool::new(false)),
      |_| {},
    ))
    .expect_err("une panne");
    assert_eq!(transcript.kind(), "native");

    let report = tauri::async_runtime::block_on(translate_live_report_inner(
      engine(),
      a_session_report(),
      "fr".into(),
      "en",
      Arc::new(AtomicBool::new(false)),
      |_| {},
    ))
    .expect_err("une panne");
    assert_eq!(report.to_string(), "moteur en panne");
  }

  #[test]
  fn a_blocking_call_carries_its_value_back() {
    let value = tauri::async_runtime::block_on(off_thread(|| Ok(42))).expect("succès");
    assert_eq!(value, 42);
  }

  /// L'erreur du pont doit remonter **intacte**, sans être reclassée : le frontend branche sur
  /// `kind`, et une panne de traduction est une panne native.
  #[test]
  fn a_failing_call_surfaces_its_error_untouched() {
    let error =
      tauri::async_runtime::block_on(off_thread::<u8>(|| Err(AppError::Native("boum".into()))))
        .expect_err("l'erreur doit remonter");
    assert_eq!(error.kind(), "native");
    assert_eq!(error.to_string(), "boum");
  }

  #[test]
  fn a_probe_pair_short_circuits_the_choice_entirely() {
    // ⚠️ Elle court-circuite le CHOIX, pas seulement la garde de périmètre : posée en aval de
    // la décision, elle n'était jamais atteinte — la décision concluant « rien ne manque ».
    assert_eq!(
      probe_pair(Some("fr-pl".into()), true),
      Some(("fr".to_owned(), "pl".to_owned()))
    );
  }

  #[test]
  fn a_malformed_probe_is_ignored() {
    for forced in [
      None,
      Some(String::new()),
      Some("pl".into()),
      Some("-pl".into()),
    ] {
      assert_eq!(probe_pair(forced, true), None);
    }
  }

  #[test]
  fn only_a_downloadable_pair_is_ever_offered() {
    // `Unsupported` n'est pas `Supported` : proposer un téléchargement qu'Apple ne fera jamais
    // serait une promesse en l'air.
    let availability = TranslationAvailability {
      languages: vec!["fr".into(), "it".into()],
      pairs: vec![
        PairAvailability {
          source: "fr".into(),
          target: "it".into(),
          status: PairStatus::Unsupported,
        },
        PairAvailability {
          source: "en".into(),
          target: "it".into(),
          status: PairStatus::Supported,
        },
      ],
    };
    let spoken = vec!["fr".to_owned(), "en".to_owned()];
    let chosen = representative_missing_pair(&availability, "it", &spoken).expect("une paire");
    assert_eq!(chosen.source, "en");
  }

  #[test]
  fn nothing_is_offered_when_everything_is_installed() {
    let availability = TranslationAvailability {
      languages: vec!["fr".into(), "it".into()],
      pairs: vec![PairAvailability {
        source: "fr".into(),
        target: "it".into(),
        status: PairStatus::Installed,
      }],
    };
    assert!(representative_missing_pair(&availability, "it", &["fr".to_owned()]).is_none());
  }

  #[test]
  fn a_source_the_user_does_not_speak_is_ignored() {
    let availability = TranslationAvailability {
      languages: vec!["es".into(), "it".into()],
      pairs: vec![PairAvailability {
        source: "es".into(),
        target: "it".into(),
        status: PairStatus::Supported,
      }],
    };
    assert!(representative_missing_pair(&availability, "it", &["fr".to_owned()]).is_none());
  }

  /// Ces deux tests sont la preuve **exécutée** que la porte de mesure ne franchit pas la
  /// frontière du développement. Chacun ne tourne que dans son profil, et chacun affirme une
  /// valeur en dur — pas `cfg!`, sinon l'assertion ne prouverait rien.
  #[cfg(debug_assertions)]
  #[test]
  fn the_probe_is_allowed_in_a_development_build() {
    assert!(probe_allowed());
  }

  #[cfg(not(debug_assertions))]
  #[test]
  fn the_probe_is_refused_in_a_production_build() {
    assert!(!probe_allowed());
    assert_eq!(probe_pair(Some("fr-pl".into()), false), None);
  }
}
