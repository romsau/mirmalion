//! **L'écho des haut-parleurs, mesuré comme une question d'identité.**
//!
//! Le flux micro est étiqueté « Moi » par construction — la seule promesse à 100 % de la
//! diarisation, sans aucune inférence. Sur haut-parleurs elle est fausse : le micro réentend
//! les interlocuteurs, qui seraient attribués à l'utilisateur. La mesure ne demande donc pas
//! « ces deux signaux se ressemblent-ils ? », qui dépend du délai et de la pièce, mais « cette
//! voix du micro est-elle une voix que le flux système connaît déjà ? ». Elle cherche un fossé
//! entre deux populations — l'écho contre sa source, des étrangers entre eux — pas un seuil.
//!
//! ⚠️ `setVoiceProcessingEnabled`, la solution d'Apple, s'empare de la sortie audio, autour de
//! laquelle notre agrégat est bâti. Essayée, inutilisable, ne pas y revenir.
//!
//! `cargo test --test live_echo -- --ignored --nocapture strangers` est hermétique ; `the_echo`
//! ouvre le tap et le micro — jouer un média sur les haut-parleurs avant.

use std::{path::PathBuf, thread, time::Duration};

/// Le dossier des médias de mesure, hors dépôt. Même emplacement que les autres mesures.
fn media_dir() -> PathBuf {
  PathBuf::from(std::env::var("HOME").expect("HOME"))
    .join("dev")
    .join("mirmalion")
    .join("media-test")
}

/// Ce que le pont rend d'un rapprochement de voix.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceMatch {
  first: Vec<VoiceSummary>,
  second: Vec<VoiceSummary>,
  /// `distances[i][j]`. ⚠️ `None` veut dire **incomparable**, jamais « différentes ».
  distances: Vec<Vec<Option<f64>>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSummary {
  speaker: u32,
  speech_ms: u64,
}

impl VoiceMatch {
  /// La distance la plus faible de toute la matrice — **le meilleur rapprochement possible**.
  ///
  /// C'est le nombre qui décide : s'il existe une voix du micro proche d'une voix du système,
  /// l'une est l'écho de l'autre.
  fn closest(&self) -> Option<f64> {
    self
      .distances
      .iter()
      .flatten()
      .filter_map(|distance| *distance)
      .fold(None, |best: Option<f64>, distance| {
        Some(best.map_or(distance, |current| current.min(distance)))
      })
  }

  /// Pour chaque voix du **second** média, sa distance à la voix du premier qui lui ressemble le
  /// plus. C'est la forme sous laquelle le produit posera la question : « ce locuteur du micro,
  /// le système le connaît-il ? »
  fn best_per_second(&self) -> Vec<(u32, u64, Option<f64>)> {
    self
      .second
      .iter()
      .enumerate()
      .map(|(column, voice)| {
        let best = self
          .distances
          .iter()
          .filter_map(|row| row.get(column).copied().flatten())
          .fold(None, |best: Option<f64>, distance| {
            Some(best.map_or(distance, |current: f64| current.min(distance)))
          });
        (voice.speaker, voice.speech_ms, best)
      })
      .collect()
  }
}

fn match_voices(first: &std::path::Path, second: &std::path::Path) -> VoiceMatch {
  let raw = app_lib::measure::voice_match(
    &first.to_string_lossy(),
    &second.to_string_lossy(),
    app_lib::measure::AUTO_THRESHOLD,
  )
  .expect("le rapprochement des voix a échoué");
  serde_json::from_str(&raw).expect("rapprochement illisible")
}

/// Le nom court d'un média, pour que le rapport tienne dans un terminal.
fn short(path: &std::path::Path) -> String {
  let name = path.file_stem().unwrap_or_default().to_string_lossy();
  name.chars().take(28).collect()
}

fn media(name: &str) -> Option<PathBuf> {
  let found = std::fs::read_dir(media_dir())
    .ok()?
    .filter_map(|entry| entry.ok())
    .map(|entry| entry.path())
    .find(|path| {
      path
        .file_name()
        .is_some_and(|file| file.to_string_lossy().contains(name))
    });
  if found.is_none() {
    eprintln!("média absent du corpus, paire ignorée : {name}");
  }
  found
}

// Population 1 — des étrangers

