//! La consolidation : ce qui se passe entre le clic sur « Arrêter » et le document.
//!
//! Quatre gestes, dans cet ordre, et l'ordre n'est pas négociable : attendre que les deux moteurs
//! aient rendu leurs derniers segments, rapprocher les voix des deux fichiers d'un seul appel,
//! écarter l'écho du flux micro puis entrelacer les deux flux, supprimer l'audio.
//!
//! # Pièges
//!
//! - ⚠️ L'audio est supprimé même quand la consolidation échoue : ces fichiers portent des voix,
//!   des noms et des chiffres que personne n'a accepté de laisser derrière lui. Les garder « au
//!   cas où » ferait d'un échec de diarisation une fuite de confidentialité.
//! - ⚠️ Le flux système n'est plus diarisé pour lui-même : ses voix ne servent que de référence,
//!   pour savoir lesquelles le micro réentend. Sans micro, aucune diarisation du tout.

use std::{path::Path, time::Duration, time::Instant};

use crate::{
  diarization::{AUTO_THRESHOLD, DiarizationSegment, attribute, echo, without_slivers},
  error::AppError,
  transcript::Word,
};

use super::{
  LiveSession, LiveTranscript, echo_text,
  progress::{self, LiveStep, Steps},
  weave,
};

/// Ce que le pont rend d'un rapprochement de voix.
///
/// Les segments du système (`firstSegments`) traversent le pont mais ne sont pas déclarés ici :
/// serde les ignore, ils ne servaient qu'à étiqueter des locuteurs qui n'existent plus.
///
/// # Pièges
///
/// - ⚠️ Aucune empreinte ici — voir `mirmalion_voice_match` côté Swift. Ce qui traverse est une
///   distance, dont on ne reconstruit aucune des deux voix.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceMatch {
  /// Les voix du micro, dans l'ordre des colonnes de [`Self::distances`].
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est la clé de lecture de la matrice, et l'oublier décale tout : le pont ne décrit que
  ///   les voix ayant une empreinte lisible, une voix trop courte garde ses tours de parole mais
  ///   saute son numéro ici. Voir [`echo::echoes_of_the_room`].
  second: Vec<VoiceSummary>,
  /// Les tours de parole du micro, tels que le pont les a diarisés.
  second_segments: Vec<DiarizationSegment>,
  /// `distances[i][j]` — la voix `i` du système contre la voix `j` du micro. `None` vaut
  /// « incomparable », jamais « différentes ».
  distances: Vec<Vec<Option<f64>>>,
}

/// Une voix telle que le pont la résume : son numéro, jamais son empreinte.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSummary {
  speaker: u32,
}

/// Combien de temps on attend que les moteurs rendent leurs derniers segments.
///
/// Le cas courant est réglé par le signal de fin que chaque flux émet (`complete()` côté Swift) :
/// l'attente s'arrête dès qu'ils ont parlé, souvent en moins d'une seconde.
///
/// # Pièges
///
/// - ⚠️ Ce n'est pas le délai nominal, c'est le plafond : il ne sert qu'au moteur qui meurt sans
///   rien dire, et alors on consolide ce qu'on a plutôt que de laisser l'utilisateur devant un
///   sablier qui ne s'arrêtera jamais.
const SETTLING_CEILING: Duration = Duration::from_secs(20);

/// Le pas de guet : assez fin pour ne pas ajouter d'attente perceptible à un arrêt normal.
const SETTLING_STEP: Duration = Duration::from_millis(50);

/// Attend que les deux flux aient fini, et rend `false` si le plafond a été atteint.
fn wait_until_settled(session: &LiveSession, now: impl Fn() -> Instant) -> bool {
  let started = now();
  while !session.settled() {
    if now().duration_since(started) >= SETTLING_CEILING {
      // ⚠️ On le dit, et on continue : un transcript amputé de sa dernière phrase vaut mieux
      // qu'un arrêt qui ne rend jamais la main, mais il ne doit pas passer pour complet.
      log::warn!("un flux de session n'a pas signalé sa fin ; consolidation sur ce qui est acquis");
      return false;
    }
    std::thread::sleep(SETTLING_STEP);
  }
  true
}

