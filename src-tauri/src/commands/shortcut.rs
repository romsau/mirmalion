//! Les raccourcis globaux ⌃⌥ et ⌃⌥⌘ : brancher le tap, faire tourner la machine, prévenir
//! l'interface.
//!
//! Le partage des rôles, et il n'est pas négociable :
//!
//! - **Swift** possède le tap clavier et ne sait dire qu'une chose — laquelle des deux
//!   combinaisons est formée, ou aucune (`native/Sources/MirmalionNative/Shortcut.swift`).
//! - **[`crate::shortcut`]** décide ce que cela veut dire, sans rien connaître de macOS.
//! - **Ici** on relie les deux et on émet, et c'est tout ce qu'on fait.
//!
//! # Pièges
//!
//! - ⚠️ Le raccourci arrive par évènement, jamais par sondage : un sondage manquerait un appui
//!   bref, et le mode « maintenir pour parler » se joue à la dizaine de millisecondes.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

use crate::{
  commands,
  error::AppError,
  native,
  shortcut::{Combo, ShortcutAction, ShortcutMachine, ShortcutMode},
};

/// Le nom de l'évènement Tauri qui porte les actions de raccourci au frontend.
///
/// # Pièges
///
/// - ⚠️ Un seul canal, et une **action** plutôt qu'un front : deux canaux « pressé » et
///   « relâché » n'offriraient aucune garantie d'ordre, et « relâché » serait faux en mode
///   bascule, où l'arrêt naît d'un appui. Voir [`ShortcutAction`].
/// - ⚠️ Cette chaîne est du contrat : le frontend s'y abonne par sa valeur.
pub const SHORTCUT_EVENT: &str = "shortcut";

/// La machine à états, partagée entre les commandes et le rappel du pont.
///
/// # Pièges
///
/// - ⚠️ Verrou synchrone, jamais tenu à travers un `.await` : la machine ne fait que quelques
///   comparaisons, et l'émission de l'évènement se fait verrou relâché.
pub struct ShortcutState(pub Mutex<ShortcutMachine>);

/// Ce que l'interface doit savoir du raccourci.
///
/// # Pièges
///
/// - ⚠️ [`ShortcutStatus::listening`] et [`ShortcutStatus::trusted`] ne disent pas la même
///   chose, et il faut les deux. Ils divergent dans le cas qui compte : autorisation accordée
///   après le démarrage, tap jamais réinstallé — l'utilisateur a coché la case et rien ne se
///   passe.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
  /// Le tap est en place et reçoit les évènements clavier.
  pub listening: bool,
  /// L'autorisation Accessibilité est accordée.
  pub trusted: bool,
  /// La combinaison enfoncée **à l'instant de la lecture**, `None` s'il n'y en a aucune.
  pub combo: Option<Combo>,
  /// Le mode de déclenchement en vigueur.
  pub mode: ShortcutMode,
  /// Le raccourci répond-il ? Coupé pendant une session.
  pub enabled: bool,
  /// Une dictée est-elle en cours **du point de vue du raccourci** ?
  ///
  /// ⚠️ Ce n'est pas l'état du pipeline de dictée mais ce que le raccourci croit avoir
  /// déclenché. Les deux doivent coïncider ; les afficher séparément permet de constater une
  /// divergence plutôt que de la supposer.
  pub recording: bool,
  /// De quoi expliquer un `listening` faux. `None` quand tout va bien.
  pub detail: Option<String>,
}

/// Ce que le pont rend dans `mirmalion_shortcut_status`.
#[derive(serde::Deserialize)]
struct NativeStatus {
  /// Le tap clavier est en place.
  listening: bool,
  /// L'autorisation Accessibilité est accordée.
  trusted: bool,
  /// Le code de la combinaison enfoncée à l'instant de la lecture, `0` s'il n'y en a aucune.
  combo: i32,
}

