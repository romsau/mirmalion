//! Le pipeline de dictée : assembler la chaîne, et la piloter.
//!
//! Ce module **exécute**, il ne décide pas : l'enchaînement des étapes, la dégradation et la
//! correspondance avec l'overlay vivent dans [`crate::dictation`], pur et testé sans micro ni
//! modèle. Au frontend il ne reste qu'à afficher.
//!
//! # Pièges
//!
//! - ⚠️ L'orchestrateur reste côté Rust : la dictée doit aboutir fenêtre fermée, et WebKit bride
//!   les minuteurs d'un webview caché — or la fenêtre principale démarre cachée.
//! - ⚠️ La garde de durée s'applique là où le raccourci arrive, avant que quoi que ce soit ne
//!   bouge : plus loin, ⌃⌥⌘ tapé ailleurs a déjà ouvert le micro.
//! - ⚠️ Le verrou de session n'est jamais tenu à travers un `.await` : le tenir bloquerait le
//!   runtime pendant les secondes que met le modèle.

use std::{
  collections::VecDeque,
  sync::{Mutex, MutexGuard},
  time::Instant,
};

use tauri::{Manager, State};

use crate::{
  blocking::off_thread,
  commands::{
    self, audio, dictations,
    injection::{self, InjectionOutcome},
    llm::LlmHandle,
    overlay::{self, OverlayPayload, OverlayState},
    prompts,
    stt::SttHandle,
    translation::TranslationHandle,
  },
  dictation::{
    MIN_DICTATION_MS, Plan, Run, Step, long_enough,
    timing::{Leg, Timeline},
  },
  error::AppError,
  i18n,
  llm::RephrasingStyle,
  settings::Stored,
  shortcut::{Combo, ShortcutAction},
  state::AppState,
  translation::TranslationOutcome,
};

/// Une dictée en cours.
struct Session {
  /// L'avancement de la machine à états.
  run: Run,
  /// L'instant de l'**appui** sur ⌃⌥, pour la garde de durée.
  ///
  /// ⚠️ Le front, jamais l'instant où la dictée s'est ouverte : les actions du raccourci passent
  /// par une file, et dater l'ouverture ferait juger la durée d'un geste sur le temps que la
  /// machine a mis à le traiter — un ⌃⌥⌘ parasite de 30 ms passerait alors la garde.
  started: Instant,
  /// Le numéro de cette dictée. **C'est le jeton d'annulation.**
  ///
  /// ⚠️ Le pipeline relâche le verrou à chaque étape pour attendre le modèle : pendant ce
  /// temps, une annulation — ou une nouvelle dictée — peut remplacer la session. L'exécutant
  /// compare ce numéro avant chaque étape. Sans lui, une dictée abandonnée finirait par coller
  /// son texte plusieurs secondes après.
  id: u64,
  /// L'application à qui ce texte est destiné, relevée **au début** de la dictée.
  ///
  /// `0` si le système n'en annonçait aucune : l'insertion retombe alors sur le premier plan.
  ///
  /// ⚠️ Au début, et pas au collage : une seconde plus tard, notre pilule est passée au premier
  /// plan — créer une fenêtre active l'application malgré `focused(false)`
  /// (tauri-apps/tauri#7519, #14102) —, et un collage visant « le premier plan » partirait dans
  /// notre propre webview sans laisser de trace.
  target: i32,
  /// La mesure de latence, **ouverte au relâchement du raccourci**.
  ///
  /// ⚠️ `None` tant qu'on parle : ce qu'on chronomètre part de la fin de la dictée, pas de son
  /// début — le temps de parole appartient à l'utilisateur. Voir [`crate::dictation::timing`].
  measure: Option<Measure>,
}

/// Le chronomètre d'une dictée en cours : les tronçons déjà notés, et deux repères.
///
/// # Pièges
///
/// - ⚠️ Deux repères et non un : [`Measure::released`] ne bouge jamais, c'est le zéro du total,
///   tandis que [`Measure::leg`] avance à chaque étape franchie. Un seul repère donnerait des
///   durées cumulées, où chaque étape porterait le poids des précédentes.
struct Measure {
  /// Le relâchement du raccourci : le zéro du total.
  released: Instant,
  /// Le début du tronçon en cours.
  leg: Instant,
  /// Les tronçons déjà notés.
  timeline: Timeline,
}

impl Measure {
  /// Ouvre le chronomètre sur l'instant du relâchement.
  ///
  /// # Pièges
  ///
  /// - ⚠️ `released` est l'instant du **front**, pas celui de l'appel : les actions du raccourci
  ///   passent par une file, et dater ici donnerait une latence amputée de l'attente que
  ///   l'utilisateur subit pourtant.
  fn open_at(released: Instant) -> Self {
    Self {
      released,
      leg: released,
      timeline: Timeline::default(),
    }
  }

  /// Clôt le tronçon courant et en ouvre un nouveau.
  fn close(&mut self, leg: Leg) {
    self.timeline.record(leg, self.leg.elapsed().as_millis());
    self.leg = Instant::now();
  }
}

/// Ce que la file du pipeline sait exécuter, et l'instant du front qui l'a demandé.
///
/// # Pièges
///
/// - ⚠️ [`ShortcutAction::Suppressed`] n'en fait pas partie : il n'ouvre ni ne ferme de dictée,
///   et son avertissement dure deux secondes — le faire attendre son tour, ou faire attendre un
///   arrêt derrière lui, n'aurait aucun sens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Queued {
  /// Ouvrir une dictée, l'instant de l'appui et la combinaison en main.
  Begin(Instant, Combo),
  /// Changer la langue d'écriture de la dictée en cours, l'instant du geste en main.
  Retarget(Instant, Combo),
  /// Fermer la dictée en cours, l'instant du relâchement en main.
  End(Instant),
}

