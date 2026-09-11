//! Les formats d'export d'un transcript — **purs, sans I/O, sans disque, sans horloge**.
//!
//! Ce module transforme un `Transcript` (ou la vue plate de ses paragraphes) en **une `String`** :
//! aucun fichier ouvert, aucun chemin demandé, aucun moteur appelé. L'emplacement, la boîte de
//! dialogue et l'écriture appartiennent à la commande appelante. Le temps y est en millisecondes
//! entières — jamais un flottant, dont deux arrondis successifs décalent une réplique.
//!
//! # Pièges
//!
//! - ⚠️ Rust ne fabrique **aucun texte localisé** : un libellé à afficher arrive déjà résolu de
//!   l'appelant. L'en-tête du CSV est l'exception assumée — format de machine, en anglais.
//! - ⚠️ Ce qu'on exporte est ce qui est affiché : les paragraphes **rendus** entrent depuis
//!   l'appelant dès qu'une traduction est affichée, sans quoi le `.docx` contredirait l'écran.
//! - ⚠️ Une traduction n'a plus d'horodatage au mot : [`crate::export::translated_json`] le dit
//!   dans le fichier, et les sous-titres reposent alors sur les repères des paragraphes.

/// Le document Word (`.docx`) — un zip d'XML, écrit par une caisse et non à la main.
pub mod docx;
/// Les huit formats offerts, et l'extension de chacun.
pub mod format;
/// Le rendu HTML — la représentation riche du presse-papiers, et la source du PDF.
pub mod html;
/// Le nom de fichier proposé dans « Enregistrer sous ».
pub mod naming;
/// Ce qui relie un document à un format : les octets à écrire, ou la charge utile du pont.
pub mod render;
/// Les formats d'export d'un **compte rendu** — des rubriques, jamais des paragraphes horodatés.
pub mod report;

use serde::Serialize;

use crate::{
  error::AppError,
  transcript::{Paragraph, RenderedParagraph, Transcript},
};

/// Un bloc des formats **mis en page** — DOCX, HTML et PDF.
///
/// Un seul bit de structure, « ceci est un titre » : les rubriques d'un compte rendu sont son
/// squelette, et un PDF où « Résumé », « Décisions » et « Tâches » se liraient comme du corps de
/// texte ne serait plus un document.
///
/// # Pièges
///
/// - ⚠️ Un drapeau plutôt qu'un niveau : il n'y a qu'une profondeur de titre dans tout le
///   produit, et un `level: u8` inviterait à en inventer d'autres là où le modèle n'en produit
///   pas. Le transcript, lui, n'en pose jamais — ses paragraphes sont tous du corps de texte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
  /// Le texte du bloc, déjà rendu et détouré.
  pub text: String,
  /// Ce bloc est-il un titre de rubrique ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ `default` côté Swift aussi : le décodeur du PDF doit tolérer un bloc sans drapeau.
  pub heading: bool,
}

impl Block {
  /// Un paragraphe de corps de texte.
  pub fn body(text: impl Into<String>) -> Self {
    Self {
      text: text.into(),
      heading: false,
    }
  }

  /// Un titre de rubrique.
  pub fn heading(text: impl Into<String>) -> Self {
    Self {
      text: text.into(),
      heading: true,
    }
  }
}

/// La vue en blocs d'un transcript rendu, pour les formats mis en forme.
pub fn blocks(paragraphs: &[RenderedParagraph]) -> Vec<Block> {
  paragraphs
    .iter()
    .map(|paragraph| Block::body(paragraph.text.trim()))
    .collect()
}

