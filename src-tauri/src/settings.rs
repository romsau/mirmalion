//! Les réglages non sensibles, lus directement dans le fichier du frontend.
//!
//! `tauri-plugin-store` appartient au webview : le lire par lui suppose un frontend démarré.
//! Or la langue d'interface, le thème, le mode de dictée et tout le pipeline natif de dictée
//! ont besoin de ces valeurs avant — ou sans — qu'un webview existe.
//!
//! # Pièges
//!
//! - ⚠️ C'est une lecture, jamais une écriture. Le frontend reste le seul à écrire ce fichier ;
//!   y écrire d'ici ferait diverger deux sources sans qu'aucune ne le sache.
//! - ⚠️ Les défauts doivent rester d'accord avec `DEFAULT_SETTINGS` de
//!   `src/app/core/models/settings.ts` — un test de chaque côté les compare.
//! - ⚠️ Le fichier est un JSON en clair, éditable à la main : rien de sensible n'y entre — le
//!   prompt personnalisé vit dans la base chiffrée — et chaque champ est validé seul, pour
//!   qu'un champ abîmé ne fasse pas perdre les autres.

use std::path::Path;

use crate::{llm::RephrasingStyle, shortcut::ShortcutMode};

/// La langue parlée par défaut : l'anglais, comme `DEFAULT_SETTINGS` côté TypeScript.
const DEFAULT_LANGUAGE: &str = "en";

/// Ce que le backend sait des choix de l'utilisateur.
///
/// # Pièges
///
/// - ⚠️ Une lecture est un instantané. Les réglages changent pendant que l'application tourne :
///   le pipeline en relit un à chaque dictée plutôt que d'en garder un en mémoire, qu'un
///   changement d'écran rendrait aussitôt faux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
  /// L'utilisateur a-t-il déjà traversé l'accueil de premier lancement ?
  pub onboarding_completed: bool,
  /// `"light"` ou `"dark"`, ou `None` quand rien n'est écrit — au premier lancement, macOS
  /// suit alors l'apparence du système, ce qui est le meilleur défaut possible.
  pub theme: Option<String>,
  /// Maintien ou bascule : ce que fait le raccourci global de dictée.
  pub dictation_mode: ShortcutMode,
  /// Le code de la langue parlée : `fr`, `en`, `ja`…
  pub dictation_language: String,
  /// L'identifiant du micro choisi, ou `None` pour celui du système.
  pub microphone_id: Option<String>,
  /// Le nettoyage par le modèle de langue est-il appliqué aux dictées ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ Vrai par défaut : c'est ce que l'application a toujours fait, et un fichier de réglages
  ///   écrit avant l'interrupteur ne dit rien de lui. Le rendre faux par défaut éteindrait le
  ///   nettoyage de tout le monde à la mise à jour.
  pub cleanup: bool,
  /// Le style de reformulation demandé, ou `None` pour « pas de reformulation ».
  ///
  /// # Pièges
  ///
  /// - ⚠️ L'interrupteur et le style sont **deux** réglages côté interface, et un seul ici : le
  ///   style survit à l'extinction là-bas, mais ce qui traverse le pont est la seule question qui
  ///   intéresse le pipeline — reformuler, et dans quel style. Un interrupteur éteint rend
  ///   `None`, quel que soit le style retenu.
  /// - ⚠️ Le `none` du menu ne devient pas une variante de [`crate::llm::RephrasingStyle`], il
  ///   devient l'absence d'étape — sinon chaque appelant aurait deux façons de ne rien faire.
  pub rephrasing: Option<RephrasingStyle>,
  /// La langue cible de traduction, ou `None` pour « Pas de traduction ».
  pub translation_target: Option<String>,
  /// Combien de dictées l'historique conserve. FIFO au-delà.
  pub dictation_retention: i64,
  /// L'application apparaît-elle dans le Dock ? L'application vit dans la barre des menus ;
  /// l'y ajouter est un choix explicite.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Faux par défaut, et lu avant tout frontend : la politique d'activation se pose au
  ///   démarrage, bien avant qu'un webview n'existe. Attendre le frontend ferait apparaître
  ///   puis disparaître l'icône.
  pub show_in_dock: bool,
  /// L'indicateur visuel — la pilule flottante — s'affiche-t-il pendant un direct ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ Vrai par défaut : un booléen absent du fichier doit montrer l'indicateur, sinon un
  ///   enregistrement tourne sans aucun repère à l'écran sur une machine jamais réglée.
  /// - ⚠️ Il ne parle que du direct, où la pilule peut rester des heures au-dessus de toutes
  ///   les applications, donc dans un partage d'écran ; en dictée elle dure trois secondes.
  /// - ⚠️ L'éteindre ne laisse pas zéro repère : l'état d'enregistrement du tray, lui, ne se
  ///   règle pas — voir [`crate::tray::set_recording`].
  pub live_overlay_visible: bool,
  /// L'ancienneté au-delà de laquelle une session archivée est purgée.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Une ancienneté, pas un nombre — l'inverse de la dictée. On ne stocke que du texte,
  ///   et un plafond en nombre dépendrait de la fréquence des sessions : un mois d'historique
  ///   chez l'un, deux ans chez l'autre.
  /// - ⚠️ La valeur voyage telle quelle — `"30d"`, `"6m"`, `"unlimited"` — et c'est
  ///   [`crate::live::history::retention_cutoff`] qui la traduit, en un seul endroit.
  pub live_retention: String,
}