/// Les actions du raccourci en attente, et l'exécutant qui les vide.
#[derive(Default)]
struct Pending {
  /// Les actions, dans l'ordre où le tap les a produites.
  actions: VecDeque<Queued>,
  /// Un exécutant vide la file en ce moment.
  draining: bool,
}

/// L'état du pipeline, monté au démarrage.
#[derive(Default)]
pub struct DictationHandle {
  /// La dictée en cours, s'il y en a une.
  current: Mutex<Option<Session>>,
  /// Le numéro de la dernière dictée ouverte. Monotone, jamais réutilisé.
  next_id: Mutex<u64>,
  /// Les actions du raccourci qui n'ont pas encore été exécutées.
  ///
  /// ⚠️ **C'est ce qui met l'ouverture et la fermeture dans l'ordre.** Une tâche par action
  /// laissait le runtime les ordonnancer comme il voulait : un arrêt pouvait s'exécuter avant
  /// que le démarrage n'ait posé sa session, ne trouvait rien à fermer, et la dictée restait
  /// ouverte — micro et pilule — jusqu'à la suivante.
  pending: Mutex<Pending>,
}

impl DictationHandle {
  /// Prend le verrou de session, en reprenant un verrou empoisonné plutôt qu'en paniquant.
  fn lock(&self) -> MutexGuard<'_, Option<Session>> {
    self
      .current
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  /// Prend le verrou de la file, en reprenant un verrou empoisonné plutôt qu'en paniquant.
  fn pending(&self) -> MutexGuard<'_, Pending> {
    self
      .pending
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  /// Pose une action dans la file, et dit s'il faut lancer un exécutant.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le drapeau se lève **sous le même verrou** que la pose : deux fronts qui arrivent
  ///   ensemble lanceraient sinon deux exécutants, et l'ordre serait de nouveau au hasard.
  fn enqueue(&self, queued: Queued) -> bool {
    let mut pending = self.pending();
    pending.actions.push_back(queued);
    let idle = !pending.draining;
    pending.draining = true;
    idle
  }

  /// L'action suivante, ou `None` — et l'exécutant est alors libéré.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La libération se fait **sous le même verrou** que le constat de file vide. La faire
  ///   après coup laisserait un front se poser entre les deux, dans une file que plus personne
  ///   ne vide : la dictée ne s'ouvrirait — ou ne se fermerait — jamais.
  fn next_queued(&self) -> Option<Queued> {
    let mut pending = self.pending();
    let next = pending.actions.pop_front();
    if next.is_none() {
      pending.draining = false;
    }
    next
  }

  /// Rend un numéro de dictée neuf, plus grand que tous les précédents.
  fn take_id(&self) -> u64 {
    let mut next = self
      .next_id
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    *next += 1;
    *next
  }
}

/// Monte le pipeline. Appelé une fois, dans `.setup()`.
pub fn setup(app: &tauri::AppHandle) {
  commands::remember_app(app);
  app.manage(DictationHandle::default());
}

/// Le raccourci a parlé. Rend la main immédiatement.
///
/// # Pièges
///
/// - ⚠️ Appelé depuis le fil du tap clavier, qui distribue les évènements de toute la session :
///   rien de lent ne doit s'y faire, d'où l'enfilement sans attente.
/// - ⚠️ L'instant du front se relève **ici**, sur le fil du tap : c'est le seul endroit qui date
///   le geste plutôt que son traitement. Tout ce qui juge une durée — la garde du ⌃⌥⌘ parasite,
///   la mesure de latence — part de ces deux instants-là.
pub fn on_shortcut(app: &tauri::AppHandle, action: ShortcutAction) {
  let at = Instant::now();
  let queued = match action {
    ShortcutAction::Start(combo) => Queued::Begin(at, combo),
    ShortcutAction::Retarget(combo) => Queued::Retarget(at, combo),
    ShortcutAction::Stop => Queued::End(at),
    // L'avertissement ne touche pas au pipeline : il n'a rien à faire dans la file.
    ShortcutAction::Suppressed => {
      let app = app.clone();
      tauri::async_runtime::spawn(async move { warn_suspended(&app).await });
      return;
    }
  };

  // Un exécutant à la fois : celui qui tourne prendra l'action qu'on vient de poser.
  if !app.state::<DictationHandle>().enqueue(queued) {
    return;
  }

  let app = app.clone();
  tauri::async_runtime::spawn(async move { drain(&app).await });
}

/// Exécute les actions du raccourci une par une, dans leur ordre d'arrivée.
///
/// # Pièges
///
/// - ⚠️ Le verrou de la file ne survit à aucun `await` : le tenir ferait attendre le fil du tap
///   clavier, qui distribue les évènements de toute la session.
async fn drain(app: &tauri::AppHandle) {
  loop {
    let Some(next) = app.state::<DictationHandle>().next_queued() else {
      return;
    };

    match next {
      Queued::Begin(at, combo) => begin(app, at, combo).await,
      Queued::Retarget(at, combo) => retarget(app, at, combo),
      Queued::End(at) => end(app, at).await,
    }
  }
}

/// Combien de temps la pilule dit « Dictée suspendue » avant de rendre la main au chrono.
///
/// Assez pour être lu, assez peu pour ne pas masquer l'enregistrement — c'est un avertissement,
/// pas un état.
const SUSPENDED_NOTICE_MS: u64 = 2_000;

/// Ce que la pilule affiche en ce moment, ou `None` si elle est effacée.
fn remembered(app: &tauri::AppHandle) -> Option<OverlayPayload> {
  app
    .state::<overlay::OverlayHandle>()
    .0
    .lock()
    .ok()
    .and_then(|current| *current)
}

