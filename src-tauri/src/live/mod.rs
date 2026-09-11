//! La session, entre le direct et le document : ce qu'on accumule pendant, ce qu'on en fait à
//! l'arrêt.
//!
//! La capture écrit deux fichiers et transcrit deux flux séparément (`SystemAudioTap.swift`) ;
//! ce module est le seul endroit où ils se rencontrent, et c'est à l'arrêt. En direct, l'audio
//! n'est pas complet et le regroupement des voix est global : un locuteur qui n'a dit que trois
//! mots ne devient distinguable qu'à sa deuxième intervention. D'où deux temps, approximatif
//! pendant, corrigé après.
//!
//! # Pièges
//!
//! - ⚠️ Sur un fichier, une mauvaise diarisation se rattrape — le média est toujours là. Sur une
//!   session, non : l'audio est supprimé à la finalisation, la consolidation ne passe qu'une
//!   fois, et un mauvais découpage des voix est définitif.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::transcript::{PARAGRAPH_SILENCE_MS, Transcript, Word};

pub mod documents;
pub mod echo_text;
pub mod finalise;
pub mod headings;
pub mod history;
pub mod progress;
pub mod report;
pub mod title;

/// Le transcript d'une session : du texte, sans étiquette de locuteur.
///
/// Le micro est capté, transcrit et débarrassé de son écho — voir [`finalise`] ; simplement, ce
/// qu'il a dit s'écrit au même titre que le reste.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscript {
  /// Les deux flux entrelacés en un texte chronologique.
  pub transcript: Transcript,
  /// L'intitulé proposé par le modèle local, `None` s'il n'y avait rien à nommer ou si la
  /// génération a échoué.
  ///
  /// # Pièges
  ///
  /// - ⚠️ `None` n'est pas une panne, et le repli n'est pas ici : « Session du {date} » se compose
  ///   dans la langue de l'interface, avec `Intl`. Le backend n'a à connaître ni la langue de
  ///   l'écran ni le format de date du lieu.
  pub title: Option<String>,
}

/// Entrelace les mots des deux flux en un transcript chronologique unique.
///
/// `system` porte les mots du flux système ; `mine` ceux du micro qui ont survécu au filtre
/// d'écho — voir [`crate::diarization::echo`].
///
/// # Pièges
///
/// - ⚠️ Les deux flux restent transcrits et diarisés séparément en amont : c'est ce travail qui
///   permet au filtre d'écho de savoir de quelle voix vient chaque mot du micro.
/// - ⚠️ Le décalage de ~0,20 s entre les flux — le micro s'ouvre après le tap — n'est pas compensé :
///   il ne déplace que l'ordre d'entrelacement, et une constante mal signée doublerait l'erreur.
pub fn weave(system: &[Word], mine: &[Word], language: &str) -> LiveTranscript {
  let mut words: Vec<Word> = Vec::with_capacity(system.len() + mine.len());
  words.extend_from_slice(system);
  words.extend_from_slice(mine);

  // ⚠️ Tri stable, et par le début du mot : deux mots qui commencent au même instant — un de
  // chaque flux, donc deux personnes qui parlent ensemble — gardent l'ordre d'insertion, le
  // système d'abord. C'est arbitraire mais déterministe, et un transcript qui changerait d'ordre
  // d'une consolidation à l'autre serait impossible à relire.
  words.sort_by_key(|word| word.start_ms);

  LiveTranscript {
    // ⚠️ Toujours `None`, et personne ne le remplit ensuite : le produit ne demande plus de titre
    // au modèle — voir `finalise::consolidate`. Le document s'ouvre sur « Session du {date} »,
    // composé côté écran, et l'utilisateur renomme. Le champ reste parce que la brique reste.
    title: None,
    transcript: Transcript::of(&words, language),
  }
}

/// De quel flux vient un morceau de transcript.
///
/// # Pièges
///
/// - ⚠️ Le type vit dans le domaine et non dans les commandes : c'est [`LiveSession`] qui range
///   les mots par flux, et une session doit pouvoir se mesurer sans couche IPC autour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveStream {
  /// L'audio de l'application captée : la voix des autres.
  System,
  /// Le micro de l'utilisateur. **« Moi » par construction**, sans la moindre inférence.
  Microphone,
}

