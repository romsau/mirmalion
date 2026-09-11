//! Piloter la capture d'une session : les sources, le démarrage, l'arrêt, l'état.
//!
//! Ce module **pilote** ; il ne transporte pas. Les tampons vont du tap Core Audio aux fichiers,
//! entièrement en Swift (`native/Sources/MirmalionNative/SystemAudioTap.swift`).
//!
//! # Pièges
//!
//! - ⚠️ Le seul module de session qui écrive sur le disque : une session laisse deux fichiers
//!   audio temporaires, le temps que la consolidation et le compte rendu repassent sur l'audio
//!   entier. Exception bornée à la session et au dossier de cache.
//! - ⚠️ Le dossier est désigné ici, jamais côté Swift, qui n'a pas à deviner l'identité du
//!   bundle : c'est ce qui donne à la variante de développement son propre cache.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{LIVE_STOPPED_EVENT, announce, now_ms, read_settings};
use super::{finalise::consolidate, meter::watch_level};
use crate::{
  blocking::off_thread,
  commands::permissions::{PermissionStatus, PermissionsStatus},
  error::AppError,
  native,
};

/// Le dossier des fichiers temporaires d'une session, sous le cache de l'application.
///
/// # Pièges
///
/// - ⚠️ Le cache, et non `app_data_dir()` : ces fichiers n'ont pas vocation à survivre. À côté de
///   la base chiffrée, ils seraient sauvegardés par Time Machine et remonteraient dans iCloud.
const LIVE_AUDIO_DIRECTORY: &str = "live-audio";

/// Une source captable, telle que le sélecteur de l'écran Direct la présentera.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
  /// `"system"` pour tout le système, sinon le `pid` en texte. **Opaque** : le frontend le
  /// renvoie tel quel, il n'a rien à en déduire.
  pub id: String,
  /// Le nom affiché dans le sélecteur.
  pub name: String,
  /// Vrai pour la seule entrée « Tout le système ». Elle se place en tête de liste, et elle
  /// est **toujours proposée** — c'est le choix qui marche à coup sûr.
  pub is_system: bool,
}

/// Où en est la capture de session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCaptureStatus {
  /// Le tap est-il ouvert ?
  pub running: bool,
  /// La source captée, telle qu'elle a été demandée.
  pub source_id: Option<String>,
  /// Le nom affichable de cette source.
  pub source_name: Option<String>,
  /// Les échantillons écrits par flux.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Ce sont les seuls champs qui prouvent que la capture marche : un `running: true` avec un
  ///   compteur figé est un tap ouvert sur une application muette, pas un enregistrement.
  pub system_frames: u64,
  /// Les échantillons écrits par le flux du micro.
  pub microphone_frames: u64,
  /// Ce que le tap et le micro ont **livré**, avant conversion, avec leur cadence et le nombre
  /// de tampons perdus.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Ces six champs ont attrapé un vrai défaut, et c'est pour cela qu'ils restent : sans eux,
  ///   un flux qui écrit moins qu'il ne devrait est indiscernable d'une source silencieuse. Le
  ///   flux système écrivait 7 % de moins que le micro — quatre minutes de décalage sur une heure.
  pub system_input_frames: u64,
  /// Les échantillons livrés par le micro, avant conversion.
  pub microphone_input_frames: u64,
  /// La cadence réelle du tap système, en hertz.
  pub system_input_sample_rate: f64,
  /// La cadence réelle du micro, en hertz.
  pub microphone_input_sample_rate: f64,
  /// Les tampons perdus par le tap système.
  pub system_dropped_buffers: u64,
  /// Les tampons perdus par le micro.
  pub microphone_dropped_buffers: u64,
  /// Les tampons que le **disque** a refusés, par flux.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Ce sont eux, et non les compteurs de trames, qui disent que l'enregistrement atteint
  ///   vraiment le fichier : côté Swift, `frames` s'incrémente à la **conversion**, sur le fil
  ///   audio, quand l'écriture a lieu plus tard sur une file. Un disque plein laisse donc
  ///   `system_frames` grimper et le VU-mètre bouger sur un WAV qui n'avance plus.
  /// - ⚠️ Distincts de `system_dropped_buffers`, qui compte les échecs de conversion. Les deux
  ///   à zéro et les trames qui montent : la capture va bien.
  pub system_write_failures: u64,
  /// Les tampons que le disque a refusés sur le flux du micro.
  pub microphone_write_failures: u64,
  /// Le niveau combiné des deux flux, de 0 à 1 — ce que le VU-mètre affiche.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Il n'existe aucun flux mixé : ce nombre est une addition quadratique des deux énergies,
  ///   sans qu'aucun tampon mixé soit construit.
  pub level: f64,
  /// Le fichier du flux système, tant que la capture tourne.
  pub system_path: Option<String>,
  /// Le fichier du flux micro, s'il a été ouvert.
  pub microphone_path: Option<String>,
}