/// L'export **Markdown** : un titre, puis un bloc par paragraphe.
///
/// # Pièges
///
/// - ⚠️ Le texte transcrit n'est pas échappé, à dessein : échapper les `*`, `_`, `#` et `` ` ``
///   d'une prose dictée constellerait l'export de barres obliques inverses pour se prémunir d'un
///   cas — un astérisque prononcé — que la transcription ne produit pour ainsi dire jamais.
pub fn markdown(title: &str, paragraphs: &[RenderedParagraph]) -> String {
  let mut blocks: Vec<String> = Vec::with_capacity(paragraphs.len() + 1);
  if !title.is_empty() {
    blocks.push(format!("# {title}"));
  }
  blocks.extend(paragraphs.iter().map(|p| p.text.trim().to_owned()));
  document(blocks)
}

/// L'export **texte brut** : la même structure que le Markdown, **sans balisage**.
pub fn plain_text(title: &str, paragraphs: &[RenderedParagraph]) -> String {
  let mut blocks: Vec<String> = Vec::with_capacity(paragraphs.len() + 1);
  if !title.is_empty() {
    blocks.push(title.to_owned());
  }
  blocks.extend(paragraphs.iter().map(|p| p.text.trim().to_owned()));
  document(blocks)
}

/// L'export **CSV**, conforme à la **RFC 4180** : `start,text`, en-tête compris.
///
/// Le temps de début est en `HH:MM:SS` : la milliseconde n'aide personne dans un tableur, et le
/// format JSON la conserve pour qui en a besoin.
///
/// # Pièges
///
/// - ⚠️ L'en-tête est en anglais et ne se localise pas : c'est un format de machine, et traduire
///   ses colonnes rendrait un fichier français illisible par un script écrit sur un anglais.
pub fn csv(paragraphs: &[RenderedParagraph]) -> String {
  // ⚠️ **CRLF, pas LF** : c'est ce qu'exige la RFC 4180, et c'est ce qu'attendent Excel et
  // Numbers. Les outils Unix tolèrent le retour chariot, l'inverse n'est pas vrai.
  let mut out = String::from("start,text\r\n");
  for paragraph in paragraphs {
    out.push_str(&field(&hms(paragraph.start_ms)));
    out.push(',');
    out.push_str(&field(&paragraph.text));
    out.push_str("\r\n");
  }
  out
}

/// L'export **JSON** : la structure complète, **sans perte**.
///
/// Seul format qui conserve les **mots horodatés** ; les autres écrasent la granularité au
/// paragraphe. Un JSON exporté doit pouvoir reconstruire le transcript.
///
/// # Errors
///
/// Rend [`AppError::Io`] si `serde_json` refuse de sérialiser le document.
///
/// # Pièges
///
/// - ⚠️ Seul format qui refuse la traduction telle quelle — voir [`translated_json`].
pub fn json(transcript: &Transcript, title: &str) -> Result<String, AppError> {
  let document = Document {
    title,
    language: &transcript.language,
    duration_ms: transcript.paragraphs.last().map_or(0, Paragraph::end_ms),
    paragraphs: &transcript.paragraphs,
  };
  // Indenté : ce fichier est autant lu par un humain que par un script, et l'export d'une
  // session d'une heure sur une seule ligne n'est ouvrable nulle part.
  serde_json::to_string_pretty(&document).map_err(encoding_failed)
}

/// L'export **JSON d'une traduction** : même structure, **sans les mots**, et qui le dit —
/// `"translated": true`, une `"note"` lisible, et `"sourceLanguage"` au lieu de `"language"`.
///
/// # Errors
///
/// Rend [`AppError::Io`] si `serde_json` refuse de sérialiser le document.
///
/// # Pièges
///
/// - ⚠️ Traduire réordonne, ajoute et fusionne les mots : aucun horodatage au mot ne survit.
///   Les recopier mentirait, et un `"language"` maintenu au-dessus d'un texte allemand serait le
///   même mensonge — d'où la clé renommée, qui casse tout lecteur qui la croirait.
pub fn translated_json(
  transcript: &Transcript,
  paragraphs: &[RenderedParagraph],
  title: &str,
) -> Result<String, AppError> {
  let document = TranslatedDocument {
    title,
    source_language: &transcript.language,
    translated: true,
    note: TRANSLATED_NOTE,
    duration_ms: paragraphs.last().map_or(0, |paragraph| paragraph.end_ms),
    paragraphs,
  };
  serde_json::to_string_pretty(&document).map_err(encoding_failed)
}

