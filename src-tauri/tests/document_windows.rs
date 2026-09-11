//! **Une fenêtre-document se ferme par `destroy()`, jamais par `close()`.**
//!
//! ⚠️ Le même défaut a été livré deux fois, à deux endroits éloignés du code. `close()`
//! **demande** la fermeture — il émet `CloseRequested` —, et les deux fenêtres-documents
//! interceptent justement cet évènement pour poser leur question avant de fermer. La commande
//! de fermeture, appelée **après** que la question a été tranchée, rentre donc dans une boucle
//! avec l'écran qui l'a appelée. Le symptôme est muet : la pastille rouge ne fait **rien**.
//!
//! Un commentaire dans chacun des deux fichiers n'a pas suffi : ce test le rend exécutable.
//!
//! ⚠️ **Il ne juge que les commandes de fermeture de fenêtre-document.** `close()` reste le
//! geste juste ailleurs — la fenêtre d'onboarding, par exemple, que personne n'intercepte.

use std::{fs, path::Path};

/// Les modules qui portent une commande de fermeture de fenêtre-document.
const DOCUMENT_COMMANDS: [&str; 2] = ["src/commands/filedoc.rs", "src/commands/live/document.rs"];

#[test]
fn no_document_window_is_closed_by_asking_politely() {
  // Assemblé à l'exécution : écrit en toutes lettres, le motif ferait échouer le test sur
  // lui-même — c'est la règle qu'observe déjà `logging_policy.rs`.
  let forbidden = format!("window.{}()", "close");

  let offenders: Vec<String> = DOCUMENT_COMMANDS
    .iter()
    .filter(|relative| {
      let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
      let source = fs::read_to_string(&path).expect("lecture du module de commandes");
      source.contains(&forbidden)
    })
    .map(|relative| (*relative).to_owned())
    .collect();

  assert!(
    offenders.is_empty(),
    "une fenêtre-document se ferme par `destroy()` — `{forbidden}` rouvre la question que \
     l'utilisateur vient de trancher, et la fenêtre ne se ferme jamais :\n{}",
    offenders.join("\n")
  );
}