/// Ce qu'une session accumule pendant qu'elle se déroule.
///
/// # Pièges
///
/// - ⚠️ Les mots s'arrêtent ici, ils ne vont pas à l'écran : l'affichage en direct n'a besoin que
///   de la phrase, les mots horodatés servent à la consolidation. Les faire traverser l'IPC
///   coûterait, sur une session de deux heures, proportionnellement à sa durée.
#[derive(Default)]
pub struct LiveSession {
  inner: Mutex<LiveState>,
}

/// Où en est la session, du point de vue de ce qu'une fenêtre doit montrer.
///
/// # Pièges
///
/// - ⚠️ Trois états et pas deux : entre « Arrêter » et le transcript consolidé, il s'écoule
///   plusieurs secondes. Un booléen « ça enregistre » ferait retomber la fenêtre sur un document
///   vide pendant ce temps-là, avant de la faire sauter au transcript.
/// - ⚠️ Il ne dit rien du tap : « le tap est-il ouvert » est une question de plomberie, à
///   laquelle [`crate::commands::live::LiveCaptureStatus`] répond. La consolidation
///   tourne alors que le tap est fermé depuis longtemps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LivePhase {
  /// Aucune session en cours.
  #[default]
  Idle,
  /// La capture est ouverte et le transcript s'écrit au fil de l'eau.
  Recording,
  /// La capture est close, la consolidation tourne — c'est le voile.
  Finalising,
}

/// Ce qu'une fenêtre a besoin de savoir de la session en cours, à froid.
///
/// # Pièges
///
/// - ⚠️ C'est la réhydratation : chaque fenêtre porte sa propre instance d'Angular, donc son
///   propre magasin, et ce que le déclencheur a retenu en démarrant est invisible à la
///   fenêtre-session. La vérité vit ici, et les deux la relisent.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionState {
  /// Où en est la session — voir [`LivePhase`].
  pub phase: LivePhase,
  /// La fenêtre-session concernée — `None` au repos.
  pub document_id: Option<String>,
  /// Quand la capture a commencé. C'est de là que les deux fenêtres tirent leur minuteur.
  pub started_at_ms: Option<u64>,
  /// Ce qui est capté — « Microsoft Teams », « Tout le système ». `None` au repos.
  pub source_name: Option<String>,
  /// Le micro est-il capté en plus du système ?
  pub with_microphone: bool,
}

/// Combien d'énoncés du système restent comparables.
///
/// # Pièges
///
/// - ⚠️ Quelques répliques suffisent : l'écho est simultané, et une liste sans fin ferait payer
///   chaque comparaison de plus en plus cher sur une session de deux heures.
const HEARD_KEPT: usize = 8;

#[derive(Default)]
struct LiveState {
  system: Vec<Word>,
  microphone: Vec<Word>,
  /// Les derniers énoncés acquis du système, pour y reconnaître l'écho du micro.
  heard: Vec<echo_text::Heard>,
  /// Ce que le système est en train de dire.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Les hypothèses se comparent entre elles, et c'est ce qui efface le doublon à l'écran :
  ///   attendre les énoncés acquis des deux moteurs le laissait visible toute la durée de la
  ///   phrase, alors que le système écrit déjà ce qu'il entend.
  system_hypothesis: Option<String>,
  /// Ce que le micro est en train de dire.
  microphone_hypothesis: Option<String>,
  /// La fin du dernier segment vu, tous flux confondus — voir [`LiveSession::opens_paragraph`].
  last_spoken_end_ms: Option<u64>,
  /// Le flux système a-t-il rendu tout ce qu'il avait ? Voir `complete()` côté Swift.
  system_settled: bool,
  /// Le flux micro a-t-il rendu tout ce qu'il avait ?
  microphone_settled: bool,
  /// Le micro était-il capté ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sans lui, on n'attend pas son signal de fin : sinon l'arrêt d'une session enregistrée
  ///   sans micro patienterait jusqu'à l'expiration du délai.
  expects_microphone: bool,
  /// La langue de la session, telle que le démarrage l'a fixée.
  language: String,
  /// Ce qui était capté — « Microsoft Teams », « Tout le système ».
  ///
  /// # Pièges
  ///
  /// - ⚠️ Relevé au démarrage, jamais relu à l'arrêt : l'application visée peut avoir été fermée
  ///   entre-temps, et le document doit continuer de dire ce qui a été enregistré.
  source_name: String,
  /// La session et sa fenêtre — `directdoc-3`, vide au repos.
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est le lien qui permet à l'arrêt de savoir qui consolider. Sans lui, l'arrêt devrait
  ///   retrouver le document — par la dernière fenêtre ouverte, par le plus grand compteur — et
  ///   toutes ces pistes se trompent dès qu'une session terminée reste affichée à côté.
  document_id: String,
  /// Quand la capture a commencé, en millisecondes depuis l'époque. `0` au repos.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le chrono de chaque fenêtre se relit ici, il ne se compte pas : deux fenêtres affichent
  ///   la même session, et l'une d'elles peut renaître en cours de route — un compteur tenu par
  ///   un composant repartirait de zéro à chaque fois.
  started_at_ms: u64,
  /// Où en est la session — voir [`LivePhase`].
  phase: LivePhase,
}

