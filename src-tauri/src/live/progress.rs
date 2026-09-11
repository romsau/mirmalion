//! Ce que le voile compte : les étapes réelles d'une finalisation et d'une génération.
//!
//! # Pièges
//!
//! - ⚠️ Aucune durée ne traverse ce module. Les étapes n'ont pas la même durée — une analyse de
//!   voix et une suppression de fichier n'ont rien de comparable —, donc « il reste 40 % » ne se
//!   convertit en aucune seconde, et un temps annoncé faux est cru.
//! - ⚠️ Rust nomme l'étape, Angular la traduit : ce qui voyage est un identifiant d'étape —
//!   `settling`, `voices`… — que `stepLabel` (`core/services/live`) rend dans la langue de
//!   l'écran. Un libellé français sortirait tel quel sur les huit autres langues.
//! - ⚠️ Sans micro, il n'y a ni analyse de voix ni écho à écarter — voir
//!   [`crate::live::finalise`]. Compter cinq étapes pour en franchir trois laisserait la barre
//!   bloquée à 60 % avant de disparaître, ce qui se lit comme un travail abandonné.

use serde::Serialize;

/// Une étape franchie, telle que l'écran la nomme.
///
/// Le nom sérialisé est le seul nom : pas d'`as_str` à côté, contrairement à
/// [`crate::live::report::ReportKind`] qui, lui, doit nommer un prompt côté Swift.
///
/// # Pièges
///
/// - ⚠️ Ces identifiants voyagent dans un évènement et sont lus par un `switch` d'Angular : en
///   renommer un sans toucher `stepLabel` ferait retomber le voile sur son libellé générique,
///   sans erreur nulle part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveStep {
  /// On attend que les deux moteurs rendent leurs derniers segments.
  Settling,
  /// On rapproche les voix des deux fichiers — la mesure dont vit le filtre d'écho.
  ///
  /// Une seule étape pour les deux : le pont n'expose qu'un appel (`mirmalion_voice_match`), qui
  /// diarise les deux fichiers d'un coup.
  Voices,
  /// On écarte du micro ce que les haut-parleurs ont rejoué.
  Echo,
  /// On entrelace les deux flux en un transcript.
  Weaving,
  /// On supprime l'audio de la session. **Toujours, même après un échec.**
  Erasing,
  /// Une passe de notes sur une tranche du transcript — le *map*.
  Notes,
  /// La rédaction du compte rendu à partir des notes — le *reduce*.
  Writing,
}

/// Les étapes d'une finalisation avec micro.
const WITH_MICROPHONE: &[LiveStep] = &[
  LiveStep::Settling,
  LiveStep::Voices,
  LiveStep::Echo,
  LiveStep::Weaving,
  LiveStep::Erasing,
];

/// Les étapes d'une finalisation sans micro : rien à comparer, donc rien à écarter.
const WITHOUT_MICROPHONE: &[LiveStep] = &[LiveStep::Settling, LiveStep::Weaving, LiveStep::Erasing];

/// Le plan d'une finalisation, selon qu'un micro était capté ou non.
pub fn finalisation(with_microphone: bool) -> &'static [LiveStep] {
  if with_microphone {
    WITH_MICROPHONE
  } else {
    WITHOUT_MICROPHONE
  }
}

/// Le compteur d'étapes d'un travail dont le plan est connu d'avance.
///
/// Le total est fixé à la construction et le plan se franchit dans l'ordre : la barre ne peut pas
/// décroître, et il n'y a rien à borner puisqu'il n'y a rien à ré-estimer.
///
/// # Pièges
///
/// - ⚠️ On annonce ce qui commence : `done` vaut le rang de l'étape, pas son rang + 1. Compter
///   l'étape en cours comme faite montrerait 100 % pendant tout le dernier travail.
pub struct Steps<'a> {
  plan: &'a [LiveStep],
  report: Box<dyn Fn(LiveStep, usize, usize) + Send + 'a>,
}

impl<'a> Steps<'a> {
  /// Un compteur sur `plan`, qui remet chaque étape franchie à `report`.
  pub fn new(plan: &'a [LiveStep], report: impl Fn(LiveStep, usize, usize) + Send + 'a) -> Self {
    Self {
      plan,
      report: Box::new(report),
    }
  }

