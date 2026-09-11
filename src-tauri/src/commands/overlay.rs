//! L'overlay d'enregistrement : la fenêtre, et l'état qu'elle affiche.
//!
//! L'overlay est une fenêtre séparée, donc un webview séparé : l'état ne peut lui parvenir que
//! par le backend, où il **reste**. La coquille le lit à son démarrage, puis suit les évènements.
//!
//! # Pièges
//!
//! - ⚠️ L'état doit persister ici, pas seulement voyager en évènement : la fenêtre met quelques
//!   dizaines de millisecondes à monter son webview, et un évènement émis pendant ce temps n'a
//!   personne pour l'entendre.
//! - ⚠️ Rien de ce qui transite ici n'est du contenu utilisateur : l'overlay affiche une étape,
//!   jamais le texte dicté. C'est ce qui permet de le faire flotter au-dessus de n'importe quelle
//!   application, y compris pendant un partage d'écran.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::{commands::window as geometry, error::AppError, i18n};

/// L'étiquette de la fenêtre.
///
/// # Pièges
///
/// - ⚠️ C'est aussi la route Angular (`/overlay`) : la renommer d'un seul côté ouvre une fenêtre
///   vide, sans erreur nulle part. Voir `applyWindowRoute` dans `src/app/app.routes.ts`.
pub const OVERLAY_WINDOW: &str = "overlay";

/// L'évènement qui porte les changements d'état vers la fenêtre.
///
/// ⚠️ Cette chaîne est du contrat : la coquille s'y abonne par sa valeur.
pub const OVERLAY_EVENT: &str = "overlay-state";

/// Les états d'un enregistrement, miroir d'`OverlayState` côté Angular.
///
/// # Pièges
///
/// - ⚠️ Pas d'état « Reformulation » : [`OverlayState::Preparing`] couvre le nettoyage **et** la
///   reformulation, deux passes du même modèle, indiscernables pour qui attend.
/// - ⚠️ Pas d'état « Indisponible » non plus : la pilule ne dit que ce qu'elle sait — la dictée
///   a produit un texte, ou elle n'a rien produit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlayState {
  /// Le micro est ouvert : c'est le seul état où quelque chose est capté.
  Listening,
  /// Le modèle nettoie, et le cas échéant reformule, ce qui vient d'être dit.
  Preparing,
  /// La traduction est en cours.
  Translating,
  /// La dictée a produit un texte. **Qu'il ait été collé ou non**, nettoyé ou non : ce que
  /// l'application d'accueil en fait ne regarde pas la pilule, et le texte est de toute façon
  /// dans l'historique.
  Done,
  /// La dictée n'a **rien** produit : moteur ou micro refusés, moteur resté muet, ou rien de
  /// compris.
  Error,
  /// ⌃⌥ a été pressé **pendant une session**, où la dictée est coupée.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Direct uniquement, et fugace : il ne remplace pas l'enregistrement en cours, il
  ///   l'interrompt visuellement ~2 s puis la pilule revient à son chrono. C'est le seul endroit
  ///   visible depuis l'application où répondre au geste — une snackbar ne serait jamais vue.
  Suspended,
}

/// Ce que la pilule doit afficher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPayload {
  /// L'étape en cours.
  pub state: OverlayState,
  /// Faut-il afficher le chrono ?
  ///
  /// ⚠️ Seule différence entre dictée et session : en session, « Écoute » dure la séance ; en
  /// dictée, quelques secondes.
  pub chrono: bool,
}

/// L'état courant, ou `None` quand aucun enregistrement n'est en cours.
#[derive(Default)]
pub struct OverlayHandle(pub Mutex<Option<OverlayPayload>>);