impl LiveSession {
  /// Ouvre une session, en effaçant tout ce que la précédente avait laissé.
  pub fn start(
    &self,
    language: &str,
    with_microphone: bool,
    source_name: &str,
    document_id: &str,
    started_at_ms: u64,
  ) {
    let mut live = self.locked();
    // ⚠️ Les deux drapeaux de fin traversent le démarrage, et c'est tout l'enjeu : Swift lance
    // la transcription **pendant** `live_start`, donc un moteur qui refuse la langue se signale
    // avant qu'on arrive ici. Les remettre à zéro effacerait son aveu, et la consolidation
    // attendrait le plafond de vingt secondes à chaque session muette. Ils s'éteignent dans
    // [`LiveSession::close`].
    let (system_settled, microphone_settled) = (live.system_settled, live.microphone_settled);
    *live = LiveState {
      expects_microphone: with_microphone,
      language: language.to_owned(),
      source_name: source_name.to_owned(),
      document_id: document_id.to_owned(),
      started_at_ms,
      phase: LivePhase::Recording,
      system_settled,
      microphone_settled,
      ..LiveState::default()
    };
  }

  /// Ce qui était capté, relevé au démarrage.
  pub fn source_name(&self) -> String {
    self.locked().source_name.clone()
  }

  /// L'étiquette de la fenêtre-session en cours, ou `None` au repos.
  ///
  /// # Pièges
  ///
  /// - ⚠️ L'identifiant du document **est** l'étiquette de sa fenêtre (`directdoc-3`) : c'est ce
  ///   qui permet d'adresser un évènement à elle seule. Les découpler ferait taire la fenêtre
  ///   sans un mot — un `emit_to` vers une étiquette inconnue ne rend aucune erreur.
  pub fn window_label(&self) -> Option<String> {
    let live = self.locked();
    (live.phase != LivePhase::Idle).then(|| live.document_id.clone())
  }

  /// Ce qu'une fenêtre a besoin de savoir, à froid. Voir `LiveSessionState`.
  pub fn state(&self) -> LiveSessionState {
    let live = self.locked();
    let idle = live.phase == LivePhase::Idle;
    LiveSessionState {
      phase: live.phase,
      document_id: (!idle).then(|| live.document_id.clone()),
      started_at_ms: (!idle).then_some(live.started_at_ms),
      source_name: (!idle).then(|| live.source_name.clone()),
      with_microphone: !idle && live.expects_microphone,
    }
  }

  /// L'enregistrement est fini, la consolidation commence.
  ///
  /// Rend l'identifiant du document à consolider, ou `None` s'il n'y a rien à faire.
  ///
  /// # Pièges
  ///
  /// - ⚠️ L'arrêt est appelable sur un chemin d'erreur, sans savoir où l'on en était : c'est ce
  ///   `None` qui rend une seconde consolidation impossible plutôt qu'inoffensive.
  pub fn finalising(&self) -> Option<String> {
    let mut live = self.locked();
    if live.phase != LivePhase::Recording {
      return None;
    }
    live.phase = LivePhase::Finalising;
    Some(live.document_id.clone())
  }

  /// La session est close. La suivante repartira d'un état vide.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Les deux drapeaux de fin s'éteignent **ici**, et pas au démarrage : entre les deux, un
  ///   moteur qui renonce a le droit de se signaler, et [`LiveSession::start`] doit garder cet
  ///   aveu. Les éteindre plus tard le perdrait — voir le piège de `start`.
  pub fn close(&self) {
    let mut live = self.locked();
    live.phase = LivePhase::Idle;
    live.document_id.clear();
    live.started_at_ms = 0;
    live.system_settled = false;
    live.microphone_settled = false;
  }

