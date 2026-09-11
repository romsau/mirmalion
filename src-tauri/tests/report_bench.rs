//! **Banc de mesure du compte rendu.** Fabrique un compte rendu sur des transcripts réels et
//! rapporte — il n'affirme presque rien.
//! `cargo test --test report_bench -- --ignored --nocapture`
//!
//! ⚠️ **Un banc, pas des assertions** : un modèle génératif n'est pas reproductible, et un test
//! qui exigerait une sortie exacte serait un test qui ment. Ce fichier rend visible ce que les
//! consignes fixes — celles que l'utilisateur ne voit jamais — poussent le modèle à écrire.
//!
//! ⚠️ **Il est ici et pas dans `src/`** pour une raison mécanique : `tests/logging_policy.rs`
//! interdit `println!` dans tout `src/`, et un banc qui rapporte doit écrire sur la console.
//!
//! ⚠️ **Le vocabulaire du cadre déteint sur le modèle** : tant que les consignes parlaient de
//! *meeting*, un podcast à une seule voix se voyait résumé en « la réunion ». Elles disent
//! maintenant *transcript* et *recording*, et le podcast ci-dessous est ce qui le vérifie.

use app_lib::measure::{llm_capabilities, llm_report};

/// Un contenu qui n'est **pas** une réunion : un épisode de podcast, à une seule voix.
///
/// ⚠️ **C'est le cas qui révèle le biais du cadre.** Sur une vraie réunion, « décisions » et
/// « tâches » existent, et un modèle qui les cherche les trouve — on ne peut rien conclure.
/// Ici il n'y en a **aucune** : tout ce que le compte rendu en dira sous ces mots sera inventé.
const PODCAST: &str = "Bienvenue dans ce nouvel épisode. Aujourd'hui je voulais vous parler de \
   la mémoire cache des processeurs, parce que c'est un sujet dont on entend parler partout sans \
   jamais vraiment l'expliquer. Alors, l'idée de départ est très simple : la mémoire vive est \
   lente, beaucoup plus lente que le processeur, et il faut donc ranger tout près de lui les \
   données dont il se sert le plus souvent. C'est ça, une cache. Le premier niveau, qu'on appelle \
   L1, fait quelques dizaines de kilo-octets et répond en trois ou quatre cycles. Le deuxième, \
   L2, fait quelques centaines de kilo-octets pour une douzaine de cycles. Et le troisième, L3, \
   se compte en méga-octets et coûte une quarantaine de cycles. À côté de ça, un accès à la \
   mémoire vive coûte deux à trois cents cycles, ce qui est colossal. Ce qui m'intéresse là-dedans, \
   c'est que toute la performance d'un programme moderne tient souvent moins à son algorithme \
   qu'à la façon dont il range ses données. Un tableau que l'on parcourt dans l'ordre est \
   plusieurs fois plus rapide qu'une liste chaînée qui contient exactement les mêmes valeurs. \
   Même nombre d'opérations, même complexité, et pourtant un rapport de un à dix. Je vous \
   conseille d'ailleurs l'article de Ulrich Drepper sur le sujet, qui date de 2007 mais qui n'a \
   pas pris une ride. Voilà pour aujourd'hui, on se retrouve la semaine prochaine.";

/// Une vraie réunion, à plusieurs voix — le cas nominal, qui doit rester bon.
///
/// ⚠️ **Le contrôle du banc.** Neutraliser le vocabulaire du cadre ne vaut que si ce qui marchait
/// continue de marcher : un compte rendu de réunion doit toujours rendre ses décisions et ses
/// tâches. ⚠️ **Il ne nomme personne**, comme les transcripts que le produit rend : c'est ce qui
/// rend visible un responsable inventé.
const MEETING: &str = "Bon, on démarre. Le premier point c'est l'intégration du paiement. Elle \
   est presque terminée, il reste les tests de bout en bout à écrire, ça devrait être bouclé \
   mercredi. Est-ce qu'on maintient la démo de vendredi du coup ? Oui, on la maintient, on a \
   assez de matière même s'il manque deux écrans. D'accord, alors je préviens le client cet \
   après-midi. Deuxième point, les deux bugs d'affichage sur la liste : le premier est corrigé, \
   le second est plus embêtant parce qu'il ne se reproduit que sur les écrans Retina. Je le \
   prends, je regarde ça demain matin. Il faudra aussi qu'on tranche sur les langues avant la \
   fin du mois — est-ce qu'on garde les neuf ou est-ce qu'on en coupe quatre pour la première \
   version ? On garde les neuf, c'est l'argument de vente, on ne va pas le raboter maintenant. \
   Dernier point, le budget du trimestre est validé, il n'y a rien à faire dessus. Très bien, \
   on se refait un point lundi prochain.";