impl Default for Stored {
  fn default() -> Self {
    Self {
      onboarding_completed: false,
      theme: None,
      dictation_mode: ShortcutMode::Hold,
      dictation_language: DEFAULT_LANGUAGE.to_owned(),
      microphone_id: None,
      rephrasing: None,
      cleanup: true,
      translation_target: None,
      dictation_retention: DEFAULT_DICTATION_RETENTION,
      show_in_dock: true,
      live_overlay_visible: true,
      live_retention: "6m".to_owned(),
    }
  }
}

impl Stored {
  /// Lit le fichier de réglages, ou rend les défauts.
  ///
  /// # Pièges
  ///
  /// - ⚠️ N'échoue jamais : fichier absent, JSON tronqué, champ d'un type inattendu — tout ce
  ///   qui ne se lit pas vaut son défaut, et un champ abîmé ne fait pas perdre les autres.
  pub fn read(settings_file: &Path) -> Self {
    let Ok(raw) = std::fs::read_to_string(settings_file) else {
      return Self::default();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
      return Self::default();
    };
    Self::from_json(&parsed)
  }

  /// Relève chaque champ du JSON déjà analysé, indépendamment des autres.
  fn from_json(parsed: &serde_json::Value) -> Self {
    let defaults = Self::default();
    let text = |key: &str| parsed.get(key).and_then(serde_json::Value::as_str);

    Self {
      onboarding_completed: parsed
        .get("onboardingCompleted")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(defaults.onboarding_completed),
      theme: text("theme")
        .filter(|value| matches!(*value, "light" | "dark"))
        .map(str::to_owned),
      dictation_mode: match text("dictationMode") {
        Some("hold") => ShortcutMode::Hold,
        Some("toggle") => ShortcutMode::Toggle,
        _ => defaults.dictation_mode,
      },
      dictation_language: text("dictationLanguage")
        .filter(|value| is_scope_language(value))
        .unwrap_or(DEFAULT_LANGUAGE)
        .to_owned(),
      microphone_id: text("microphoneId").map(str::to_owned),
      cleanup: parsed
        .get("cleanupEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(defaults.cleanup),
      // ⚠️ **Les deux champs sont lus ensemble, et l'interrupteur commande.** Un fichier écrit
      // avant lui ne porte que le style : `rephrasingEnabled` absent vaut alors « allumé », ce
      // que `rephrased_before` tranche — sans quoi la mise à jour éteindrait la reformulation
      // de qui l'avait réglée.
      rephrasing: rephrased_before(parsed)
        .then(|| text("rephrasingMode").and_then(parse_rephrasing))
        .flatten(),
      translation_target: text("translationTarget")
        .filter(|value| is_scope_language(value))
        .map(str::to_owned),
      dictation_retention: parsed
        .get("dictationRetention")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| DICTATION_RETENTIONS.contains(value))
        .unwrap_or(defaults.dictation_retention),
      show_in_dock: parsed
        .get("showInDock")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(defaults.show_in_dock),
      live_overlay_visible: parsed
        .get("liveOverlayVisible")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(defaults.live_overlay_visible),
      // ⚠️ Pas de filtre sur la liste des paliers ici : une valeur inconnue retombe sur le
      // défaut dans `retention_cutoff`. Filtrer aussi ici donnerait deux endroits où tenir la
      // liste — donc un endroit où l'oublier.
      live_retention: text("liveRetention")
        .unwrap_or(&defaults.live_retention)
        .to_owned(),
    }
  }
}