/// Le rappel appelé **par Swift**, depuis le fil du tap, à chaque front de la combinaison.
///
/// # Pièges
///
/// - ⚠️ Il doit rester bref : ce fil distribue les évènements clavier de toute la session.
///   Faire tourner la machine et émettre un évènement est tout ce qu'il peut se permettre.
/// - ⚠️ Aucune panique ne doit s'en échapper : elle avorterait le processus. D'où
///   [`native::guarded`], et le verrou empoisonné repris plutôt que déballé.
extern "C" fn on_shortcut_edge(code: i32) {
  let Some(app) = commands::app() else {
    log::warn!("front de raccourci reçu avant le démarrage, ignoré");
    return;
  };

  native::guarded("front de raccourci", || {
    let state = app.state::<ShortcutState>();
    let action = {
      let mut machine = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      machine.update(Combo::from_code(code))
    };

    emit(app, action);
  });
}

/// Ce que l'action dit au frontend, ou `None` quand elle ne le regarde pas.
///
/// # Pièges
///
/// - ⚠️ Ces deux chaînes sont **du contrat** : le frontend s'abonne par leur valeur, et
///   `recording-sound.ts` s'en sert pour choisir le son. Une action muette ici est une action
///   qui ne sonne pas — c'est voulu pour les deux autres.
/// - ⚠️ La combinaison **ne voyage pas** sur ce bus : l'évènement dit « une dictée commence /
///   se termine », rien de plus. Ajouter la langue d'écriture ici donnerait au webview un
///   pouvoir qu'il n'a pas besoin d'avoir, et deux sons là où il n'en faut qu'un.
fn announced(action: ShortcutAction) -> Option<&'static str> {
  match action {
    ShortcutAction::Start(_) => Some("start"),
    ShortcutAction::Stop => Some("stop"),
    // ⚠️ `Suppressed` ne part pas sur ce bus : le frontend y joue le bip de départ, et diffuser
    // un geste refusé ferait sonner une dictée qui n'a pas lieu, au milieu d'une session.
    // L'avertissement a son propre chemin : le pipeline le transforme en état de pilule.
    // `Retarget` non plus : rien ne commence ni ne finit, il n'y a rien à annoncer.
    ShortcutAction::Suppressed | ShortcutAction::Retarget(_) => None,
  }
}

/// Émet l'action, si action il y a, et déclenche le pipeline. Toujours verrou relâché.
fn emit(app: &tauri::AppHandle, action: Option<ShortcutAction>) {
  let Some(action) = action else { return };
  // La seule trace d'un raccourci qui marche. `log` est en `release_max_level_warn` : cette
  // ligne n'existe plus dans le binaire livré, et elle ne porte qu'un verbe.
  log::debug!("raccourci global : {action:?}");

  if let Some(announced) = announced(action) {
    commands::announce(app, SHORTCUT_EVENT, announced);
  }

  // ⚠️ Le pipeline est appelé ici et non par l'évènement ci-dessus : l'évènement est pour
  // l'interface, qui peut être fermée, alors que la dictée doit partir dans tous les cas.
  commands::dictation::on_shortcut(app, action);
}

/// Monte la machine, branche le rappel et tente de mettre le tap à l'écoute.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse d'enregistrer l'observateur.
///
/// # Pièges
///
/// - ⚠️ Un tap qui ne démarre pas n'empêche pas l'application de démarrer : sans
///   l'Accessibilité, l'utilisateur perd le raccourci, pas la dictée. On journalise et on
///   continue.
pub fn setup(app: &tauri::AppHandle, mode: ShortcutMode) -> Result<(), AppError> {
  commands::remember_app(app);
  app.manage(ShortcutState(Mutex::new(ShortcutMachine::new(mode))));
  native::shortcut_set_observer(Some(on_shortcut_edge))?;

  if let Err(error) = native::shortcut_start() {
    log::warn!("raccourci global inactif au démarrage : {error}");
  }
  Ok(())
}