/// ⌃⌥ a été pressé pendant une session : on le **dit**, et on ne démarre rien.
///
/// # Pièges
///
/// - ⚠️ La pilule est le seul endroit possible : l'utilisateur est dans une autre application et
///   ne verrait ni notre fenêtre ni une snackbar.
/// - ⚠️ L'état précédent n'est restauré que si l'avertissement est encore le dernier mot : la
///   session peut s'être arrêtée entre-temps, et remettre « Écoute » ferait réapparaître une
///   pilule sur une session finie.
async fn warn_suspended(app: &tauri::AppHandle) {
  let previous = remembered(app);

  let notice = OverlayPayload {
    state: OverlayState::Suspended,
    chrono: false,
  };
  if overlay::present(app, notice).is_err() {
    return;
  }

  // ⚠️ `spawn_blocking` plutôt qu'un `tokio::time::sleep` : tokio n'est pas une dépendance
  // directe du crate.
  if tauri::async_runtime::spawn_blocking(|| {
    std::thread::sleep(std::time::Duration::from_millis(SUSPENDED_NOTICE_MS));
  })
  .await
  .is_err()
  {
    return;
  }

  if remembered(app) != Some(notice) {
    return;
  }

  match previous {
    Some(payload) => {
      let _ = overlay::present(app, payload);
    }
    // Aucune pilule avant l'avertissement : il n'y a rien à restaurer, on l'efface.
    None => {
      let _ = overlay::hide_overlay(app.clone()).await;
    }
  }
}

/// Le moteur a rendu son texte — ou renoncé. Enchaîne sur les transformations.
///
/// # Pièges
///
/// - ⚠️ Un abandon du moteur ne se distingue pas d'un final : seul compte ce qui a été produit.
///   Un abandon avec du texte vaut un final ; sans texte, il finit en *Erreur*, comme un silence.
pub fn on_transcript(app: &tauri::AppHandle, text: String) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    transform(&app, text).await;
  });
}

/// Ouvre une dictée : la pilule dès que la garde de durée est franchie, le moteur tout de suite.
///
/// # Pièges
///
/// - ⚠️ `pressed` est l'instant de l'**appui**, pas celui de l'appel : c'est de lui que la garde
///   de durée tire son verdict. Redater ici ferait dépendre le sort d'un ⌃⌥⌘ parasite de ce que
///   la machine avait d'autre à faire à cet instant.
/// - ⚠️ `combo` peut encore changer : les doigts atteignent ⌃⌥⌘ en passant par ⌃⌥, et la
///   dictée s'ouvre sur ce qu'ils ont d'abord posé. Voir [`retarget`].
async fn begin(app: &tauri::AppHandle, pressed: Instant, combo: Combo) {
  let handle = app.state::<DictationHandle>();
  let id = handle.take_id();

  // ⚠️ La cible se relève ici et nulle part ailleurs : c'est maintenant que l'utilisateur a son
  // curseur là où il veut son texte, une seconde plus tard notre pilule sera passée devant.
  let (target, label) = crate::native::focus_owner();
  // Comparée à la trace du collage, celle-ci dit si l'application visée a changé en route.
  log::debug!("dictée : cible relevée au départ = {label}");

  // Une dictée déjà en cours cède la place. Le changement de numéro suffit à faire renoncer
  // son exécutant à la prochaine étape.
  let stored = read_settings(app);
  {
    let mut current = handle.lock();
    *current = Some(Session {
      run: Run::start(Plan {
        language: stored.dictation_language.clone(),
        cleanup: stored.cleanup,
        rephrasing: stored.rephrasing,
        translation_target: target_for(combo, &stored),
      }),
      started: pressed,
      id,
      target,
      measure: None,
    });
  }
  // ⚠️ Trace de course : elle date la pose de la session, que l'arrêt cherche. Sans elle, un
  // arrêt qui ne trouve rien à fermer ne dit pas s'il est passé avant ou après ce point.
  log::debug!("dictée {id} : session posée");

  // ⚠️ L'overlay part sans attendre le moteur — qui coûte ~600 ms avant son premier échantillon
  // — mais pas avant la garde de durée : afficher tout de suite ferait clignoter une pilule à
  // chaque ⌃⌥⌘ tapé dans une autre application.
  reveal_after_guard(app, id);

  let engine = app.state::<SttHandle>().0.clone();
  let language = stored.dictation_language.clone();
  let started = off_thread(move || engine.start(&language)).await;

  if let Err(error) = started {
    log::warn!("dictée impossible, moteur refusé : {}", error.kind());
    abandon(app, id, OverlayState::Error);
    return;
  }

  if let Err(error) = audio::start_capture(stored.microphone_id.clone()).await {
    log::warn!("dictée impossible, micro refusé : {}", error.kind());
    let engine = app.state::<SttHandle>().0.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || engine.cancel()).await;
    abandon(app, id, OverlayState::Error);
  }
}

/// La langue vers laquelle ⌃⌥⌘ traduit quand le champ « Traduction » ne demande rien.
///
/// # Pièges
///
/// - ⚠️ L'anglais et pas la langue de l'interface : le second raccourci existe pour écrire dans
///   une langue qu'on ne parle pas, et l'interface est réglée dans celle qu'on parle.
const DEFAULT_TRANSLATION: &str = "en";

/// Combien de temps après l'appui la combinaison peut encore changer la langue d'écriture.
///
/// # Pièges
///
/// - ⚠️ Cette fenêtre n'est pas un confort, c'est ce qui rend ⌃⌥⌘ atteignable : les doigts
///   posent ⌃⌥ avant ⌘, et sans elle la dictée partirait toujours dans la langue parlée. Au-delà,
///   l'utilisateur parle depuis longtemps — un ⌘ ajouté là est un accident, pas une demande.
const RETARGET_WINDOW_MS: u128 = 250;

/// La langue vers laquelle écrire, selon le geste et les réglages.
///
/// # Pièges
///
/// - ⚠️ **⌃⌥ ne change pas de comportement** : il rend le réglage tel quel, y compris son
///   absence. Le second raccourci s'ajoute, il ne redistribue rien.
/// - ⚠️ Traduire vers la langue parlée n'est pas traduire : le plan rend `None`, sans quoi le
///   modèle recevrait un aller-retour français → français, qui coûte une seconde pour abîmer le
///   texte.
fn target_for(combo: Combo, stored: &Stored) -> Option<String> {
  let asked = match combo {
    Combo::Spoken => stored.translation_target.clone(),
    Combo::Translated => stored
      .translation_target
      .clone()
      .or_else(|| Some(DEFAULT_TRANSLATION.to_owned())),
  };
  asked.filter(|target| *target != stored.dictation_language)
}

