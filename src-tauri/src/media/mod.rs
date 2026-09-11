//! L'import d'un média local : **ce qu'on accepte, et ce qu'on refuse au dépôt**.
//!
//! Les refus sont prononcés **avant** que l'écran ne bascule en « traitement en cours » : type
//! illisible, fichier vide, vidéo sans piste audio, plusieurs fichiers déposés d'un coup. Un
//! refus arrivé après le basculement obligerait l'interface à revenir en arrière, donnant
//! l'impression qu'un traitement a commencé puis échoué.
//!
//! # Pièges
//!
//! - ⚠️ Un média refusé n'est pas une `Err` : [`MediaInspection`] porte le refus comme une
//!   réponse, avec son motif. Une `Err` d'ici veut dire « la brique native est cassée », et rien
//!   d'autre. Les confondre ferait passer un mauvais dépôt pour une panne, et l'inverse.
//! - ⚠️ Le motif voyage en **code**, jamais en phrase : l'interface est localisée au build, et un
//!   message rédigé ici sortirait en français sur une interface allemande.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// La langue parlée du média, décidée **après** le dépôt et **avant** la transcription.
pub mod language;

/// Les extensions du sélecteur « Parcourir », tirées d'`AVURLAsset.audiovisualTypes()`.
///
/// # Pièges
///
/// - ⚠️ Filtre de confort, pas validation : la vraie décision se prend en ouvrant le conteneur,
///   dans [`inspect`]. Un `.mp4` renommé en `.mp3` est lisible et doit être accepté.
/// - ⚠️ Elle suit ce qu'AVFoundation lit, jamais l'inverse : plus étroite, elle rend impossible à
///   choisir un format qui marche, et rien dans la boîte de dialogue ne l'explique.
/// - ⚠️ Déclarer un type n'est pas savoir le décoder : DRM (`m4p`, `m4b`, `aa`, `aax`), playlists
///   (`m3u`, `pls`) et types venus de VLC (`vob`, `mod`) restent dehors, comme `webm` et `mkv`.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
  // Audio — familles MPEG, Apple, ondes brutes, Xiph, téléphonie.
  "mp3", "mpga", "m4a", "m4r", "aac", "adts", "mp2", //
  "wav", "wave", "bwf", "w64", "aiff", "aif", "aifc", "au", "snd", "caf", //
  "flac", "ogg", "oga", "opus", //
  "ac3", "eac3", "ec3", "amr", //
  // Vidéo — conteneurs QuickTime/MPEG-4, flux de transport, caméscopes.
  "mp4", "mpg4", "mov", "qt", "m4v", //
  "mpg", "mpeg", "mpe", "m2v", //
  "3gp", "3gpp", "3g2", //
  "ts", "mts", "m2ts", //
  "avi", "dv",
];

/// Le titre par défaut d'un document, **tiré du nom du fichier privé de son extension**.
///
/// La comparaison ignore la casse, `.MP4` comme `.mp4` : macOS n'en fait pas non plus.
///
/// # Pièges
///
/// - ⚠️ On ne retire que ce qu'on reconnaît : `Path::file_stem` couperait tout ce qui suit le
///   dernier point, et `Table ronde 3.08` deviendrait `Table ronde 3`. On ne coupe que si le
///   suffixe figure dans [`SUPPORTED_EXTENSIONS`].
/// - ⚠️ Un nom qui n'est **que** son extension reste entier : `.mp4` privé de `mp4` ne laisserait
///   qu'un point, donc un titre vide — et un fichier caché s'il repartait vers le disque.
pub fn title_of(file_name: &str) -> &str {
  let Some((stem, extension)) = file_name.rsplit_once('.') else {
    return file_name;
  };
  let known = SUPPORTED_EXTENSIONS
    .iter()
    .any(|candidate| extension.eq_ignore_ascii_case(candidate));
  if known && !stem.is_empty() {
    stem
  } else {
    file_name
  }
}

/// Pourquoi un média est refusé.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaProblem {
  /// Le fichier est vide.
  Empty,
  /// Le fichier n'est pas un média lisible.
  Unreadable,
  /// Un média valide, mais sans piste audio — une vidéo muette.
  NoAudioTrack,
  /// Plusieurs fichiers déposés d'un coup, refusés sans en ouvrir aucun : traiter le premier
  /// serait un choix arbitraire fait à la place de l'utilisateur.
  MultipleFiles,
  /// Aucun fichier — un glisser qui ne portait rien de déposable (du texte, une image
  /// depuis une page web).
  NoFile,
}