  /// Enregistre les mots d'un segment finalisé.
  pub fn record(&self, stream: LiveStream, words: &[Word]) {
    let mut live = self.locked();
    match stream {
      LiveStream::System => live.system.extend_from_slice(words),
      LiveStream::Microphone => live.microphone.extend_from_slice(words),
    }
  }

  /// Ce segment ouvre-t-il un nouveau paragraphe ? Retient au passage sa fin.
  ///
  /// Le silence est la seule frontière honnête d'un paragraphe : sans étiquette de locuteur, un
  /// retour à la ligne par segment n'a plus de sens — le moteur découpe au gré de ses
  /// respirations — et tout coller ferait d'une session de deux heures un bloc illisible.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Tous flux confondus : un silence n'en est un que si les deux se taisent, couper parce
  ///   qu'un flux s'est tu pendant que l'autre parlait rendrait la pause au mauvais endroit.
  /// - ⚠️ Sans mots horodatés, pas de paragraphe : on ne coupe que sur preuve.
  pub fn opens_paragraph(&self, words: &[Word]) -> bool {
    let (Some(first), Some(last)) = (words.first(), words.last()) else {
      return false;
    };
    let mut live = self.locked();
    let opens = live
      .last_spoken_end_ms
      .is_some_and(|previous| first.start_ms.saturating_sub(previous) >= PARAGRAPH_SILENCE_MS);
    live.last_spoken_end_ms = Some(live.last_spoken_end_ms.unwrap_or(0).max(last.end_ms));
    opens
  }

  /// Retient ce que le système vient de dire, pour y reconnaître l'écho du micro.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Seuls les derniers énoncés sont gardés : l'écho est simultané, et au-delà de quelques
  ///   répliques un texte qui se ressemble est une redite, pas un écho.
  pub fn hear(&self, text: &str, at_ms: u64) {
    let mut live = self.locked();
    live.heard.push(echo_text::Heard {
      text: text.to_owned(),
      at_ms,
    });
    let excess = live.heard.len().saturating_sub(HEARD_KEPT);
    live.heard.drain(..excess);
  }

  /// La couverture la plus forte entre ce que le micro vient d'écrire et ce que le système a dit,
  /// sans appliquer le seuil.
  ///
  /// `at_ms` vaut `None` pour une hypothèse, qui n'a pas de mots horodatés : la comparaison se
  /// fait alors depuis l'instant du dernier énoncé retenu.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Chaque hypothèse est jugée sur son propre texte, jamais sur un état retenu : un tel état
  ///   peut rester vrai indéfiniment et faire taire le micro.
  /// - ⚠️ Le seuil s'applique chez l'appelant, qui journalise aussi ce qui a failli être écarté.
  pub fn weigh(&self, text: &str, at_ms: Option<u64>) -> Option<f64> {
    let live = self.locked();
    Self::compare(text, at_ms, &live)
  }

  /// La comparaison elle-même, sous verrou déjà tenu.
  ///
  /// Deux références, et on garde la plus forte : ce que le système a acquis, et ce qu'il est en
  /// train de dire. La seconde permet de trancher pendant la phrase, au lieu d'attendre que les
  /// deux moteurs aient finalisé.
  fn compare(text: &str, at_ms: Option<u64>, live: &LiveState) -> Option<f64> {
    let against_live = live
      .system_hypothesis
      .as_deref()
      .map(|hypothesis| echo_text::coverage_now(text, hypothesis));
    let against_settled = at_ms
      .or_else(|| live.heard.last().map(|last| last.at_ms))
      .and_then(|at| echo_text::weigh(text, at, &live.heard));
    match (against_live.flatten(), against_settled) {
      (Some(left), Some(right)) => Some(left.max(right)),
      (found, None) | (None, found) => found,
    }
  }

  /// Retient ce que le système est en train de dire.
  pub fn hear_hypothesis(&self, text: &str) {
    self.locked().system_hypothesis = Some(text.to_owned());
  }

  /// Retient ce que le micro est en train de dire, pour pouvoir le reconsidérer.
  pub fn hold_hypothesis(&self, text: &str) {
    self.locked().microphone_hypothesis = Some(text.to_owned());
  }