/// Deux enregistrements sans personne en commun : à quelle distance sont leurs voix ?
///
/// ⚠️ **Hermétique** : aucun micro, aucun tap, aucune autorisation. Il ne lit que le corpus, et
/// c'est ce qui permet de le rejouer sans rien préparer.
///
/// ⚠️ **LA PAIRE DE CONTRÔLE EST LE MÊME MÉDIA DANS DEUX CONTENEURS** (`.mp4` et `.mov`). Elle
/// n'est pas là pour faire nombre : elle donne le **plancher** de la mesure — ce que vaut la
/// distance quand les voix sont rigoureusement identiques. Sans elle, on ne saurait pas si une
/// petite distance signifie « la même personne » ou « l'instrument ne sépare rien ».
#[test]
#[ignore = "diarise plusieurs médias du corpus hors dépôt — se lance à la main"]
fn strangers_keep_their_distance_while_the_same_recording_matches_itself() {
  let control: Vec<(&str, &str)> = vec![("Extrait du débat présidentiel.mp4", "conteneur")];
  let strangers: Vec<(&str, &str)> = vec![
    ("Extrait du débat présidentiel.mp4", "Mélenchon"),
    ("Extrait du débat présidentiel.mp4", "Ruffin"),
    ("Mélenchon", "Ruffin"),
    ("Mélenchon", "cdanslair"),
    ("Ruffin", "cdanslair"),
  ];

  println!("\n  ── LA MÊME VOIX (contrôle : un média, deux conteneurs) ───────────────");
  let floor = report(&control, Edge::Worst);
  println!("\n  ── DES ÉTRANGERS ────────────────────────────────────────────────────");
  let strangers = report(&strangers, Edge::Tightest);

  let Some(floor) = floor else {
    println!("\n  ⚠️ contrôle absent : rien à conclure.");
    return;
  };
  let Some(strangers) = strangers else {
    println!("\n  ⚠️ aucun couple d'étrangers mesurable : rien à conclure.");
    return;
  };

  println!("\n  ── LE FOSSÉ ─────────────────────────────────────────────────────────");
  println!("  la même voix, au pire        : {floor:.3}");
  println!("  des étrangers, au mieux      : {strangers:.3}");
  println!("  écart                        : {:.3}", strangers - floor);
  println!(
    "  ⚠️ une borne se pose au MILIEU d'un fossé, pas sur la valeur qui a échoué :\n     \
     milieu = {:.3}",
    (floor + strangers) / 2.0
  );

  assert!(
    strangers > floor,
    "sans fossé, l'identité de voix ne peut pas trancher l'écho : \
     même voix {floor:.3}, étrangers {strangers:.3}"
  );
}

/// De quel côté se trouve le bord du fossé, pour cette population-là.
///
/// ⚠️ **Les deux populations n'ont pas leur bord du même côté**, et les confondre flatte le
/// fossé. Pour la même voix, ce qui compte est le rapprochement le **pire** — le plus grand
/// écart qu'une identité vraie ait produit. Pour des étrangers, c'est le plus **serré** — la fois
/// où deux inconnus se sont le plus ressemblés. Prendre le maximum des deux côtés, comme cette
/// mesure l'a d'abord fait, rapportait 0,669 là où deux étrangers étaient descendus à 0,365 :
/// un fossé deux fois trop large, et une borne qui aurait mordu dans du réel.
enum Edge {
  /// Le plus grand des rapprochements — la population de la **même** voix.
  Worst,
  /// Le plus petit des rapprochements — la population des **étrangers**.
  Tightest,
}

/// Mesure une liste de paires et rend le bord du fossé de cette population.
fn report(pairs: &[(&str, &str)], edge_side: Edge) -> Option<f64> {
  let mut edge: Option<f64> = None;
  for (first, second) in pairs {
    let (Some(first), Some(second)) = (media(first), media(second)) else {
      continue;
    };
    let matched = match_voices(&first, &second);
    let closest = matched.closest();
    println!(
      "  {:<30} × {:<30} {} voix × {} voix   plus proche : {}",
      short(&first),
      short(&second),
      matched.first.len(),
      matched.second.len(),
      closest.map_or("—".to_string(), |distance| format!("{distance:.3}"))
    );
    if let Some(closest) = closest {
      edge = Some(edge.map_or(closest, |current: f64| match edge_side {
        Edge::Worst => current.max(closest),
        Edge::Tightest => current.min(closest),
      }));
    }
  }
  edge
}

// Population 2 — l'écho, capté pour de vrai

/// Combien de temps on capte. Assez pour que le diariseur ait de quoi travailler des deux côtés.
const CAPTURE_SECONDS: u64 = 25;

fn measurement_directory() -> PathBuf {
  std::env::temp_dir().join("mirmalion-echo-measure")
}

/// Rejoue le rapprochement sur une paire de flux **déjà captée**.
///
/// ⚠️ **L'INSTRUMENT SE SÉPARE DE LA CAPTURE, ET C'EST CE QUI LE REND REJOUABLE.** Capter
/// demande des haut-parleurs actifs, un micro ouvert et vingt-cinq secondes ; rapprocher ne
/// demande rien. Les river l'un à l'autre obligerait à refaire une prise de son à chaque fois
/// qu'on veut réexaminer les mêmes nombres — c'est-à-dire à ne jamais les réexaminer.
///
/// ```sh
/// MIRMALION_STREAM_PAIR=/chemin/du/dossier \
///   cargo test --test live_echo -- --ignored --nocapture an_existing_pair
/// ```
#[test]
#[ignore = "demande MIRMALION_STREAM_PAIR — se lance à la main sur une capture déjà faite"]
fn an_existing_pair_of_streams_is_matched() {
  let Ok(directory) = std::env::var("MIRMALION_STREAM_PAIR") else {
    println!("\n  MIRMALION_STREAM_PAIR non défini : rien à rapprocher.");
    return;
  };
  let directory = PathBuf::from(directory);
  report_pair(
    &directory.join("system.wav"),
    &directory.join("microphone.wav"),
  );
}