/// Ce qu'on sait d'un média accepté.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
  /// Le chemin, tel que l'utilisateur l'a fourni.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le fichier reste où il est : on ne le copie pas, on ne le déplace pas. C'est ce qui
  ///   rend la ré-analyse possible.
  pub path: String,
  /// Le nom du fichier, sans son dossier. Le titre du document s'en tire par [`title_of`] —
  /// **il n'est pas ce nom**, l'extension en est retirée.
  pub file_name: String,
  /// La durée du média, en millisecondes.
  pub duration_ms: u64,
  /// Le conteneur porte-t-il une piste vidéo ?
  pub has_video: bool,
}

/// Le verdict du dépôt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MediaInspection {
  /// Le média est accepté, avec ce qu'on en sait.
  Accepted(MediaInfo),
  /// Le média est refusé, avec son motif.
  Rejected { problem: MediaProblem },
}

impl MediaInspection {
  fn rejected(problem: MediaProblem) -> Self {
    Self::Rejected { problem }
  }
}

/// Ce que le pont natif rend, mot pour mot. Miroir de `MediaInspection` côté Swift.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeInspection {
  problem: Option<String>,
  duration_ms: u64,
  #[allow(dead_code)]
  has_audio: bool,
  has_video: bool,
}

/// L'ouverture du conteneur, isolée derrière un trait.
///
/// # Pièges
///
/// - ⚠️ Une couture de test, et rien d'autre : les refus doivent être éprouvés un par un, et
///   fabriquer autant de médias défectueux sur le disque serait lent, dépendant de
///   l'environnement, et muet le jour où il casserait. Un `extern "C"` n'est pas substituable, un
///   trait l'est. Ne pas y ajouter de seconde implémentation réelle.
pub trait MediaInspector: Send + Sync {
  /// Rend le JSON d'inspection du média.
  ///
  /// # Errors
  ///
  /// Rend une [`AppError`] si la brique native a échoué à ouvrir le conteneur.
  fn inspect(&self, path: &str) -> Result<String, AppError>;
}

/// L'implémentation réelle : le pont Swift.
pub struct NativeInspector;

impl MediaInspector for NativeInspector {
  fn inspect(&self, path: &str) -> Result<String, AppError> {
    crate::native::media_inspect(path)
  }
}

/// Prononce le verdict de dépôt sur ce que l'utilisateur a fourni.
///
/// `paths` est ce qui a été déposé ou choisi — d'où le pluriel : le glisser-déposer de macOS
/// peut porter plusieurs fichiers, et c'est un cas de refus à part entière.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue, si son JSON est illisible, ou s'il rend un motif
/// de refus que ce module ne connaît pas.
pub fn inspect(
  paths: &[String],
  inspector: &dyn MediaInspector,
) -> Result<MediaInspection, AppError> {
  // ⚠️ Les deux refus de cardinalité se prononcent avant toute lecture disque : ouvrir un
  // fichier pour ensuite refuser parce qu'il y en avait deux serait du travail jeté, et sur un
  // média d'une heure ce travail se voit.
  match paths.len() {
    0 => return Ok(MediaInspection::rejected(MediaProblem::NoFile)),
    1 => {}
    _ => return Ok(MediaInspection::rejected(MediaProblem::MultipleFiles)),
  }

  let path = &paths[0];
  let json = inspector.inspect(path)?;
  let native: NativeInspection = serde_json::from_str(&json)
    .map_err(|error| AppError::Native(format!("inspection de média illisible : {error}")))?;

  if let Some(problem) = native.problem.as_deref() {
    // ⚠️ Un motif inconnu ne devient pas « illisible » en silence : le pont et ce module portent
    // le même vocabulaire, écrit deux fois, et si l'un dérive on veut une erreur franche plutôt
    // qu'un refus qui dirait n'importe quoi à l'utilisateur.
    let problem = match problem {
      "empty" => MediaProblem::Empty,
      "unreadable" => MediaProblem::Unreadable,
      "noAudioTrack" => MediaProblem::NoAudioTrack,
      other => {
        return Err(AppError::Native(format!(
          "motif de refus inconnu du pont : {other}"
        )));
      }
    };
    return Ok(MediaInspection::rejected(problem));
  }

  Ok(MediaInspection::Accepted(MediaInfo {
    path: path.clone(),
    file_name: file_name_of(path),
    duration_ms: native.duration_ms,
    has_video: native.has_video,
  }))
}

/// Le nom d'un fichier, sans son dossier.
///
/// # Pièges
///
/// - ⚠️ Pas de `Path::file_name`, et c'est délibéré : il rendrait `None` sur un chemin terminé
///   par un séparateur, et le titre du document deviendrait vide. Ici, un chemin dégénéré rend
///   le chemin lui-même — laid, mais jamais vide.
fn file_name_of(path: &str) -> String {
  path
    .rsplit('/')
    .find(|segment| !segment.is_empty())
    .unwrap_or(path)
    .to_string()
}

