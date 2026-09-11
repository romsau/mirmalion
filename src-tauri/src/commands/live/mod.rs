//! Le Direct, côté commandes : le vocabulaire partagé et l'assemblage.
//!
//! Les gestes vivent dans les sous-modules — [`capture`], [`history`], [`finalise`],
//! [`document`], [`report`], [`meter`], [`observer`]. Ne restent ici que ce qu'ils se disent
//! entre eux : les noms d'évènements, les types que porte le transcript, et les trois passe-plats
//! qu'aucun d'eux ne possède seul.
//!
//! Aucun de ces modules ne transporte de son : les tampons vont du tap Core Audio aux fichiers,
//! entièrement en Swift (`native/Sources/MirmalionNative/SystemAudioTap.swift`).
//!
//! # Pièges
//!
//! - ⚠️ Le mot est « Direct » à l'écran et `live` ici — dans les routes, la base et le Swift
//!   aussi. Le renommer d'un côté sans l'autre coupe le lien pour qui lit les deux.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{commands, error::AppError, live::LiveStream, native};

pub mod capture;
pub mod document;
pub mod finalise;
pub mod history;
pub mod meter;
pub mod observer;
pub mod report;

// ⚠️ Les commandes ne sont **pas** ré-exportées : `generate_handler!` a besoin des items que
// `#[tauri::command]` engendre à côté de la fonction, qu'un `pub use` ne transporte pas. `lib.rs`
// les nomme par leur chemin complet, ce qui dit au passage de quel sous-module elles viennent.
// Seuls voyagent ici les types que le reste du crate manipule.
pub use capture::{AudioSource, LiveCaptureStatus};
pub use report::ReportJobs;

/// Le nom de l'évènement Tauri qui porte le transcript d'une session.
///
/// # Pièges
///
/// - ⚠️ Distinct de `transcription`, celui de la dictée : les charges utiles diffèrent — celle-ci
///   nomme son flux — et un canal commun ferait apparaître une dictée dans une session.
/// - ⚠️ Un seul canal pour les trois natures — partiel, final, échec — parce qu'elles sont
///   ordonnées : trois canaux distincts laisseraient un final doubler le dernier partiel.
pub const LIVE_TRANSCRIPT_EVENT: &str = "live-transcript";

/// L'enregistrement est fini ; la consolidation commence.
///
/// # Pièges
///
/// - ⚠️ Deux évènements et non un : le déclencheur doit rendre son formulaire tout de suite, quand
///   la fenêtre-session doit au contraire lever son voile et patienter. Un seul évènement à la fin
///   laisserait le formulaire verrouillé pendant toute la consolidation.
pub const LIVE_STOPPED_EVENT: &str = "live-stopped";

/// La session est consolidée. La charge utile est le document complet.
///
/// # Pièges
///
/// - ⚠️ Le document voyage dans l'évènement, il n'est pas seulement annoncé : la fenêtre a besoin
///   de son contenu, et un simple signal l'obligerait à un aller-retour de plus.
pub const LIVE_FINALISED_EVENT: &str = "live-finalised";

/// Une étape de plus est franchie — finalisation **ou** génération de compte rendu.
///
/// # Pièges
///
/// - ⚠️ Un seul canal pour les deux attentes : elles ne se recouvrent jamais, un compte rendu ne
///   se demandant que sur un document déjà consolidé. L'étape dit de laquelle il s'agit.
pub const LIVE_PROGRESS_EVENT: &str = "live-progress";

/// Le niveau des deux flux, poussé tant que la capture tourne.
///
/// # Pièges
///
/// - ⚠️ C'est Rust qui bat la mesure, et non la fenêtre : chaque fenêtre-session qui relevait
///   elle-même le niveau payait dix allers-retours IPC par seconde, pendant toute la session.
/// - ⚠️ Aucun identifiant de document n'y voyage, et il n'en faut pas : le tap est unique dans le
///   processus, donc une seule session capte à la fois. Les autres fenêtres n'enregistrent pas et
///   ne montrent aucun mètre.
pub const LIVE_LEVEL_EVENT: &str = "live-level";