  /// Annonce l'entrée dans `step`.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sans effet si le plan ne contient pas l'étape : c'est ce qui rend le chemin sans micro
  ///   silencieux sur les voix et sur l'écho sans qu'aucun appelant ait à savoir lequel des deux
  ///   plans il exécute.
  pub fn enter(&self, step: LiveStep) {
    if let Some(index) = self.plan.iter().position(|planned| *planned == step) {
      (self.report)(step, index, self.plan.len());
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{LiveStep, Steps, finalisation};
  use std::sync::Mutex;

  /// Ce qu'un voile aurait affiché, dans l'ordre.
  fn recording() -> Mutex<Vec<(LiveStep, usize, usize)>> {
    Mutex::new(Vec::new())
  }

  /// ⚠️ La barre ne recule jamais, et c'est ce test qui le dit : une barre qui saute en arrière
  /// donne à voir un travail qui se défait.
  #[test]
  fn a_finalisation_with_a_microphone_crosses_its_five_steps_in_order() {
    let seen = recording();
    let steps = Steps::new(finalisation(true), |step, done, total| {
      seen.lock().expect("verrou").push((step, done, total));
    });

    for step in [
      LiveStep::Settling,
      LiveStep::Voices,
      LiveStep::Echo,
      LiveStep::Weaving,
      LiveStep::Erasing,
    ] {
      steps.enter(step);
    }

    let seen = seen.lock().expect("verrou").clone();
    assert_eq!(
      seen.iter().map(|(_, done, _)| *done).collect::<Vec<_>>(),
      vec![0, 1, 2, 3, 4],
      "le compte des étapes faites ne doit que croître"
    );
    assert!(seen.iter().all(|(_, _, total)| *total == 5));
  }

  /// ⚠️ Sans micro, trois étapes et non cinq : il n'y a ni voix à rapprocher ni écho à écarter.
  /// Annoncer cinq étapes laisserait la barre à 60 % au moment de disparaître, ce qui se lit
  /// comme un travail abandonné.
  #[test]
  fn a_finalisation_without_a_microphone_never_announces_the_steps_it_will_not_run() {
    let seen = recording();
    let steps = Steps::new(finalisation(false), |step, done, total| {
      seen.lock().expect("verrou").push((step, done, total));
    });

    // Le même code appelant, sur les deux plans : c'est tout l'intérêt de `enter`.
    for step in [
      LiveStep::Settling,
      LiveStep::Voices,
      LiveStep::Echo,
      LiveStep::Weaving,
      LiveStep::Erasing,
    ] {
      steps.enter(step);
    }

    let seen = seen.lock().expect("verrou").clone();
    assert_eq!(
      seen
        .iter()
        .map(|(step, done, _)| (*step, *done))
        .collect::<Vec<_>>(),
      vec![
        (LiveStep::Settling, 0),
        (LiveStep::Weaving, 1),
        (LiveStep::Erasing, 2)
      ]
    );
    assert!(seen.iter().all(|(_, _, total)| *total == 3));
  }

  /// ⚠️ **Le dernier évènement n'est jamais « tout est fait »** : le voile disparaît, il ne se
  /// remplit pas. Annoncer 3/3 laisserait une barre pleine à l'écran une fraction de seconde.
  #[test]
  fn no_step_is_ever_announced_as_already_done() {
    let seen = recording();
    let steps = Steps::new(finalisation(false), |step, done, total| {
      seen.lock().expect("verrou").push((step, done, total));
    });
    steps.enter(LiveStep::Erasing);

    assert_eq!(
      *seen.lock().expect("verrou"),
      vec![(LiveStep::Erasing, 2, 3)]
    );
  }

  /// Les identifiants voyagent dans un évènement et sont lus par un `switch` d'Angular : un nom
  /// inattendu ferait retomber le voile sur son libellé générique, **sans erreur nulle part**.
  #[test]
  fn every_step_has_its_own_stable_name() {
    let names: Vec<String> = [
      LiveStep::Settling,
      LiveStep::Voices,
      LiveStep::Echo,
      LiveStep::Weaving,
      LiveStep::Erasing,
      LiveStep::Notes,
      LiveStep::Writing,
    ]
    .iter()
    .map(|step| {
      serde_json::to_value(step)
        .expect("sérialisation")
        .as_str()
        .expect("une chaîne")
        .to_owned()
    })
    .collect();

    assert_eq!(
      names,
      vec![
        "settling", "voices", "echo", "weaving", "erasing", "notes", "writing"
      ],
      "ces noms sont ceux qu'Angular lit dans `stepLabel`"
    );
  }
}