/// La dictée en cours change de langue d'écriture — si le geste est encore assez frais.
///
/// # Pièges
///
/// - ⚠️ Le refus au-delà de la fenêtre est **silencieux** : rien n'a commencé ni fini, et une
///   pilule qui clignoterait ici avertirait d'un geste que l'utilisateur n'a pas voulu faire.
fn retarget(app: &tauri::AppHandle, at: Instant, combo: Combo) {
  let stored = read_settings(app);
  let handle = app.state::<DictationHandle>();
  let mut current = handle.lock();
  let Some(session) = current.as_mut() else {
    return;
  };

  if at.saturating_duration_since(session.started).as_millis() > RETARGET_WINDOW_MS {
    log::debug!("changement de langue d'écriture ignoré, la dictée est déjà lancée");
    return;
  }

  if session.run.retarget(target_for(combo, &stored)) {
    log::debug!("dictée {} : langue d'écriture reprise", session.id);
  }
}

/// Montre la pilule **si la dictée a passé la garde de durée**.
///
/// # Pièges
///
/// - ⚠️ Le seul endroit où l'overlay attend : partout ailleurs il suit l'étape sans délai, une
///   dictée établie devant voir chaque changement d'état tout de suite.
fn reveal_after_guard(app: &tauri::AppHandle, id: u64) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let _ = tauri::async_runtime::spawn_blocking(|| {
      std::thread::sleep(std::time::Duration::from_millis(MIN_DICTATION_MS));
    })
    .await;

    let alive = {
      let handle = app.state::<DictationHandle>();
      let current = handle.lock();
      current.as_ref().is_some_and(|session| session.id == id)
    };
    if alive {
      show(&app, OverlayState::Listening);
    }
  });
}

/// Ferme la dictée ; le texte, lui, arrivera par [`on_transcript`].
///
/// # Pièges
///
/// - ⚠️ `released` est l'instant du **relâchement**, pas celui de l'appel : il borne la durée que
///   juge la garde, et il est le zéro de la mesure de latence.
async fn end(app: &tauri::AppHandle, released: Instant) {
  let handle = app.state::<DictationHandle>();
  let elapsed = {
    let mut current = handle.lock();
    match current.as_mut() {
      Some(session) => {
        // ⚠️ Le chronomètre part ici et nulle part ailleurs : c'est le relâchement du raccourci,
        // la borne que l'utilisateur ressent. Ouvert avant la garde de durée pour coller au
        // geste — une dictée trop brève emporte sa session, donc sa mesure.
        session.measure = Some(Measure::open_at(released));
        // ⚠️ Saturant plutôt que tronquant : `as u64` sur des millisecondes ferait qu'une durée
        // au-delà de 584 millions d'années se relit comme une dictée trop brève, donc jetée.
        // Le cas est absurde ; le sens de l'erreur ne l'est pas.
        // ⚠️ D'un front à l'autre, et non jusqu'à maintenant : c'est la durée de l'appui, la
        // seule que la garde ait le droit de juger.
        u64::try_from(
          released
            .saturating_duration_since(session.started)
            .as_millis(),
        )
        .unwrap_or(u64::MAX)
      }
      // Un arrêt sans démarrage : le raccourci s'est réinitialisé, ou la dictée a déjà été
      // abandonnée. Il n'y a rien à fermer.
      None => {
        // ⚠️ Trace de course : à comparer avec « session posée ». Cette ligne suivie d'une pose
        // de session, c'est un arrêt qui a doublé son démarrage — la dictée reste alors ouverte,
        // micro et pilule, jusqu'à la suivante.
        log::debug!("arrêt de dictée sans session à fermer");
        return;
      }
    }
  };

  // ⚠️ La garde de durée est obligatoire : ⌃⌥⌘ tapé dans une autre application produit deux
  // paires démarrage/arrêt de ~30 ms. En dessous du seuil, on annule au lieu de terminer — pas
  // de final, donc pas de texte, pas d'historique, pas de collage.
  if !long_enough(elapsed) {
    log::debug!("dictée trop brève, abandonnée sans rien produire");
    let engine = app.state::<SttHandle>().0.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || engine.cancel()).await;
    let _ = audio::stop_capture().await;
    // La session disparaît **avant** que la garde n'expire : `reveal_after_guard` ne trouvera
    // plus rien à montrer. Il n'y a donc aucune pilule à retirer — c'est précisément ce que
    // « ne laisse aucune trace » veut dire.
    handle.lock().take();
    return;
  }

  let engine = app.state::<SttHandle>().0.clone();
  let finished = off_thread(move || engine.finish()).await;
  let _ = audio::stop_capture().await;

  let id = handle.lock().as_ref().map(|session| session.id);
  let Some(id) = id else { return };

  if let Err(error) = finished {
    log::warn!("fin de dictée refusée par le moteur : {}", error.kind());
    abandon(app, id, OverlayState::Error);
    return;
  }

  watch_for_transcript(app, id);
}

/// Le temps qu'on laisse au moteur pour rendre son texte après un arrêt.
///
/// # Pièges
///
/// - ⚠️ Large à dessein : sur un moteur batch, la transcription **commence** quand
///   l'enregistrement s'arrête. Un délai serré couperait une dictée qui travaille encore.
const TRANSCRIPT_TIMEOUT_SECS: u64 = 45;

