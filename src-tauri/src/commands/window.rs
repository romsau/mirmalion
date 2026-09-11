//! Géométrie des fenêtres, et les gestes natifs qui l'accompagnent.
//!
//! # Pièges
//!
//! - ⚠️ Les dimensions vivent ici et nulle part ailleurs : `lib.rs` les lit pour construire les
//!   fenêtres, les commandes les relisent pour les redimensionner. Deux tables de nombres
//!   finiraient par diverger d'un pixel, sans qu'on sache laquelle fait foi.

use tauri::Manager;

use crate::error::AppError;

/// Largeur de la fenêtre large — Dictée, Session, Options.
pub const WIDE_WIDTH: f64 = 900.0;

/// Largeur de la fenêtre étroite — espace Fichiers, et historique replié.
pub const NARROW_WIDTH: f64 = 450.0;

/// Hauteur du header — 9 de marge, 32 de bouton, 9 de marge.
///
/// Le filet du bas n'en fait pas partie : c'est sur cette bande-là que les boutons de fenêtre
/// se centrent.
pub const HEADER_HEIGHT: f64 = 50.0;

/// La marge latérale du header, en points — le pendant de `--header-pad-x` côté CSS.
///
/// # Pièges
///
/// - ⚠️ Elle sert aussi aux pastilles de macOS, que Swift décale d'autant : AppKit les pose à
///   ~7 pt du bord, où elles paraissent collées au coin face à nos boutons de droite. Les deux
///   valeurs doivent rester égales, c'est la symétrie du header qui est en jeu.
pub const HEADER_PAD_X: f64 = 16.0;

/// Hauteur totale, **constante quel que soit l'écran**.
///
/// Elle se compose : le header, son filet d'un pixel, puis 582 px de corps (22 de marge
/// haute, 544 d'écran utile, 16 de marge basse). L'écran Options annule ses marges et rend
/// 582 px pleins — d'où la même hauteur totale.
pub const HEIGHT: f64 = 633.0;

/// Largeur d'ouverture d'une fenêtre-document.
///
/// Plus large que la fenêtre principale, et redimensionnable, contrairement à elle : un
/// transcript est un texte long qu'on lit, pas un écran de commande.
pub const DOCUMENT_WIDTH: f64 = 980.0;

/// Hauteur d'ouverture d'une fenêtre-document.
pub const DOCUMENT_HEIGHT: f64 = 700.0;

/// Largeur plancher d'une fenêtre-document, en deçà de laquelle le transcript cesse d'être
/// lisible. Elle ne protège aucune mise en page fixe : la fenêtre n'en a pas.
pub const DOCUMENT_MIN_WIDTH: f64 = 620.0;

/// Hauteur plancher d'une fenêtre-document.
pub const DOCUMENT_MIN_HEIGHT: f64 = 420.0;

/// Largeur de la fenêtre d'onboarding — **portrait**, et donc plus étroite que tout le reste.
///
/// C'est une fenêtre à part, pas une disposition de la fenêtre principale.
pub const ONBOARDING_WIDTH: f64 = 470.0;

/// Hauteur du corps d'une étape d'onboarding.
///
/// Elle est **fixe** : une étape ne défile pas, elle tient dans la fenêtre. C'est ce qui
/// garantit que le bouton de pied est toujours visible sans avoir à le chercher.
pub const ONBOARDING_BODY_HEIGHT: f64 = 620.0;

/// Hauteur totale de la fenêtre d'onboarding : la barre de titre, son filet, et le corps.
pub const ONBOARDING_HEIGHT: f64 = HEADER_HEIGHT + 1.0 + ONBOARDING_BODY_HEIGHT;

/// Largeur d'ouverture de la fenêtre de l'overlay, le temps qu'Angular mesure la pilule et
/// demande la taille exacte par [`resize_overlay`].
///
/// # Pièges
///
/// - ⚠️ La fenêtre **est** la pilule : la transparence de Tauri exige des API privées d'Apple,
///   motif de rejet au Mac App Store. La forme s'obtient en taillant la fenêtre à la pilule.
/// - ⚠️ Une taille plausible plutôt que zéro : à zéro, le premier affichage montre une image de
///   fenêtre dégénérée.
pub const OVERLAY_WIDTH: f64 = 220.0;