/// Consolide une session terminée et supprime son audio.
///
/// `directory` est le dossier des fichiers temporaires ; il disparaît à la fin, quoi qu'il
/// arrive. `report` reçoit chaque étape franchie — voir [`crate::live::progress`].
///
/// # Errors
///
/// Rend l'erreur du pont si le rapprochement des voix échoue ou si sa réponse est illisible.
///
/// # Pièges
///
/// - ⚠️ Le plan se décide sur l'existence du fichier micro, pas sur le réglage : l'appareil a pu
///   être refusé ou débranché, et se fier à l'intention laisserait deux étapes jamais franchies.
pub fn consolidate(
  session: &LiveSession,
  directory: &Path,
  report: impl Fn(LiveStep, usize, usize) + Send,
) -> Result<LiveTranscript, AppError> {
  let steps = Steps::new(
    progress::finalisation(directory.join("microphone.wav").exists()),
    report,
  );

  steps.enter(LiveStep::Settling);
  wait_until_settled(session, Instant::now);
  let (system_words, microphone_words, language) = session.take();

  // ⚠️ Aucun titre n'est demandé au modèle ici : le document s'ouvre sur « Session du 05/08/2026
  // à 16:12 », composé côté écran dans la langue de l'interface. Un intitulé inventé est
  // trompeur quand il rate, sans que rien ne dise lequel on lit — et c'est une passe de LLM en
  // moins entre « Arrêter » et la fenêtre.
  let outcome = assemble(
    directory,
    &system_words,
    &microphone_words,
    &language,
    &steps,
  );

  // ⚠️ La suppression est dans un `defer` de fait : elle suit le calcul, réussi ou non, et elle
  // est donc aussi annoncée après un échec. C'est une promesse de confidentialité, pas une étape
  // de calcul — voir l'en-tête du module.
  steps.enter(LiveStep::Erasing);
  if let Err(error) = std::fs::remove_dir_all(directory) {
    if error.kind() != std::io::ErrorKind::NotFound {
      // ⚠️ Aucun chemin dans le message : un dossier de session nomme le cache de l'utilisateur,
      // et le journal dit ce qui a échoué, jamais sur quoi.
      log::warn!(
        "l'audio de la session n'a pas pu être supprimé : {}",
        error.kind()
      );
    }
  }

  outcome
}

/// Le calcul seul — séparé pour que la suppression de l'audio n'en dépende pas.
///
/// # Errors
///
/// Rend l'erreur du pont si le rapprochement des voix échoue ou si sa réponse est illisible.
fn assemble(
  directory: &Path,
  system_words: &[Word],
  microphone_words: &[Word],
  language: &str,
  steps: &Steps<'_>,
) -> Result<LiveTranscript, AppError> {
  let system_audio = directory.join("system.wav");
  let microphone_audio = directory.join("microphone.wav");

  // ⚠️ Sans micro, on ne diarise rien du tout : pas de second fichier, donc pas d'écho possible,
  // et les voix du flux système ne serviraient qu'à des étiquettes qui n'existent plus. Le
  // transcript se compose directement depuis les mots — le cas d'une conférence qu'on écoute.
  if !microphone_audio.exists() {
    steps.enter(LiveStep::Weaving);
    return Ok(weave(system_words, &[], language));
  }

  steps.enter(LiveStep::Voices);
  let matched = match_voices(&system_audio, &microphone_audio)?;
  let microphone_segments = without_slivers(matched.second_segments);

  // ⚠️ Le filtre d'écho porte sur les mots, pas sur les segments : retirer d'abord les segments
  // d'écho puis attribuer les mots ferait retomber chaque mot d'écho sur le segment le plus
  // proche qui reste, c'est-à-dire sur une voix qu'on garde. On attribue donc contre tous les
  // tours du micro, puis on jette les mots dont la voix est un écho.
  steps.enter(LiveStep::Echo);
  let voices: Vec<u32> = matched.second.iter().map(|voice| voice.speaker).collect();
  let echoed = echo::echoes_of_the_room(&matched.distances, &voices);
  let attribution = attribute(microphone_words, &microphone_segments);
  let mine: Vec<Word> = microphone_words
    .iter()
    .zip(attribution.iter())
    .filter(|(_, voice)| !echoed.contains(*voice))
    .map(|(word, _)| word.clone())
    .collect();

  log::debug!(
    "consolidation : {} voix micro dont {} d'écho",
    microphone_segments
      .iter()
      .map(|segment| segment.speaker)
      .collect::<std::collections::BTreeSet<_>>()
      .len(),
    echoed.len()
  );
  log::debug!("écho : {}", nearest_per_voice(&matched.distances, &voices));

  // Un second filtre, sur le texte. Les deux répondent à la même question par deux chemins qui
  // échouent différemment : celui du dessus demande « cette voix du micro, le système la
  // connaît-il ? » et ne peut rien dire quand le diariseur n'a pas su isoler l'utilisateur ;
  // celui-ci demande « ce que le micro dit à cet instant, le système ne le dit-il pas aussi ? »,
  // énoncé par énoncé, sans se soucier du nombre de voix.
  //
  // ⚠️ En union, pas en intersection : exiger les deux ne garderait que ce qu'ils attrapent tous
  // les deux, moins que chacun seul, alors que le défaut vécu est l'écho qui passe, pas l'écho
  // écarté à tort. Un transcript où chaque phrase figure deux fois donne un compte rendu qui
  // radote — le doublon coûte plus cher là qu'à l'écran.
  let (mine, echoed_utterances) = echo_text::without_echo(&mine, system_words);
  log::debug!(
    "écho (texte) : {echoed_utterances} énoncés du micro écartés, {} mots gardés",
    mine.len()
  );

  steps.enter(LiveStep::Weaving);
  Ok(weave(system_words, &mine, language))
}