  /// L'hypothèse du micro est-elle devenue un écho ? Si oui, elle est retirée et sa couverture
  /// rendue.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Une hypothèse se reconsidère quand la référence arrive, pas seulement à sa naissance :
  ///   le micro cesse d'émettre dès qu'il a fini d'entendre, et si le système finalise entre-temps,
  ///   la juger une seule fois laisse le doublon à l'écran jusqu'au bout.
  /// - ⚠️ Elle est retirée en même temps qu'elle est signalée, sinon chaque énoncé acquis du
  ///   système rejouerait le même verdict et ferait pleuvoir des effacements inutiles.
  pub fn take_echoed_hypothesis(&self) -> Option<f64> {
    let mut live = self.locked();
    let held = live.microphone_hypothesis.clone()?;
    let found = Self::compare(&held, None, &live).filter(|f| *f >= echo_text::SAME_UTTERANCE)?;
    live.microphone_hypothesis = None;
    Some(found)
  }

  /// Oublie l'hypothèse d'un flux — son énoncé acquis vient de la remplacer.
  pub fn drop_hypothesis(&self, stream: LiveStream) {
    let mut live = self.locked();
    match stream {
      LiveStream::System => live.system_hypothesis = None,
      LiveStream::Microphone => live.microphone_hypothesis = None,
    }
  }

  /// Note qu'un flux a rendu tout ce qu'il avait.
  pub fn settle(&self, stream: LiveStream) {
    let mut live = self.locked();
    match stream {
      LiveStream::System => live.system_settled = true,
      LiveStream::Microphone => live.microphone_settled = true,
    }
  }

  /// Les deux flux ont-ils fini de rendre leurs derniers segments ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est la question que pose la consolidation avant de commencer : `live_stop` rend la main
  ///   tout de suite, les derniers segments arrivent après, et consolider sans attendre perdrait
  ///   la fin de la session.
  pub fn settled(&self) -> bool {
    let live = self.locked();
    live.system_settled && (!live.expects_microphone || live.microphone_settled)
  }

  /// Rend ce que la session a produit et **repart à zéro**.
  pub fn take(&self) -> (Vec<Word>, Vec<Word>, String) {
    let mut live = self.locked();
    let language = live.language.clone();
    (
      std::mem::take(&mut live.system),
      std::mem::take(&mut live.microphone),
      language,
    )
  }

  /// L'état de la session sous verrou, repris même après empoisonnement.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un verrou empoisonné ne fait pas échouer une session : refuser de lire l'état perdrait
  ///   tout ce qui a été transcrit, pour deux listes de mots qu'on empile et qui n'ont rien
  ///   d'incohérent.
  fn locked(&self) -> std::sync::MutexGuard<'_, LiveState> {
    self.inner.lock().unwrap_or_else(|poisoned| {
      log::warn!("état de session repris après une panne dans un autre fil");
      poisoned.into_inner()
    })
  }
}

#[cfg(test)]
mod tests {
  use super::LiveStream;
  use super::{LivePhase, LiveSession, weave};
  use crate::transcript::Word;

  fn word(text: &str, start_ms: u64) -> Word {
    Word {
      text: text.into(),
      start_ms,
      end_ms: start_ms + 200,
    }
  }

  /// ⚠️ **Au repos, une fenêtre ne doit rien apprendre.** Un identifiant résiduel ferait rouvrir
  /// un voile sur une session close, et un instant de départ résiduel un minuteur qui compte
  /// depuis ce matin.
  #[test]
  fn at_rest_the_session_tells_a_window_that_there_is_nothing_to_show() {
    let state = LiveSession::default().state();

    assert_eq!(state.phase, LivePhase::Idle);
    assert_eq!(state.document_id, None);
    assert_eq!(state.started_at_ms, None);
    assert_eq!(state.source_name, None);
    assert!(!state.with_microphone);
  }

