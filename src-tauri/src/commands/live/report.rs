//! Le compte rendu d'une session, par le modèle de langue local.
//!
//! # Pièges
//!
//! - ⚠️ Le compte rendu appartient au Direct, et à lui seul : les fichiers n'en ont pas.
//! - ⚠️ Long et interruptible : l'avancement part par [`super::LIVE_PROGRESS_EVENT`], et
//!   l'annulation passe par [`ReportJobs`], jamais par l'abandon de la tâche.

use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};

use tauri::{AppHandle, Manager};

use super::finalise::mirror;
use super::progressed;
use crate::{blocking::off_thread, error::AppError, native};

/// Les générations de compte rendu en cours, et le drapeau qui arrête chacune.
///
/// La mécanique vit dans [`crate::jobs`], partagée avec la traduction de document.
///
/// # Pièges
///
/// - ⚠️ Enveloppe de rangement, et rien d'autre : `.manage()` classe par type, et deux tables du
///   même type se marcheraient dessus.
/// - ⚠️ Une table par document : plusieurs fenêtres-sessions terminées peuvent être ouvertes,
///   chacune capable de demander *son* compte rendu.
#[derive(Default)]
pub struct ReportJobs(pub crate::jobs::Jobs);

/// Génère — ou régénère — le compte rendu d'une session ; l'arrêt passe par [`cancel_live_report`].
///
/// # Errors
///
/// Rend [`AppError::Io`] si la session est inconnue, [`AppError::Native`] si le modèle échoue.
///
/// # Pièges
///
/// - ⚠️ Régénérer ne re-transcrit rien : le transcript ne dépend pas du type de compte rendu, et
///   il n'y aurait de toute façon plus d'audio à lire.
/// - ⚠️ Une annulation ne range rien, et c'est tout ce qui fait « l'état d'avant » : elle rend le
///   document relu, intact. Ranger des rubriques vides effacerait le compte rendu précédent.
#[tauri::command]
pub async fn generate_live_report(
  app: AppHandle,
  jobs: tauri::State<'_, ReportJobs>,
  id: String,
  kind: String,
  prompt: Option<String>,
) -> Result<crate::live::documents::LiveDocument, AppError> {
  let documents = app.state::<crate::live::documents::LiveDocuments>();
  let document = documents.get(&id)?;
  let language = document.transcript.language.clone();
  let turns: Vec<String> = document
    .transcript
    .rendered()
    .into_iter()
    .map(|turn| turn.text)
    .collect();

  let flag = jobs.0.begin(&id);
  let outcome = generated(&app, &id, turns, kind, prompt, language, Arc::clone(&flag)).await;
  // ⚠️ Quelle que soit l'issue, y compris une panne : une entrée laissée derrière ferait qu'un
  // clic tardif sur « Annuler » armerait un drapeau que plus personne ne lit.
  jobs.0.end(&id, &flag);

  let written = match outcome? {
    Some(sections) => app
      .state::<crate::live::documents::LiveDocuments>()
      .set_report(&id, sections)?,
    None => app
      .state::<crate::live::documents::LiveDocuments>()
      .get(&id)?,
  };
  mirror(&app, &written).await;
  Ok(written)
}

/// Le travail lui-même. **Rend `None` si l'utilisateur a renoncé.**
///
/// # Errors
///
/// Rend [`AppError::Native`] si le modèle échoue, ou [`AppError::Io`] si la tâche n'est pas
/// revenue.
#[allow(clippy::too_many_arguments)]
async fn generated(
  app: &AppHandle,
  id: &str,
  turns: Vec<String>,
  kind: String,
  prompt: Option<String>,
  language: String,
  cancelled: Arc<AtomicBool>,
) -> Result<Option<Vec<crate::live::report::ReportSection>>, AppError> {
  let watcher = app.clone();
  let watched = id.to_owned();
  off_thread(move || {
    crate::live::report::compose(
      &turns,
      &language,
      prompt.as_deref(),
      |stage, text| native::llm_report(text, stage.as_str(), &kind, prompt.as_deref(), &language),
      |stage, done, total| {
        progressed(&watcher, &watched, step_of(stage), done, total);
        // ⚠️ Le même rappel mesure et décide : un second endroit qui relirait le drapeau serait
        // un endroit de plus à oublier — voir `translate_document_inner`.
        !cancelled.load(Ordering::SeqCst)
      },
      // ⚠️ Le doute ne refait rien : une détection en échec — pont cassé, texte trop court — rend
      // `None`, et `compose` laisse alors le compte rendu tel quel.
      |written| native::detect_text_language(written).ok().flatten(),
    )
  })
  .await
}

/// L'étage du map-reduce, dans le vocabulaire du voile.
///
/// # Pièges
///
/// - ⚠️ Deux vocabulaires et non un : `Stage` dit ce qu'on demande au modèle et traverse le pont
///   Swift, `LiveStep` dit ce que l'écran montre. Les fondre lierait un prompt natif à un libellé.
fn step_of(stage: crate::live::report::Stage) -> crate::live::progress::LiveStep {
  match stage {
    // ⚠️ Condenser est une prise de notes, vu de l'écran : l'utilisateur n'a pas à connaître le
    // repli interne, et lui inventer une étape obligerait le frontend à la nommer.
    crate::live::report::Stage::Notes | crate::live::report::Stage::Condense => {
      crate::live::progress::LiveStep::Notes
    }
    crate::live::report::Stage::Report => crate::live::progress::LiveStep::Writing,
  }
}

/// Demande l'arrêt de la génération du compte rendu de `id`.
///
/// Idempotente et sans échec : annuler ce qui n'existe plus n'est pas une erreur, l'interface
/// peut cliquer juste après la fin.
///
/// # Pièges
///
/// - ⚠️ L'arrêt se constate entre deux passes, jamais au milieu d'une : le pont ne sait pas
///   interrompre une génération en cours.
#[tauri::command]
pub fn cancel_live_report(jobs: tauri::State<'_, ReportJobs>, id: String) {
  jobs.0.cancel(&id);
}