/// L'export **SRT** : repères numérotés à partir de 1, virgule décimale.
///
/// # Pièges
///
/// - ⚠️ Sur une traduction, les repères sont ceux des paragraphes, jamais des mots :
///   l'horodatage au mot n'y survit pas. Sous-titrage moins fin, assumé — ne pas chercher à le
///   réparer par un ré-alignement, qui ne pourrait qu'inventer.
pub fn srt(paragraphs: &[RenderedParagraph]) -> String {
  let mut out = String::new();
  for (index, paragraph) in paragraphs.iter().enumerate() {
    let text = cue_text(&paragraph.text);
    out.push_str(&format!(
      "{}\n{} --> {}\n{text}\n\n",
      index + 1,
      clock(paragraph.start_ms, ','),
      clock(paragraph.end_ms, ','),
    ));
  }
  out
}

/// L'export **WebVTT** : en-tête `WEBVTT`, mêmes repères, **point** décimal.
///
/// # Pièges
///
/// - ⚠️ Le texte reste échappé, et c'est le seul format où il doit l'être : le WebVTT admet des
///   balises dans le texte d'un repère, donc un `<` du transcript ouvrirait une balise inconnue
///   et le lecteur avalerait la fin de la réplique.
/// - ⚠️ Même corollaire que [`srt`] sur une traduction : les repères sont ceux des paragraphes.
pub fn vtt(paragraphs: &[RenderedParagraph]) -> String {
  let mut out = String::from("WEBVTT\n");
  for paragraph in paragraphs {
    let text = escape_vtt(&cue_text(&paragraph.text));
    out.push_str(&format!(
      "\n{} --> {}\n{text}\n",
      clock(paragraph.start_ms, '.'),
      clock(paragraph.end_ms, '.'),
    ));
  }
  out
}

/// Le document assemblé : blocs séparés d'une ligne vide, terminé par un saut de ligne.
///
/// # Pièges
///
/// - ⚠️ Un export vide est la chaîne vide, pas un saut de ligne solitaire : un fichier d'un
///   octet invisible se croit corrompu, un fichier de zéro octet se comprend.
pub(crate) fn document(blocks: Vec<String>) -> String {
  if blocks.is_empty() {
    return String::new();
  }
  let mut out = blocks.join("\n\n");
  out.push('\n');
  out
}

/// Un champ CSV, échappé selon la **RFC 4180**.
///
/// Encadré de guillemets **seulement** s'il contient une virgule, un guillemet ou un saut de
/// ligne ; les guillemets internes sont **doublés**.
///
/// # Pièges
///
/// - ⚠️ Un saut de ligne conservé dans un champ entre guillemets est licite et voulu : le
///   tronquer perdrait du texte, alors que le tableur, lui, sait le lire.
pub(crate) fn field(value: &str) -> String {
  if value.contains([',', '"', '\n', '\r']) {
    format!("\"{}\"", value.replace('"', "\"\""))
  } else {
    value.to_owned()
  }
}