#[cfg(test)]
mod tests {
  use super::{
    MediaInspection, MediaInspector, MediaProblem, SUPPORTED_EXTENSIONS, file_name_of, inspect,
    title_of,
  };
  use crate::error::AppError;

  /// ⚠️ **Le cas qui interdit `file_stem`** : `Table ronde 3.08` n'a pas d'extension, il a un
  /// point. Couper au dernier point amputerait le titre de l'utilisateur en silence.
  #[test]
  fn only_a_known_media_extension_is_stripped_from_the_title() {
    assert_eq!(title_of("plateau.mp4"), "plateau");
    assert_eq!(
      title_of("entretien.MP3"),
      "entretien",
      "la casse est ignorée"
    );
    // Un point qui n'introduit pas une extension connue reste dans le titre.
    assert_eq!(title_of("Table ronde 3.08"), "Table ronde 3.08");
    assert_eq!(title_of("notes.txt"), "notes.txt");
    // Un nom sans point du tout, et un nom à points multiples : seul le dernier suffixe compte.
    assert_eq!(title_of("plateau"), "plateau");
    assert_eq!(title_of("cdanslair.07.05.2019.mp4"), "cdanslair.07.05.2019");
  }

  /// ⚠️ **Un nom qui n'est QUE son extension reste entier** : le réduire à un point donnerait un
  /// titre vide, et un fichier caché si ce nom repartait vers le disque.
  #[test]
  fn a_name_made_only_of_its_extension_survives_whole() {
    assert_eq!(title_of(".mp4"), ".mp4");
    assert_eq!(title_of(""), "");
  }

  /// La doublure qui justifie l'existence du trait : elle rend le JSON qu'on veut éprouver,
  /// sans qu'aucun média n'ait à exister sur le disque.
  struct Fake(Result<String, AppError>);

  impl MediaInspector for Fake {
    fn inspect(&self, _path: &str) -> Result<String, AppError> {
      match &self.0 {
        Ok(json) => Ok(json.clone()),
        Err(error) => Err(AppError::Native(error.to_string())),
      }
    }
  }

  fn accepted_json() -> Fake {
    Fake(Ok(
      r#"{"problem":null,"durationMs":370149,"hasAudio":true,"hasVideo":true}"#.into(),
    ))
  }

  fn refusing(problem: &str) -> Fake {
    Fake(Ok(format!(
      r#"{{"problem":"{problem}","durationMs":0,"hasAudio":false,"hasVideo":false}}"#
    )))
  }

  fn paths(one: &str) -> Vec<String> {
    vec![one.to_string()]
  }

  #[test]
  fn a_readable_media_with_sound_is_accepted_and_stays_where_it_is() {
    let path = "/Users/moi/Films/plateau.mp4";
    let verdict = inspect(&paths(path), &accepted_json()).expect("inspection");

    let MediaInspection::Accepted(info) = verdict else {
      panic!("le média devait être accepté");
    };
    assert_eq!(info.path, path, "le chemin d'origine, jamais une copie");
    assert_eq!(info.file_name, "plateau.mp4");
    assert_eq!(info.duration_ms, 370_149);
    assert!(info.has_video);
  }

  #[test]
  fn each_of_the_three_native_refusals_is_carried_through() {
    for (code, expected) in [
      ("empty", MediaProblem::Empty),
      ("unreadable", MediaProblem::Unreadable),
      ("noAudioTrack", MediaProblem::NoAudioTrack),
    ] {
      let verdict = inspect(&paths("/tmp/x"), &refusing(code)).expect("inspection");
      assert_eq!(
        verdict,
        MediaInspection::Rejected { problem: expected },
        "motif « {code} »"
      );
    }
  }

  #[test]
  fn several_files_are_refused_without_opening_any_of_them() {
    // La doublure échouerait si on l'appelait : c'est ce qui prouve qu'on ne l'appelle pas.
    let never = Fake(Err(AppError::Native("ne doit pas être appelé".into())));
    let dropped = vec!["/tmp/a.mp3".to_string(), "/tmp/b.mp3".to_string()];

    assert_eq!(
      inspect(&dropped, &never).expect("inspection"),
      MediaInspection::Rejected {
        problem: MediaProblem::MultipleFiles
      }
    );
  }

  #[test]
  fn an_empty_drop_is_refused_without_opening_anything() {
    let never = Fake(Err(AppError::Native("ne doit pas être appelé".into())));
    assert_eq!(
      inspect(&[], &never).expect("inspection"),
      MediaInspection::Rejected {
        problem: MediaProblem::NoFile
      }
    );
  }