/// Ferme une dictée dont le moteur n'a jamais rien rendu.
///
/// # Pièges
///
/// - ⚠️ Le contrat du moteur promet un final ou un abandon, une fois et une seule ; ce chien de
///   garde existe pour le jour où il ne le tient pas. Sans lui, la pilule resterait sur *Écoute*
///   jusqu'à la dictée suivante, et l'utilisateur croirait le micro encore ouvert.
fn watch_for_transcript(app: &tauri::AppHandle, id: u64) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    // `spawn_blocking` plutôt qu'un `tokio::time::sleep` : tokio n'est pas une dépendance
    // directe du crate, et l'ajouter pour une attente par dictée serait cher payé.
    let _ = tauri::async_runtime::spawn_blocking(|| {
      std::thread::sleep(std::time::Duration::from_secs(TRANSCRIPT_TIMEOUT_SECS));
    })
    .await;

    let silent = {
      let handle = app.state::<DictationHandle>();
      let current = handle.lock();
      current
        .as_ref()
        .is_some_and(|session| session.id == id && session.run.awaiting_transcript())
    };
    if silent {
      log::warn!("le moteur n'a rendu aucun texte, dictée abandonnée");
      abandon(&app, id, OverlayState::Error);
    }
  });
}

/// Fait courir le texte brut jusqu'au curseur, étape après étape.
///
/// # Pièges
///
/// - ⚠️ La boucle relâche le verrou avant chaque attente et revérifie le numéro de session à
///   chaque tour : c'est ce qui rend l'annulation immédiate sans qu'aucune étape n'ait à la
///   connaître.
async fn transform(app: &tauri::AppHandle, text: String) {
  let handle = app.state::<DictationHandle>();

  let Some((id, mut step)) = ({
    let mut current = handle.lock();
    current.as_mut().map(|session| {
      // Le moteur a rendu : du relâchement jusqu'ici, tout est « moteur » — fermeture de
      // session, arrêt du micro, transcription. Voir `Leg::Engine`.
      if let Some(measure) = session.measure.as_mut() {
        measure.close(Leg::Engine);
      }
      (session.id, session.run.transcribed(text))
    })
  }) else {
    // Aucune session : la dictée a été annulée pendant que le moteur finalisait.
    return;
  };

  loop {
    if !still_current(&handle, id) {
      return;
    }
    push_overlay(app, &handle, id);

    // Le tronçon qu'on s'apprête à parcourir, relevé **avant** que le `match` ne consomme
    // l'étape. `Insert` et `Done` sont absents : le premier se chronomètre dans `insert`, où
    // le collage se termine, et le second ne parcourt rien.
    let leg = match &step {
      Step::ApplyDictionary(_) => Some(Leg::Dictionary),
      Step::Clean { .. } => Some(Leg::Cleaning),
      Step::Rephrase { .. } => Some(Leg::Rephrasing),
      Step::Translate { .. } => Some(Leg::Translation),
      Step::Insert(_) | Step::Done => None,
    };

    let produced = match step {
      Step::ApplyDictionary(text) => Ok(apply_dictionary(app, text).await),
      Step::Clean { text, language } => clean(app, text, language).await,
      Step::Rephrase {
        text,
        style,
        language,
      } => rephrase(app, text, style, &language).await,
      Step::Translate {
        text,
        source,
        target,
      } => translate(app, text, source, target).await,
      Step::Insert(text) => {
        insert(app, &handle, id, text).await;
        return;
      }
      Step::Done => {
        finish(app, &handle, id).await;
        return;
      }
    };

    let mut current = handle.lock();
    let Some(session) = current.as_mut().filter(|session| session.id == id) else {
      return;
    };
    // ⚠️ On note le tronçon même quand l'étape a renoncé : un nettoyage qui échoue au bout de
    // trois secondes a coûté trois secondes à l'utilisateur, et ne compter que les réussites
    // donnerait une latence plus flatteuse que celle qu'on subit.
    if let (Some(leg), Some(measure)) = (leg, session.measure.as_mut()) {
      measure.close(leg);
    }
    step = match produced {
      Ok(text) => session.run.advance(text),
      // Le renoncement est le même geste que la réussite : on repart du texte qu'on avait.
      Err(()) => session.run.degrade(),
    };
  }
}

/// Colle le texte, puis pose l'état terminal.
///
/// # Pièges
///
/// - ⚠️ Les trois issues du collage finissent de la même façon : la pilule dit ce que la dictée
///   a produit, pas ce que l'application d'accueil en a fait.
/// - ⚠️ Les trois issues se journalisent, réussite comprise : sans la trace du succès, « le pont
///   n'a pas été appelé » et « il a rendu `inserted` sans que rien n'apparaisse » sont
///   indiscernables. Un verdict et une issue, jamais de contenu utilisateur.
async fn insert(
  app: &tauri::AppHandle,
  handle: &State<'_, DictationHandle>,
  id: u64,
  text: String,
) {
  // La cible relevée au début de la dictée. `0` si la session s'est volatilisée entre-temps :
  // l'insertion retombe alors sur le premier plan, ce qui vaut mieux que de ne rien tenter.
  let target = handle
    .lock()
    .as_ref()
    .filter(|session| session.id == id)
    .map_or(0, |session| session.target);
  log::debug!(
    "collage : cible relevée au départ (pid {target}), premier plan actuel = {}",
    crate::native::focus_owner().1
  );
  match injection::insert_into(text, target).await {
    Ok(InjectionOutcome::Inserted) => log::debug!("collage : ⌘V posté, presse-papiers rendu"),
    // Comportement **nominal** : le curseur n'était pas dans un champ de saisie.
    Ok(InjectionOutcome::NoEditableField) => {
      log::debug!("aucun champ éditable au premier plan, rien inséré");
    }
    Err(error) => log::warn!("collage en échec : {}", error.kind()),
  }
  // ⚠️ La mesure s'arrête ici : le ⌘V est posté et le presse-papiers rendu. Ce que
  // l'application d'accueil en fait ensuite n'est pas observable, et prétendre mesurer
  // l'apparition du texte à l'écran serait mentir.
  if let Some(measure) = handle
    .lock()
    .as_mut()
    .filter(|session| session.id == id)
    .and_then(|session| session.measure.as_mut())
  {
    measure.close(Leg::Insertion);
  }
  finish(app, handle, id).await;
}