/// Hauteur d'ouverture de la fenêtre de l'overlay. Voir [`OVERLAY_WIDTH`].
pub const OVERLAY_HEIGHT: f64 = 56.0;

/// Rayon des coins de la pilule, appliqué au calque de la vue de contenu.
///
/// # Pièges
///
/// - ⚠️ Doit rester égal au `border-radius` du composant de la pilule : l'un taille la fenêtre,
///   l'autre peint le fond, et un écart laisse un liseré d'accent dans les angles.
pub const OVERLAY_CORNER_RADIUS: f64 = 18.0;

/// Largeur plancher acceptée par [`resize_overlay`].
///
/// # Pièges
///
/// - ⚠️ Le WebView n'est pas digne de confiance : sans ces bornes, un défaut de mesure ouvrirait
///   une fenêtre d'un pixel ou de trente mille.
pub const OVERLAY_MIN_WIDTH: f64 = 120.0;

/// Largeur plafond acceptée par [`resize_overlay`]. Voir [`OVERLAY_MIN_WIDTH`].
pub const OVERLAY_MAX_WIDTH: f64 = 640.0;

/// Hauteur plancher acceptée par [`resize_overlay`]. Voir [`OVERLAY_MIN_WIDTH`].
pub const OVERLAY_MIN_HEIGHT: f64 = 32.0;

/// Hauteur plafond acceptée par [`resize_overlay`]. Voir [`OVERLAY_MIN_WIDTH`].
pub const OVERLAY_MAX_HEIGHT: f64 = 120.0;

/// Distance entre le bas de la barre des menus et le haut de la fenêtre de l'overlay.
///
/// Appliquée côté Swift, sur `visibleFrame` — qui exclut déjà la barre des menus **et
/// l'encoche**.
pub const OVERLAY_TOP_MARGIN: f64 = 8.0;

/// Passe la fenêtre en disposition étroite ou large.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le redimensionnement de secours est refusé par Tauri.
///
/// # Pièges
///
/// - ⚠️ La commande prend un booléen, pas une largeur : laisser le WebView choisir un nombre de
///   pixels ouvrirait la porte à une fenêtre de trois pixels ou de trente mille.
#[tauri::command]
pub async fn set_window_compact(
  window: tauri::WebviewWindow,
  compact: bool,
) -> Result<(), AppError> {
  let width = if compact { NARROW_WIDTH } else { WIDE_WIDTH };
  if !resize_animated(&window, width) {
    // Le fil principal n'a pas pris la tâche : on redimensionne d'un coup, comme avant.
    window.set_size(tauri::LogicalSize::new(width, HEIGHT))?;
  }
  // ⚠️ Sans cela, une partie de la page garde l'image d'avant : le layout suit le
  // redimensionnement, la peinture non.
  refresh_webview(&window);
  Ok(())
}

/// Le redimensionnement sec, quand l'animation n'a pas pu avoir lieu.
fn fallback_resize(window: &tauri::WebviewWindow, width: f64) {
  if let Err(error) = window.set_size(tauri::LogicalSize::new(width, HEIGHT)) {
    log::warn!("fenêtre non redimensionnée : {error}");
  }
}

/// Confie `body` au fil principal avec la `NSWindow` de `window`.
///
/// `what` nomme **l'échec** et non le geste — « boutons de fenêtre non recentrés » : les trois
/// pannes possibles le complètent chacune d'un suffixe, et aucune ne remonte.
///
/// # Pièges
///
/// - ⚠️ `true` dit que `body` est planifié, pas qu'il a réussi ni même commencé : il s'exécute
///   après le retour, et l'attendre bloquerait l'appelant le temps d'une animation AppKit.
/// - ⚠️ `false` est le seul échec rendu — la planification refusée, avant tout appel.
pub(super) fn on_native_window<F>(
  window: &tauri::WebviewWindow,
  what: &'static str,
  body: F,
) -> bool
where
  F: FnOnce(&crate::native::MainWindow) -> Result<(), AppError> + Send + 'static,
{
  on_native_window_or(window, what, body, || ())
}