/// Ce que porte [`LIVE_STOPPED_EVENT`] : **quelle** session s'est arrêtée.
///
/// # Pièges
///
/// - ⚠️ Un évènement Tauri est diffusé à toutes les fenêtres, et plusieurs fenêtres-sessions
///   terminées peuvent être ouvertes : sans cet identifiant, chacune lèverait son voile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveStopped<'a> {
  document_id: &'a str,
}

/// Le dossier des fichiers temporaires de session.
pub fn live_audio_directory(cache_dir: &std::path::Path) -> PathBuf {
  cache_dir.join(LIVE_AUDIO_DIRECTORY)
}

/// L'ancien nom du dossier, balayé lui aussi.
///
/// # Pièges
///
/// - ⚠️ Le renommage « Réunion → Direct » a changé `meeting-audio` en `live-audio`. Un orphelin
///   laissé par un crash **avant** la mise à jour porte l'ancien nom : ne balayer que le nouveau
///   le rendrait invisible pour toujours — de l'audio de session qui survit sur le disque.
/// - ⚠️ Ne se retire que le jour où plus aucune machine ne peut porter d'orphelin de cette époque.
const LEGACY_AUDIO_DIRECTORY: &str = "meeting-audio";

/// Efface tout audio de session qui traîne. **Rend le nombre de fichiers emportés.**
///
/// N'échoue jamais : un cache illisible ne doit pas empêcher l'application de démarrer.
///
/// # Pièges
///
/// - ⚠️ C'est le filet du crash : le chemin nominal supprime l'audio à la finalisation, ce
///   balayage couvre le chemin sans fin — panne, `SIGKILL`, coupure. Sans lui, l'audio d'une
///   session survit à l'arrêt de l'application, et c'est une fuite de confidentialité.
/// - ⚠️ Le dossier entier part, pas les deux noms connus : un troisième flux laisserait sinon un
///   orphelin qu'aucun balayage ne connaîtrait. Aucun nom de fichier au journal, un compte.
pub fn sweep_live_audio(cache_dir: &std::path::Path) -> usize {
  let swept: usize = [LIVE_AUDIO_DIRECTORY, LEGACY_AUDIO_DIRECTORY]
    .into_iter()
    .map(|name| {
      let directory = cache_dir.join(name);
      let count = std::fs::read_dir(&directory)
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
      // ⚠️ Le compte se prend avant la suppression : après, il n'y a plus rien à compter.
      let _ = std::fs::remove_dir_all(&directory);
      count
    })
    .sum();
  if swept > 0 {
    log::warn!("{swept} fichier(s) audio de session orphelin(s) effacé(s) au démarrage");
  }
  swept
}

