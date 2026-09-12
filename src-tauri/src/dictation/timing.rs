//! Le chronomètre d'une dictée — **pur, sans horloge, sans I/O**.
//!
//! Le départ est le **relâchement** du raccourci, pas la dernière syllabe : l'application ne sait
//! pas quand l'utilisateur a fini de parler, et le relâchement est la borne qu'il *ressent*.
//! L'arrivée est le **retour de l'insertion**, quand le ⌘V est posté et le presse-papiers rendu.
//! Chaque étape est chronométrée séparément, et ce qui n'appartient à aucune — verrous, envois
//! d'overlay, tâches lancées — apparaît en clair sous le nom `reste`.
//!
//! # Pièges
//!
//! - ⚠️ Le rapport ne mesure pas l'apparition du texte à l'écran : ce que l'application d'accueil
//!   fait de l'évènement est hors de portée, et prétendre le contraire mentirait.
//! - ⚠️ Ce type ne connaît pas l'heure — il reçoit des durées déjà mesurées. Un chronomètre qui
//!   appellerait `Instant::now()` ne se testerait qu'en dormant, donc jamais exactement, et un
//!   instrument dont on ne peut pas prouver la justesse ne prouve rien de ce qu'il mesure.

use std::fmt::Write as _;

use super::Plan;

/// Le préfixe de la ligne de rapport.
///
/// # Pièges
///
/// - ⚠️ Contrat avec `scripts/latency-report.mjs` : le script ne lit que les lignes qui commencent
///   par là, et les deux doivent rester d'accord.
pub const REPORT_PREFIX: &str = "latence dictée";

/// Un tronçon du parcours.
///
/// # Pièges
///
/// - ⚠️ `Engine` couvre du relâchement au texte final, fermeture de la session et arrêt du micro
///   compris. On ne les sépare pas : le moteur ne dit pas où il en est, et trois tronçons dont
///   deux seraient devinés vaudraient moins qu'un seul qui est mesuré.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leg {
  /// Du relâchement au texte final rendu par le moteur.
  Engine,
  /// L'application du dictionnaire personnel.
  Dictionary,
  /// Le nettoyage par le modèle local.
  Cleaning,
  /// La reformulation.
  Rephrasing,
  /// La traduction.
  Translation,
  /// Le collage au curseur.
  Insertion,
}

impl Leg {
  /// Le nom du tronçon dans la ligne de rapport.
  fn key(self) -> &'static str {
    match self {
      Self::Engine => "moteur",
      Self::Dictionary => "dictionnaire",
      Self::Cleaning => "nettoyage",
      Self::Rephrasing => "reformulation",
      Self::Translation => "traduction",
      Self::Insertion => "collage",
    }
  }
}

/// Les tronçons d'une dictée, dans l'ordre où ils ont été parcourus.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Timeline {
  /// Les tronçons mesurés, avec leur durée en millisecondes.
  legs: Vec<(Leg, u128)>,
}

impl Timeline {
  /// Note la durée d'un tronçon.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Une étape qui n'a pas eu lieu n'est pas notée à zéro, elle est absente : zéro voudrait
  ///   dire « instantanée », et toutes les dictées sans reformulation tireraient sa moyenne vers
  ///   le bas.
  pub fn record(&mut self, leg: Leg, millis: u128) {
    self.legs.push((leg, millis));
  }

  /// La somme des tronçons mesurés.
  pub fn measured(&self) -> u128 {
    self.legs.iter().map(|(_, millis)| millis).sum()
  }

  /// La ligne de rapport, à journaliser telle quelle.
  ///
  /// `total` est mesuré de bout en bout par l'appelant ; `reste` est ce qui en subsiste une fois
  /// les tronçons retirés.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Aucun contenu utilisateur, et c'est vérifiable à l'œil : des durées, un code de langue,
  ///   un nom de style, un code de langue cible. Rien de ce qui a été dicté.
  /// - ⚠️ `reste` peut être négatif en théorie, deux mesures ne s'emboîtant pas exactement. On le
  ///   borne à zéro plutôt que d'afficher un nombre qui ferait douter de tout le reste.
  pub fn report(&self, total: u128, plan: &Plan) -> String {
    let mut line = format!("{REPORT_PREFIX} | total={total}");
    for (leg, millis) in &self.legs {
      let _ = write!(line, " {}={millis}", leg.key());
    }
    let _ = write!(line, " reste={}", total.saturating_sub(self.measured()));
    let _ = write!(
      line,
      " | langue={} style={} cible={}",
      blank_as_dash(&plan.language),
      plan.rephrasing.map_or("aucun", |style| style.as_str()),
      plan
        .translation_target
        .as_deref()
        .map_or("aucune", blank_as_dash),
    );
    line
  }
}

/// La valeur, ou un tiret si elle est vide.
///
/// # Pièges
///
/// - ⚠️ Un champ vide casserait le découpage `clé=valeur` du script. Le cas ne devrait pas
///   arriver, mais un rapport illisible se remarque, alors qu'un rapport tronqué se croit.
fn blank_as_dash(value: &str) -> &str {
  if value.is_empty() { "-" } else { value }
}