/// [`on_native_window`], plus un `recover` exécuté si le geste natif n'a pas eu lieu.
///
/// # Pièges
///
/// - ⚠️ `recover` ne couvre **que** les échecs survenus sur le fil principal. Une planification
///   refusée ne le déclenche pas : à ce moment-là l'appelant tient encore la main, et le `false`
///   qu'il reçoit est son signal. C'est ce qui permet à `recover` d'être un `FnOnce`.
fn on_native_window_or<F, R>(
  window: &tauri::WebviewWindow,
  what: &'static str,
  body: F,
  recover: R,
) -> bool
where
  F: FnOnce(&crate::native::MainWindow) -> Result<(), AppError> + Send + 'static,
  R: FnOnce() + Send + 'static,
{
  let handle = window.clone();
  let scheduled = window.run_on_main_thread(move || {
    let done = match handle.ns_window() {
      Ok(ns_window) => {
        // SAFETY: `ns_window` vient de `WebviewWindow::ns_window()` — valide tant que la fenêtre
        // vit —, et `run_on_main_thread` garantit le fil principal. C'est l'unique construction
        // d'un `MainWindow` du backend, donc l'unique endroit où cet invariant se démontre.
        let native = unsafe { crate::native::MainWindow::new(ns_window) };
        match body(&native) {
          Ok(()) => true,
          Err(error) => {
            log::warn!("{what} ({}) : {error}", error.kind());
            false
          }
        }
      }
      Err(error) => {
        log::warn!("{what} — fenêtre native introuvable : {error}");
        false
      }
    };
    if !done {
      recover();
    }
  });
  if let Err(error) = scheduled {
    log::warn!("{what} — fil principal indisponible : {error}");
    return false;
  }
  true
}

/// Place l'application dans le Dock, ou l'en retire, **sans redémarrage**.
///
/// # Errors
///
/// Rend [`AppError::Io`] si macOS refuse le changement de politique d'activation.
///
/// # Pièges
///
/// - ⚠️ N'écrit pas le réglage : la persistance passe par le magasin, et le démarrage relit ce
///   fichier avant toute fenêtre — sans quoi l'icône apparaîtrait puis disparaîtrait le temps
///   que le webview pousse la valeur.
#[tauri::command]
pub async fn set_dock_visible(app: tauri::AppHandle, visible: bool) -> Result<(), AppError> {
  crate::lifecycle::set_dock_visibility(&app, visible)
}

/// La durée du repli, en secondes.
///
/// # Pièges
///
/// - ⚠️ La fenêtre utile est étroite : au-delà de ~0,18 s le mouvement traîne derrière le clic,
///   en deçà de 0,10 s il cesse d'être perçu comme une animation et redevient un saut.
const COMPACT_ANIMATION: f64 = 0.13;

/// Redimensionne la fenêtre en l'animant, et rend `false` si l'animation n'a pas pu être
/// demandée — à charge pour l'appelant de redimensionner d'un coup.
///
/// # Pièges
///
/// - ⚠️ Le résultat ne dit pas que l'animation a fini, seulement qu'elle a été confiée à
///   AppKit : elle se déroule sur le fil principal après le retour. Attendre la fin bloquerait
///   le frontend pendant toute la durée du mouvement.
fn resize_animated(window: &tauri::WebviewWindow, width: f64) -> bool {
  // ⚠️ Le secours est confié au fil principal et pas laissé à l'appelant : `run_on_main_thread`
  // rend la main dès que la tâche est planifiée, donc l'appelant croit déjà le redimensionnement
  // fait et ne repassera pas. Seule la planification refusée lui revient, par le booléen.
  let fallback = window.clone();
  on_native_window_or(
    window,
    "redimensionnement non animé",
    move |native| crate::native::resize_window_animated(native, width, HEIGHT, COMPACT_ANIMATION),
    move || fallback_resize(&fallback, width),
  )
}

/// Demande au webview de se repeindre, après tout changement de taille de fenêtre.
///
/// L'échec est absorbé : un repaint manquant est cosmétique, et le premier survol de souris
/// le corrige déjà.
fn refresh_webview(window: &tauri::WebviewWindow) {
  on_native_window(
    window,
    "webview non rafraîchi",
    crate::native::refresh_webview,
  );
}