/// La variable qui force l'affichage de l'overlay **en développement**.
///
/// Elle prend le nom d'un [`OverlayState`] en camelCase, éventuellement suivi de `:chrono` pour
/// obtenir le rendu de session. Elle permet de revoir la pilule état par état sans dérouler
/// tout le pipeline de dictée.
///
/// # Pièges
///
/// - ⚠️ Inerte en production, comme les autres variables de simulation : une pilule qui
///   apparaîtrait au démarrage parce qu'une variable traîne serait un défaut inexplicable.
const FORCE_OVERLAY: &str = "MIRMALION_FORCE_OVERLAY";

/// L'état imposé par l'environnement, s'il y en a un et si l'on est en développement.
pub fn forced_state() -> Option<OverlayPayload> {
  state_from(std::env::var(FORCE_OVERLAY).ok().as_deref())
}

/// Ce que vaut la variable une fois lue. Un état hors vocabulaire rend `None` plutôt que
/// d'être deviné.
///
/// # Pièges
///
/// - ⚠️ La lecture est laissée à l'appelant, et la coupure n'est pas cosmétique : depuis
///   l'edition 2024, poser une variable d'environnement est `unsafe`, parce qu'un autre fil qui
///   en lirait une au même instant relit une zone libérée. Les tests parallèles de cargo sont
///   exactement ce cas — passer la valeur les dispense d'y toucher.
fn state_from(raw: Option<&str>) -> Option<OverlayPayload> {
  if !cfg!(debug_assertions) {
    return None;
  }
  let raw = raw?;
  let (state, rest) = raw.split_once(':').unwrap_or((raw, ""));
  let state = serde_json::from_value(serde_json::Value::String(state.to_owned())).ok()?;
  Some(OverlayPayload {
    state,
    chrono: rest == "chrono",
  })
}

/// Affiche l'overlay, ou met à jour ce qu'il affiche. Idempotent.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la fenêtre ne peut être ni retrouvée ni construite, ou si
/// l'évènement ne part pas.
#[tauri::command]
pub async fn show_overlay(
  app: tauri::AppHandle,
  state: OverlayState,
  chrono: bool,
) -> Result<(), AppError> {
  present(&app, OverlayPayload { state, chrono })
}

/// Crée la fenêtre de la pilule **une fois pour toutes, au démarrage**.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la fenêtre ne peut pas être construite.
///
/// # Pièges
///
/// - ⚠️ Au démarrage, et jamais à chaque dictée : créer une fenêtre active l'application sur
///   macOS malgré `focused(false)` (tauri-apps/tauri#7519, #14102). La pilule naissant au début
///   d'une dictée, cette activation retirerait le focus au champ où l'utilisateur écrit — d'où
///   sa conversion en panneau non activant juste après.
pub fn ensure(app: &tauri::AppHandle) -> Result<(), AppError> {
  if app.get_webview_window(OVERLAY_WINDOW).is_none() {
    create(app)?;
  }
  Ok(())
}

/// Le geste que [`show_overlay`] enveloppe, utilisable dès le démarrage.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la fenêtre ne peut être ni retrouvée ni construite, ou si
/// l'évènement ne part pas.
pub fn present(app: &tauri::AppHandle, payload: OverlayPayload) -> Result<(), AppError> {
  remember(app, Some(payload));

  // ⚠️ La marque du tray ne suit que « Écoute », seul état où le micro est ouvert : préparation,
  // traduction et fin travaillent sur ce qui a déjà été dit, et laisser la marque allumée ferait
  // mentir le seul repère qui reste quand la pilule est éteinte.
  crate::tray::set_recording(app, payload.state == OverlayState::Listening);

  // ⚠️ L'état est posé avant la création : la coquille le lit à son démarrage, et n'a donc rien à
  // rattraper si elle monte après l'évènement.
  ensure(app)?;
  app.emit_to(OVERLAY_WINDOW, OVERLAY_EVENT, payload)?;
  Ok(())
}