#[cfg(test)]
mod tests {
  use super::{Leg, REPORT_PREFIX, Timeline};
  use crate::{dictation::Plan, llm::RephrasingStyle};

  fn plan() -> Plan {
    Plan {
      language: "fr".to_owned(),
      cleanup: true,
      rephrasing: None,
      translation_target: None,
    }
  }

  #[test]
  fn a_bare_dictation_reports_its_two_legs_and_nothing_else() {
    let mut timeline = Timeline::default();
    timeline.record(Leg::Engine, 900);
    timeline.record(Leg::Cleaning, 400);
    timeline.record(Leg::Insertion, 150);

    assert_eq!(
      timeline.report(1500, &plan()),
      format!(
        "{REPORT_PREFIX} | total=1500 moteur=900 nettoyage=400 collage=150 reste=50 \
         | langue=fr style=aucun cible=aucune"
      )
    );
  }

  /// ⚠️ C'est l'invariant qui rend le rapport lisible : une étape absente ne pèse pas zéro
  /// dans les statistiques, elle n'y entre pas du tout.
  #[test]
  fn a_stage_that_did_not_run_is_absent_and_never_zero() {
    let mut timeline = Timeline::default();
    timeline.record(Leg::Engine, 800);

    let line = timeline.report(800, &plan());
    assert!(!line.contains("reformulation="), "{line}");
    assert!(!line.contains("traduction="), "{line}");
  }

  #[test]
  fn every_leg_has_its_own_key_in_the_line() {
    let mut timeline = Timeline::default();
    for leg in [
      Leg::Engine,
      Leg::Dictionary,
      Leg::Cleaning,
      Leg::Rephrasing,
      Leg::Translation,
      Leg::Insertion,
    ] {
      timeline.record(leg, 10);
    }

    let line = timeline.report(60, &plan());
    for key in [
      "moteur=10",
      "dictionnaire=10",
      "nettoyage=10",
      "reformulation=10",
      "traduction=10",
      "collage=10",
    ] {
      assert!(line.contains(key), "{key} absent de {line}");
    }
  }

  #[test]
  fn the_configuration_is_named_so_the_runs_can_be_told_apart() {
    let mut timeline = Timeline::default();
    timeline.record(Leg::Engine, 100);

    let line = timeline.report(
      100,
      &Plan {
        language: "en".to_owned(),
        cleanup: true,
        rephrasing: Some(RephrasingStyle::Concise),
        translation_target: Some("it".to_owned()),
      },
    );
    assert!(
      line.ends_with("| langue=en style=concise cible=it"),
      "{line}"
    );
  }

  /// Deux mesures prises à des instants différents ne s'emboîtent pas exactement : le total
  /// peut se retrouver sous la somme des tronçons. Un `reste` négatif ferait douter de tout.
  #[test]
  fn a_total_below_the_sum_of_the_legs_yields_zero_and_never_a_negative_remainder() {
    let mut timeline = Timeline::default();
    timeline.record(Leg::Engine, 900);

    assert!(timeline.report(880, &plan()).contains(" reste=0 "));
  }

  #[test]
  fn an_empty_language_stays_a_single_token() {
    let mut timeline = Timeline::default();
    timeline.record(Leg::Engine, 100);

    let line = timeline.report(
      100,
      &Plan {
        language: String::new(),
        cleanup: true,
        rephrasing: None,
        translation_target: Some(String::new()),
      },
    );
    assert!(line.ends_with("| langue=- style=aucun cible=-"), "{line}");
  }

  /// ⚠️ **Le contrat avec `scripts/latency-report.mjs`, et c'est lui le vrai risque.** Le
  /// script découpe la ligne en jetons `clé=valeur` séparés par des espaces : une valeur qui
  /// contiendrait une espace décalerait toutes les suivantes, et le rapport serait **faux sans
  /// être vide** — le pire des deux mondes, puisqu'on le croirait.
  ///
  /// *(Que la ligne ne porte aucun contenu dicté, en revanche, ne se teste pas : `report` ne
  /// reçoit qu'un total et un [`Plan`], et un `Plan` n'a pas de champ de texte. C'est la
  /// signature qui le garantit, et une signature vaut mieux qu'une assertion.)*
  #[test]
  fn every_token_of_the_line_stays_parseable() {
    let mut timeline = Timeline::default();
    timeline.record(Leg::Engine, 900);
    timeline.record(Leg::Rephrasing, 700);

    let line = timeline.report(
      1600,
      &Plan {
        language: "it".to_owned(),
        cleanup: true,
        rephrasing: Some(RephrasingStyle::Custom),
        translation_target: Some("fr".to_owned()),
      },
    );
    let tokens: Vec<&str> = line
      .trim_start_matches(REPORT_PREFIX)
      .split_whitespace()
      .collect();
    for token in tokens {
      assert!(
        token == "|" || token.split('=').count() == 2,
        "{token} n'est ni un séparateur ni un couple clé=valeur, dans {line}"
      );
    }
  }
}