/// Ramène la fenêtre appelante au premier plan, après un prompt système.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la première activation est refusée ; les reprises ne remontent rien.
///
/// # Pièges
///
/// - ⚠️ Jamais après avoir ouvert les Réglages Système : l'utilisateur y a été envoyé pour
///   faire quelque chose, lui repasser devant l'en empêcherait.
/// - ⚠️ Une seule activation ne suffit pas : macOS rend le premier plan à l'application
///   précédente **après** avoir refermé le prompt, et aucun évènement n'annonce cette fin.
#[tauri::command]
pub async fn focus_window(window: tauri::WebviewWindow) -> Result<(), AppError> {
  window.set_focus()?;

  let deferred = window.clone();
  tauri::async_runtime::spawn_blocking(move || {
    for delay in REFOCUS_DELAYS_MS {
      std::thread::sleep(std::time::Duration::from_millis(delay));
      if let Err(error) = deferred.set_focus() {
        // Cosmétique : la fenêtre reste utilisable, elle est simplement derrière.
        log::warn!("reprise du premier plan refusée : {error}");
        return;
      }
    }
  });

  Ok(())
}

/// Les instants où l'on réaffirme le premier plan, en millisecondes **entre deux passages** et
/// non depuis le départ. Voir [`focus_window`].
const REFOCUS_DELAYS_MS: [u64; 3] = [120, 180, 250];

/// Agrandit la fenêtre à l'écran, ou la ramène à sa taille précédente — le geste du bouton vert.
///
/// # Errors
///
/// Rend [`AppError::Io`] si Tauri refuse de lire ou de changer l'état de la fenêtre.
///
/// # Pièges
///
/// - ⚠️ Une fenêtre non redimensionnable est laissée telle quelle, sans erreur : c'est ce
///   garde-fou qui dispense le frontend de savoir dans quelle fenêtre il tourne.
/// - ⚠️ Ce n'est pas le plein écran : Dock et barre des menus restent visibles.
#[tauri::command]
pub async fn toggle_window_zoom(window: tauri::WebviewWindow) -> Result<(), AppError> {
  if !window.is_resizable()? {
    return Ok(());
  }
  if window.is_maximized()? {
    window.unmaximize()?;
  } else {
    window.maximize()?;
  }
  Ok(())
}

/// Accorde l'apparence **native** de toutes les fenêtres au thème choisi dans l'application.
///
/// # Errors
///
/// Ne rend jamais d'erreur : chaque échec est cosmétique et reste dans le journal.
///
/// # Pièges
///
/// - ⚠️ Le thème du webview ne dit rien à macOS : sans cet appel, la `NSWindow` garde son
///   apparence claire et trace un liseré d'un pixel en haut de la fenêtre.
/// - ⚠️ Changer l'apparence renvoie les boutons de fenêtre dans la bande standard d'AppKit, sans
///   la moindre notification : d'où [`center_buttons`] juste après, inconditionnel.
#[tauri::command]
pub async fn set_window_theme(app: tauri::AppHandle, dark: bool) -> Result<(), AppError> {
  let theme = if dark {
    tauri::Theme::Dark
  } else {
    tauri::Theme::Light
  };
  for (label, window) in app.webview_windows() {
    if let Err(error) = window.set_theme(Some(theme)) {
      log::warn!("apparence native non appliquée à « {label} » : {error}");
    }
    // ⚠️ L'overlay n'a pas de pastilles — c'est un `NSPanel` sans décorations —, et lui en
    // demander écrirait un « boutons de fenêtre introuvables » qui décrit le fonctionnement
    // normal. Filtré ici plutôt que rendu silencieux côté Swift : une fenêtre à décorations qui
    // perdrait ses boutons doit, elle, rester signalée.
    if label != super::overlay::OVERLAY_WINDOW {
      center_buttons(&window);
    }
  }
  Ok(())
}

/// Installe le maintien des boutons de fenêtre de macOS au centre de la bande du header.
///
/// Ne remonte pas d'erreur : des pastilles mal alignées ne valent pas un démarrage en échec.
///
/// # Pièges
///
/// - ⚠️ Deux appels et deux seulement — à la création de la fenêtre, et après un changement
///   d'apparence ([`set_window_theme`]). Ce n'est pas un placement ponctuel : Swift s'abonne aux
///   relayouts d'AppKit et réapplique la correction lui-même. Le changement d'apparence est le
///   seul relayout sans notification, donc le seul qu'il ne peut pas voir venir.
pub fn center_buttons(window: &tauri::WebviewWindow) {
  on_native_window(window, "boutons de fenêtre non recentrés", |native| {
    crate::native::center_window_buttons(native, HEADER_HEIGHT, HEADER_PAD_X)
  });
}