/// Retire l'overlay, sans effet s'il n'y en a pas.
///
/// # Errors
///
/// Ne rend jamais d'erreur : le `Result` suit le contrat commun des commandes IPC.
#[tauri::command]
pub async fn hide_overlay(app: tauri::AppHandle) -> Result<(), AppError> {
  remember(&app, None);
  // ⚠️ La marque du tray s'éteint ici aussi, et pas seulement dans `present` : c'est ce chemin
  // que prennent l'arrêt d'une session et l'annulation d'une dictée, échecs compris.
  crate::tray::set_recording(&app, false);
  if let Some(window) = app.get_webview_window(OVERLAY_WINDOW) {
    // ⚠️ On efface, on ne ferme pas : recréer la fenêtre à chaque dictée activerait
    // l'application malgré `focused(false)` (tauri-apps/tauri#7519, #14102) et volerait le focus
    // au champ où l'utilisateur écrit. Le fondu s'arrête à 1 % d'opacité, assez pour que WebKit
    // continue de rendre, et il reste indispensable : escamoter la pilule est le défaut qu'il
    // corrige.
    geometry::fade_out_overlay(&window);
  }
  Ok(())
}

/// Ce que l'overlay doit afficher **maintenant**, ou `None` si rien n'est en cours.
///
/// Appelé par la coquille à son démarrage, pour combler l'intervalle entre la création de la
/// fenêtre et l'abonnement de son webview.
///
/// # Errors
///
/// Ne rend jamais d'erreur : un verrou empoisonné est repris plutôt que remonté.
#[tauri::command]
pub async fn get_overlay_state(
  handle: tauri::State<'_, OverlayHandle>,
) -> Result<Option<OverlayPayload>, AppError> {
  Ok(
    *handle
      .0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner()),
  )
}

/// Taille la fenêtre sur la pilule que le webview vient de mesurer.
///
/// # Errors
///
/// Ne rend jamais d'erreur : une fenêtre disparue entre la mesure et l'appel n'en est pas une.
///
/// # Pièges
///
/// - ⚠️ Les dimensions viennent du WebView, donc elles sont bornées : un défaut de mesure ne
///   doit pouvoir ouvrir ni une fenêtre d'un pixel, ni une fenêtre qui couvre l'écran. Le clamp
///   est silencieux — refuser laisserait une pilule tronquée.
#[tauri::command]
pub async fn resize_overlay(
  app: tauri::AppHandle,
  width: f64,
  height: f64,
) -> Result<(), AppError> {
  let Some(window) = app.get_webview_window(OVERLAY_WINDOW) else {
    // La fenêtre a pu être retirée entre la mesure et l'appel : ce n'est pas une erreur.
    return Ok(());
  };
  let width = clamp(
    width,
    geometry::OVERLAY_MIN_WIDTH,
    geometry::OVERLAY_MAX_WIDTH,
  );
  let height = clamp(
    height,
    geometry::OVERLAY_MIN_HEIGHT,
    geometry::OVERLAY_MAX_HEIGHT,
  );
  geometry::resize_overlay(&window, width, height);
  Ok(())
}

/// Ramène une valeur dans ses bornes, `NaN` compris.
///
/// # Pièges
///
/// - ⚠️ `f64::clamp` laisse passer `NaN` : il ne compare vrai avec rien. JavaScript en produit
///   sans effort — mesure sur un élément non rendu, division par zéro —, et il finirait en
///   taille de fenêtre.
fn clamp(value: f64, low: f64, high: f64) -> f64 {
  if value.is_nan() {
    return low;
  }
  value.clamp(low, high)
}

/// Mémorise l'état courant, ou l'efface, pour la coquille qui le relira à son démarrage.
fn remember(app: &tauri::AppHandle, payload: Option<OverlayPayload>) {
  let handle = app.state::<OverlayHandle>();
  let mut current = handle
    .0
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  *current = payload;
}