/// Ce qu'un flux vient de produire.
///
/// # Pièges
///
/// - ⚠️ `text` ne porte que le nouveau morceau, jamais le transcript accumulé — contrairement à la
///   dictée. C'est ce qui rend le coût d'une session de deux heures indépendant de sa durée :
///   republier l'accumulation ferait traverser des dizaines de milliers de mots à l'IPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LiveTranscriptEvent {
  /// Une hypothèse sur ce qui est en train d'être dit. Elle **remplace** la précédente
  /// hypothèse **du même flux**, et rien d'autre.
  Partial {
    /// Le flux dont vient l'hypothèse.
    stream: LiveStream,
    /// Le texte de l'hypothèse, qui remplace la précédente.
    text: String,
  },
  /// Un segment que le moteur ne remettra plus en cause. Il s'**ajoute**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Aucun numéro de locuteur en direct : ce que l'écran montre pendant l'enregistrement est
  ///   certain par construction — le flux dit si c'est l'utilisateur ou les autres, sans la
  ///   moindre inférence. La diarisation fine se fait à l'arrêt, sur l'enregistrement entier.
  Final {
    /// Le flux dont vient le segment.
    stream: LiveStream,
    /// Le texte du segment, qui s'ajoute au transcript.
    text: String,
    /// Ce segment suit-il un **silence** ? L'écran y ouvre alors un nouveau paragraphe.
    ///
    /// # Pièges
    ///
    /// - ⚠️ Décidé ici parce que les horodatages s'arrêtent ici : envoyer les mots à l'écran pour
    ///   qu'il recalcule les pauses ferait payer à une session un coût proportionnel à sa durée.
    #[serde(default)]
    paragraph: bool,
    /// Les mots horodatés du segment.
    ///
    /// # Pièges
    ///
    /// - ⚠️ `skip_serializing` : ces mots s'arrêtent au backend, où ils servent à la consolidation
    ///   — rapprocher le texte des tours de parole. L'écran n'affiche que la phrase ; les lui
    ///   envoyer ferait payer à une session un coût proportionnel à sa durée. Le champ reste
    ///   **désérialisable**, sans quoi rien n'entrerait.
    #[serde(default, skip_serializing)]
    words: Vec<crate::transcript::Word>,
  },
  /// Ce que ce flux tenait n'ira pas à l'écran : **l'hypothèse en cours est à effacer.**
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sans cet évènement, une hypothèse d'écho reste affichée pour toujours : l'écran garde
  ///   l'hypothèse d'un flux jusqu'à ce qu'un `final` du **même flux** la remplace. Écarter un
  ///   `final` d'écho en s'arrêtant là laissait la phrase des haut-parleurs sous « Moi ».
  /// - ⚠️ Effacer n'est pas afficher un vide : rien ne s'ajoute au transcript acquis, seule
  ///   l'hypothèse en cours disparaît.
  Dropped {
    /// Le flux dont l'hypothèse est retirée.
    stream: LiveStream,
  },
  /// Ce flux ne sera pas transcrit.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La capture, elle, continue : l'audio est la seule chose irremplaçable, et un transcript
  ///   se refait depuis le fichier.
  Failed {
    /// Le flux qui abandonne.
    stream: LiveStream,
    /// De quoi expliquer l'abandon.
    text: String,
  },
  /// Ce flux a rendu **tout** ce qu'il avait.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Ne va pas à l'écran : c'est un signal de plomberie, qui dit à la consolidation qu'elle
  ///   peut commencer. `live_stop` rend la main tout de suite et les derniers segments arrivent
  ///   après ; sans ce signal, il faudrait attendre un délai au jugé.
  Finished {
    /// Le flux qui a tout rendu.
    stream: LiveStream,
  },
}