  /// ⚠️ Ce que la seconde fenêtre vient chercher : elle naît au milieu d'une session déjà
  /// commencée, et sans ces quatre valeurs elle afficherait un minuteur à zéro et une méta vide
  /// sur un enregistrement d'une heure.
  #[test]
  fn a_running_session_hands_a_window_everything_it_needs_to_catch_up() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-3",
      1_754_300_000_000,
    );

    let state = session.state();
    assert_eq!(state.phase, LivePhase::Recording);
    assert_eq!(state.document_id.as_deref(), Some("directdoc-3"));
    assert_eq!(state.started_at_ms, Some(1_754_300_000_000));
    assert_eq!(state.source_name.as_deref(), Some("Microsoft Teams"));
    assert!(state.with_microphone);
  }

  /// ⚠️ **L'étiquette de la fenêtre est l'identifiant du document**, et c'est ce qui permet
  /// d'adresser le transcript à elle seule plutôt qu'à toutes les fenêtres ouvertes. Au repos,
  /// il n'y a personne à qui parler — un `emit_to` vers une étiquette vide part en silence.
  #[test]
  fn the_window_to_address_is_the_document_and_nothing_at_rest() {
    let session = LiveSession::default();
    assert_eq!(session.window_label(), None);

    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-3",
      1_754_300_000_000,
    );
    assert_eq!(session.window_label().as_deref(), Some("directdoc-3"));
    assert!(
      session
        .window_label()
        .expect("une session tourne")
        .starts_with(crate::live::documents::DIRECTDOC_PREFIX),
      "l'étiquette doit rester celle que le joker des capacités reconnaît"
    );

    session.close();
    assert_eq!(session.window_label(), None);
  }

  /// ⚠️ Le test qui empêche une session d'être consolidée deux fois. Trois gestes arrêtent une
  /// session — le bouton du déclencheur, celui de la fenêtre, sa fermeture — et rien n'empêche
  /// deux d'entre eux de partir ensemble : la seconde consolidation trouverait les mots déjà
  /// emportés et rendrait un transcript vide.
  #[test]
  fn only_the_first_stop_gets_a_session_to_consolidate() {
    let session = LiveSession::default();
    session.start(
      "fr",
      false,
      "Tout le système",
      "directdoc-1",
      1_754_300_000_000,
    );

    assert_eq!(session.finalising().as_deref(), Some("directdoc-1"));
    assert_eq!(session.finalising(), None, "le second arrêt n'obtient rien");
    assert_eq!(session.state().phase, LivePhase::Finalising);
  }

  /// ⚠️ **Arrêter une session qui n'a jamais commencé n'est pas une erreur** : l'arrêt est
  /// appelable sur un chemin de repli, sans savoir où l'on en était.
  #[test]
  fn stopping_what_never_started_consolidates_nothing() {
    assert_eq!(LiveSession::default().finalising(), None);
  }

  #[test]
  fn closing_the_session_brings_the_state_back_to_rest() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-2",
      1_754_300_000_000,
    );
    session.finalising();
    session.close();

    assert_eq!(session.state().phase, LivePhase::Idle);
    assert_eq!(session.state().document_id, None);
  }

  /// Le cas nominal : les deux flux se rejoignent dans l'ordre du temps.
  #[test]
  fn the_two_streams_become_one_chronological_text() {
    let system = vec![
      word("Bonjour", 0),
      word("à", 200),
      word("tous.", 400),
      word("Oui,", 1_400),
      word("bien", 1_600),
      word("sûr.", 1_800),
    ];
    let mine = vec![word("Merci", 800), word("beaucoup.", 1_000)];

    let woven = weave(&system, &mine, "fr");

    // ⚠️ **Un seul paragraphe** : personne ne s'est tu deux secondes et demie. C'est exactement
    // ce que le retrait des locuteurs a changé — ce texte formait trois tours étiquetés.
    assert_eq!(
      woven.transcript.plain_text(),
      "Bonjour à tous. Merci beaucoup. Oui, bien sûr."
    );
  }

  /// ⚠️ Ce que le micro a dit est dans le texte, sans rien qui le désigne : la voix de
  /// l'utilisateur ne disparaît pas, elle cesse d'être étiquetée.
  #[test]
  fn what_the_microphone_said_is_in_the_text_and_nothing_marks_it() {
    let woven = weave(&[word("Ensuite", 500)], &[word("D'abord", 0)], "fr");
    let text = woven.transcript.plain_text();
    assert_eq!(text, "D'abord Ensuite");
    for interdit in ["Moi", "Locuteur", "—"] {
      assert!(
        !text.contains(interdit),
        "« {interdit} » ne doit plus exister"
      );
    }
  }

  /// Une session qu'on écoute sans y parler : rien à entrelacer, et c'est un cas nominal.
  #[test]
  fn a_silent_user_leaves_the_system_stream_alone() {
    let woven = weave(&[word("Bonjour", 0)], &[], "fr");
    assert_eq!(woven.transcript.plain_text(), "Bonjour");
  }

  /// ⚠️ **Le recouvrement reste ordonné par le temps.** Deux personnes qui parlent ensemble
  /// produisent des mots imbriqués ; l'ordre du texte suit celui de la parole.
  #[test]
  fn overlapping_speech_stays_in_time_order() {
    let system = vec![word("Attends", 0), word("deux", 300)];
    let mine = vec![word("Non", 100), word("mais", 400)];

    let woven = weave(&system, &mine, "fr");
    assert_eq!(woven.transcript.plain_text(), "Attends Non deux mais");
  }

  /// ⚠️ **Deux mots au même instant gardent un ordre déterministe** — le système d'abord. Un
  /// transcript qui changerait d'ordre d'une consolidation à l'autre serait impossible à relire.
  #[test]
  fn simultaneous_words_keep_a_stable_order() {
    let first = weave(&[word("Système", 100)], &[word("Micro", 100)], "fr");
    let second = weave(&[word("Système", 100)], &[word("Micro", 100)], "fr");
    assert_eq!(first, second);
    assert_eq!(first.transcript.plain_text(), "Système Micro");
  }

  /// ⚠️ Un silence dans la session est un paragraphe dans le texte, et c'est la seule frontière
  /// qui subsiste : sans elle, une session de deux heures serait un bloc.
  #[test]
  fn a_silence_in_the_session_opens_a_paragraph() {
    let woven = weave(&[word("Avant", 0), word("après", 10_000)], &[], "fr");
    assert_eq!(woven.transcript.paragraphs.len(), 2);
  }

  #[test]
  fn a_session_starts_empty_and_forgets_the_previous_one() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.record(LiveStream::System, &[word("Bonjour", 0)]);

    session.start(
      "en",
      false,
      "Tout le système",
      "directdoc-0",
      1_754_300_000_000,
    );
    let (system, microphone, language) = session.take();
    assert!(system.is_empty(), "la session précédente ne déborde pas");
    assert!(microphone.is_empty());
    assert_eq!(language, "en");
  }

  /// ⚠️ **Sans micro, on n'attend pas son signal de fin** — sinon l'arrêt d'une conférence
  /// écoutée sans y parler patienterait jusqu'à l'expiration du délai, pour rien.
  #[test]
  fn a_session_without_a_microphone_settles_on_the_system_alone() {
    let session = LiveSession::default();
    session.start(
      "fr",
      false,
      "Tout le système",
      "directdoc-0",
      1_754_300_000_000,
    );
    assert!(!session.settled());
    session.settle(LiveStream::System);
    assert!(session.settled());
  }

  /// ⚠️ **Un moteur peut lâcher avant que la session soit posée** : Swift démarre la
  /// transcription pendant `live_start`, donc son `failed` — et le `settle` qu'il déclenche —
  /// arrive avant `start`. Mesuré : le moteur refusait la langue, l'aveu était effacé, et chaque
  /// arrêt attendait les vingt secondes du plafond pour une session qui n'avait jamais transcrit.
  #[test]
  fn an_engine_that_gives_up_before_the_session_is_posted_still_counts() {
    let session = LiveSession::default();
    session.settle(LiveStream::System);
    session.start(
      "en",
      false,
      "Tout le système",
      "directdoc-0",
      1_754_300_000_000,
    );
    assert!(
      session.settled(),
      "l'aveu d'un moteur qui a renoncé ne doit pas être effacé par le démarrage"
    );
  }

  /// ⚠️ **L'aveu ne traverse pas deux sessions.** Il survit au démarrage — voir le test
  /// précédent — donc quelque chose doit l'éteindre, et c'est la fermeture. Sans elle, la
  /// session suivante se croirait finie avant d'avoir commencé et serait consolidée à vide.
  #[test]
  fn what_one_session_gave_up_does_not_follow_the_next() {
    let session = LiveSession::default();
    session.settle(LiveStream::System);
    session.start(
      "en",
      false,
      "Tout le système",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.close();

    session.start(
      "fr",
      false,
      "Tout le système",
      "directdoc-1",
      1_754_300_001_000,
    );
    assert!(
      !session.settled(),
      "la session suivante repart d'un moteur qui n'a encore rien dit"
    );
  }

  #[test]
  fn a_session_with_a_microphone_waits_for_both() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.settle(LiveStream::System);
    assert!(!session.settled(), "le micro n'a pas encore rendu sa fin");
    session.settle(LiveStream::Microphone);
    assert!(session.settled());
  }

  /// ⚠️ **Le seuil s'applique ICI, comme chez l'appelant réel** : `weigh` rend la couverture
  /// brute pour que le journal puisse aussi rapporter ce qui a failli être écarté.
  fn is_echo(found: f64) -> bool {
    found >= super::echo_text::SAME_UTTERANCE
  }

  /// Ce que le système a dit et ce que le micro répète, écrits une fois pour ces tests.
  const SAID: &str = "Nous recevrons Ken Pereira du Québec qui est un animateur au studio";
  const REHEARD: &str = "Nous recevrons Ken Pereira du Québec, qui est un animateur au studio";

  /// ⚠️ Une hypothèse se compare à l'hypothèse d'en face, pas seulement aux acquis. Les deux
  /// moteurs révisent la leur en même temps : n'avoir que les énoncés acquis pour référence
  /// laissait le doublon à l'écran toute la durée de la phrase.
  #[test]
  fn the_hypothesis_of_one_stream_answers_for_the_other() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.hear_hypothesis(SAID);

    assert!(
      session.weigh(REHEARD, None).is_some_and(is_echo),
      "l'hypothèse du système doit suffire à reconnaître l'écho"
    );
  }

  /// ⚠️ Et elle se reconsidère quand l'acquis arrive — c'est l'autre moitié. Le micro cesse
  /// d'émettre dès qu'il a fini d'entendre, sa dernière hypothèse reste affichée telle quelle,
  /// et si le système finalise entre-temps on sait alors qu'elle était de l'écho.
  #[test]
  fn a_held_hypothesis_becomes_an_echo_when_the_reference_arrives() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.hold_hypothesis(REHEARD);
    assert_eq!(session.take_echoed_hypothesis(), None, "rien à comparer");

    session.hear(SAID, 4_000);
    assert!(session.take_echoed_hypothesis().is_some());

    // ⚠️ **Retirée en même temps que signalée** : sans cela, chaque énoncé acquis du système
    // rejouerait le verdict et ferait pleuvoir des effacements inutiles.
    assert_eq!(session.take_echoed_hypothesis(), None);
  }

  /// ⚠️ **Ce que l'utilisateur seul a dit n'est jamais repris**, même quand le système parle.
  #[test]
  fn a_held_hypothesis_of_the_user_survives_the_reference() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.hold_hypothesis("Je note tout ça et je vous renvoie un résumé demain matin");
    session.hear(SAID, 4_000);

    assert_eq!(session.take_echoed_hypothesis(), None);
  }

  /// Un énoncé acquis remplace l'hypothèse de son flux : elle ne doit plus servir de référence.
  #[test]
  fn a_settled_utterance_clears_the_hypothesis_of_its_stream() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.hear_hypothesis(SAID);
    session.drop_hypothesis(LiveStream::System);

    assert!(!session.weigh(REHEARD, None).is_some_and(is_echo));
  }

  /// ⚠️ **Une nouvelle session oublie les hypothèses de la précédente** — sans quoi le premier
  /// mot d'une session se comparerait à ce qui s'est dit dans la session d'avant.
  #[test]
  fn a_new_session_forgets_what_was_being_said_in_the_previous_one() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.hear_hypothesis(SAID);
    session.hold_hypothesis(REHEARD);

    session.start("fr", true, "Google Meet", "directdoc-0", 1_754_300_000_000);
    assert!(!session.weigh(REHEARD, None).is_some_and(is_echo));
    assert_eq!(session.take_echoed_hypothesis(), None);
  }

  /// ⚠️ **Le dernier instant parlé de la session précédente ne déborde pas** : sans cela, le
  /// premier segment d'une nouvelle session ouvrirait ou non un paragraphe selon l'heure à
  /// laquelle la précédente s'est tue.
  #[test]
  fn a_new_session_forgets_where_the_previous_one_stopped() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    assert!(!session.opens_paragraph(&[word("Avant", 0)]));

    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    assert!(
      !session.opens_paragraph(&[word("Après", 600_000)]),
      "rien ne précède : il n'y a pas de silence à mesurer"
    );
  }

  #[test]
  fn taking_the_words_hands_them_over_and_leaves_nothing_behind() {
    let session = LiveSession::default();
    session.start(
      "fr",
      true,
      "Microsoft Teams",
      "directdoc-0",
      1_754_300_000_000,
    );
    session.record(LiveStream::System, &[word("Bonjour", 0)]);
    session.record(LiveStream::Microphone, &[word("Salut", 500)]);

    let (system, microphone, _) = session.take();
    assert_eq!(system.len(), 1);
    assert_eq!(microphone.len(), 1);

    let (system, microphone, _) = session.take();
    assert!(system.is_empty(), "les mots ne se rendent qu'une fois");
    assert!(microphone.is_empty());
  }
}