/// Balaye l'audio orphelin au démarrage de l'application.
///
/// # Pièges
///
/// - ⚠️ Le cache introuvable n'est pas une erreur : au tout premier lancement il n'existe pas
///   encore, et rien à balayer est le cas nominal.
pub fn sweep_on_launch(app: &AppHandle) {
  match app.path().app_cache_dir() {
    Ok(cache) => {
      sweep_live_audio(&cache);
    }
    Err(error) => log::warn!("cache introuvable, audio de session non balayé : {error}"),
  }
}

/// Les sources audio captables. **Ne déclenche aucun prompt et n'ouvre rien.**
///
/// Utilisable **avant** que l'enregistrement audio soit autorisé : c'est ce qui permet au
/// sélecteur de se remplir dès l'affichage de l'écran Direct.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou rend une charge utile illisible.
#[tauri::command]
pub async fn list_audio_sources() -> Result<Vec<AudioSource>, AppError> {
  off_thread(|| native::parse(&native::list_audio_sources()?, "les sources audio")).await
}

/// La langue demandée manque-t-elle au moteur ?
///
/// Décision pure : elle ne lit rien et n'ouvre rien, elle tranche. C'est ce qui la rend
/// éprouvable, et c'est elle qui porte la règle, pas son appelant.
///
/// # Pièges
///
/// - ⚠️ **Une liste vide ne bloque rien** : le pont rend `[]` quand il n'a pas su répondre dans
///   son délai, et refuser toutes les sessions punirait l'utilisateur pour un moteur muet.
/// - ⚠️ Pas de langue, ou une langue vide, veut dire « enregistre sans transcrire » : un choix
///   légitime, pas une panne — les fichiers sont écrits et tout se refait depuis eux.
fn missing_language(installed: &[String], language: Option<&str>) -> bool {
  !installed.is_empty()
    && language
      .is_some_and(|wanted| !wanted.is_empty() && !installed.iter().any(|held| held == wanted))
}

