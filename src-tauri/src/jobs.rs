//! Les travaux longs qu'on peut arrêter : un drapeau par document, et rien d'autre.
//!
//! Une traduction de transcript, une génération de compte rendu — deux travaux de plusieurs
//! dizaines de secondes, lancés depuis une fenêtre-document, que l'utilisateur doit pouvoir
//! interrompre. Ce module ne sait pas ce qu'il arrête : il tient des drapeaux, et c'est la
//! boucle du travail qui les lit, à son cran de progression, et qui décide ce que « s'arrêter »
//! veut dire pour elle.
//!
//! # Pièges
//!
//! - ⚠️ Un drapeau par document, pas un pour tout le backend : un drapeau unique ferait
//!   qu'annuler dans une fenêtre arrêterait le travail de la voisine, sans que rien ne l'explique.
//! - ⚠️ Chaque domaine l'enveloppe dans un type à lui (`TranslationJobs`, `ReportJobs`) :
//!   `.manage()` de Tauri range par **type**, et deux tables du même type se marcheraient dessus.

use std::{
  collections::HashMap,
  sync::{
    Arc, Mutex, MutexGuard, PoisonError,
    atomic::{AtomicBool, Ordering},
  },
};

/// Les travaux en cours, et le drapeau qui arrête chacun.
#[derive(Default)]
pub struct Jobs {
  flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Jobs {
  /// La table des drapeaux, **même après un empoisonnement du verrou**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Annuler ne doit jamais échouer ni paniquer. Un verrou empoisonné veut dire qu'un fil a
  ///   paniqué en le tenant ; la table, elle, ne contient que des drapeaux et reste cohérente.
  ///   Refuser l'arrêt pour cela laisserait tourner le moteur sans recours.
  fn flags(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
    self.flags.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// Ouvre le travail de `id` : rend son drapeau **neuf**, et arrête celui qu'il remplace.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le drapeau est neuf à chaque départ, jamais remis à `false` : rien ne peut rester levé
  ///   d'un travail précédent. C'est le défaut classique de ce motif — le second départ s'annule
  ///   tout seul, et personne ne comprend pourquoi.
  pub fn begin(&self, id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(previous) = self.flags().insert(id.to_owned(), Arc::clone(&flag)) {
      previous.store(true, Ordering::SeqCst);
    }
    flag
  }

  /// Referme le travail de `id`, **s'il est toujours le sien**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La comparaison porte sur le drapeau, pas sur l'identifiant : un travail qui se termine
  ///   après avoir été remplacé effacerait sinon l'entrée du travail suivant, qui deviendrait
  ///   inannulable.
  pub fn end(&self, id: &str, flag: &Arc<AtomicBool>) {
    let mut flags = self.flags();
    if flags
      .get(id)
      .is_some_and(|current| Arc::ptr_eq(current, flag))
    {
      flags.remove(id);
    }
  }

  /// Demande l'arrêt du travail de `id`. **Sans effet s'il n'y en a pas.**
  pub fn cancel(&self, id: &str) {
    if let Some(flag) = self.flags().get(id) {
      flag.store(true, Ordering::SeqCst);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::Jobs;
  use std::sync::atomic::Ordering;

  /// ⚠️ **Le drapeau est neuf à chaque départ.** Sans cela, le travail suivant s'annulerait
  /// tout seul — le défaut classique de ce motif.
  #[test]
  fn each_job_starts_with_a_flag_of_its_own() {
    let jobs = Jobs::default();

    let first = jobs.begin("filedoc-0");
    assert!(!first.load(Ordering::SeqCst));
    jobs.cancel("filedoc-0");
    assert!(first.load(Ordering::SeqCst));

    let second = jobs.begin("filedoc-0");
    assert!(
      !second.load(Ordering::SeqCst),
      "l’annulation d’hier ne doit pas arrêter le travail d’aujourd’hui"
    );
  }

  /// ⚠️ **Un second départ arrête le premier**, sinon deux boucles se partageraient le moteur
  /// pour remplir la même barre.
  #[test]
  fn beginning_again_stops_the_job_it_replaces() {
    let jobs = Jobs::default();
    let first = jobs.begin("filedoc-0");

    let second = jobs.begin("filedoc-0");

    assert!(first.load(Ordering::SeqCst));
    assert!(!second.load(Ordering::SeqCst));
  }

  /// ⚠️ **Un drapeau par document.** Deux fenêtres-documents travaillent en parallèle : annuler
  /// dans l'une ne doit rien arrêter dans l'autre.
  #[test]
  fn cancelling_one_document_leaves_the_other_alone() {
    let jobs = Jobs::default();
    let mine = jobs.begin("filedoc-0");
    let yours = jobs.begin("filedoc-1");

    jobs.cancel("filedoc-0");

    assert!(mine.load(Ordering::SeqCst));
    assert!(!yours.load(Ordering::SeqCst));
  }

  /// Annuler ce qui n'existe pas — un clic juste après la fin — ne casse rien et ne dit rien.
  #[test]
  fn cancelling_a_job_that_is_over_is_not_an_error() {
    let jobs = Jobs::default();
    let flag = jobs.begin("filedoc-0");
    jobs.end("filedoc-0", &flag);

    jobs.cancel("filedoc-0");
    jobs.cancel("jamais-ouvert");

    assert!(!flag.load(Ordering::SeqCst));
  }

  /// ⚠️ **Un travail qui se termine après avoir été remplacé n'efface pas l'entrée du suivant** —
  /// sinon le second deviendrait inannulable, et son « Annuler » serait un bouton mort.
  #[test]
  fn a_job_that_ends_late_does_not_close_the_one_that_replaced_it() {
    let jobs = Jobs::default();
    let first = jobs.begin("filedoc-0");
    let second = jobs.begin("filedoc-0");

    jobs.end("filedoc-0", &first);
    jobs.cancel("filedoc-0");

    assert!(second.load(Ordering::SeqCst));
  }
}