/// La distance la plus courte trouvée pour chaque voix du micro, prête à journaliser.
///
/// # Pièges
///
/// - ⚠️ Ce journal est le seul témoin qui survive à la consolidation : l'audio est supprimé juste
///   après, aucune session ne peut être rejouée. Sans lui, rien ne distingue « voix non mesurée »
///   de « mesurée et loin de la borne » ou « près, verdict bon, défaut ailleurs ».
/// - ⚠️ Aucun contenu utilisateur : un numéro de voix et une distance ne disent ni qui parle, ni
///   de quoi. L'empreinte, elle, ne quitte jamais Swift.
fn nearest_per_voice(distances: &[Vec<Option<f64>>], voices: &[u32]) -> String {
  if voices.is_empty() {
    return "aucune voix comparable côté micro".to_owned();
  }
  let readings: Vec<String> = voices
    .iter()
    .enumerate()
    .map(|(column, voice)| {
      let closest = distances
        .iter()
        .filter_map(|row| row.get(column).copied().flatten())
        .fold(None, |best: Option<f64>, distance| {
          Some(best.map_or(distance, |current| current.min(distance)))
        });
      match closest {
        Some(distance) => format!("voix {voice} à {distance:.3}"),
        None => format!("voix {voice} non mesurée"),
      }
    })
    .collect();
  format!(
    "{} (borne {:.2})",
    readings.join(" · "),
    echo::ECHO_DISTANCE
  )
}

/// Rapproche les voix des deux fichiers, d'un seul appel au pont.
///
/// # Errors
///
/// Rend l'erreur du pont, ou [`AppError::Native`] si sa réponse n'est pas lisible.
fn match_voices(system: &Path, microphone: &Path) -> Result<VoiceMatch, AppError> {
  let raw = crate::native::voice_match(
    &system.to_string_lossy(),
    &microphone.to_string_lossy(),
    AUTO_THRESHOLD,
  )?;
  serde_json::from_str(&raw)
    .map_err(|error| AppError::Native(format!("rapprochement des voix illisible : {error}")))
}

#[cfg(test)]
mod tests {
  use super::{SETTLING_CEILING, consolidate, nearest_per_voice, wait_until_settled};
  use crate::live::LiveSession;
  use crate::live::LiveStream;
  use std::cell::Cell;
  use std::path::PathBuf;
  use std::time::{Duration, Instant};