/// Démarre la capture d'une session. `microphone_device_id` : `None` = pas de micro,
/// `Some("default")` = le micro système, sinon une entrée nommée — les deux premiers diffèrent.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le cache est illisible, [`AppError::Native`] si le tap refuse.
///
/// # Pièges
///
/// - ⚠️ Aucune garde sur l'autorisation d'enregistrement audio, et il ne faut pas en ajouter :
///   faute de préflight TCC, `audioCapturePermission()` rend toujours `unknown`, et une garde
///   `!= Granted` refuserait toutes les sessions. C'est le tap qui refuse, au bon endroit.
#[tauri::command]
pub async fn start_live_capture(
  app: AppHandle,
  source_id: String,
  microphone_device_id: Option<String>,
  language: Option<String>,
  translation_target: Option<String>,
) -> Result<crate::live::documents::LiveDocument, AppError> {
  let directory = live_audio_directory(&app.path().app_cache_dir()?);
  let folder = directory
    .to_str()
    .ok_or_else(|| AppError::Io("le dossier d'enregistrement n'est pas un chemin lisible".into()))?
    .to_owned();

  // ⚠️ **Avant d'ouvrir quoi que ce soit.** macOS reprend les modèles de transcription qu'il a
  // donnés — Apple les tient pour des actifs partagés —, si bien qu'une langue choisie la
  // semaine dernière peut avoir disparu. Sans ce garde, la session s'ouvrait, le moteur refusait
  // dans son coin, et l'utilisateur enregistrait du silence sans qu'un mot le lui dise.
  //
  // ⚠️ Le refus est net plutôt que dégradé : on sait ici que la transcription ne viendra pas, et
  // laisser tourner une heure d'audio muet pour l'apprendre à l'arrêt serait pire que rien.
  {
    let engine = app.state::<crate::commands::stt::SttHandle>().0.clone();
    let installed = off_thread(move || engine.capabilities())
      .await?
      .installed_locales;
    if missing_language(&installed, language.as_deref()) {
      return Err(AppError::InvalidArgument(format!(
        "les ressources de transcription de « {} » ne sont plus installées sur cette machine : \
         réinstallez la langue dans Options ▸ Langues parlées, ou choisissez-en une autre",
        language.as_deref().unwrap_or_default()
      )));
    }
  }

  let spoken = language.clone().unwrap_or_default();
  let remembered = source_id.clone();
  // ⚠️ C'est le micro réellement ouvert qui compte, pas celui qu'on a demandé : l'autorisation
  // peut l'avoir écarté, et la consolidation attendrait alors le signal de fin d'un flux qui
  // n'existe pas, jusqu'à son plafond de vingt secondes.
  //
  // ⚠️ Le micro, lui, se lit vraiment. Le refuser ne doit pas empêcher d'enregistrer la session,
  // seulement d'y ajouter sa voix : on dégrade plutôt que d'échouer.
  let with_microphone = off_thread(move || {
    let status: PermissionsStatus =
      native::parse(&native::permissions_status()?, "les autorisations")?;
    let microphone = microphone_device_id
      .filter(|_| status.microphone.status == PermissionStatus::Granted)
      .map(std::borrow::Cow::Owned);
    let opened = microphone.is_some();

    native::live_start(
      &source_id,
      microphone.as_deref(),
      &folder,
      language.as_deref(),
    )
    .map(|()| opened)
  })
  .await?;

  // ⚠️ Le nom de la source, pas son identifiant : le document affiche « Microsoft Teams », pas
  // « 4212 » — et l'application peut avoir disparu de la liste quand on le composera.
  let source_name = list_audio_sources()
    .await
    .ok()
    .and_then(|sources| {
      sources
        .into_iter()
        .find(|source| source.id == remembered)
        .map(|source| source.name)
    })
    .unwrap_or_else(|| remembered.clone());

  // ⚠️ Le document et sa fenêtre naissent ici, au démarrage : la fenêtre-session est la session,
  // elle montre l'enregistrement puis le transcript puis le compte rendu. L'ouvrir seulement à
  // l'arrêt laisserait l'utilisateur sans rien à regarder pendant qu'il enregistre.
  //
  // ⚠️ Après l'ouverture du tap, jamais avant : un tap qui refuse de s'ouvrir doit laisser
  // l'écran comme il était. Poser la fenêtre d'abord donnerait un « Arrêter » qui n'arrête rien.
  let started_at_ms = now_ms();
  let document = app
    .state::<crate::live::documents::LiveDocuments>()
    // ⚠️ La cible de traduction est rangée avec le document, pas lue dans les réglages par la
    // fenêtre : le réglage dit ce que le formulaire propose, le document ce que cette session a
    // demandé. Sinon, préparer la session suivante changerait la langue de celle qui tourne.
    .begin(
      source_name.clone(),
      started_at_ms,
      &spoken,
      translation_target,
    )?;

  app
    .state::<std::sync::Arc<crate::live::LiveSession>>()
    .start(
      &spoken,
      with_microphone,
      &source_name,
      &document.id,
      started_at_ms,
    );

  // ⚠️ Après le démarrage du tap, et une seule fois : le fil s'arrête de lui-même quand la
  // capture s'arrête, et la fenêtre n'a plus qu'à écouter.
  watch_level(&app, document.id.clone());

  // ⚠️ L'échec de la fenêtre n'arrête pas la session : l'audio s'écrit déjà et le déclencheur
  // garde son bouton « Arrêter ». Une fenêtre manquante est un ennui, une session perdue non.
  if let Err(error) = crate::lifecycle::create_live_window(&app, &document.id) {
    log::error!(
      "la fenêtre de la session n'a pas pu s'ouvrir : {}",
      error.kind()
    );
  }

  // ⚠️ La dictée est coupée ici, dans la commande, et pas par le frontend : une bascule exposée
  // au WebView lui donnerait le pouvoir de se rendre le raccourci pendant une session — deux
  // moteurs sur le même micro.
  //
  // ⚠️ Coupée après que le tap a démarré, jamais avant : si l'ouverture échoue, couper d'abord
  // aurait laissé l'utilisateur sans raccourci et sans session.
  crate::commands::shortcut::set_enabled(&app, false);

  // ⚠️ La pilule est présentée par le backend, pas par l'écran, exactement comme en dictée : la
  // fenêtre principale peut être fermée pendant une session, et c'est l'état retenu ici que
  // `warn_suspended` restaure après son avertissement.
  //
  // ⚠️ `chrono: true` : c'est la seule chose qui distingue la pilule d'une session de celle d'une
  // dictée.
  //
  // ⚠️ Éteindre la pilule n'éteint pas le repère. La pilule est un `NSPanel` au-dessus de toutes
  // les applications : elle apparaît dans un partage et dans une copie d'écran. La retirer sans
  // rien laisser derrière ferait tourner un micro trois heures, donc le battement du tray prend le
  // relais — et lui, il ne se règle pas.
  //
  // ⚠️ Le battement bat quoi qu'affiche la pilule, et il n'est posé que pour le direct : c'est la
  // durée d'une session qui le justifie, pas le micro ouvert. Voir `tray::set_pulsing`.
  crate::tray::set_pulsing(&app, true);

  // ⚠️ Le réglage est relu ici, à chaque démarrage, jamais mémorisé : il se change à chaud depuis
  // Options ▸ Direct, et une valeur retenue au lancement serait fausse au premier changement.
  if read_settings(&app).live_overlay_visible {
    let _ = crate::commands::overlay::present(
      &app,
      crate::commands::overlay::OverlayPayload {
        state: crate::commands::overlay::OverlayState::Listening,
        chrono: true,
      },
    );
  } else {
    crate::tray::set_recording(&app, true);
  }
  Ok(document)
}