/// Les mots qu'un compte rendu de podcast **ne devrait pas** avoir à écrire.
///
/// ⚠️ **Rapportés, jamais assertés** : le modèle a parfaitement le droit d'employer « décision »
/// dans une phrase juste. Ce qui se lit, c'est la **différence** entre les deux formulations du
/// cadre — et c'est le lecteur du banc qui tranche.
const MEETING_WORDS: [&str; 8] = [
  "décision",
  "Décision",
  "tâche",
  "Tâche",
  "réunion",
  "Réunion",
  "participant",
  "Participant",
];

fn available() -> bool {
  match llm_capabilities() {
    Ok(raw) => raw.contains("\"available\":true"),
    Err(_) => false,
  }
}

/// Le compte rendu complet d'un transcript court : une passe de notes, une passe de rédaction.
///
/// ⚠️ **Une seule tranche**, parce que ces textes tiennent dans la fenêtre. Le map-reduce est
/// éprouvé ailleurs (`live::report::slices`, pur) ; ce qu'on mesure ici est le **contenu**.
fn compose(transcript: &str, kind: &str) -> Result<String, String> {
  let notes =
    llm_report(transcript, "notes", kind, None, "fr").map_err(|error| error.to_string())?;
  llm_report(&notes, "report", kind, None, "fr").map_err(|error| error.to_string())
}

fn headings(markdown: &str) -> Vec<String> {
  markdown
    .lines()
    .filter_map(|line| line.trim().strip_prefix("##"))
    .map(|title| title.trim_start_matches('#').trim().to_owned())
    .collect()
}

fn count_meeting_words(text: &str) -> usize {
  MEETING_WORDS
    .iter()
    .map(|word| text.matches(word).count())
    .sum()
}

fn show(label: &str, markdown: &str) {
  println!("\n──────── {label} ────────");
  println!("rubriques : {:?}", headings(markdown));
  println!(
    "mots de réunion : {} — {:?}",
    count_meeting_words(markdown),
    MEETING_WORDS
      .iter()
      .filter(|word| markdown.contains(**word))
      .collect::<Vec<_>>()
  );
  println!("{markdown}");
}

/// **Ce que les consignes fixes poussent le modèle à écrire sur un contenu qui n'est pas une
/// réunion.**
#[test]
#[ignore = "appelle le vrai modèle de langue — plusieurs dizaines de secondes ; se lance à la main"]
fn what_the_frame_makes_the_model_write_about_something_that_is_not_a_meeting() {
  if !available() {
    println!("modèle de langue indisponible sur cette machine — banc sauté");
    return;
  }

  for kind in ["summary", "media", "lecture"] {
    match compose(PODCAST, kind) {
      Ok(markdown) => show(&format!("podcast · {kind}"), &markdown),
      Err(error) => println!("\n──────── podcast · {kind} ──────── ÉCHEC : {error}"),
    }
  }
}

/// **Le contrôle : une vraie réunion doit rester bien rendue, et SANS responsable inventé.**
///
/// ⚠️ **C'est ici que se lit le second défaut** : la liste de rubriques de « Point d'équipe »
/// demandait un *owner* par tâche. Le transcript ne nomme personne — tout nom qui apparaît sous
/// « Tâches » a donc été **inventé**.
#[test]
#[ignore = "appelle le vrai modèle de langue — plusieurs dizaines de secondes ; se lance à la main"]
fn what_a_real_meeting_yields_and_whether_a_task_gets_an_owner_nobody_named() {
  if !available() {
    println!("modèle de langue indisponible sur cette machine — banc sauté");
    return;
  }

  for kind in ["team", "summary"] {
    match compose(MEETING, kind) {
      Ok(markdown) => show(&format!("réunion · {kind}"), &markdown),
      Err(error) => println!("\n──────── réunion · {kind} ──────── ÉCHEC : {error}"),
    }
  }
}

/// Le découpage des rubriques, **sans modèle** : il doit marcher sur une sortie vide comme sur
/// un Markdown complet, sinon le banc rapporterait n'importe quoi sans qu'on le sache.
#[test]
fn the_bench_reads_its_own_headings_correctly() {
  assert!(headings("").is_empty());
  assert_eq!(
    headings("## Résumé\nDeux points.\n### Tâches\n- Corriger."),
    vec!["Résumé", "Tâches"]
  );
  assert_eq!(count_meeting_words("Une décision, une tâche."), 2);
}