/// Les plafonds d'historique de dictée proposés. Miroir de `DICTATION_RETENTIONS` côté
/// TypeScript.
///
/// # Pièges
///
/// - ⚠️ Une valeur hors liste rend le défaut, elle n'est pas ramenée dans les bornes. Le
///   fichier est éditable à la main : `dictationRetention: 5000000` ne doit pas devenir un
///   plafond d'un million, ni `1` purger l'historique à chaque dictée.
pub const DICTATION_RETENTIONS: [i64; 4] = [50, 100, 200, 500];

/// Le plafond d'historique de dictée retenu quand rien n'est écrit.
pub const DEFAULT_DICTATION_RETENTION: i64 = 200;

/// Les 6 langues traitées de bout en bout. Miroir de `LANGUAGES` côté TypeScript.
///
/// # Pièges
///
/// - ⚠️ Une langue hors de cette liste est refusée, jamais transmise : elle atteindrait le
///   moteur de transcription, qui refuserait la session — l'utilisateur verrait une dictée en
///   panne pour un fichier de réglages édité à la main.
/// - ⚠️ Distincte d'[`crate::i18n::SUPPORTED_LOCALES`], et elle le reste : rien n'oblige à
///   traduire l'interface dans chaque langue qu'on sait transcrire. Ce sont les mêmes six
///   aujourd'hui, et un test les lie pour qu'aucune ne bouge sans qu'on regarde l'autre.
pub const LANGUAGES: [&str; 6] = ["fr", "en", "es", "de", "it", "pt"];

/// Ce code de langue fait-il partie des 6 traitées ?
fn is_scope_language(value: &str) -> bool {
  LANGUAGES.contains(&value)
}

/// La reformulation est-elle demandée ? Lit l'interrupteur, et à défaut l'ancien champ seul.
///
/// # Pièges
///
/// - ⚠️ Ne se rabat sur le style **que** si l'interrupteur est absent du fichier : dès qu'il
///   existe, il fait foi. Sans cette garde, une reformulation éteinte sur un style choisi se
///   rallumerait seule à la relecture suivante.
fn rephrased_before(parsed: &serde_json::Value) -> bool {
  match parsed
    .get("rephrasingEnabled")
    .and_then(serde_json::Value::as_bool)
  {
    Some(asked) => asked,
    None => parsed
      .get("rephrasingMode")
      .and_then(serde_json::Value::as_str)
      .is_some_and(|style| style != "none"),
  }
}

