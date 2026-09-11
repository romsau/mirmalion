//! Le rappel du pont, et ce qu'il faut décider avant d'afficher un mot.
//!
//! # Pièges
//!
//! - ⚠️ Appelé par Swift depuis un fil quelconque, à chaque segment : il doit rester bref, et
//!   aucune panique ne doit s'en échapper — voir [`crate::native::guarded`].
//! - ⚠️ Le backend retient avant d'émettre. Les mots horodatés et le signal de fin servent à la
//!   consolidation, pas à l'écran : émettre d'abord laisserait une fenêtre où l'écran a le texte
//!   et la consolidation ne l'a pas encore.

use tauri::{AppHandle, Manager};

use super::{LIVE_TRANSCRIPT_EVENT, LiveStream, LiveTranscriptEvent};
use crate::{commands, native};

/// Le rappel appelé **par Swift**, depuis un fil quelconque.
///
/// # Pièges
///
/// - ⚠️ La chaîne n'appartient pas à Rust et ne survit pas à l'appel : on la lit immédiatement et
///   on ne conserve pas le pointeur.
/// - ⚠️ Rien ne remonte d'ici : une charge utile illisible est journalisée et jetée. Le
///   traitement passe par [`native::guarded`] — une panique avortait le processus, et une
///   session de deux heures avec.
pub(super) extern "C" fn on_live_transcript(payload: *const std::ffi::c_char) {
  if payload.is_null() {
    return;
  }
  // SAFETY: le pont garantit une chaîne C valide, terminée par un nul, pour la durée de
  // l'appel. On ne conserve pas le pointeur.
  let raw = unsafe { std::ffi::CStr::from_ptr(payload) };
  let Ok(text) = raw.to_str() else {
    log::warn!("évènement de transcript de session non UTF-8, ignoré");
    return;
  };
  let Ok(event) = serde_json::from_str::<LiveTranscriptEvent>(text) else {
    // ⚠️ Jamais le contenu dans le message : un transcript de session est du contenu
    // utilisateur, et un journal dit ce qui a échoué, jamais sur quoi.
    log::warn!("évènement de transcript de session illisible, ignoré");
    return;
  };
  let Some(app) = commands::app() else {
    log::warn!("évènement de transcript reçu avant le démarrage, ignoré");
    return;
  };
  native::guarded("transcript de session", || dispatch(app, event));
}

