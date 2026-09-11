//! **Les huit formats d'export produisent-ils un fichier valide ?**
//!
//! ⚠️ Les tests unitaires de `src/export/` comparent des **chaînes**, pas des fichiers. Un
//! `.srt` dont les repères seraient écrits avec un point décimal passerait toutes leurs
//! assertions le jour où l'attendu serait recopié depuis la sortie. Ce fichier écrit donc les
//! huit sur le disque et les relit **avec les yeux du format** : le JSON se redésérialise, le CSV
//! se reparse selon la RFC 4180, les sous-titres se décodent, le `.docx` repasse par `textutil`.
//!
//! ⚠️ Ce qu'il ne prouve pas : qu'un fichier s'ouvre dans Word ou VLC, et que le **texte** d'un
//! PDF est le bon — macOS n'a aucun extracteur en ligne de commande, et en écrire un serait
//! fabriquer un instrument moins sûr que ce qu'il mesure. De ce côté-là, c'est la charge utile
//! envoyée au pont qui est vérifiée.
//!
//! Transcript synthétique, `/usr/bin/textutil` pour seul outil extérieur : d'où l'absence de
//! `#[ignore]`, ce fichier tourne dans `npm run verify`.

use std::{
  ffi::{CStr, CString, c_char},
  fs,
  path::{Path, PathBuf},
  process::Command,
};

use app_lib::{
  export::{
    format::ExportFormat,
    render::{self, Rendering},
  },
  measure::{Paragraph, Transcript, Word},
};

// Le pont du PDF, déclaré ici
//
// ⚠️ **Cette déclaration double celle de `src/native/mod.rs`, à contrecœur** — exactement comme
// `tests/transcript_translation.rs`, et pour la même raison : `native` reste privé (c'est la seule
// zone `unsafe` du backend) et `measure` n'expose pas `export_pdf`. L'y ajouter demanderait de
// toucher `lib.rs`, ce que ce chantier n'a pas le droit de faire. **À reprendre** : exporter
// `crate::native::export_pdf` dans `measure` et supprimer ce bloc.
//
// Le lien lui-même est déjà posé par `build.rs` (`cargo:rustc-link-lib=dylib=MirmalionNative`),
// qui s'applique aux tests comme au binaire — y compris le `-rpath` sans lequel dyld ne
// trouverait rien à l'exécution.
unsafe extern "C" {
  fn mirmalion_export_pdf(
    payload: *const c_char,
    path: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_free_string(pointer: *mut c_char);
}

// Le document d'épreuve

/// Le titre du document — **il exerce l'échappement des trois rendus balisés** (HTML, DOCX, PDF)
/// avant même qu'un tour n'ait été écrit.
const TITLE: &str = "Session « bilan » & suite <2026>";

/// Quatre paragraphes, et **du texte choisi pour faire mal à chaque format** : une virgule et un
/// guillemet double (CSV), un `<` et un `&` (HTML et VTT), un `*`, un `_` et un `#` (Markdown),
/// des accents de plusieurs langues. ⚠️ Les mots sont horodatés **un par un**, pas seulement les
/// paragraphes : c'est ce que le JSON prétend ne jamais perdre.
///
/// ⚠️ **Les paragraphes se forment par le silence, et c'est le modèle qui les pose.** On ne
/// construit plus un `Transcript` champ par champ : les trous de plus de 2,5 s entre `dit-elle`
/// (3 000 ms) et `Il` (6 200 ms), etc., sont ce qui découpe le document. Les fabriquer à la main
/// laisserait ce test passer même si `Transcript::of` cessait de découper.
fn document() -> Transcript {
  Transcript::of(
    &[
      word("Bonjour", 1_500, 2_000),
      word("à", 2_000, 2_200),
      word("tous,", 2_200, 2_600),
      word("dit-elle", 2_600, 3_000),
      // ── silence ──
      word("Il", 6_200, 6_400),
      word("a", 6_400, 6_500),
      word("dit", 6_500, 6_800),
      word("\"oui\",", 6_800, 7_200),
      word("1", 7_200, 7_300),
      word("<", 7_300, 7_400),
      word("2", 7_400, 7_500),
      word("&", 7_500, 7_600),
      word("3", 7_600, 8_000),
      // ── silence ── ⚠️ Un paragraphe qui porte des accents d'autres langues du périmètre :
      // un export qui recode mal ne se voit pas sur du français seul.
      word("Grüße", 11_000, 11_400),
      word("aus", 11_400, 11_600),
      word("São", 11_600, 11_900),
      // ── silence ──
      word("Résumé", 15_000, 15_400),
      word("*important*", 15_400, 15_900),
      word("_souligné_", 15_900, 16_200),
      word("#final", 16_200, 16_500),
    ],
    "fr",
  )
}

fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
  Word {
    text: text.into(),
    start_ms,
    end_ms,
  }
}