/// L'état du raccourci, sans rien installer ni demander d'autorisation.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou si sa réponse est illisible.
#[tauri::command]
pub async fn get_shortcut_status(
  state: State<'_, ShortcutState>,
) -> Result<ShortcutStatus, AppError> {
  let native = read_native_status()?;
  let machine = state
    .0
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());

  Ok(ShortcutStatus {
    listening: native.listening,
    trusted: native.trusted,
    combo: Combo::from_code(native.combo),
    mode: machine.mode(),
    enabled: machine.enabled(),
    recording: machine.recording(),
    detail: detail_for(&native),
  })
}

/// (Re)met le tap à l'écoute. Idempotent.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse d'installer le tap.
///
/// # Pièges
///
/// - ⚠️ À appeler quand l'Accessibilité vient d'être accordée : elle se coche hors de
///   l'application, et sans cet appel la case cochée ne changerait rien avant le prochain
///   lancement.
#[tauri::command]
pub async fn start_shortcut(state: State<'_, ShortcutState>) -> Result<(), AppError> {
  native::shortcut_start()?;
  // Le tap repart d'un état neuf : la machine aussi, sans quoi elle resterait sur une
  // certitude d'avant la coupure.
  reset(&state);
  Ok(())
}

/// Retire le tap et referme ce qui était ouvert. Idempotent.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse de retirer le tap.
#[tauri::command]
pub async fn stop_shortcut(
  app: tauri::AppHandle,
  state: State<'_, ShortcutState>,
) -> Result<(), AppError> {
  native::shortcut_stop()?;
  emit(&app, reset(&state));
  Ok(())
}

/// Applique le mode de déclenchement, **à chaud**.
///
/// Le frontend la rappelle à chaque changement ; une dictée en cours s'arrête, voir
/// [`ShortcutMachine::set_mode`].
///
/// # Errors
///
/// Ne rend jamais d'erreur : le `Result` suit le contrat commun des commandes IPC.
#[tauri::command]
pub async fn set_shortcut_mode(
  app: tauri::AppHandle,
  state: State<'_, ShortcutState>,
  mode: ShortcutMode,
) -> Result<(), AppError> {
  let action = {
    let mut machine = state
      .0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    machine.set_mode(mode)
  };
  emit(&app, action);
  Ok(())
}

/// Coupe ou rétablit le raccourci — **le point de coupure de la session**.
///
/// # Pièges
///
/// - ⚠️ Ne doit pas devenir une commande IPC : elle est appelée depuis le backend, là où
///   l'enregistrement de session démarre et s'arrête. Exposer la bascule au WebView lui
///   donnerait le pouvoir de se rendre le raccourci pendant une session.
pub fn set_enabled(app: &tauri::AppHandle, enabled: bool) {
  let action = {
    let state = app.state::<ShortcutState>();
    let mut machine = state
      .0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    machine.set_enabled(enabled)
  };
  emit(app, action);
}

/// Remet la machine à zéro et rend l'arrêt qu'elle devait éventuellement.
fn reset(state: &State<'_, ShortcutState>) -> Option<ShortcutAction> {
  state
    .0
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .reset()
}

/// Relit l'état du tap auprès du pont.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou si sa réponse est illisible.
fn read_native_status() -> Result<NativeStatus, AppError> {
  let raw = native::shortcut_status()?;
  native::parse(&raw, "l'état du raccourci")
}