/// Pose sur la fenêtre de l'overlay ce qu'`always_on_top` ne sait pas faire : le niveau
/// système, le comportement en plein écran, la traversée des clics, le placement en haut.
///
/// # Pièges
///
/// - ⚠️ Sans cet appel, la pilule disparaît sous une application en plein écran et intercepte
///   les clics — donc vole le focus, donc casse le collage au curseur.
pub fn configure_overlay(window: &tauri::WebviewWindow) {
  on_native_window(window, "overlay non configuré", |native| {
    crate::native::configure_overlay_window(native, OVERLAY_TOP_MARGIN, OVERLAY_CORNER_RADIUS)
  });
}

/// Montre la pilule **sans activer l'application**.
///
/// # Pièges
///
/// - ⚠️ À employer à la place de `WebviewWindow::show()`, qui descend à `makeKeyAndOrderFront:`
///   et active l'application. La pilule apparaissant au début de la dictée, le champ où
///   l'utilisateur venait de poser son curseur perdrait le focus, et le ⌘V posté ensuite
///   partirait dans notre propre webview.
pub fn present_overlay(window: &tauri::WebviewWindow) {
  on_native_window(
    window,
    "pilule non présentée",
    crate::native::present_overlay_window,
  );
}

/// Efface la pilule en fondu.
///
/// # Pièges
///
/// - ⚠️ Ne ferme rien : la fenêtre de la pilule vit du démarrage à la fin du processus, et
///   [`crate::commands::overlay`] compte dessus.
pub fn fade_out_overlay(window: &tauri::WebviewWindow) {
  on_native_window(
    window,
    "overlay non effacé en fondu",
    crate::native::fade_out_overlay_window,
  );
}

/// Retaille la fenêtre de l'overlay et la recentre en haut de l'écran.
pub fn resize_overlay(window: &tauri::WebviewWindow, width: f64, height: f64) {
  on_native_window(window, "overlay non retaillé", move |native| {
    crate::native::resize_overlay_window(native, width, height, OVERLAY_TOP_MARGIN)
  });
}

// Les invariants de la maquette, vérifiés à la compilation plutôt que par des tests : ce sont
// des constantes, il n'y a rien à exécuter pour les mesurer. Modifier un nombre sans modifier
// les autres ne donne pas un test rouge, mais un build qui refuse de passer.

/// La fenêtre large est **paysage**. L'étroite ne l'est pas : c'est une demi-fenêtre, pas une
/// fenêtre portrait.
const _: () = assert!(WIDE_WIDTH > HEIGHT);

/// L'étroite est exactement la moitié de la large, ce qui fait que la colonne de gauche garde
/// sa largeur quand l'historique se replie.
const _: () = assert!(NARROW_WIDTH * 2.0 == WIDE_WIDTH);

/// La largeur d'ouverture de l'overlay tient dans ses bornes ; sans cela la fenêtre sauterait à
/// la première mesure du webview.
const _: () = assert!(OVERLAY_WIDTH >= OVERLAY_MIN_WIDTH && OVERLAY_WIDTH <= OVERLAY_MAX_WIDTH);

/// La hauteur d'ouverture de l'overlay tient dans ses bornes.
const _: () = assert!(OVERLAY_HEIGHT >= OVERLAY_MIN_HEIGHT && OVERLAY_HEIGHT <= OVERLAY_MAX_HEIGHT);

/// La hauteur est la somme du header, de son filet, et du corps — 22 de marge haute, 544
/// d'écran utile, 16 de marge basse. Si l'un bouge, l'autre doit bouger aussi.
const _: () = assert!(HEIGHT == HEADER_HEIGHT + 1.0 + (22.0 + 544.0 + 16.0));

/// Le header est la somme de ses trois bandes : marge, bouton, marge.
const _: () = assert!(HEADER_HEIGHT == 9.0 + 32.0 + 9.0);

/// La fenêtre d'onboarding est **portrait**, là où toutes les autres sont paysage ou carrées.
const _: () = assert!(ONBOARDING_HEIGHT > ONBOARDING_WIDTH);

/// Elle partage la **hauteur de barre de titre** de la fenêtre principale : les deux barres
/// sont le même objet visuel, et le recentrage natif des pastilles est calculé une seule fois.
const _: () = assert!(ONBOARDING_HEIGHT == HEADER_HEIGHT + 1.0 + ONBOARDING_BODY_HEIGHT);