/// Le style de reformulation écrit dans le fichier, ou `None` s'il n'y a pas d'étape.
///
/// # Pièges
///
/// - ⚠️ `"none"` rend `None`, comme une valeur inconnue : les deux veulent dire « pas de
///   reformulation », et les distinguer obligerait chaque appelant à traiter deux façons de
///   ne rien faire.
fn parse_rephrasing(value: &str) -> Option<RephrasingStyle> {
  match value {
    "standard" => Some(RephrasingStyle::Standard),
    "professional" => Some(RephrasingStyle::Professional),
    "concise" => Some(RephrasingStyle::Concise),
    "detailed" => Some(RephrasingStyle::Detailed),
    "friendly" => Some(RephrasingStyle::Friendly),
    "custom" => Some(RephrasingStyle::Custom),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::{DEFAULT_DICTATION_RETENTION, DICTATION_RETENTIONS, LANGUAGES, Stored};
  use crate::{llm::RephrasingStyle, shortcut::ShortcutMode};

  fn read(json: serde_json::Value) -> Stored {
    Stored::from_json(&json)
  }

  /// ⚠️ Deux périmètres, deux constantes, et rien qui les liait. Ils sont conceptuellement
  /// distincts — on peut savoir transcrire une langue sans traduire l'interface dedans — mais
  /// ils sont **les mêmes six** aujourd'hui, et une langue ajoutée d'un seul côté ne se voyait
  /// nulle part.
  #[test]
  fn the_spoken_and_interface_scopes_agree() {
    let mut spoken = LANGUAGES.to_vec();
    let mut interface = crate::i18n::SUPPORTED_LOCALES.to_vec();
    spoken.sort_unstable();
    interface.sort_unstable();
    assert_eq!(
      spoken, interface,
      "les langues parlées et les langues d'interface ont divergé : si c'est voulu, c'est ce \
       test qui doit dire pourquoi"
    );
  }

  /// Les défauts sont **le contrat partagé avec `DEFAULT_SETTINGS`** de
  /// `src/app/core/models/settings.ts`. Les faire diverger donnerait deux comportements
  /// différents selon qu'un réglage a déjà été écrit ou non — le pire des bogues à reproduire.
  #[test]
  fn the_defaults_match_the_typescript_side() {
    let defaults = Stored::default();
    assert!(!defaults.onboarding_completed);
    assert_eq!(defaults.theme, None);
    assert_eq!(defaults.dictation_mode, ShortcutMode::Hold);
    assert_eq!(defaults.dictation_language, "en");
    assert_eq!(defaults.microphone_id, None);
    assert_eq!(defaults.rephrasing, None);
    assert_eq!(defaults.translation_target, None);
    assert_eq!(defaults.dictation_retention, 200);
    assert!(defaults.show_in_dock);
    assert!(defaults.live_overlay_visible);
    assert_eq!(defaults.live_retention, "6m");
  }

  /// ⚠️ L'indicateur reste affiché tant que personne n'a dit le contraire. Fichier absent,
  /// tronqué, clé manquante, mauvais type : chacun de ces cas doit le montrer. L'inverse
  /// laisserait un enregistrement tourner sans le moindre repère à l'écran, sur une machine où
  /// personne n'a rien réglé.
  #[test]
  fn the_live_indicator_stays_on_unless_the_file_says_otherwise() {
    assert!(read(serde_json::json!({})).live_overlay_visible);
    assert!(read(serde_json::json!({ "liveOverlayVisible": "non" })).live_overlay_visible);
    assert!(read(serde_json::json!({ "liveOverlayVisible": true })).live_overlay_visible);
    assert!(!read(serde_json::json!({ "liveOverlayVisible": false })).live_overlay_visible);
  }

  /// Les quatre paliers de rétention sont acceptés tels quels.
  #[test]
  fn every_offered_retention_tier_is_accepted() {
    for tier in DICTATION_RETENTIONS {
      let stored = read(serde_json::json!({ "dictationRetention": tier }));
      assert_eq!(stored.dictation_retention, tier);
    }
  }

  /// ⚠️ **Une valeur hors liste rend le DÉFAUT, elle n'est pas ramenée dans les bornes.** Le
  /// fichier est un JSON en clair qu'on peut éditer à la main : accepter `1` purgerait
  /// l'historique à chaque dictée, accepter `5000000` ne le purgerait jamais.
  #[test]
  fn a_retention_outside_the_offered_tiers_falls_back_to_the_default() {
    for absurd in [
      serde_json::json!(1),
      serde_json::json!(0),
      serde_json::json!(-10),
      serde_json::json!(5_000_000),
      serde_json::json!("200"),
      serde_json::json!(null),
    ] {
      let stored = read(serde_json::json!({ "dictationRetention": absurd }));
      assert_eq!(
        stored.dictation_retention, DEFAULT_DICTATION_RETENTION,
        "valeur refusée : {absurd}"
      );
    }
  }

  #[test]
  fn an_absent_file_gives_the_defaults() {
    let missing = std::env::temp_dir().join("mirmalion-settings-qui-n-existe-pas.json");
    assert_eq!(Stored::read(&missing), Stored::default());
  }

  #[test]
  fn a_broken_file_gives_the_defaults() {
    let path = std::env::temp_dir().join(format!("mirmalion-settings-{}.json", std::process::id()));
    std::fs::write(&path, "{ ceci n'est pas du JSON").expect("écriture");
    assert_eq!(Stored::read(&path), Stored::default());
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn a_full_file_is_read_whole() {
    let stored = read(serde_json::json!({
      "onboardingCompleted": true,
      "theme": "dark",
      "dictationMode": "toggle",
      "dictationLanguage": "fr",
      "microphoneId": "77",
      "rephrasingMode": "professional",
      "translationTarget": "it",
    }));

    assert!(stored.onboarding_completed);
    assert_eq!(stored.theme.as_deref(), Some("dark"));
    assert_eq!(stored.dictation_mode, ShortcutMode::Toggle);
    assert_eq!(stored.dictation_language, "fr");
    assert_eq!(stored.microphone_id.as_deref(), Some("77"));
    assert_eq!(stored.rephrasing, Some(RephrasingStyle::Professional));
    assert_eq!(stored.translation_target.as_deref(), Some("it"));
  }

  /// ⚠️ **Un champ abîmé ne doit pas faire perdre les autres.** Le fichier est en clair et
  /// éditable à la main ; une version future peut aussi y écrire des valeurs inconnues.
  /// **Le nettoyage est allumé tant que rien ne dit le contraire.** Un fichier écrit avant
  /// l'interrupteur ne le mentionne pas : le rendre faux par défaut éteindrait le nettoyage de
  /// tout le monde à la mise à jour.
  #[test]
  fn cleaning_stays_on_until_the_file_says_otherwise() {
    assert!(read(serde_json::json!({})).cleanup);
    assert!(read(serde_json::json!({ "cleanupEnabled": true })).cleanup);
    assert!(!read(serde_json::json!({ "cleanupEnabled": false })).cleanup);
    assert!(
      read(serde_json::json!({ "cleanupEnabled": "oui" })).cleanup,
      "une valeur inexploitable retombe sur le défaut, elle n'éteint rien"
    );
  }

  /// **L'interrupteur de reformulation commande, et l'ancien fichier est relu quand il manque.**
  /// La table entière est ici : c'est elle qui décide si une mise à jour perd le réglage de
  /// quelqu'un.
  #[test]
  fn the_rephrasing_switch_wins_over_the_style_it_remembers() {
    let asked = |value| read(value).rephrasing;

    assert_eq!(
      asked(serde_json::json!({ "rephrasingMode": "professional" })),
      Some(RephrasingStyle::Professional),
      "fichier d'avant l'interrupteur : le style seul vaut « allumé »"
    );
    assert_eq!(
      asked(serde_json::json!({ "rephrasingMode": "none" })),
      None,
      "fichier d'avant, réglé sur « pas de reformulation »"
    );
    assert_eq!(
      asked(serde_json::json!({
        "rephrasingEnabled": false,
        "rephrasingMode": "professional",
      })),
      None,
      "⚠️ LA CASE QUI FAIT EXISTER LA FONCTION : éteint sur un style choisi reste éteint"
    );
    assert_eq!(
      asked(serde_json::json!({
        "rephrasingEnabled": true,
        "rephrasingMode": "concise",
      })),
      Some(RephrasingStyle::Concise)
    );
    assert_eq!(
      asked(serde_json::json!({ "rephrasingEnabled": true })),
      None,
      "allumé sans style exploitable : il n'y a rien à demander au modèle"
    );
    assert_eq!(
      asked(serde_json::json!({})),
      None,
      "un fichier vide ne reformule pas"
    );
  }

  #[test]
  fn one_broken_field_does_not_lose_the_others() {
    let stored = read(serde_json::json!({
      "theme": 42,
      "dictationMode": "téléportation",
      "dictationLanguage": "fr",
      "rephrasingMode": ["pas", "une", "chaîne"],
      "translationTarget": "it",
    }));

    assert_eq!(stored.theme, None, "retombe sur le défaut");
    assert_eq!(stored.dictation_mode, ShortcutMode::Hold, "idem");
    assert_eq!(stored.dictation_language, "fr", "celui-ci survit");
    assert_eq!(stored.rephrasing, None);
    assert_eq!(stored.translation_target.as_deref(), Some("it"));
  }

  /// ⚠️ **Une langue hors périmètre est refusée, pas transmise.** Elle atteindrait sinon le
  /// moteur de transcription, qui refuserait la session : l'utilisateur verrait une dictée en
  /// panne pour un fichier édité à la main.
  #[test]
  fn a_language_outside_the_scope_falls_back() {
    let stored = read(serde_json::json!({
      "dictationLanguage": "nl",
      "translationTarget": "tr",
    }));
    assert_eq!(stored.dictation_language, "en");
    assert_eq!(stored.translation_target, None);
  }

  /// ⚠️ Sans compte dans le nom : il y en avait neuf, il y en a six, et le nom a menti pendant
  /// tout l'intervalle. Le nombre est tenu par le type — `[&str; 6]` — et par `i18n.rs`.
  #[test]
  fn every_language_of_the_scope_is_accepted() {
    for language in LANGUAGES {
      let stored = read(serde_json::json!({ "dictationLanguage": language }));
      assert_eq!(stored.dictation_language, language);
    }
  }

  /// « Pas de reformulation » et « pas de traduction » deviennent l'**absence d'étape**, pas
  /// une variante que chaque appelant devrait reconnaître.
  #[test]
  fn none_becomes_the_absence_of_a_step() {
    let stored = read(serde_json::json!({
      "rephrasingMode": "none",
      "translationTarget": "none",
    }));
    assert_eq!(stored.rephrasing, None);
    assert_eq!(stored.translation_target, None);
  }

  #[test]
  fn every_rephrasing_style_is_recognised() {
    let pairs = [
      ("standard", RephrasingStyle::Standard),
      ("professional", RephrasingStyle::Professional),
      ("concise", RephrasingStyle::Concise),
      ("detailed", RephrasingStyle::Detailed),
      ("friendly", RephrasingStyle::Friendly),
      ("custom", RephrasingStyle::Custom),
    ];
    for (written, expected) in pairs {
      let stored = read(serde_json::json!({ "rephrasingMode": written }));
      assert_eq!(stored.rephrasing, Some(expected), "pour « {written} »");
    }
  }
}