  /// ⚠️ L'attente s'éprouve avec une horloge fabriquée, jamais avec `sleep` : un test qui
  /// attendrait vraiment vingt secondes ne serait jamais rejoué.
  fn frozen_clock(steps: &[Duration]) -> impl Fn() -> Instant + '_ {
    let origin = Instant::now();
    let index = Cell::new(0);
    move || {
      let step = index.get().min(steps.len().saturating_sub(1));
      index.set(index.get() + 1);
      origin + steps.get(step).copied().unwrap_or_default()
    }
  }

  /// Un dossier de session temporaire, avec les fichiers qu'une capture y laisse.
  ///
  /// ⚠️ Pas de `microphone.wav` : sans lui, `assemble` ne diarise rien et ne touche pas au pont,
  /// ce qui rend la consolidation éprouvable sans moteur, en quelques millisecondes. C'est aussi
  /// le cas qui isole ce qu'on mesure ici — la disparition du dossier.
  fn a_session_directory(name: &str) -> PathBuf {
    let directory =
      std::env::temp_dir().join(format!("mirmalion-finalise-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("dossier de session");
    std::fs::write(directory.join("system.wav"), b"RIFF....WAVE").expect("audio système");
    directory
  }

  fn a_settled_session() -> LiveSession {
    let session = LiveSession::default();
    session.start(
      "fr",
      false,
      "Tout le système",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.settle(LiveStream::System);
    session
  }

  /// L'audio de la session disparaît du disque, et c'est mesuré ici plutôt que relu : ces
  /// fichiers portent des voix, des noms et des chiffres que personne n'a accepté de laisser
  /// derrière lui.
  ///
  /// ⚠️ On vérifie le dossier, pas deux noms de fichiers : un flux ajouté plus tard y écrirait un
  /// troisième fichier, et une assertion nominative le laisserait passer sans un mot.
  #[test]
  fn consolidating_a_session_takes_its_audio_off_the_disk() {
    let directory = a_session_directory("nominal");
    assert!(directory.is_dir(), "le dossier existe avant l’arrêt");

    consolidate(&a_settled_session(), &directory, |_, _, _| {}).expect("consolidation");

    assert!(
      !directory.exists(),
      "le dossier de la session doit avoir disparu, fichiers compris"
    );
  }

  /// ⚠️ L'audio disparaît même quand il n'y a rien à consolider : une session muette reste une
  /// session dont l'audio a été capté, et le garder « puisque le transcript est vide » ferait
  /// exactement la fuite que le module cherche à empêcher.
  #[test]
  fn a_session_that_produced_no_word_still_loses_its_audio() {
    let directory = a_session_directory("muette");
    let transcript = consolidate(&a_settled_session(), &directory, |_, _, _| {})
      .expect("une session muette n’est pas une panne");

    assert!(transcript.transcript.paragraphs.is_empty());
    assert!(!directory.exists());
  }

  /// ⚠️ Supprimer ce qui n'existe pas n'est pas une erreur : le balayage du démarrage a pu passer
  /// avant, sur une session dont le processus était mort, et la consolidation qui reprend
  /// derrière lui ne doit pas échouer pour autant.
  #[test]
  fn a_directory_already_gone_is_not_a_failure() {
    let directory = std::env::temp_dir().join("mirmalion-finalise-absent");
    let _ = std::fs::remove_dir_all(&directory);

    consolidate(&a_settled_session(), &directory, |_, _, _| {}).expect("pas une panne");
  }

  #[test]
  fn a_settled_session_does_not_wait_at_all() {
    let session = LiveSession::default();
    session.start(
      "fr",
      false,
      "Tout le système",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.settle(LiveStream::System);

    assert!(wait_until_settled(
      &session,
      frozen_clock(&[Duration::ZERO])
    ));
  }

  /// ⚠️ Un moteur qui meurt sans rien dire ne bloque pas l'arrêt : sans ce plafond, le bouton
  /// « Arrêter » resterait enfoncé pour toujours sur une session dont un flux a échoué en
  /// silence — et ce moteur-là échoue précisément en silence.
  #[test]
  fn a_stream_that_never_reports_its_end_stops_the_wait_at_the_ceiling() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.settle(LiveStream::System);

    let settled = wait_until_settled(
      &session,
      frozen_clock(&[Duration::ZERO, SETTLING_CEILING + Duration::from_secs(1)]),
    );
    assert!(!settled, "le plafond doit être signalé, pas masqué");
  }

  /// ⚠️ Ce journal est le seul témoin qui survive à la consolidation — l'audio est supprimé juste
  /// après. Il doit donc distinguer « non mesurée » de « mesurée et loin » : deux causes
  /// différentes, qui appellent deux correctifs différents.
  #[test]
  fn the_echo_log_tells_an_unmeasured_voice_apart_from_a_distant_one() {
    let reading = nearest_per_voice(&[vec![Some(0.412), None], vec![Some(0.118), None]], &[0, 3]);

    assert!(reading.contains("voix 0 à 0.118"), "{reading}");
    assert!(reading.contains("voix 3 non mesurée"), "{reading}");
    assert!(
      reading.contains("0.26"),
      "la borne doit figurer : {reading}"
    );
  }

  /// Sans voix comparable, le journal le dit plutôt que de rendre une ligne vide qu'on lirait
  /// comme un défaut d'écriture.
  #[test]
  fn the_echo_log_says_so_when_there_was_nothing_to_compare() {
    assert_eq!(
      nearest_per_voice(&[], &[]),
      "aucune voix comparable côté micro"
    );
  }
}