/// Ce que porte [`LIVE_PROGRESS_EVENT`].
///
/// # Pièges
///
/// - ⚠️ Aucun libellé ne voyage ici — voir [`crate::live::progress`] : une phrase française émise
///   par Rust sortirait telle quelle dans les huit autres langues d'une interface localisée.
/// - ⚠️ `done` compte les étapes finies, et l'étape nommée est celle qui commence : au premier
///   évènement la barre est à zéro et le libellé dit ce qui se fait.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveProgress<'a> {
  document_id: &'a str,
  step: crate::live::progress::LiveStep,
  done: u32,
  total: u32,
}

/// Les réglages, relus **à chaque démarrage de session**. Voir [`crate::settings`].
///
/// # Pièges
///
/// - ⚠️ Une lecture, jamais une mémoire : ces réglages se changent à chaud, et une valeur retenue
///   au lancement serait fausse au premier passage dans les Options.
fn read_settings(app: &AppHandle) -> crate::settings::Stored {
  match app.try_state::<crate::state::AppState>() {
    Some(state) => {
      crate::settings::Stored::read(&state.data_dir().join(crate::i18n::SETTINGS_FILE))
    }
    // L'état n'est pas monté : impossible en pratique, la capture étant montée après lui.
    None => crate::settings::Stored::default(),
  }
}

/// L'instant présent, en millisecondes depuis l'époque.
///
/// # Pièges
///
/// - ⚠️ Une horloge qui recule rend `0`, elle ne panique pas : `duration_since` échoue si
///   l'horloge système est antérieure à 1970, et perdre une session pour une date fausse serait
///   hors de proportion.
fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
    .unwrap_or_default()
}

/// Annonce une étape franchie à toutes les fenêtres.
///
/// # Pièges
///
/// - ⚠️ Un évènement perdu n'arrête pas le travail — même règle que la traduction : ce qui compte
///   est de rendre le document, pas de remplir sa barre.
fn progressed(
  app: &AppHandle,
  document_id: &str,
  step: crate::live::progress::LiveStep,
  done: usize,
  total: usize,
) {
  // ⚠️ Adressé, et pas au titre de la session en cours : un compte rendu se demande sur un
  // document **déjà consolidé**, donc pendant qu'aucune capture ne tourne. L'étiquette se prend
  // sur le document dont le travail avance, jamais sur `LiveSession`.
  crate::commands::announce_to(
    app,
    document_id,
    LIVE_PROGRESS_EVENT,
    &LiveProgress {
      document_id,
      step,
      // ⚠️ Le seul endroit où ces comptes rétrécissent, et il est saturant : une barre bloquée
      // à 100 % vaut mieux qu'une barre qui repart de zéro. Le cas ne se produit pas — un plan
      // fait sept étapes, un compte rendu quelques tranches — et c'est pour cela qu'il n'est
      // pas une erreur.
      done: u32::try_from(done).unwrap_or(u32::MAX),
      total: u32::try_from(total).unwrap_or(u32::MAX),
    },
  );
}

/// Annonce un tournant de la session à **toutes** les fenêtres.
///
/// # Pièges
///
/// - ⚠️ Un échec d'émission se journalise et ne remonte pas : l'appelant est soit l'arrêt, qui a
///   déjà fait le travail qui comptait, soit une tâche de fond que personne n'attend.
/// - ⚠️ Diffuser est ici le bon choix, et il est étroit : les deux seuls évènements qui passent
///   par là — l'arrêt et la consolidation finie — ont **deux** destinataires, la fenêtre-session
///   et le déclencheur qui rafraîchit son historique. Ce qui porte du transcript s'adresse, par
///   `commands::announce_to`.
fn announce<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: &T) {
  crate::commands::announce(app, event, payload);
}

/// Branche la remontée du transcript de session. Appelé une fois, dans `.setup()`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse d'enregistrer l'observateur.
///
/// # Pièges
///
/// - ⚠️ Avant toute session : un observateur enregistré en retard perd les premiers segments, et
///   le produit ne les rejoue pas — ce sont les mots du « bon, on commence ».
pub fn setup(app: &AppHandle) -> Result<(), AppError> {
  commands::remember_app(app);
  app.manage(ReportJobs::default());
  native::live_set_transcript_observer(Some(observer::on_live_transcript))
}