/// Pourquoi le raccourci n'écoute pas, ou `None` s'il écoute.
///
/// # Pièges
///
/// - ⚠️ Les deux motifs ne se confondent pas : « autorisation manquante » se règle en cochant
///   une case, « autorisation accordée mais tap absent » en le redémarrant. Les mélanger
///   enverrait l'utilisateur dans les Réglages Système pour y trouver une case déjà cochée.
fn detail_for(native: &NativeStatus) -> Option<String> {
  match (native.listening, native.trusted) {
    (true, _) => None,
    (false, false) => Some(
      "l'autorisation Accessibilité n'est pas accordée : le raccourci global ne peut rien recevoir"
        .into(),
    ),
    (false, true) => {
      Some("le raccourci global n'écoute pas, bien que l'autorisation soit accordée".into())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{NativeStatus, SHORTCUT_EVENT, ShortcutStatus, announced, detail_for};
  use crate::shortcut::{Combo, ShortcutAction, ShortcutMode};

  /// Le nom de l'évènement est **du contrat** : le frontend s'y abonne par cette chaîne, et
  /// la renommer coupe le raccourci en silence.
  #[test]
  fn the_event_name_is_part_of_the_contract() {
    assert_eq!(SHORTCUT_EVENT, "shortcut");
  }

  /// Le pont écrit exactement cette forme. Si l'un des deux côtés dérive, on veut une erreur
  /// franche plutôt qu'un état par défaut qui prétendrait que tout va bien.
  #[test]
  fn the_bridge_status_is_read_back_without_loss() {
    let parsed: NativeStatus =
      serde_json::from_str(r#"{"listening":true,"trusted":true,"combo":2}"#)
        .expect("désérialisation");
    assert!(parsed.listening);
    assert!(parsed.trusted);
    assert_eq!(parsed.combo, 2);
  }

  /// ⚠️ **Les deux chaînes du bus sont du contrat**, et `recording-sound.ts` en dépend pour
  /// choisir son son. Les renommer couperait les bips sans rien casser d'autre.
  #[test]
  fn only_the_start_and_the_stop_reach_the_frontend() {
    assert_eq!(
      announced(ShortcutAction::Start(Combo::Spoken)),
      Some("start")
    );
    assert_eq!(
      announced(ShortcutAction::Start(Combo::Translated)),
      Some("start"),
      "la langue d'écriture ne regarde pas le frontend"
    );
    assert_eq!(announced(ShortcutAction::Stop), Some("stop"));
  }

  /// ⚠️ Un geste refusé qui sonnerait ferait entendre une dictée qui n'a pas lieu, au milieu
  /// d'une session ; un changement de cible qui sonnerait ferait biper la dictée en cours.
  #[test]
  fn the_two_silent_actions_stay_silent() {
    assert_eq!(announced(ShortcutAction::Suppressed), None);
    assert_eq!(announced(ShortcutAction::Retarget(Combo::Translated)), None);
  }

  #[test]
  fn a_truncated_bridge_status_is_refused() {
    assert!(serde_json::from_str::<NativeStatus>(r#"{"listening":true}"#).is_err());
  }

  /// Un tap en place n'a rien à expliquer.
  #[test]
  fn a_listening_tap_has_nothing_to_explain() {
    assert!(
      detail_for(&NativeStatus {
        listening: true,
        trusted: false,
        combo: 0,
      })
      .is_none()
    );
  }

  /// Les deux causes de silence ne se disent pas de la même façon — c'est tout l'intérêt du
  /// message.
  #[test]
  fn the_two_reasons_for_silence_are_told_apart() {
    let missing = detail_for(&NativeStatus {
      listening: false,
      trusted: false,
      combo: 0,
    })
    .expect("un tap muet doit s'expliquer");
    let stopped = detail_for(&NativeStatus {
      listening: false,
      trusted: true,
      combo: 0,
    })
    .expect("un tap muet doit s'expliquer");

    assert!(missing.contains("Accessibilité"));
    assert_ne!(missing, stopped);
  }

  /// L'état voyage en camelCase, comme tout le contrat IPC.
  #[test]
  fn the_status_travels_in_camel_case() {
    let json = serde_json::to_value(ShortcutStatus {
      listening: false,
      trusted: true,
      combo: Some(Combo::Translated),
      mode: ShortcutMode::Toggle,
      enabled: true,
      recording: false,
      detail: Some("muet".into()),
    })
    .expect("sérialisation");

    assert_eq!(json["listening"], false);
    assert_eq!(json["combo"], "translated");
    assert_eq!(json["mode"], "toggle");
    assert_eq!(json["detail"], "muet");
  }
}