/// Le texte d'un repère de sous-titre, **débarrassé de ses lignes vides**.
///
/// # Pièges
///
/// - ⚠️ Une ligne vide termine un repère, en SRT comme en VTT. Un texte qui en contiendrait une
///   couperait le fichier au milieu d'une réplique : la suite serait lue comme un nouveau
///   repère, la numérotation se décalerait, et le lecteur rejetterait tout ce qui suit.
fn cue_text(text: &str) -> String {
  text
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

/// Les trois caractères que le WebVTT réserve dans le texte d'un repère.
///
/// # Pièges
///
/// - ⚠️ L'esperluette d'abord : l'échapper après `<` transformerait le `&lt;` qu'on vient
///   d'écrire en `&amp;lt;`.
fn escape_vtt(text: &str) -> String {
  text
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

/// `HH:MM:SS`, un séparateur décimal puis `mmm` — le repère de temps des sous-titres.
///
/// # Pièges
///
/// - ⚠️ Les heures ne sont pas plafonnées à deux chiffres : le `{:02}` est un minimum de largeur,
///   pas un maximum, et au-delà de 99 h l'horloge s'élargit. Une troncature ferait repartir un
///   repère à `00:` au milieu du fichier, et le décalage passerait pour un défaut de
///   transcription.
fn clock(ms: u64, decimal: char) -> String {
  let (hours, minutes, seconds, millis) = parts(ms);
  format!("{hours:02}:{minutes:02}:{seconds:02}{decimal}{millis:03}")
}

/// `HH:MM:SS` — l'horloge du CSV, **sans milliseconde**.
fn hms(ms: u64) -> String {
  let (hours, minutes, seconds, _) = parts(ms);
  format!("{hours:02}:{minutes:02}:{seconds:02}")
}

/// Décompose des millisecondes en `(heures, minutes, secondes, millisecondes)`.
///
/// Arithmétique entière de bout en bout : aucun flottant n'entre ici, donc aucun arrondi n'en
/// sort.
fn parts(ms: u64) -> (u64, u64, u64, u64) {
  (
    ms / 3_600_000,
    ms / 60_000 % 60,
    ms / 1_000 % 60,
    ms % 1_000,
  )
}

/// L'échec de sérialisation JSON, traduit en erreur du backend.
///
/// Inatteignable avec les types de ce module — aucune clé non textuelle, aucun flottant, donc
/// rien de ce que `serde_json` refuse. La fonction est éprouvée seule.
fn encoding_failed(error: serde_json::Error) -> AppError {
  AppError::Io(format!("export JSON impossible : {error}"))
}

/// La forme de l'export JSON : le transcript, **plus** ce que le transcript ne porte pas.
///
/// Le titre et la durée vivent ici et non dans [`Transcript`] : ce sont des propriétés du
/// **document exporté**, pas du modèle de domaine.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document<'a> {
  title: &'a str,
  language: &'a str,
  duration_ms: u64,
  paragraphs: &'a [Paragraph],
}

/// La phrase que porte un JSON de traduction, à l'intention du **lecteur humain**.
///
/// # Pièges
///
/// - ⚠️ En anglais, et elle ne se localise pas — même règle que l'en-tête du CSV : un JSON est lu
///   par un script, réimporté, diffé. Une note traduite ferait de la même information neuf
///   chaînes différentes selon la machine qui a exporté, et personne ne pourrait la tester.
const TRANSLATED_NOTE: &str = "Translated transcript: word-level timings do not survive \
  translation, so paragraphs carry no words. The start and end times of each paragraph are \
  those of the original audio.";

/// La forme de l'export JSON **d'une traduction**. Voir [`translated_json`] pour les trois
/// marques qui la distinguent d'un [`Document`], et pourquoi elles sont dans le fichier.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslatedDocument<'a> {
  title: &'a str,
  /// La langue du **média**, jamais celle de la traduction : on ne la connaît pas ici.
  source_language: &'a str,
  translated: bool,
  note: &'static str,
  duration_ms: u64,
  paragraphs: &'a [RenderedParagraph],
}

#[cfg(test)]
mod tests {
  use super::{
    blocks, clock, csv, encoding_failed, hms, json, markdown, plain_text, srt, translated_json, vtt,
  };
  use crate::transcript::{RenderedParagraph, Transcript, Word};

  fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
    Word {
      text: text.into(),
      start_ms,
      end_ms,
    }
  }

  fn rendered(start_ms: u64, end_ms: u64, text: &str) -> RenderedParagraph {
    RenderedParagraph {
      start_ms,
      end_ms,
      text: text.into(),
    }
  }

  /// Deux paragraphes — le cas nominal de tout document.
  fn two_paragraphs() -> Vec<RenderedParagraph> {
    vec![
      rendered(1_500, 4_000, "Bonjour tout le monde"),
      rendered(4_200, 6_750, "Très bien, merci."),
    ]
  }

  fn transcript() -> Transcript {
    Transcript::of(
      &[
        word("Bonjour", 1_500, 2_000),
        word("à", 2_000, 2_200),
        // ⚠️ Le silence ouvre le second paragraphe : c'est la seule frontière du modèle.
        word("Très", 4_700, 5_000),
        word("bien.", 5_000, 6_750),
      ],
      "fr",
    )
  }

  // ---------------------------------------------------------------- horloge

  /// ⚠️ Les bornes qui font basculer un chiffre : la seconde qui n'est pas encore là (999 ms),
  /// celle qui vient d'arriver, et la minute qui remet les secondes à zéro.
  #[test]
  fn the_clock_never_rounds_and_never_carries_early() {
    assert_eq!(clock(0, ','), "00:00:00,000");
    assert_eq!(clock(999, ','), "00:00:00,999");
    assert_eq!(clock(1_000, ','), "00:00:01,000");
    assert_eq!(clock(59_999, ','), "00:00:59,999");
    assert_eq!(clock(60_000, ','), "00:01:00,000");
    assert_eq!(clock(3_600_000, ','), "01:00:00,000");
    assert_eq!(clock(3_661_001, ','), "01:01:01,001");
  }

  /// ⚠️ Le défaut que `{:02}` pourrait laisser croire fermé : au-delà de 99 h, l'horloge
  /// s'élargit. Tronquer ferait repartir un repère à `00:` au milieu du fichier.
  #[test]
  fn beyond_ninety_nine_hours_the_clock_widens_instead_of_truncating() {
    assert_eq!(clock(360_000_000, ','), "100:00:00,000");
    assert_eq!(clock(3_600_000 * 1_234 + 42, ','), "1234:00:00,042");
  }

  #[test]
  fn the_decimal_separator_is_the_callers_choice() {
    assert_eq!(clock(1_500, '.'), "00:00:01.500");
  }

  #[test]
  fn the_csv_clock_drops_the_milliseconds_without_rounding_up() {
    assert_eq!(hms(999), "00:00:00");
    assert_eq!(hms(3_661_999), "01:01:01");
    assert_eq!(hms(360_000_000), "100:00:00");
  }

  // -------------------------------------------------------------- markdown

  #[test]
  fn markdown_titles_the_document_and_separates_its_paragraphs() {
    assert_eq!(
      markdown("Session", &two_paragraphs()),
      "# Session\n\nBonjour tout le monde\n\nTrès bien, merci.\n"
    );
  }

  #[test]
  fn markdown_without_a_title_starts_at_the_first_paragraph() {
    assert_eq!(
      markdown("", &two_paragraphs()),
      "Bonjour tout le monde\n\nTrès bien, merci.\n"
    );
  }

  /// ⚠️ **Le test qui garde la porte de l'export.** Les huit formats ont porté des étiquettes de
  /// locuteur — en gras dans le Markdown, derrière un tiret cadratin dans le texte brut, en
  /// colonne dans le CSV, dans une balise de voix en VTT. Ce test **fige leur absence** : un
  /// texte hostile qui contient les marques d'autrefois ne doit ressortir décoré nulle part.
  #[test]
  fn no_format_writes_a_speaker_label_any_more() {
    let paragraphs = two_paragraphs();
    let sorties = [
      markdown("Session", &paragraphs),
      plain_text("Session", &paragraphs),
      csv(&paragraphs),
      srt(&paragraphs),
      vtt(&paragraphs),
      json(&transcript(), "Session").expect("sérialisation"),
      translated_json(&transcript(), &paragraphs, "Session").expect("sérialisation"),
    ];
    for sortie in sorties {
      for interdit in ["Locuteur", "speaker", "Speaker", "<v ", " — "] {
        assert!(
          !sortie.contains(interdit),
          "« {interdit} » ne doit plus sortir d'aucun format : {sortie}"
        );
      }
    }
  }

  /// ⚠️ Zéro octet, pas un saut de ligne solitaire — voir `document`.
  #[test]
  fn an_empty_export_is_an_empty_string() {
    assert_eq!(markdown("", &[]), "");
    assert_eq!(plain_text("", &[]), "");
  }

  // ------------------------------------------------------------ texte brut

  #[test]
  fn plain_text_keeps_the_structure_and_drops_every_mark() {
    let out = plain_text("Session", &two_paragraphs());
    assert_eq!(
      out,
      "Session\n\nBonjour tout le monde\n\nTrès bien, merci.\n"
    );
    assert!(!out.contains('*'), "aucun balisage dans le texte brut");
    assert!(!out.contains('#'));
  }

  #[test]
  fn plain_text_titles_without_decorating_it() {
    assert_eq!(plain_text("Titre", &[]), "Titre\n");
  }

  /// L'invariant du modèle dit qu'un paragraphe vide ne doit pas exister ; l'export refuse
  /// quand même de laisser une ligne de bords blancs.
  #[test]
  fn an_empty_paragraph_writes_an_empty_block_rather_than_whitespace() {
    assert_eq!(plain_text("", &[rendered(0, 0, "   ")]), "\n");
  }

  // ------------------------------------------------------------------- CSV

  #[test]
  fn csv_opens_with_its_header_and_one_record_per_paragraph() {
    assert_eq!(
      csv(&two_paragraphs()),
      "start,text\r\n\
       00:00:01,Bonjour tout le monde\r\n\
       00:00:04,\"Très bien, merci.\"\r\n"
    );
  }

  #[test]
  fn csv_without_a_single_paragraph_is_still_a_valid_file() {
    assert_eq!(csv(&[]), "start,text\r\n");
  }

  /// RFC 4180, les trois cas qui obligent à encadrer, et le doublement des guillemets.
  #[test]
  fn csv_quotes_what_the_rfc_demands_and_doubles_the_quotes() {
    let paragraphs = [
      rendered(0, 1, "sans rien de spécial"),
      rendered(0, 1, "avec, une virgule"),
      rendered(0, 1, "il a dit « \"oui\" » net"),
      rendered(0, 1, "deux\nlignes"),
      rendered(0, 1, "retour\r\nchariot"),
    ];
    assert_eq!(
      csv(&paragraphs),
      "start,text\r\n\
       00:00:00,sans rien de spécial\r\n\
       00:00:00,\"avec, une virgule\"\r\n\
       00:00:00,\"il a dit « \"\"oui\"\" » net\"\r\n\
       00:00:00,\"deux\nlignes\"\r\n\
       00:00:00,\"retour\r\nchariot\"\r\n"
    );
  }

  // ------------------------------------------------------------------ JSON

  #[test]
  fn json_keeps_the_words_and_their_timings() {
    let out = json(&transcript(), "Session").expect("sérialisation");
    let value: serde_json::Value = serde_json::from_str(&out).expect("JSON valide");

    assert_eq!(value["title"], "Session");
    assert_eq!(value["language"], "fr");
    assert_eq!(value["durationMs"], 6_750);
    assert_eq!(value["paragraphs"][0]["words"][0]["text"], "Bonjour");
    assert_eq!(value["paragraphs"][0]["words"][0]["startMs"], 1_500);
    assert_eq!(value["paragraphs"][0]["words"][1]["endMs"], 2_200);
  }

  /// ⚠️ « Sans perte » se prouve : le transcript se reconstruit depuis l'export.
  #[test]
  fn a_transcript_survives_a_round_trip_through_the_json_export() {
    let source = transcript();
    let out = json(&source, "Titre").expect("sérialisation");
    let back: Transcript = serde_json::from_str(&out).expect("désérialisation");
    assert_eq!(back, source);
  }

  #[test]
  fn json_of_an_empty_transcript_reports_a_zero_duration() {
    let empty = Transcript::of(&[], "en");
    let value: serde_json::Value =
      serde_json::from_str(&json(&empty, "").expect("sérialisation")).expect("JSON valide");
    assert_eq!(value["durationMs"], 0);
  }

  // ------------------------------------------------------ JSON de traduction

  /// ⚠️ Les trois marques qui rendent la traduction **lisible** dans le fichier, et l'absence
  /// de mots qui les motive.
  #[test]
  fn a_translated_json_says_it_is_translated_and_why_it_has_no_words() {
    let out = translated_json(&transcript(), &two_paragraphs(), "Session").expect("sérialisation");
    let value: serde_json::Value = serde_json::from_str(&out).expect("JSON valide");

    assert_eq!(value["translated"], true, "le drapeau qu'un script teste");
    assert!(
      value["note"]
        .as_str()
        .expect("une note")
        .contains("word-level timings do not survive translation"),
      "la phrase qu'un humain lit"
    );

    assert_eq!(value["sourceLanguage"], "fr");
    assert!(
      value["language"].is_null(),
      "⚠️ la langue du média ne doit PAS être annoncée comme celle du texte traduit"
    );

    assert_eq!(value["paragraphs"][0]["text"], "Bonjour tout le monde");
    assert_eq!(value["paragraphs"][0]["startMs"], 1_500);
    assert_eq!(value["paragraphs"][1]["endMs"], 6_750);
    assert!(
      value["paragraphs"][0]["words"].is_null(),
      "aucun mot ne survit à la traduction — les recopier serait mentir"
    );
    assert_eq!(
      value["durationMs"], 6_750,
      "la fin du dernier paragraphe traduit"
    );
  }

  /// Un export d'origine et un export traduit doivent se distinguer **à l'œil**, pas par
  /// déduction : c'est tout l'objet de la décision.
  #[test]
  fn the_original_json_carries_none_of_the_translation_marks() {
    let out = json(&transcript(), "Session").expect("sérialisation");
    let value: serde_json::Value = serde_json::from_str(&out).expect("JSON valide");

    assert!(value["translated"].is_null());
    assert!(value["note"].is_null());
    assert!(value["sourceLanguage"].is_null());
    assert_eq!(value["language"], "fr");
    assert!(!value["paragraphs"][0]["words"].is_null());
  }

  #[test]
  fn a_translation_without_a_single_paragraph_reports_a_zero_duration() {
    let value: serde_json::Value =
      serde_json::from_str(&translated_json(&transcript(), &[], "").expect("sérialisation"))
        .expect("JSON valide");
    assert_eq!(value["durationMs"], 0);
    assert_eq!(value["paragraphs"].as_array().expect("un tableau").len(), 0);
  }

  /// La branche d'erreur est inatteignable avec nos types (voir `encoding_failed`) : on éprouve
  /// la traduction du défaut, pas un défaut fabriqué.
  #[test]
  fn a_serialisation_failure_would_surface_as_an_io_error() {
    let failure = serde_json::from_str::<u8>("\"pas un nombre\"").expect_err("erreur attendue");
    let error = encoding_failed(failure);
    assert_eq!(error.kind(), "io");
    assert!(error.to_string().starts_with("export JSON impossible : "));
  }

  // ------------------------------------------------------------------- SRT

  #[test]
  fn srt_numbers_from_one_and_writes_a_comma_before_the_milliseconds() {
    assert_eq!(
      srt(&two_paragraphs()),
      "1\n00:00:01,500 --> 00:00:04,000\nBonjour tout le monde\n\n\
       2\n00:00:04,200 --> 00:00:06,750\nTrès bien, merci.\n\n"
    );
  }

  #[test]
  fn srt_of_nothing_is_nothing() {
    assert_eq!(srt(&[]), "");
  }

  /// ⚠️ Le défaut qui casserait tout le fichier : une ligne vide dans une réplique termine
  /// le repère, et la suite serait lue comme un nouveau sous-titre.
  #[test]
  fn a_blank_line_inside_a_cue_is_folded_away() {
    let paragraphs = [rendered(0, 1_000, "Première ligne\n\n  \nSeconde ligne")];
    assert_eq!(
      srt(&paragraphs),
      "1\n00:00:00,000 --> 00:00:01,000\nPremière ligne\nSeconde ligne\n\n"
    );
  }

  // ------------------------------------------------------------------- VTT

  #[test]
  fn vtt_opens_with_its_signature_and_uses_a_dot() {
    assert_eq!(
      vtt(&two_paragraphs()),
      "WEBVTT\n\n\
       00:00:01.500 --> 00:00:04.000\nBonjour tout le monde\n\n\
       00:00:04.200 --> 00:00:06.750\nTrès bien, merci.\n"
    );
  }

  #[test]
  fn an_empty_vtt_is_still_a_valid_file() {
    assert_eq!(vtt(&[]), "WEBVTT\n");
  }

  /// ⚠️ **L'échappement survit à la balise de voix qui le motivait.** Le WebVTT admet toujours
  /// des balises dans le texte d'un repère, donc un `<` du transcript ouvrirait une balise
  /// inconnue et le lecteur avalerait la suite.
  /// ⚠️ Et l'esperluette en premier, sinon `&lt;` ressortirait `&amp;lt;`.
  #[test]
  fn vtt_escapes_the_markup_characters_in_the_text() {
    let paragraphs = [rendered(0, 1_000, "1 < 2 & 3 > 2")];
    assert_eq!(
      vtt(&paragraphs),
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n1 &lt; 2 &amp; 3 &gt; 2\n"
    );
  }

  #[test]
  fn vtt_folds_blank_lines_like_srt_does() {
    let paragraphs = [rendered(0, 1_000, "Une ligne\n\nUne autre")];
    assert_eq!(
      vtt(&paragraphs),
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nUne ligne\nUne autre\n"
    );
  }

  // ------------------------------------------------------- caractères durs

  /// Guillemets, virgules, sauts de ligne, accents et emoji : aucun format ne doit
  /// les perdre, et chacun les protège à sa manière.
  #[test]
  fn every_format_survives_hostile_text() {
    let hostile = "Il a dit : \"oui, çà va\" 🙂\n漢字";
    let paragraphs = [rendered(0, 1_000, hostile)];

    assert!(markdown("Ünïcode 🎧", &paragraphs).contains(hostile));
    assert!(plain_text("", &paragraphs).contains(hostile));
    assert!(csv(&paragraphs).contains("\"Il a dit : \"\"oui, çà va\"\" 🙂\n漢字\""));

    // Les sous-titres replient le saut de ligne, le reste passe intact.
    assert!(srt(&paragraphs).contains("Il a dit : \"oui, çà va\" 🙂\n漢字"));
    assert!(vtt(&paragraphs).contains("Il a dit"));

    let source = Transcript::of(&[word(hostile, 0, 1_000)], "fr");
    let back: Transcript =
      serde_json::from_str(&json(&source, "Ünïcode 🎧").expect("sérialisation"))
        .expect("désérialisation");
    assert_eq!(back, source);
  }

  // ---------------------------------------------------------------- blocs

  /// La vue en blocs porte exactement le texte des formats texte, débarrassé de ses bords.
  #[test]
  fn blocks_carry_the_trimmed_text_of_each_paragraph() {
    assert_eq!(
      blocks(&two_paragraphs()),
      vec![
        super::Block::body("Bonjour tout le monde"),
        super::Block::body("Très bien, merci."),
      ]
    );
    assert_eq!(
      blocks(&[rendered(0, 1, " Bonjour ")]),
      vec![super::Block::body("Bonjour")],
      "un paragraphe de transcript n'est jamais un titre"
    );
    assert!(blocks(&[]).is_empty());
  }
}