/// Arrête la capture et ferme les deux fichiers. **Sans effet si rien ne tourne.**
///
/// # Errors
///
/// Rend [`AppError::Native`] si la fermeture du tap échoue.
///
/// # Pièges
///
/// - ⚠️ Le raccourci et le battement du tray sont rendus même si l'arrêt échoue, et d'abord : ni
///   l'un ni l'autre n'étant exposé, rien ne les rendrait à leur place.
/// - ⚠️ C'est lui qui lance la consolidation, plus aucun frontend : des trois gestes qui arrêtent
///   une session, l'un est la fermeture de la fenêtre qui aurait dû enchaîner.
#[tauri::command]
pub async fn stop_live_capture(app: AppHandle) -> Result<(), AppError> {
  crate::commands::shortcut::set_enabled(&app, true);
  crate::tray::set_pulsing(&app, false);
  let _ = crate::commands::overlay::hide_overlay(app.clone()).await;
  let closed = close_capture().await;

  // ⚠️ `finalising()` est ce qui rend l'arrêt idempotent : il ne rend un identifiant qu'à la
  // session qui enregistrait vraiment, et un second arrêt — deux fenêtres, deux clics — n'obtient
  // rien, donc ne relance pas une consolidation qui écraserait le transcript par du vide.
  //
  // ⚠️ La consolidation part en tâche de fond et l'arrêt rend la main tout de suite : un bouton
  // qui met huit secondes à répondre passe pour planté. Les fenêtres apprennent la suite par
  // `LIVE_STOPPED_EVENT` puis `LIVE_FINALISED_EVENT`.
  if let Some(id) = app
    .state::<std::sync::Arc<crate::live::LiveSession>>()
    .finalising()
  {
    announce(&app, LIVE_STOPPED_EVENT, &LiveStopped { document_id: &id });
    let elsewhere = app.clone();
    tauri::async_runtime::spawn(async move { consolidate(elsewhere, id).await });
  }

  closed
}