/// Le traitement d'un évènement de transcript, une fois la charge utile relue.
///
/// Séparé du rappel pour deux raisons : la lecture du pointeur brut reste hors du garde à
/// paniques, qui n'a rien à y protéger, et ce corps-ci devient éprouvable sans frontière C.
fn dispatch(app: &tauri::AppHandle, event: LiveTranscriptEvent) {
  // ⚠️ Le backend retient avant d'émettre : les mots horodatés et le signal de fin servent à la
  // consolidation, pas à l'écran. Émettre d'abord laisserait une fenêtre où l'écran a le texte
  // et la consolidation ne l'a pas encore.
  let session = app.state::<std::sync::Arc<crate::live::LiveSession>>();
  let outgoing = match event {
    LiveTranscriptEvent::Final {
      stream,
      text,
      words,
      ..
    } => {
      session.record(stream, &words);
      // ⚠️ Le milieu du segment, pas son début : un segment qui chevauche un changement de
      // locuteur commence chez l'un et finit chez l'autre, et le milieu tombe du côté où il a
      // réellement été prononcé le plus longtemps. Même raisonnement que `Word::midpoint_ms`.
      let at = words
        .first()
        .zip(words.last())
        .map(|(first, last)| first.start_ms + last.end_ms.saturating_sub(first.start_ms) / 2);

      // ⚠️ Le système nourrit la comparaison, le micro s'y mesure : deux flux qui portent la même
      // phrase au même moment, c'est un écho — mécaniquement, sans interpréter aucun signal.
      session.drop_hypothesis(stream);
      // ⚠️ Relevé avant toute décision d'écho : l'état des silences doit suivre ce qui a été
      // *dit*, pas ce qui a été *affiché*. Un écho écarté a bien occupé la salle.
      let paragraph = session.opens_paragraph(&words);
      if stream == LiveStream::System {
        if let Some(at) = at {
          session.hear(&text, at);
        }
        let settled = LiveTranscriptEvent::Final {
          stream,
          text,
          paragraph,
          words: Vec::new(),
        };
        // ⚠️ L'hypothèse du micro se reconsidère ici : le micro cesse d'émettre dès qu'il a fini
        // d'entendre, et sa dernière hypothèse reste affichée jusqu'à son propre énoncé acquis.
        // Quand le système finalise entre les deux, on sait qu'elle était de l'écho ; ne la juger
        // qu'à sa naissance laissait le doublon à l'écran jusqu'au bout.
        match session.take_echoed_hypothesis() {
          Some(coverage) => {
            log::debug!("écho écarté du direct (hypothèse reconsidérée) : {coverage:.3}");
            vec![
              settled,
              LiveTranscriptEvent::Dropped {
                stream: LiveStream::Microphone,
              },
            ]
          }
          None => vec![settled],
        }
      } else {
        match weighed(session.weigh(&text, at), "segment") {
          Some(coverage) => {
            // ⚠️ Ce qu'on écarte se journalise, sinon « le micro est muet » et « le micro est
            // écarté » sont indiscernables : deux pannes opposées, et « Moi » reste vide dans
            // les deux cas. Le taux, et rien d'autre — aucun contenu.
            log::debug!("écho écarté du direct : couverture {coverage:.3}");
            // ⚠️ On efface, on ne se tait pas — voir `LiveTranscriptEvent::Dropped` : ne rien
            // émettre laissait l'hypothèse d'écho affichée pour toujours.
            vec![LiveTranscriptEvent::Dropped { stream }]
          }
          None => vec![LiveTranscriptEvent::Final {
            stream,
            text,
            paragraph,
            words: Vec::new(),
          }],
        }
      }
    }
    // ⚠️ Une hypothèse se juge sur son texte, jamais sur un état. Un `partial` n'a pas de mots
    // horodatés : aucun instant à interroger. Lire à la place le dernier tour trouvé dans ce flux
    // fait taire le micro — un dernier tour d'écho reste le dernier tant que la diarisation ne
    // trouve rien de neuf, et l'utilisateur disparaît de son propre transcript.
    //
    // ⚠️ Un texte porte sa preuve en lui : si la phrase que le micro écrit est celle que le
    // système vient d'écrire, c'est un écho, et ce verdict ne se fige pas. Une phrase que le
    // système n'a jamais dite passe toujours.
    LiveTranscriptEvent::Partial { stream, text } => {
      // ⚠️ Le système nourrit la comparaison avant que le micro s'y mesure, hypothèse comprise :
      // c'est ce qui permet de trancher pendant la phrase plutôt qu'après.
      if stream == LiveStream::System {
        session.hear_hypothesis(&text);
        return emit(app, vec![LiveTranscriptEvent::Partial { stream, text }]);
      }
      match weighed(session.weigh(&text, None), "hypothèse") {
        Some(_) => {
          session.drop_hypothesis(stream);
          vec![LiveTranscriptEvent::Dropped { stream }]
        }
        None => {
          // Retenue pour être **reconsidérée** quand le système finalisera : voir
          // `take_echoed_hypothesis`.
          session.hold_hypothesis(&text);
          vec![LiveTranscriptEvent::Partial { stream, text }]
        }
      }
    }
    LiveTranscriptEvent::Finished { stream } => {
      session.settle(stream);
      // ⚠️ Rien ne remonte à l'écran — voir la variante. C'est de la plomberie.
      return;
    }
    // ⚠️ Un flux en échec est terminé, lui aussi : sans cela, la consolidation d'une session dont
    // un moteur a lâché attendrait un signal de fin qui ne viendra jamais, jusqu'au plafond de
    // vingt secondes, à chaque arrêt.
    LiveTranscriptEvent::Failed { stream, text } => {
      // ⚠️ Journalisé ici, et pas seulement remonté à l'écran : le moteur peut lâcher **avant**
      // que la fenêtre-session existe, et `emit` jette alors l'évènement faute de destinataire.
      // C'est le seul diagnostic qu'on ait d'un moteur qui ne démarre pas.
      //
      // ⚠️ Le message vient du moteur, jamais de l'audio : un identifiant de locale, une raison
      // technique. Aucun contenu utilisateur n'y entre.
      log::warn!("un moteur de transcription de session a échoué : {text}");
      session.settle(stream);
      vec![LiveTranscriptEvent::Failed { stream, text }]
    }
    // ⚠️ `Dropped` ne vient jamais du pont : c'est nous qui le fabriquons ci-dessus. Le bras
    // existe pour qu'ajouter une variante demain fasse échouer la compilation plutôt que de
    // passer sans être traitée.
    dropped @ LiveTranscriptEvent::Dropped { .. } => vec![dropped],
  };

  emit(app, outgoing);
}

/// Tranche une couverture, **et journalise la zone grise**. Rend `Some` quand c'est un écho.
///
/// # Pièges
///
/// - ⚠️ Ce qui a failli être écarté vaut ce qui l'a été : `SAME_UTTERANCE` est posé sur un seul
///   exemple, quand `ECHO_DISTANCE` et `SLIVER_MS` le sont entre deux populations. Ne rapporter
///   que les échos écartés ne montrerait qu'un côté du fossé.
/// - ⚠️ Aucun contenu utilisateur, jamais — un taux et la nature du morceau, rien d'autre.
fn weighed(found: Option<f64>, what: &str) -> Option<f64> {
  let coverage = found?;
  if coverage >= crate::live::echo_text::SAME_UTTERANCE {
    log::debug!("écho écarté du direct ({what}) : couverture {coverage:.3}");
    return Some(coverage);
  }
  if coverage >= crate::live::echo_text::WORTH_REPORTING {
    log::debug!("écho NON écarté ({what}) : couverture {coverage:.3}");
  }
  None
}

/// Émet ce qu'un évènement du pont a produit — **un ou deux**.
///
/// # Pièges
///
/// - ⚠️ Deux, quand un énoncé acquis du système révèle que l'hypothèse du micro était de l'écho :
///   il faut alors afficher le premier **et** effacer la seconde, dans cet ordre.
/// - ⚠️ Adressé, parce qu'il porte **le transcript** : diffusé, il traversait l'IPC vers chaque
///   fenêtre-fichier ouverte à côté, qui n'a rien à en connaître.
/// - ⚠️ Sans session en cours, rien n'est émis : un évènement arrivé après l'arrêt n'a plus de
///   fenêtre à qui parler.
fn emit(app: &AppHandle, events: Vec<LiveTranscriptEvent>) {
  let Some(label) = app
    .state::<std::sync::Arc<crate::live::LiveSession>>()
    .window_label()
  else {
    return;
  };
  for event in events {
    crate::commands::announce_to(app, &label, LIVE_TRANSCRIPT_EVENT, &event);
  }
}