/// Construit la fenêtre flottante.
///
/// # Errors
///
/// Rend [`AppError::Io`] si Tauri refuse de construire la fenêtre.
///
/// # Pièges
///
/// - ⚠️ Elle naît invisible et n'est présentée qu'une fois configurée : la montrer d'abord la
///   ferait apparaître au milieu de l'écran, à son niveau par défaut, avant de sauter en haut.
/// - ⚠️ La présenter ne la rend pas visible : elle reste transparente jusqu'à la première mesure
///   du webview. Un webview muet ne donne donc aucune pilule, plutôt qu'une pastille vide.
fn create(app: &tauri::AppHandle) -> Result<(), AppError> {
  // ⚠️ `try_state` et non `state` : ce dernier panique si l'état n'est pas encore monté, et une
  // panique dans la construction d'une fenêtre fait tomber l'application. Le repli est la langue
  // source, celle du bundle par défaut.
  let locale = app
    .try_state::<crate::AppState>()
    .map_or(i18n::SOURCE_LOCALE, |state| state.interface_locale());
  let window = tauri::WebviewWindowBuilder::new(
    app,
    OVERLAY_WINDOW,
    tauri::WebviewUrl::App(i18n::window_path(locale, !cfg!(debug_assertions)).into()),
  )
  .title("Mirmalion")
  .inner_size(geometry::OVERLAY_WIDTH, geometry::OVERLAY_HEIGHT)
  .resizable(false)
  .decorations(false)
  // ⚠️ Pas de `transparent(true)` : cette option exige `macos-private-api`, donc des API privées
  // d'Apple et un motif de rejet au Mac App Store. La forme s'obtient en taillant la fenêtre à
  // la pilule et en arrondissant les coins de son calque, en API publique.
  //
  // ⚠️ `focused(false)` est inerte tel qu'on l'emploie : Tao ne le consulte que dans la branche
  // `if visible { … }` du constructeur, or la fenêtre naît cachée. On le garde parce qu'il
  // redeviendrait la bonne réponse si elle naissait visible ; ne pas s'y fier pour autant, c'est
  // `present_overlay` qui garantit qu'elle ne prend jamais le focus.
  .focused(false)
  .skip_taskbar(true)
  .always_on_top(true)
  .visible(false)
  .build()
  .map_err(i18n::window_error)?;

  // Ce que `always_on_top` ne couvre pas : le niveau système, la survie au plein écran, la
  // traversée des clics, et le placement en haut de l'écran.
  geometry::configure_overlay(&window);
  // ⚠️ Jamais `window.show()` : il descend à `makeKeyAndOrderFront:`, qui active l'application
  // et retire donc le focus au champ où l'utilisateur vient de poser son curseur, à l'instant où
  // il commence à dicter. `present_overlay` ordonne la fenêtre devant sans rien activer.
  geometry::present_overlay(&window);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{
    FORCE_OVERLAY, OVERLAY_EVENT, OVERLAY_WINDOW, OverlayPayload, OverlayState, clamp,
    forced_state, state_from,
  };

  /// ⚠️ **Il ne tourne qu'en développement**, et son jumeau ci-dessous ne tourne qu'en
  /// production : c'est la seule façon de prouver *par exécution* qu'un profil fait ce que
  /// l'autre refuse. Même doctrine que les tests de niveau de journalisation.
  #[cfg(debug_assertions)]
  #[test]
  fn the_environment_decides_whether_an_overlay_shows_at_startup() {
    assert!(
      state_from(None).is_none(),
      "sans variable, aucune pilule ne doit apparaître au démarrage"
    );

    let payload = state_from(Some("listening:chrono")).expect("la variable est posée");
    assert_eq!(payload.state, OverlayState::Listening);
    assert!(payload.chrono);

    let payload = state_from(Some("done")).expect("la variable est posée");
    assert_eq!(payload.state, OverlayState::Done);
    assert!(
      !payload.chrono,
      "le chrono ne s'invite pas sans être demandé"
    );

    // Un état hors vocabulaire n'affiche rien plutôt que d'être deviné.
    assert!(state_from(Some("reformulation")).is_none());
  }

  /// ⚠️ **En production, la variable ne fait RIEN** — pas même quand elle est posée. Une
  /// pilule qui apparaîtrait au démarrage chez un utilisateur parce qu'une variable traîne
  /// dans son environnement serait un défaut sans explication possible.
  #[cfg(not(debug_assertions))]
  #[test]
  fn the_environment_is_inert_in_production() {
    assert!(state_from(Some("listening:chrono")).is_none());
  }

  /// La lecture, elle, n'est éprouvée que dans un sens : l'environnement d'une vérification ne
  /// porte pas la variable, et la pilule reste absente. Poser la variable pour éprouver l'autre
  /// sens demanderait un `unsafe` que les tests parallèles de cargo rendraient malhonnête.
  #[test]
  fn nothing_is_forced_when_the_variable_is_absent() {
    assert!(
      forced_state().is_none(),
      "{FORCE_OVERLAY} traîne dans l'environnement de cette vérification"
    );
  }

  /// L'étiquette est **la route Angular**. La renommer d'un côté seulement ouvre une fenêtre
  /// vide, sans erreur nulle part.
  #[test]
  fn the_window_label_is_also_the_angular_route() {
    assert_eq!(OVERLAY_WINDOW, "overlay");
  }

  /// Le WebView n'est pas digne de confiance : ce qu'il mesure est ramené dans ses bornes.
  #[test]
  fn a_measurement_from_the_webview_is_brought_back_into_range() {
    assert_eq!(clamp(0.0, 120.0, 640.0), 120.0);
    assert_eq!(clamp(30_000.0, 120.0, 640.0), 640.0);
    assert_eq!(clamp(-4.0, 120.0, 640.0), 120.0);
    assert_eq!(clamp(300.0, 120.0, 640.0), 300.0);
  }

  /// ⚠️ **`NaN` traverse le `clamp` de la bibliothèque standard sans être corrigé** — il ne
  /// compare vrai avec rien. JavaScript en produit sans effort (une mesure sur un élément non
  /// rendu, une division par zéro) ; il finirait en taille de fenêtre.
  #[test]
  fn a_not_a_number_falls_back_to_the_lower_bound() {
    assert_eq!(clamp(f64::NAN, 120.0, 640.0), 120.0);
  }

  /// Le nom de l'évènement est du contrat : la coquille s'y abonne par cette chaîne.
  #[test]
  fn the_event_name_is_part_of_the_contract() {
    assert_eq!(OVERLAY_EVENT, "overlay-state");
  }

  /// Les six états voyagent dans l'écriture du frontend. Une divergence rendrait la pilule
  /// muette sur un état, sans rien signaler.
  #[test]
  fn the_six_states_travel_in_the_frontend_spelling() {
    let json = |state: OverlayState| serde_json::to_string(&state).expect("sérialisation");
    assert_eq!(json(OverlayState::Listening), "\"listening\"");
    assert_eq!(json(OverlayState::Preparing), "\"preparing\"");
    assert_eq!(json(OverlayState::Translating), "\"translating\"");
    assert_eq!(json(OverlayState::Done), "\"done\"");
    assert_eq!(json(OverlayState::Error), "\"error\"");
  }

  #[test]
  fn the_payload_travels_in_camel_case_and_comes_back_whole() {
    let payload = OverlayPayload {
      state: OverlayState::Listening,
      chrono: true,
    };
    let json = serde_json::to_value(payload).expect("sérialisation");
    assert_eq!(json["state"], "listening");
    assert_eq!(json["chrono"], true);

    let back: OverlayPayload =
      serde_json::from_str(r#"{"state":"done","chrono":false}"#).expect("désérialisation");
    assert_eq!(back.state, OverlayState::Done);
    assert!(!back.chrono);
  }

  #[test]
  fn an_unknown_state_is_refused_rather_than_guessed() {
    assert!(serde_json::from_str::<OverlayState>("\"reformulation\"").is_err());
  }
}