/// L'arrêt **nu** — la capture, sans le rétablissement du raccourci.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse de fermer le tap.
///
/// # Pièges
///
/// - ⚠️ Séparé pour être éprouvable : un `AppHandle` n'est pas constructible hors d'une
///   application Tauri, donc un test ne peut pas appeler la commande.
/// - ⚠️ Ne pas l'appeler depuis le produit : rétablir le raccourci n'est pas facultatif.
async fn close_capture() -> Result<(), AppError> {
  off_thread(native::live_stop).await
}

/// Ce qu'une fenêtre a besoin de savoir de la session en cours, à froid.
///
/// # Pièges
///
/// - ⚠️ C'est la commande de la réhydratation, et les deux fenêtres s'en servent : chacune porte
///   son propre magasin, et sans elle une fenêtre ouverte au milieu d'une session afficherait
///   `00:00:00` sur un enregistrement d'une heure.
/// - ⚠️ Distincte de [`get_live_capture_status`], qui reste la plomberie : elles divergent pendant
///   toute la consolidation, où la session existe alors que le tap est fermé.
#[tauri::command]
pub fn get_live_session(
  session: tauri::State<'_, std::sync::Arc<crate::live::LiveSession>>,
) -> crate::live::LiveSessionState {
  session.state()
}

/// Où en est la capture. Voir [`LiveCaptureStatus::system_frames`] : ce sont les compteurs
/// qui comptent, pas le drapeau.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou rend une charge utile illisible.
#[tauri::command]
pub async fn get_live_capture_status() -> Result<LiveCaptureStatus, AppError> {
  off_thread(|| native::parse(&native::live_status()?, "l'état de la capture de session")).await
}

#[cfg(test)]
mod tests {
  use super::{AudioSource, LiveCaptureStatus, live_audio_directory, missing_language};
  use std::path::Path;

  /// ⚠️ Aucun test n'ouvre de tap : démarrer une capture dans `cargo test` enregistrerait ce que
  /// joue la machine de qui lance la suite, et ferait surgir un prompt TCC hors de tout clic. Ce
  /// qui se vérifie ici est la frontière. La capture elle-même se mesure par
  /// `cargo test --test system_audio -- --ignored`, jamais joué par accident.
  #[test]
  fn listing_the_sources_never_needs_a_permission() {
    let sources = tauri::async_runtime::block_on(super::list_audio_sources())
      .expect("la HAL doit répondre sans autorisation");

    // « Tout le système » est toujours là, même quand rien n'émet : c'est le choix qui marche
    // à coup sûr, et l'écran de configuration s'appuie dessus pour n'être jamais vide.
    assert_eq!(
      sources.iter().filter(|source| source.is_system).count(),
      1,
      "« Tout le système » est proposé une fois et une seule"
    );
    assert!(
      sources.first().is_some_and(|source| source.is_system),
      "« Tout le système » se place en tête"
    );
    for source in &sources {
      assert!(
        !source.id.is_empty(),
        "une source sans identifiant est inutilisable"
      );
      assert!(
        !source.name.is_empty(),
        "une source sans nom n'est pas affichable"
      );
    }
  }

  /// ⚠️ Le fil de détente de la garde absente : `start_live_capture` ne vérifie pas
  /// l'autorisation d'enregistrement audio, et ce test dit pourquoi c'est correct — macOS ne rend
  /// jamais autre chose qu'`unknown` pour cette catégorie, faute d'API de préflight. Si Apple
  /// finit par l'exposer, ce test échouera et quelqu'un ajoutera la garde devenue possible.
  #[test]
  fn macos_never_tells_us_whether_audio_capture_is_allowed() {
    let raw = crate::native::permissions_status().expect("les permissions doivent être lisibles");
    let status: crate::commands::permissions::PermissionsStatus =
      crate::native::parse(&raw, "les autorisations").expect("charge utile lisible");

    assert_eq!(
      status.audio_capture.status,
      crate::commands::permissions::PermissionStatus::Unknown,
      "tant que cet état est inconnaissable, aucune garde ne peut le lire — voir \
       `start_live_capture`"
    );
  }