  #[test]
  fn a_broken_bridge_is_an_error_not_a_refusal() {
    // ⚠️ La distinction qui compte : une brique cassée ne doit pas ressembler à un mauvais
    // fichier, sinon l'utilisateur cherchera indéfiniment ce qui cloche dans son média.
    let error = inspect(
      &paths("/tmp/x"),
      &Fake(Err(AppError::Native("boum".into()))),
    )
    .expect_err("erreur");
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn unreadable_json_from_the_bridge_is_an_error() {
    let error = inspect(&paths("/tmp/x"), &Fake(Ok("pas du json".into()))).expect_err("erreur");
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn an_unknown_refusal_code_is_refused_loudly_rather_than_guessed() {
    // Le pont et ce module portent le même vocabulaire, écrit deux fois. Si l'un dérive, on
    // veut le savoir — pas afficher un message au hasard.
    let error = inspect(&paths("/tmp/x"), &refusing("peutEtre")).expect_err("erreur");
    assert_eq!(error.kind(), "native");
    assert!(error.to_string().contains("peutEtre"), "reçu : {error}");
  }

  #[test]
  fn a_file_name_survives_paths_with_odd_shapes() {
    assert_eq!(file_name_of("/a/b/c.mp3"), "c.mp3");
    assert_eq!(file_name_of("c.mp3"), "c.mp3");
    // Le média de référence de la phase : dièse, apostrophes typographiques, points de
    // suspension. Rien de tout cela ne doit perturber le titre par défaut du document.
    assert_eq!(
      file_name_of("/Users/moi/Un million d’espèces… #cdanslair.mp4"),
      "Un million d’espèces… #cdanslair.mp4"
    );
    // ⚠️ Un chemin terminé par un séparateur : `Path::file_name` rendrait `None` ici, et le
    // titre du document serait vide.
    assert_eq!(file_name_of("/a/b/"), "b");
    assert_eq!(file_name_of("/"), "/");
    assert_eq!(file_name_of(""), "");
  }

  #[test]
  fn the_browse_filter_covers_audio_and_video_without_a_dot() {
    for expected in ["mp3", "mp4", "mov", "wav", "m4a", "flac", "avi"] {
      assert!(SUPPORTED_EXTENSIONS.contains(&expected), "« {expected} »");
    }
    assert!(
      SUPPORTED_EXTENSIONS.iter().all(|ext| !ext.starts_with('.')),
      "le sélecteur macOS veut des extensions nues"
    );
    assert!(
      SUPPORTED_EXTENSIONS
        .iter()
        .all(|ext| ext == &ext.to_ascii_lowercase()),
      "la comparaison de title_of ignore la casse, mais le sélecteur macOS attend du minuscule"
    );
  }

  /// ⚠️ **Un doublon n'échouerait nulle part** — il ferait juste apparaître l'extension deux fois
  /// dans la boîte de dialogue macOS. C'est le genre de faute qu'une liste qui grandit attrape.
  #[test]
  fn no_extension_is_listed_twice() {
    let mut seen: Vec<&str> = SUPPORTED_EXTENSIONS.to_vec();
    seen.sort_unstable();
    let count = seen.len();
    seen.dedup();
    assert_eq!(count, seen.len(), "une extension est listée deux fois");
  }

  /// ⚠️ **Ce que la liste ne doit pas contenir**, et pourquoi — voir l'en-tête de
  /// [`SUPPORTED_EXTENSIONS`]. Les trois familles ci-dessous sont *déclarées* par macOS et
  /// échoueraient : proposer un `.m4b` protégé mènerait l'utilisateur droit dans un refus.
  #[test]
  fn protected_playlist_and_unreadable_formats_stay_out() {
    for refused in [
      // DRM Audible et iTunes : déclarés, indécodables.
      "m4p", "m4b", "aa", "aax", // Des listes de lecture, pas des médias.
      "m3u", "m3u8", "pls", // AVFoundation ne les lit pas du tout.
      "webm", "mkv", "wma", "wmv",
    ] {
      assert!(
        !SUPPORTED_EXTENSIONS.contains(&refused),
        "« {refused} » ne doit pas être proposé : il mène à un refus"
      );
    }
  }

  /// L'écart mesuré, gelé : ces formats **marchaient déjà** au glisser-déposer et n'étaient pas
  /// sélectionnables. Les retirer rouvrirait l'incohérence.
  #[test]
  fn the_formats_that_worked_but_could_not_be_chosen_are_now_offered() {
    for added in [
      "opus", "ogg", "oga", "3gp", "ts", "mts", "m2ts", "aifc", "qt",
    ] {
      assert!(SUPPORTED_EXTENSIONS.contains(&added), "« {added} »");
    }
  }

  #[test]
  fn the_wire_contract_is_tagged_and_camel_case() {
    let json = serde_json::to_value(MediaInspection::Rejected {
      problem: MediaProblem::NoAudioTrack,
    })
    .expect("sérialisation");
    assert_eq!(json["status"], "rejected");
    assert_eq!(json["problem"], "noAudioTrack");
  }
}