/// Pose l'état terminal de la session, la retire, et archive ce qu'elle a produit.
///
/// # Pièges
///
/// - ⚠️ [`crate::dictation::Run::ending`] et non `overlay()` : à cet instant la machine est
///   encore sur *Insertion*, dont `overlay()` rend un état d'attente que la pilule n'efface
///   jamais — elle resterait à l'écran indéfiniment après une dictée pourtant collée.
/// - ⚠️ On affiche, puis on archive : l'écriture en base traverse un `spawn_blocking`, et la
///   faire d'abord retarderait le verdict visible d'une dictée déjà au curseur.
async fn finish(app: &tauri::AppHandle, handle: &State<'_, DictationHandle>, id: u64) {
  let ended = {
    let mut current = handle.lock();
    let Some(session) = current.as_ref().filter(|session| session.id == id) else {
      return;
    };
    let state = session.run.ending();
    let variants = session.run.variants();
    // ⚠️ Le format de cette ligne est un contrat avec `scripts/latency-report.mjs`. `log` est en
    // `release_max_level_warn` : elle est retirée à la compilation en production.
    if let Some(measure) = session.measure.as_ref() {
      log::debug!(
        "{}",
        measure
          .timeline
          .report(measure.released.elapsed().as_millis(), session.run.plan())
      );
    }
    current.take();
    (state, variants)
  };
  let (state, variants) = ended;
  // L'overlay s'efface lui-même sur un état terminal — voir `overlay-shell.component.ts`.
  show(app, state);

  // ⚠️ Une dictée sans texte ne s'archive pas : il n'y a rien à retrouver, et une ligne vide
  // consommerait une place du plafond de l'historique.
  if !variants.raw.trim().is_empty() {
    dictations::record(app, variants).await;
  }
}

/// Abandonne la dictée numéro `id` et pose un état terminal ; sans effet si elle a déjà cédé
/// la place.
fn abandon(app: &tauri::AppHandle, id: u64, state: OverlayState) {
  let handle = app.state::<DictationHandle>();
  {
    let mut current = handle.lock();
    if current.as_ref().is_none_or(|session| session.id != id) {
      return;
    }
    current.take();
  }
  show(app, state);
}

/// La dictée numéro `id` est-elle toujours celle en cours ?
fn still_current(handle: &State<'_, DictationHandle>, id: u64) -> bool {
  handle
    .lock()
    .as_ref()
    .is_some_and(|session| session.id == id)
}

/// Accorde la pilule à l'étape où en est la dictée numéro `id`.
fn push_overlay(app: &tauri::AppHandle, handle: &State<'_, DictationHandle>, id: u64) {
  let state = handle
    .lock()
    .as_ref()
    .filter(|session| session.id == id)
    .map(|session| session.run.overlay());
  if let Some(state) = state {
    show(app, state);
  }
}

/// Publie un état sur la pilule, et journalise si elle ne répond pas.
///
/// # Pièges
///
/// - ⚠️ Toujours sans chrono : c'est la seule différence entre dictée et session — « Écoute »
///   dure quelques secondes en dictée, toute la séance en session.
fn show(app: &tauri::AppHandle, state: OverlayState) {
  if let Err(error) = overlay::present(
    app,
    OverlayPayload {
      state,
      chrono: false,
    },
  ) {
    log::warn!("overlay non affiché : {error}");
  }
}

/// Les réglages, relus **à chaque dictée** : ils changent pendant que l'application tourne.
///
/// Voir [`crate::settings`].
fn read_settings(app: &tauri::AppHandle) -> Stored {
  match app.try_state::<AppState>() {
    Some(state) => Stored::read(&state.data_dir().join(i18n::SETTINGS_FILE)),
    // L'état n'est pas monté : impossible en pratique, le pipeline étant monté après lui.
    None => Stored::default(),
  }
}

// Les étapes, chacune réduite à « du texte, ou rien ».
//
// ⚠️ `Err(())` et non `Err(AppError)` : à ce niveau, la seule chose qui compte est de savoir si
// l'étape a produit du texte. Faire remonter la cause inviterait à la traiter différemment selon
// les cas, ce que la machine existe précisément pour éviter.

/// Le dictionnaire personnel, sur le texte **brut**, avant le nettoyage.
///
/// # Pièges
///
/// - ⚠️ Seule étape qui ne rend pas `Result<_, ()>` : elle corrige au lieu d'améliorer, et un
///   dictionnaire vide, illisible ou inexistant rend exactement le texte d'entrée. Lui faire
///   emprunter le chemin de la dégradation ferait croire à un échec là où il n'y a rien eu à
///   faire.
/// - ⚠️ Le texte dicté n'apparaît dans aucun journal, pas même en cas d'échec de lecture.
async fn apply_dictionary(app: &tauri::AppHandle, text: String) -> String {
  let database = app.state::<AppState>().database();
  match commands::dictionary::load(database).await {
    Ok(entries) => crate::dictionary::apply(&text, &entries).into_owned(),
    Err(error) => {
      log::warn!("dictionnaire personnel non appliqué ({}) ", error.kind());
      text
    }
  }
}