/// Le rapport commun aux deux entrées — capture fraîche ou paire retrouvée.
fn report_pair(system: &std::path::Path, microphone: &std::path::Path) -> Option<f64> {
  let matched = match_voices(system, microphone);

  println!("\n  ── LES VOIX DU MICRO, VUES DEPUIS LE SYSTÈME ────────────────────────");
  println!("  {} voix côté système", matched.first.len());
  for (speaker, speech_ms, best) in matched.best_per_second() {
    println!(
      "  micro/voix {speaker}  ({:.1} s de parole)  plus proche du système : {}",
      speech_ms as f64 / 1_000.0,
      best.map_or("—".to_string(), |distance| format!("{distance:.3}"))
    );
  }

  // ⚠️ **L'INSTRUMENT RAPPORTE LE VERDICT DU PRODUIT, PAS SEULEMENT DES NOMBRES.** Afficher
  // des distances et laisser le lecteur poser le seuil de tête, c'est exactement l'endroit où
  // l'on se ment : on lit « 0,166 » comme « petit » parce qu'on sait ce qu'on espère. Ici, c'est
  // la borne livrée qui tranche, sur les mêmes chiffres que la session.
  // ⚠️ **Les numéros de voix accompagnent la matrice**, ils ne se déduisent pas de l'ordre des
  // colonnes : une voix sans empreinte lisible saute son numéro. Voir `echoes_of_the_room`.
  let voices: Vec<u32> = matched.second.iter().map(|voice| voice.speaker).collect();
  let echoed = app_lib::measure::echoes_of_the_room(&matched.distances, &voices);
  println!(
    "\n  ── LE VERDICT, À LA BORNE LIVRÉE ({:.2}) ────────────────────────────",
    app_lib::measure::ECHO_DISTANCE
  );
  for voice in &matched.second {
    let verdict = if echoed.contains(&voice.speaker) {
      "écho — écarté de « Moi »"
    } else {
      "gardé comme « Moi »"
    };
    println!(
      "  micro/voix {}  ({:.1} s)  → {verdict}",
      voice.speaker,
      voice.speech_ms as f64 / 1_000.0
    );
  }

  let closest = matched.closest();
  println!(
    "\n  l'écho, au plus proche de sa source : {}",
    closest.map_or("—".to_string(), |distance| format!("{distance:.3}"))
  );
  closest
}

/// L'écho d'une voix est-il encore **cette voix** ?
///
/// **La marche à suivre, en deux gestes** : jouer un média qui parle **sur les haut-parleurs**
/// (pas au casque — c'est l'écho qu'on mesure), puis lancer la commande. Ne rien dire.
///
/// ⚠️ **NE PARLEZ PAS PENDANT LA MESURE.** Ce qui est éprouvé ici est le cas où le micro ne
/// porte **que** de l'écho : toute voix réelle ajouterait une population que le rapport ne
/// saurait pas distinguer, et le fossé cesserait d'être lisible.
#[test]
#[ignore = "ouvre un vrai tap et le micro, et demande des haut-parleurs actifs — se lance à la main"]
fn the_echo_of_a_voice_is_still_that_voice() {
  let directory = measurement_directory();
  let _ = std::fs::remove_dir_all(&directory);

  // ⚠️ **`None` : on n'a pas besoin du transcript ici.** Ouvrir deux moteurs de transcription
  // pour une mesure qui ne lit que des empreintes coûterait du temps et brouillerait le rapport.
  app_lib::measure::live_start(
    "system",
    Some("default"),
    &directory.to_string_lossy(),
    None,
  )
  .expect("la capture n'a pas démarré");

  println!("\n  capture de {CAPTURE_SECONDS} s — les haut-parleurs doivent parler, vous non.");
  thread::sleep(Duration::from_secs(CAPTURE_SECONDS));

  let status = app_lib::measure::live_status().expect("état illisible");
  let status: app_lib::measure::LiveCaptureStatus =
    serde_json::from_str(&status).expect("état illisible");
  app_lib::measure::live_stop().expect("l'arrêt a échoué");

  let (Some(system), Some(microphone)) = (status.system_path, status.microphone_path) else {
    panic!("les deux flux n'ont pas été écrits — la mesure ne peut rien dire");
  };
  println!(
    "  écrit : {} trames système, {} trames micro",
    status.system_frames, status.microphone_frames
  );
  assert!(
    status.system_frames > 0 && status.microphone_frames > 0,
    "un flux muet ne mesure rien : jouer du son sur les HAUT-PARLEURS, micro non coupé"
  );

  println!("  la paire reste sur le disque : {}", directory.display());
  report_pair(
    std::path::Path::new(&system),
    std::path::Path::new(&microphone),
  )
  .expect("aucune distance mesurable : les deux flux n'ont pas produit de voix");
}