  #[test]
  fn nothing_is_recording_until_someone_asks() {
    let status = tauri::async_runtime::block_on(super::get_live_capture_status())
      .expect("l'état doit être lisible à tout moment");

    assert!(
      !status.running,
      "aucune session ne s'enregistre d'elle-même"
    );
    assert_eq!(status.system_frames, 0);
    assert_eq!(status.microphone_frames, 0);
    assert_eq!(status.source_id, None);
  }

  /// L'arrêt est appelé sur les chemins d'erreur, où l'on ne sait pas toujours si quelque
  /// chose tournait.
  #[test]
  fn stopping_an_idle_capture_is_a_no_op() {
    for _ in 0..3 {
      tauri::async_runtime::block_on(super::close_capture()).expect("l'arrêt doit être idempotent");
    }
  }

  /// ⚠️ **Le cas qui a coûté trois heures.** macOS reprend les modèles de transcription qu'il a
  /// donnés : une langue choisie il y a trois jours peut avoir disparu ce matin. Sans ce garde,
  /// la session s'ouvrait, le moteur refusait dans son coin, et l'utilisateur enregistrait du
  /// silence pendant une heure sans qu'un mot le lui dise.
  #[test]
  fn a_language_the_engine_no_longer_holds_stops_the_session_before_it_opens() {
    let installed = ["fr".to_owned(), "it".to_owned()];
    assert!(missing_language(&installed, Some("en")));
    assert!(!missing_language(&installed, Some("fr")));
  }

  /// ⚠️ **Sans langue, on enregistre sans transcrire, et c'est légitime** : les fichiers sont
  /// écrits et tout se refait depuis eux. Le garde ne doit pas transformer ce choix en panne.
  #[test]
  fn recording_without_transcribing_is_not_a_missing_language() {
    let installed: [String; 0] = [];
    assert!(!missing_language(&installed, None));
    assert!(!missing_language(&installed, Some("")));
  }

  /// ⚠️ Un moteur qui ne sait pas dire ce qu'il a rend une liste vide. Refuser toutes les
  /// sessions sur cette base punirait l'utilisateur pour un pont muet : le garde ne tranche que
  /// sur une liste qui dit vraiment quelque chose.
  #[test]
  fn a_silent_engine_never_blocks_a_session() {
    let installed: [String; 0] = [];
    assert!(!missing_language(&installed, Some("en")));
  }

  /// ⚠️ Le dossier est un **sous**-dossier du cache, pas le cache lui-même : écrire à la racine
  /// mêlerait l'audio de session aux fichiers de WebKit, et le balayage ne saurait plus quoi
  /// supprimer sans risque.
  #[test]
  fn the_audio_lives_in_its_own_folder_under_the_cache() {
    let directory = live_audio_directory(Path::new("/tmp/cache"));
    assert_eq!(directory, Path::new("/tmp/cache/live-audio"));
    assert_ne!(
      directory,
      Path::new("/tmp/cache"),
      "le balayage doit pouvoir vider ce dossier sans toucher au reste du cache"
    );
  }

  /// ⚠️ Le test de la fuite de confidentialité : une application tuée en pleine capture n'atteint
  /// jamais la suppression nominale, et deux WAV de session restent sur le disque. Ce balayage
  /// est le seul filet de ce chemin-là.
  #[test]
  fn the_launch_sweep_takes_away_what_a_crash_left_behind() {
    let cache = std::env::temp_dir().join("mirmalion-sweep-crash");
    let directory = live_audio_directory(&cache);
    std::fs::create_dir_all(&directory).expect("dossier");
    std::fs::write(directory.join("system.wav"), b"RIFF").expect("flux système");
    std::fs::write(directory.join("microphone.wav"), b"RIFF").expect("flux micro");

    assert_eq!(super::sweep_live_audio(&cache), 2);
    assert!(
      !directory.exists(),
      "l'audio d'une session ne doit pas survivre au démarrage suivant"
    );

    let _ = std::fs::remove_dir_all(&cache);
  }