/// Le texte attendu de chaque paragraphe, dans l'ordre — recomposé par `Paragraph::text`.
fn texts() -> Vec<String> {
  document().paragraphs.iter().map(Paragraph::text).collect()
}

/// Les bornes `(début, fin)` de chaque paragraphe, en millisecondes.
fn bounds() -> Vec<(u64, u64)> {
  document()
    .paragraphs
    .iter()
    .map(|paragraph| (paragraph.start_ms(), paragraph.end_ms()))
    .collect()
}

// Le dossier de travail

/// Un dossier temporaire **effacé même quand le test échoue** : le `Drop` s'exécute pendant le
/// déroulement de la pile, là où un nettoyage écrit en fin de fonction serait sauté par le panic
/// et laisserait des `.docx` derrière chaque échec.
struct Workspace(PathBuf);

impl Workspace {
  fn new(name: &str) -> Self {
    let path = std::env::temp_dir().join(format!(
      "mirmalion-export-formats-{}-{name}",
      std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("le dossier de travail doit se créer");
    Self(path)
  }

  /// Écrit le document dans `format` et rend le chemin du fichier produit.
  ///
  /// ⚠️ **L'extension vient de `ExportFormat::extension`, jamais d'une chaîne recopiée ici** :
  /// c'est le backend qui dicte les extensions, et un test qui les redéclarerait cesserait de
  /// surveiller la seule liste qui compte.
  fn export(&self, format: ExportFormat, rendering: &Rendering<'_>) -> PathBuf {
    let path = self.0.join(format!("document.{}", format.extension()));

    if format.is_native() {
      let payload = render::pdf_payload(TITLE, rendering).expect("charge utile du PDF");
      write_pdf(&payload, &path);
    } else {
      let bytes = render::bytes(format, TITLE, rendering).expect("rendu du document");
      render::write(&path, &bytes).expect("écriture du document");
    }

    let written = fs::metadata(&path).expect("le fichier d'export doit exister après l'écriture");
    assert!(
      written.len() > 0,
      "{format:?} a produit un fichier de zéro octet"
    );
    path
  }
}

impl Drop for Workspace {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

/// Écrit le PDF par le pont natif — **c'est Swift qui pose le fichier**, un PDF n'existe jamais
/// comme tampon d'octets (voir `export::render::bytes`, qui le refuse).
fn write_pdf(payload: &str, path: &Path) {
  let payload = CString::new(payload).expect("charge utile transmissible");
  let target = CString::new(path.to_string_lossy().as_ref()).expect("chemin transmissible");
  let mut out: *mut c_char = std::ptr::null_mut();

  // SAFETY : deux chaînes C valides le temps de l'appel, et `out` est un pointeur que le pont
  // remplit ou laisse nul.
  let status = unsafe { mirmalion_export_pdf(payload.as_ptr(), target.as_ptr(), &mut out) };
  let message = if out.is_null() {
    String::new()
  } else {
    // SAFETY : le pont ne place dans `out` qu'une chaîne C issue de `strdup`, rendue une fois.
    let text = unsafe { CStr::from_ptr(out) }
      .to_string_lossy()
      .into_owned();
    unsafe { mirmalion_free_string(out) };
    text
  };

  assert_eq!(
    status, 0,
    "le pont natif a refusé d'écrire le PDF : {message}"
  );
}

// Les huit formats, sur le disque

/// Les huit formats du sélecteur. Écrits en dur pour que l'ajout d'un neuvième **casse ce test**
/// au lieu de le laisser silencieusement incomplet.
const ALL: [ExportFormat; 8] = [
  ExportFormat::Markdown,
  ExportFormat::Pdf,
  ExportFormat::Docx,
  ExportFormat::PlainText,
  ExportFormat::Csv,
  ExportFormat::Json,
  ExportFormat::Srt,
  ExportFormat::Vtt,
];

/// Le tour de garde de la DoD : **les huit s'écrivent, et chacun porte l'extension annoncée**.
/// Les tests suivants ouvrent chaque fichier avec le lecteur de son format.
#[test]
fn the_eight_formats_all_write_a_file_under_their_own_extension() {
  let source = document();
  let workspace = Workspace::new("les-huit");
  let mut extensions: Vec<String> = Vec::new();

  for format in ALL {
    let path = workspace.export(format, &Rendering::original(&source));
    extensions.push(
      path
        .extension()
        .expect("un export porte une extension")
        .to_string_lossy()
        .into_owned(),
    );
  }

  extensions.sort_unstable();
  assert_eq!(
    extensions,
    ["csv", "docx", "json", "md", "pdf", "srt", "txt", "vtt"],
    "les huit fichiers de la DoD de P3-11"
  );
}

// ------------------------------------------------------------------------------ JSON

/// ⚠️ **« Sans perte » se prouve en relisant, pas en regardant.** Le fichier posé sur le disque
/// se redésérialise en `Transcript` et doit rendre le document d'origine — paragraphes et **mots
/// horodatés** compris. C'est le seul des huit dont on puisse exiger cela.
#[test]
fn the_json_file_deserialises_back_into_the_very_same_transcript() {
  let source = document();
  let workspace = Workspace::new("json");
  let path = workspace.export(ExportFormat::Json, &Rendering::original(&source));

  let text = fs::read_to_string(&path).expect("relecture du .json");
  let back: Transcript =
    serde_json::from_str(&text).expect("le .json doit se relire en transcript");
  assert_eq!(back, source, "le JSON ne doit rien perdre du transcript");

  let value: serde_json::Value = serde_json::from_str(&text).expect("du JSON valide");
  assert_eq!(value["title"], TITLE);
  assert_eq!(value["language"], "fr");
  assert_eq!(
    value["durationMs"], 16_500,
    "la fin du dernier mot du dernier paragraphe"
  );

  // Le bien le plus précieux du format : un mot, ses deux bornes, et sa place dans son
  // paragraphe.
  assert_eq!(value["paragraphs"][0]["words"][0]["text"], "Bonjour");
  assert_eq!(value["paragraphs"][0]["words"][0]["startMs"], 1_500);
  assert_eq!(value["paragraphs"][0]["words"][3]["endMs"], 3_000);
  assert_eq!(value["paragraphs"][2]["words"][0]["text"], "Grüße");

  assert!(
    value["speakers"].is_null(),
    "plus aucun locuteur ne sort d'un export"
  );
  assert!(!text.contains("Locuteur"));
}

// ------------------------------------------------------------------------------- CSV

/// ⚠️ **LE CHAMP CITÉ SE PROUVE PAR UN ALLER-RETOUR, PAS PAR UNE SOUS-CHAÎNE.** Un texte qui
/// porte une virgule *et* un guillemet double est exactement ce qui décale une colonne dans un
/// tableur : le fichier reste lisible, et le contenu ment. On le reparse donc selon la RFC 4180
/// et on exige de retrouver le texte d'origine, caractère pour caractère.
#[test]
fn the_csv_file_reparses_into_two_columns_that_give_the_original_text_back() {
  let source = document();
  let workspace = Workspace::new("csv");
  let path = workspace.export(ExportFormat::Csv, &Rendering::original(&source));

  let text = fs::read_to_string(&path).expect("relecture du .csv");
  assert!(
    text.contains("\r\n"),
    "la RFC 4180 impose CRLF, et c'est ce qu'attendent Excel et Numbers"
  );

  let records = parse_csv(&text);
  assert_eq!(
    records.len(),
    source.paragraphs.len() + 1,
    "un en-tête, puis un enregistrement par paragraphe"
  );
  assert_eq!(
    records[0],
    ["start", "text"],
    "la colonne « speaker » est partie avec les locuteurs — voir `export::csv`"
  );

  let expected_starts = ["00:00:01", "00:00:06", "00:00:11", "00:00:15"];

  for (index, text) in texts().iter().enumerate() {
    let record = &records[index + 1];
    assert_eq!(record.len(), 2, "deux colonnes, toujours : {record:?}");
    assert_eq!(record[0], expected_starts[index], "HH:MM:SS, sans arrondi");
    assert_eq!(
      &record[1], text,
      "le texte du paragraphe {index} n'a pas survécu à son échappement"
    );
  }

  // La preuve littérale de l'échappement, en plus de l'aller-retour : sans elle, un parseur de
  // test bogué dans le même sens que l'export ferait passer les deux.
  assert!(
    text.contains("\"Il a dit \"\"oui\"\", 1 < 2 & 3\""),
    "le guillemet interne se double et le champ s'encadre"
  );
}

/// Un parseur RFC 4180 minimal : champs cités, guillemets doublés, CRLF comme LF.
///
/// ⚠️ **Écrit à la main plutôt qu'apporté par une caisse** : ajouter une dépendance au crate pour
/// un test serait la faire entrer dans le binaire livré (`cargo` ne distingue pas `dev-` ici sans
/// raison) et surtout, un parseur de vingt lignes se relit — une caisse ne se relit pas.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
  let mut records: Vec<Vec<String>> = Vec::new();
  let mut record: Vec<String> = Vec::new();
  let mut field = String::new();
  let mut quoted = false;
  let mut characters = text.chars().peekable();

  while let Some(character) = characters.next() {
    if quoted {
      if character == '"' {
        if characters.peek() == Some(&'"') {
          characters.next();
          field.push('"');
        } else {
          quoted = false;
        }
      } else {
        field.push(character);
      }
      continue;
    }
    match character {
      '"' => quoted = true,
      ',' => record.push(std::mem::take(&mut field)),
      '\r' | '\n' => {
        if character == '\r' && characters.peek() == Some(&'\n') {
          characters.next();
        }
        record.push(std::mem::take(&mut field));
        records.push(std::mem::take(&mut record));
      }
      _ => field.push(character),
    }
  }
  if !field.is_empty() || !record.is_empty() {
    record.push(field);
    records.push(record);
  }
  records
}

// --------------------------------------------------------------------- SRT et VTT

/// Un repère de sous-titre, tel qu'un lecteur le décode.
struct Cue {
  start_ms: u64,
  end_ms: u64,
  text: String,
}

/// ⚠️ **LE SÉPARATEUR DÉCIMAL EST LA FAUTE QUE CE TEST EXISTE POUR ATTRAPER.** SRT écrit une
/// virgule, WebVTT un point, et l'échange ne se voit nulle part avant qu'un lecteur ne refuse le
/// fichier — les deux restent de jolis fichiers texte. On décode donc les repères avec le
/// séparateur du format, **et** on exige que celui de l'autre soit absent de la ligne.
#[test]
fn the_srt_file_carries_monotonic_cues_that_match_the_paragraphs() {
  let source = document();
  let workspace = Workspace::new("srt");
  let path = workspace.export(ExportFormat::Srt, &Rendering::original(&source));
  let text = fs::read_to_string(&path).expect("relecture du .srt");

  let cues = parse_srt(&text);
  assert_cues_match_the_paragraphs(&cues);

  // Les repères sont numérotés à partir de 1 — un lecteur qui trouve un `0` refuse le fichier.
  assert!(text.starts_with("1\n00:00:01,500 --> 00:00:03,000\n"));

  assert_eq!(cues[0].text, "Bonjour à tous, dit-elle");
  assert_eq!(cues[1].text, "Il a dit \"oui\", 1 < 2 & 3");
  assert_eq!(cues[2].text, "Grüße aus São");
  assert!(
    !text.contains(" — "),
    "le nom du locuteur entrait dans la réplique : il n'y entre plus"
  );
}

/// Même épreuve, plus la signature et l'échappement.
///
/// ⚠️ **LA BALISE `<v Nom>` EST PARTIE, L'ÉCHAPPEMENT RESTE.** Le WebVTT admet toujours des
/// balises dans le texte d'un repère : un `<` du transcript ouvrirait une balise inconnue, et le
/// lecteur avalerait la fin de la réplique.
#[test]
fn the_vtt_file_opens_with_its_signature_and_escapes_what_its_tags_reserve() {
  let source = document();
  let workspace = Workspace::new("vtt");
  let path = workspace.export(ExportFormat::Vtt, &Rendering::original(&source));
  let text = fs::read_to_string(&path).expect("relecture du .vtt");

  assert!(
    text.starts_with("WEBVTT\n"),
    "sans cette ligne, aucun lecteur n'ouvre le fichier"
  );

  let cues = parse_vtt(&text);
  assert_cues_match_the_paragraphs(&cues);

  // ⚠️ L'esperluette est échappée **en premier**, sinon le `&lt;` qu'on vient d'écrire
  // ressortirait `&amp;lt;`.
  assert_eq!(cues[1].text, "Il a dit \"oui\", 1 &lt; 2 &amp; 3");
  assert_eq!(cues[0].text, "Bonjour à tous, dit-elle");
  assert_eq!(cues[2].text, "Grüße aus São");
  assert!(!text.contains("<v "), "la balise de voix n'a plus d'emploi");
}

/// Les repères tombent-ils là où les paragraphes ont été prononcés ?
///
/// ⚠️ **Monotones ET non chevauchants** : deux repères qui se recouvrent donnent, selon le
/// lecteur, un sous-titre qui clignote ou un fichier refusé — et rien dans le fichier ne le
/// laisse voir.
fn assert_cues_match_the_paragraphs(cues: &[Cue]) {
  let bounds = bounds();
  assert_eq!(cues.len(), bounds.len(), "un repère par paragraphe");

  let mut previous_end = 0;
  for (index, cue) in cues.iter().enumerate() {
    assert_eq!(
      (cue.start_ms, cue.end_ms),
      bounds[index],
      "le repère {index} ne tombe pas sur les bornes de son paragraphe"
    );
    assert!(
      cue.start_ms < cue.end_ms,
      "le repère {index} est de durée nulle ou négative"
    );
    assert!(
      cue.start_ms >= previous_end,
      "le repère {index} chevauche le précédent"
    );
    previous_end = cue.end_ms;
  }
}

fn parse_srt(text: &str) -> Vec<Cue> {
  text
    .split("\n\n")
    .filter(|block| !block.trim().is_empty())
    .enumerate()
    .map(|(index, block)| {
      let mut lines = block.lines();
      let number = lines.next().expect("un numéro de repère");
      assert_eq!(
        number.parse::<usize>().expect("un numéro entier"),
        index + 1,
        "les repères SRT se numérotent à partir de 1, sans trou"
      );
      cue(lines.next().expect("une ligne de repère"), ',', lines)
    })
    .collect()
}

fn parse_vtt(text: &str) -> Vec<Cue> {
  let body = text
    .strip_prefix("WEBVTT\n")
    .expect("la signature WEBVTT ouvre le fichier");
  body
    .split("\n\n")
    .filter(|block| !block.trim().is_empty())
    .map(|block| {
      let mut lines = block.trim_matches('\n').lines();
      cue(lines.next().expect("une ligne de repère"), '.', lines)
    })
    .collect()
}

/// Décode `HH:MM:SS<décimal>mmm --> HH:MM:SS<décimal>mmm`, suivi du texte du repère.
fn cue<'a>(timing: &str, decimal: char, body: impl Iterator<Item = &'a str>) -> Cue {
  let other = if decimal == ',' { '.' } else { ',' };
  assert!(
    !timing.contains(other),
    "le repère « {timing} » emploie le séparateur décimal de l'autre format"
  );

  let (start, end) = timing
    .split_once(" --> ")
    .unwrap_or_else(|| panic!("« {timing} » n'est pas une ligne de repère"));
  Cue {
    start_ms: milliseconds(start, decimal),
    end_ms: milliseconds(end, decimal),
    text: body.collect::<Vec<_>>().join("\n"),
  }
}

fn milliseconds(stamp: &str, decimal: char) -> u64 {
  let (clock, millis) = stamp
    .split_once(decimal)
    .unwrap_or_else(|| panic!("« {stamp} » n'a pas de séparateur décimal « {decimal} »"));
  let parts: Vec<&str> = clock.split(':').collect();
  assert_eq!(parts.len(), 3, "« {stamp} » n'est pas un HH:MM:SS");
  assert_eq!(
    millis.len(),
    3,
    "les millisecondes s'écrivent sur 3 chiffres"
  );

  let value = |text: &str| text.parse::<u64>().expect("un nombre entier");
  value(parts[0]) * 3_600_000 + value(parts[1]) * 60_000 + value(parts[2]) * 1_000 + value(millis)
}

// ------------------------------------------------------------------------------ DOCX

/// ⚠️ **UN ZIP QUI CONTIENT LES BONS MOTS N'EST PAS UN DOCUMENT WORD.** La signature `PK\x03\x04`
/// dit qu'on a bien un zip ; ce qui prouve le reste, c'est que le **moteur de texte du système** —
/// celui de TextEdit et de Pages — accepte de le convertir et rend le texte attendu.
///
/// ⚠️ Si `textutil` échoue, le test **échoue bruyamment**. Un outil de mesure muet qu'on prendrait
/// pour un succès est pire que pas de mesure du tout.
#[test]
fn the_docx_file_is_a_zip_that_the_system_text_engine_reads_back() {
  let source = document();
  let workspace = Workspace::new("docx");
  let path = workspace.export(ExportFormat::Docx, &Rendering::original(&source));

  let bytes = fs::read(&path).expect("relecture du .docx");
  assert_eq!(
    &bytes[..4],
    b"PK\x03\x04",
    "un .docx est un zip, et un fichier qui ne commence pas là ne s'ouvre nulle part"
  );

  let text = docx_text(&path);
  assert!(text.contains(TITLE), "le titre manque : {text}");
  for expected in texts() {
    assert!(
      text.contains(&expected),
      "« {expected} » manque au document Word : {text}"
    );
  }
  assert!(
    text.contains("Résumé") && text.contains("Grüße aus São"),
    "les accents doivent traverser le zip et la conversion"
  );
}

/// Le texte d'un `.docx`, extrait par l'outil livré avec macOS.
fn docx_text(path: &Path) -> String {
  let output = Command::new("/usr/bin/textutil")
    .args(["-convert", "txt", "-encoding", "UTF-8", "-stdout"])
    .arg(path)
    .output()
    .expect("/usr/bin/textutil est livré avec macOS et doit être exécutable");

  assert!(
    output.status.success(),
    "textutil a refusé le .docx ({}) : {}",
    output.status,
    String::from_utf8_lossy(&output.stderr)
  );
  String::from_utf8(output.stdout).expect("textutil doit rendre de l'UTF-8")
}

// ------------------------------------------------------------------------------- PDF

/// ⚠️ **Un PDF se reconnaît à ses deux bouts** : `%PDF-` en tête, et la remorque `%%EOF` en
/// queue. C'est cette seconde marque qui distingue un fichier complet d'un fichier tronqué — une
/// écriture interrompue laisse un en-tête parfaitement valide.
///
/// ⚠️ **Le texte n'est pas relu, et on ne fait pas semblant de le faire** : macOS n'offre aucun
/// extracteur en ligne de commande (voir l'en-tête). Ce qui est vérifiable, c'est la charge utile
/// envoyée au pont — le titre et les blocs.
#[test]
fn the_pdf_file_opens_at_its_signature_and_ends_at_its_trailer() {
  let source = document();
  let workspace = Workspace::new("pdf");
  let path = workspace.export(ExportFormat::Pdf, &Rendering::original(&source));

  let bytes = fs::read(&path).expect("relecture du .pdf");
  assert!(
    bytes.starts_with(b"%PDF-"),
    "un PDF s'ouvre à sa signature de version"
  );
  assert!(
    bytes.windows(5).any(|window| window == b"%%EOF"),
    "sans la remorque %%EOF, le fichier est tronqué et un lecteur le refuse"
  );

  let payload =
    render::pdf_payload(TITLE, &Rendering::original(&source)).expect("charge utile du PDF");
  let value: serde_json::Value = serde_json::from_str(&payload).expect("du JSON valide");
  assert_eq!(value["title"], TITLE);
  assert_eq!(value["blocks"][0]["text"], texts()[0]);
  assert!(
    value["separator"].is_null(),
    "le séparateur voyageait pour attacher un nom à sa réplique : il n'a plus d'objet"
  );
}

// ---------------------------------------------------------------- Markdown et texte

/// ⚠️ **Le Markdown N'ÉCHAPPE PAS le texte transcrit, et c'est une décision, pas un oubli**
/// (voir `export::markdown`). L'attente est donc écrite d'après le code : `*important*`,
/// `_souligné_` et `#final` ressortent **tels quels**, sans barre oblique inverse. Le seul
/// balisage produit est celui que l'export ajoute lui-même — le `#` du titre, et rien d'autre.
#[test]
fn the_markdown_file_marks_up_only_what_the_export_adds() {
  let source = document();
  let workspace = Workspace::new("markdown");
  let path = workspace.export(ExportFormat::Markdown, &Rendering::original(&source));
  let text = fs::read_to_string(&path).expect("relecture du .md");

  assert_eq!(
    text,
    format!(
      "# {TITLE}\n\n\
       Bonjour à tous, dit-elle\n\n\
       Il a dit \"oui\", 1 < 2 & 3\n\n\
       Grüße aus São\n\n\
       Résumé *important* _souligné_ #final\n"
    )
  );
  assert!(
    !text.contains("**"),
    "le gras ne servait qu'à nommer un locuteur"
  );
  assert!(
    !text.contains('\\'),
    "aucune barre oblique inverse : le texte dicté n'est pas échappé"
  );
}

/// Le texte brut porte la même structure **sans le moindre balisage ajouté**.
#[test]
fn the_plain_text_file_keeps_the_structure_and_adds_no_mark() {
  let source = document();
  let workspace = Workspace::new("texte");
  let path = workspace.export(ExportFormat::PlainText, &Rendering::original(&source));
  let text = fs::read_to_string(&path).expect("relecture du .txt");

  assert_eq!(
    text,
    format!(
      "{TITLE}\n\n\
       Bonjour à tous, dit-elle\n\n\
       Il a dit \"oui\", 1 < 2 & 3\n\n\
       Grüße aus São\n\n\
       Résumé *important* _souligné_ #final\n"
    )
  );
  assert!(
    !text.contains("**"),
    "le gras du Markdown n'a rien à faire dans un .txt"
  );
}

// ------------------------------------------------- aucun format ne nomme personne

/// ⚠️ **Le test qui garde la porte, sur les huit fichiers réellement écrits.** Les huit formats
/// ont porté des noms de locuteurs, chacun à sa manière — gras, tiret cadratin, colonne, balise
/// `<v>`, objet `speakers` —, et plus aucun ne doit en porter.
///
/// ⚠️ Il lit les fichiers **posés sur le disque**, pas les chaînes rendues : c'est la seule façon
/// de couvrir le DOCX et le PDF, qui passent par un zip et par le pont natif.
///
/// ⚠️ Et il exige que le **texte**, lui, soit bien là : sans cette moitié, un export vide
/// passerait triomphalement — l'erreur naturelle d'un test d'absence.
#[test]
fn none_of_the_eight_files_carries_a_speaker_label() {
  let source = document();
  let workspace = Workspace::new("sans-locuteurs");
  let rendering = Rendering::original(&source);

  for format in [
    ExportFormat::Markdown,
    ExportFormat::PlainText,
    ExportFormat::Csv,
    ExportFormat::Json,
    ExportFormat::Srt,
    ExportFormat::Vtt,
  ] {
    let path = workspace.export(format, &rendering);
    let text = fs::read_to_string(&path).expect("relecture");
    for interdit in ["Locuteur", "speaker", "Speaker", "<v ", " — "] {
      assert!(
        !text.contains(interdit),
        "« {interdit} » ressort du fichier {format:?}"
      );
    }
    // ⚠️ **LA CONTRE-ÉPREUVE : LE TEXTE N'A PAS DISPARU AVEC LES ÉTIQUETTES.** Sans elle, un
    // export vide passerait triomphalement — c'est l'erreur qu'un test d'absence fait
    // naturellement.
    //
    // ⚠️ **Le JSON se cherche AU MOT, les autres au paragraphe** : lui seul garde les mots
    // séparés, donc « Grüße aus São » ne s'y trouve nulle part d'un seul tenant. Chercher le
    // paragraphe entier y échouerait pour une raison qui n'a rien à voir avec les locuteurs.
    let paragraphe = texts()[2].clone();
    let expected = if format == ExportFormat::Json {
      "Grüße"
    } else {
      paragraphe.as_str()
    };
    assert!(
      text.contains(expected),
      "{format:?} a perdu son texte en perdant ses noms"
    );
  }

  let docx = docx_text(&workspace.export(ExportFormat::Docx, &rendering));
  assert!(!docx.contains(" — "), "le .docx nomme encore quelqu'un");
  // ⚠️ **Une absence ne se constate que sur une extraction qui a MARCHÉ.** Sans cette ligne, un
  // `textutil` muet rendrait la vérification précédente vraie pour la pire des raisons.
  for expected in texts() {
    assert!(
      docx.contains(&expected),
      "le .docx a perdu « {expected} » — ou textutil n'a rien extrait"
    );
  }

  // Le PDF n'est pas relisible ; sa charge utile, si — et c'est elle qui portait les noms.
  let payload = render::pdf_payload(TITLE, &rendering).expect("charge utile");
  let value: serde_json::Value = serde_json::from_str(&payload).expect("du JSON valide");
  let blocks = value["blocks"].as_array().expect("des blocs");
  assert_eq!(blocks.len(), texts().len());
  for block in blocks {
    // ⚠️ **Le bloc porte un texte et un drapeau de rubrique, rien d'autre** — surtout pas un
    // locuteur. Le drapeau appartient au compte rendu de session ; un transcript ne le lève
    // jamais.
    assert!(block["speaker"].is_null(), "plus aucun nom dans un bloc");
    assert_eq!(
      block["heading"], false,
      "un paragraphe de transcript n'est pas une rubrique"
    );
  }
}

// ------------------------------------------------------------------ « Copier »

/// ⚠️ **Deux représentations, jamais une.** Le HTML sert Mail, Word et
/// Pages ; le Markdown sert l'éditeur, le terminal et le champ de saisie. N'en poser qu'une ferait
/// coller du balisage brut dans la moitié des applications, ou perdrait le titre dans l'autre.
///
/// ⚠️ **Le dépôt réel dans le presse-papiers n'est PAS éprouvé ici** : il écrase la seule donnée
/// irrécupérable de la machine, et son test vit `#[ignore]` dans `src/native/mod.rs`. Ce qui se
/// vérifie sans rien détruire, c'est que les deux représentations existent et disent la même chose.
#[test]
fn copying_composes_two_representations_of_the_same_document() {
  let source = document();
  let (html, markdown) = render::clipboard(TITLE, &Rendering::original(&source));

  assert!(html.starts_with("<!DOCTYPE html>"));
  assert!(
    html.contains("<meta charset=\"utf-8\">"),
    "sans le charset, un accent collé dans une application ancienne ressort en mojibake"
  );
  assert!(html.trim_end().ends_with("</html>"));

  // ⚠️ Ici — et à l'inverse du Markdown — les caractères de balisage **sont** échappés : le texte
  // entre dans le document, pas à côté.
  assert!(html.contains("<h1>Session « bilan » &amp; suite &lt;2026&gt;</h1>"));
  assert!(html.contains("<p>Il a dit \"oui\", 1 &lt; 2 &amp; 3</p>"));
  assert!(html.contains("<p>Grüße aus São</p>"));
  assert!(
    !html.contains("<strong>"),
    "le gras ne servait qu'à nommer un locuteur"
  );

  // La seconde représentation est exactement l'export Markdown : ce qu'on colle et ce qu'on
  // enregistre sont le même document.
  let workspace = Workspace::new("presse-papiers");
  let path = workspace.export(ExportFormat::Markdown, &Rendering::original(&source));
  assert_eq!(
    markdown,
    fs::read_to_string(&path).expect("relecture du .md"),
    "le Markdown copié et le Markdown exporté doivent être le même texte"
  );

  assert_ne!(
    html, markdown,
    "deux représentations, pas deux fois la même"
  );
}