/// Le nettoyage du texte par le modèle de langue, dans la langue parlée.
///
/// # Errors
///
/// Rend `Err(())` si le modèle est indisponible, si sa sortie est jugée invraisemblable, si elle
/// a changé de langue, ou si la tâche n'est pas revenue. L'appelant repart alors du texte
/// d'entrée.
///
/// # Pièges
///
/// - ⚠️ `language` vient du plan, pas des réglages relus : même règle qu'en reformulation.
async fn clean(app: &tauri::AppHandle, text: String, language: String) -> Result<String, ()> {
  let engine = app.state::<LlmHandle>().0.clone();
  let raw = text.clone();
  let spoken = language.clone();
  let outcome = tauri::async_runtime::spawn_blocking(move || engine.clean(&text, &spoken)).await;

  match outcome {
    // ⚠️ Trois garde-fous, et ils ne regardent pas la même chose : `is_plausible_cleanup` juge ce
    // qui manque de l'entrée et ce qui s'y ajoute — il attrape une réponse, ou les consignes
    // récitées, à la place d'une correction —, `restore_substitutions` regarde les mots, que le
    // premier laisse passer à longueur égale, et `changed_language` regarde la langue, que les
    // deux autres laissent passer entièrement.
    Ok(Ok(cleaned)) if crate::llm::is_plausible_cleanup(&raw, &cleaned) => {
      let repaired = crate::llm::fidelity::restore_substitutions(&raw, &cleaned);
      if super::cleanup_changed_language(&language, &raw, &repaired) {
        log::warn!("sortie du modèle écartée : le nettoyage a changé de langue");
        return Err(());
      }
      Ok(repaired)
    }
    Ok(Ok(_)) => {
      log::warn!("sortie du modèle écartée : trop éloignée du texte dicté");
      Err(())
    }
    Ok(Err(error)) => {
      // ⚠️ Le message et non le seul genre : « native » ne nomme aucune cause, et un refus
      // du modèle ne se diagnostique pas autrement — voir `LanguageModel.modelRefusal`.
      log::warn!("nettoyage impossible ({}) : {error}", error.kind());
      Err(())
    }
    Err(_) => Err(()),
  }
}

/// La reformulation du texte nettoyé, dans le style demandé.
///
/// # Errors
///
/// Rend `Err(())` si le style personnalisé n'a pas de description, si le modèle est
/// indisponible, si sa sortie est jugée aberrante, ou si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ `language` vient du plan, pas des réglages relus : relire le réglage ici reformulerait
///   la fin d'une dictée dans une langue que l'utilisateur vient de changer en cours de route.
async fn rephrase(
  app: &tauri::AppHandle,
  text: String,
  style: RephrasingStyle,
  language: &str,
) -> Result<String, ()> {
  // Le prompt personnalisé vit dans la base chiffrée, et n'est lu que si le style l'exige.
  let custom = if style == RephrasingStyle::Custom {
    let Some(state) = app.try_state::<AppState>() else {
      return Err(());
    };
    match prompts::read_rephrasing_prompt(state.database()).await {
      Ok(Some(prompt)) => Some(prompt),
      // ⚠️ Style personnalisé sans description : on ne reformule pas, on garde le nettoyé.
      // C'est un réglage incomplet, pas une panne.
      Ok(None) => return Err(()),
      Err(error) => {
        log::warn!("prompt de reformulation illisible : {}", error.kind());
        return Err(());
      }
    }
  } else {
    None
  };

  let engine = app.state::<LlmHandle>().0.clone();
  let source = text.clone();
  let spoken = language.to_owned();
  let outcome = tauri::async_runtime::spawn_blocking(move || {
    engine.rephrase(&text, style, custom.as_deref(), &spoken)
  })
  .await;

  match outcome {
    Ok(Ok(rephrased)) if crate::llm::is_plausible_rephrasing(&source, &rephrased) => Ok(rephrased),
    Ok(Ok(_)) => {
      log::warn!("sortie de reformulation écartée : longueur aberrante");
      Err(())
    }
    Ok(Err(error)) => {
      log::warn!("reformulation impossible ({}) : {error}", error.kind());
      Err(())
    }
    Err(_) => Err(()),
  }
}

/// La traduction du texte, de `source` vers `target`.
///
/// # Errors
///
/// Rend `Err(())` si la paire est absente ou non prise en charge, si le moteur échoue, ou si la
/// tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ La langue source vient de la machine, pas des réglages : la relire ici traduirait la fin
///   d'une dictée depuis une langue que l'utilisateur vient de changer en cours de route.
async fn translate(
  app: &tauri::AppHandle,
  text: String,
  source: String,
  target: String,
) -> Result<String, ()> {
  let engine = app.state::<TranslationHandle>().0.clone();

  // ⚠️ Traduire vers la langue parlée n'a pas de sens et le framework le refuserait : on
  // garde le texte tel quel, sans compter cela comme un renoncement visible.
  if source == target {
    return Ok(text);
  }

  let outcome =
    tauri::async_runtime::spawn_blocking(move || engine.translate(&source, &target, &text)).await;

  match outcome {
    Ok(Ok(TranslationOutcome::Translated { text })) => Ok(text),
    // Paire absente ou non supportée : issues nominales, pas des pannes.
    // ⚠️ Le motif ne cite aucune langue : le couple parlé/traduit en dit déjà long sur
    // qui écrit à qui.
    Ok(Ok(TranslationOutcome::PairMissing { .. })) => {
      log::debug!("traduction non effectuée : paire absente de la machine");
      Err(())
    }
    Ok(Ok(TranslationOutcome::PairUnsupported { .. })) => {
      log::debug!("traduction non effectuée : paire non prise en charge");
      Err(())
    }
    Ok(Err(error)) => {
      log::warn!("traduction impossible : {}", error.kind());
      Err(())
    }
    Err(_) => Err(()),
  }
}

/// Abandonne la dictée en cours : ni overlay orphelin, ni presse-papiers modifié.
///
/// Idempotente : sans dictée en cours, ne fait rien.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la pilule refuse de s'effacer ; l'annulation du moteur et l'arrêt
/// du micro, eux, ne remontent rien.
#[tauri::command]
pub async fn cancel_dictation(app: tauri::AppHandle) -> Result<(), AppError> {
  let taken = {
    let handle = app.state::<DictationHandle>();
    let mut current = handle.lock();
    current.take().map(|mut session| {
      session.run.cancel();
    })
  };
  if taken.is_none() {
    return Ok(());
  }

  let engine = app.state::<SttHandle>().0.clone();
  let _ = tauri::async_runtime::spawn_blocking(move || engine.cancel()).await;
  let _ = audio::stop_capture().await;
  overlay::hide_overlay(app).await
}