  /// ⚠️ Le dossier entier part, pas les deux noms connus : un flux qu'une version future
  /// ajouterait laisserait sinon un orphelin qu'aucun balayage ne connaîtrait.
  #[test]
  fn the_sweep_takes_the_whole_folder_and_not_a_list_of_names() {
    let cache = std::env::temp_dir().join("mirmalion-sweep-unknown");
    let directory = live_audio_directory(&cache);
    std::fs::create_dir_all(&directory).expect("dossier");
    std::fs::write(directory.join("un-flux-a-venir.wav"), b"RIFF").expect("flux inconnu");

    assert_eq!(super::sweep_live_audio(&cache), 1);
    assert!(!directory.exists());

    let _ = std::fs::remove_dir_all(&cache);
  }

  /// ⚠️ Rien à balayer est le cas nominal, pas le cas dégradé : au premier lancement, le cache
  /// n'existe pas encore. Le balayage doit être muet et sans effet.
  #[test]
  fn sweeping_a_machine_that_never_recorded_is_silent() {
    let cache = std::env::temp_dir().join("mirmalion-sweep-blank");
    let _ = std::fs::remove_dir_all(&cache);
    assert_eq!(super::sweep_live_audio(&cache), 0);

    // Et il reste idempotent : deux démarrages de suite ne doivent pas différer.
    std::fs::create_dir_all(live_audio_directory(&cache)).expect("dossier vide");
    assert_eq!(super::sweep_live_audio(&cache), 0);
    assert_eq!(super::sweep_live_audio(&cache), 0);

    let _ = std::fs::remove_dir_all(&cache);
  }

  /// ⚠️ Le balayage ne doit toucher qu'à son dossier : il efface une arborescence entière, et
  /// visé un cran trop haut il emporterait le cache de WebKit et tout ce qui s'y trouve.
  #[test]
  fn the_sweep_never_reaches_outside_its_own_folder() {
    let cache = std::env::temp_dir().join("mirmalion-sweep-neighbours");
    let neighbour = cache.join("WebKit");
    std::fs::create_dir_all(&neighbour).expect("voisin");
    std::fs::write(neighbour.join("cache.db"), b"pas a nous").expect("fichier voisin");
    std::fs::create_dir_all(live_audio_directory(&cache)).expect("dossier");

    super::sweep_live_audio(&cache);

    assert!(
      neighbour.join("cache.db").exists(),
      "le balayage a mordu en dehors de son dossier"
    );

    let _ = std::fs::remove_dir_all(&cache);
  }

  #[test]
  fn serializes_in_camel_case() {
    let source = AudioSource {
      id: "system".into(),
      name: "Tout le système".into(),
      is_system: true,
    };
    let json = serde_json::to_value(&source).expect("sérialisation");
    assert_eq!(json["isSystem"], true);

    let status = LiveCaptureStatus {
      running: true,
      source_id: Some("4212".into()),
      source_name: Some("Microsoft Teams".into()),
      system_frames: 16_000,
      microphone_frames: 16_000,
      system_input_frames: 48_000,
      microphone_input_frames: 48_000,
      system_input_sample_rate: 48_000.0,
      microphone_input_sample_rate: 48_000.0,
      system_dropped_buffers: 0,
      microphone_dropped_buffers: 0,
      system_write_failures: 0,
      microphone_write_failures: 0,
      level: 0.5,
      system_path: Some("/tmp/cache/live-audio/system.wav".into()),
      microphone_path: None,
    };
    let json = serde_json::to_value(&status).expect("sérialisation");
    assert_eq!(json["systemFrames"], 16_000);
    assert_eq!(json["microphoneFrames"], 16_000);
    assert_eq!(json["sourceId"], "4212");
    assert_eq!(json["systemPath"], "/tmp/cache/live-audio/system.wav");
    assert!(json["microphonePath"].is_null());
  }
}