#[cfg(test)]
mod tests {
  use super::{DictationHandle, Queued, target_for};
  use crate::{settings::Stored, shortcut::Combo};
  use std::time::Instant;

  /// Les réglages d'un francophone, avec ou sans langue de traduction choisie.
  fn speaking_french(target: Option<&str>) -> Stored {
    Stored {
      dictation_language: "fr".to_owned(),
      translation_target: target.map(str::to_owned),
      ..Stored::default()
    }
  }

  /// **La table de vérité de la fonction, et c'est tout le produit.** Tu parles français, tu dis
  /// « bonjour » : la seule case qui distingue les deux gestes est celle du bas à gauche, et
  /// c'est elle qui évite d'aller régler la traduction dans l'écran Dictée pour une phrase.
  ///
  /// ⚠️ **⌃⌥ ne change pas de comportement**, ligne du haut comme ligne du bas : c'est la
  /// condition qui a été posée. Le second raccourci s'ajoute, il ne redistribue rien.
  #[test]
  fn each_combo_writes_in_the_language_the_table_promises() {
    let none = speaking_french(None);
    let english = speaking_french(Some("en"));

    assert_eq!(target_for(Combo::Spoken, &none), None, "bonjour");
    assert_eq!(
      target_for(Combo::Translated, &none).as_deref(),
      Some("en"),
      "hello — la seule case qui fait exister la fonction"
    );
    assert_eq!(
      target_for(Combo::Spoken, &english).as_deref(),
      Some("en"),
      "hello, comme aujourd'hui"
    );
    assert_eq!(
      target_for(Combo::Translated, &english).as_deref(),
      Some("en"),
      "hello"
    );
  }

  /// Le champ désigne la cible dès qu'il en désigne une : ⌃⌥⌘ ne repart pas sur l'anglais quand
  /// l'utilisateur a demandé l'espagnol.
  #[test]
  fn the_chosen_language_wins_over_the_default() {
    let spanish = speaking_french(Some("es"));

    assert_eq!(
      target_for(Combo::Translated, &spanish).as_deref(),
      Some("es")
    );
  }

  /// ⚠️ **Traduire vers la langue parlée n'est pas traduire.** Un anglophone qui tient ⌃⌥⌘
  /// enverrait sinon son texte faire un aller-retour anglais → anglais : une seconde de latence
  /// pour un texte que le modèle ne peut qu'abîmer.
  #[test]
  fn translating_into_the_spoken_language_is_not_translating() {
    let english_speaker = Stored {
      dictation_language: "en".to_owned(),
      translation_target: None,
      ..Stored::default()
    };
    let asked_for_its_own_language = Stored {
      dictation_language: "fr".to_owned(),
      translation_target: Some("fr".to_owned()),
      ..Stored::default()
    };

    assert_eq!(target_for(Combo::Translated, &english_speaker), None);
    assert_eq!(target_for(Combo::Spoken, &asked_for_its_own_language), None);
    assert_eq!(
      target_for(Combo::Translated, &asked_for_its_own_language),
      None
    );
  }

  /// **L'invariant que la file existe pour tenir.** Une tâche par action laissait le runtime
  /// ordonnancer l'arrêt avant le démarrage : l'arrêt ne trouvait alors aucune session à
  /// fermer, et la dictée restait ouverte — micro et pilule — jusqu'à la suivante.
  #[test]
  fn the_queue_hands_back_the_edges_in_the_order_they_arrived() {
    let handle = DictationHandle::default();
    let first = Instant::now();
    let second = Instant::now();

    handle.enqueue(Queued::Begin(first, Combo::Spoken));
    handle.enqueue(Queued::End(second));

    assert_eq!(
      handle.next_queued(),
      Some(Queued::Begin(first, Combo::Spoken))
    );
    assert_eq!(handle.next_queued(), Some(Queued::End(second)));
  }

  /// Un seul exécutant : le deuxième front se contente de poser son action, celui qui tourne
  /// la prendra. Deux exécutants remettraient l'ordre au hasard.
  #[test]
  fn only_the_first_edge_starts_an_executor() {
    let handle = DictationHandle::default();

    assert!(handle.enqueue(Queued::Begin(Instant::now(), Combo::Translated)));
    assert!(!handle.enqueue(Queued::End(Instant::now())));
  }

  /// ⚠️ La file vide libère l'exécutant, et le front suivant en relance un. Sans cette
  /// libération, plus rien ne viderait jamais la file : la dictée d'après ne s'ouvrirait pas.
  #[test]
  fn an_empty_queue_frees_the_executor_for_the_next_edge() {
    let handle = DictationHandle::default();
    handle.enqueue(Queued::Begin(Instant::now(), Combo::Translated));
    handle.next_queued();

    assert_eq!(handle.next_queued(), None);
    assert!(
      handle.enqueue(Queued::End(Instant::now())),
      "le front suivant doit relancer un exécutant"
    );
  }

  /// Les numéros de session sont **monotones et jamais réutilisés** : c'est ce qui fait du
  /// numéro un jeton d'annulation fiable. Une réutilisation ferait reprendre une dictée
  /// abandonnée par la suivante.
  #[test]
  fn session_ids_never_repeat() {
    let handle = DictationHandle::default();
    let ids: Vec<u64> = (0..100).map(|_| handle.take_id()).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "aucun numéro ne doit se répéter");
    assert!(
      ids.windows(2).all(|pair| pair[0] < pair[1]),
      "les numéros doivent croître"
    );
  }

  #[test]
  fn a_fresh_handle_has_no_session() {
    let handle = DictationHandle::default();
    assert!(handle.lock().is_none());
  }
}
