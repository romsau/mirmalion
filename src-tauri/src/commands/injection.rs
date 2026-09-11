//! Insérer le texte dicté là où l'utilisateur travaille.
//!
//! Tout le geste est en Swift (`native/…/TextInjection.swift` et `Pasteboard.swift`) et tient
//! en une séquence indivisible : photographier le presse-papiers, y poser le texte, poster ⌘V,
//! attendre, rendre le presse-papiers.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas découper cette séquence de part et d'autre du pont : la fenêtre ainsi ouverte
//!   laisserait, sur erreur, la dictée dans le presse-papiers de l'utilisateur.
//! - ⚠️ Le presse-papiers de l'utilisateur est rendu même en cas d'échec : le texte dicté est
//!   récupérable dans l'historique, le contenu copié ne l'est pas.
//! - ⚠️ Le texte dicté traverse ce module : c'est du contenu utilisateur, il n'entre jamais dans
//!   un message de journal ni dans un message d'erreur.

use serde::Serialize;

use crate::{blocking::off_thread, error::AppError, native};

/// Ce qu'il est advenu d'une demande d'insertion.
///
/// # Pièges
///
/// - ⚠️ [`InjectionOutcome::NoEditableField`] n'est pas un échec : l'utilisateur a dicté alors
///   qu'aucun champ n'attendait de texte, le produit archive la dictée et n'insère rien. En
///   faire une erreur ferait apparaître une alerte sur un comportement nominal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InjectionOutcome {
  /// Le texte a été collé, et le presse-papiers rendu.
  Inserted,
  /// Aucun champ éditable au premier plan. **Le presse-papiers n'a pas été touché.**
  NoEditableField,
}

impl InjectionOutcome {
  /// Relit la réponse du pont.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Native`] sur une valeur hors vocabulaire : les deux côtés du pont portent
  /// le même vocabulaire, écrit deux fois, et une dérive doit se voir plutôt que se deviner.
  fn parse(raw: &str) -> Result<Self, AppError> {
    match raw {
      "inserted" => Ok(Self::Inserted),
      "noEditableField" => Ok(Self::NoEditableField),
      other => Err(AppError::Native(format!(
        "le pont a rendu un résultat d'insertion inconnu : « {other} »"
      ))),
    }
  }
}

/// Insère le texte au curseur, dans l'application au premier plan.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un texte vide, [`AppError::Native`] si le pont
/// échoue ou rend un résultat hors vocabulaire.
///
/// # Pièges
///
/// - ⚠️ Ne rend pas la main tout de suite : la séquence attend ~150 ms que l'application cible
///   ait consommé le collage avant de rendre le presse-papiers. D'où le `spawn_blocking`.
#[tauri::command]
pub async fn insert_at_cursor(text: String) -> Result<InjectionOutcome, AppError> {
  insert_into(text, 0).await
}

/// Insère le texte dans l'application **désignée par son `pid`** ; `0` vaut premier plan.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un texte vide, [`AppError::Native`] si le pont
/// échoue ou rend un résultat hors vocabulaire.
///
/// # Pièges
///
/// - ⚠️ C'est la forme que la dictée doit employer : la cible se relève au **début** de la
///   dictée, et entre-temps notre pilule passe au premier plan (bogue Tauri #7519 sur macOS).
///   Un collage visant « le premier plan » atterrirait alors dans notre propre webview.
pub async fn insert_into(text: String, target: i32) -> Result<InjectionOutcome, AppError> {
  let text = accepted(text)?;

  let raw = off_thread(move || native::insert_at_cursor(&text, target)).await?;
  InjectionOutcome::parse(&raw)
}

/// Refuse un texte qui n'en est pas un, **avant que rien ne touche au presse-papiers**.
///
/// Le texte accepté ressort tel quel, sans rognage : une dictée peut légitimement commencer ou
/// finir par une espace, c'est ce qui la sépare du mot déjà tapé dans le champ.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `text` est vide ou fait d'espaces.
///
/// # Pièges
///
/// - ⚠️ Le vide se refuse ici, du côté qui décide, et non côté Swift : une dictée qui n'a rien
///   produit ne doit pas écraser ce que l'utilisateur avait copié.
fn accepted(text: String) -> Result<String, AppError> {
  if text.trim().is_empty() {
    return Err(AppError::InvalidArgument(
      "aucun texte à insérer".to_owned(),
    ));
  }
  Ok(text)
}

/// Ce que l'application au premier plan dit de son champ focalisé.
///
/// # Pièges
///
/// - ⚠️ [`FocusVerdict::Unknown`] est la réponse la plus fréquente : Chrome, et tout ce qui est
///   bâti sur Chromium, n'expose aucun élément focalisé, curseur dans une zone de texte ou non.
///   L'insertion ne doit donc refuser que sur `NotEditable`, sous peine de priver la dictée du
///   navigateur, où elle sert le plus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusVerdict {
  /// Le champ au premier plan accepte du texte.
  Editable,
  /// Le champ au premier plan refuse le texte : l'insertion n'a pas lieu.
  NotEditable,
  /// L'application ne dit rien. **Ce n'est pas un refus.**
  Unknown,
}

impl FocusVerdict {
  /// Relit le verdict rendu par le pont.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Native`] sur une valeur hors vocabulaire, plutôt que de la deviner.
  fn parse(raw: &str) -> Result<Self, AppError> {
    match raw {
      "editable" => Ok(Self::Editable),
      "notEditable" => Ok(Self::NotEditable),
      "unknown" => Ok(Self::Unknown),
      other => Err(AppError::Native(format!(
        "le pont a rendu un verdict de focus inconnu : « {other} »"
      ))),
    }
  }
}

/// Interroge l'application au premier plan sur son champ focalisé.
///
/// Ne touche à rien — ni presse-papiers, ni évènement clavier. Sert à décider **avant** la
/// dictée ce que l'interface promet : insérer, ou seulement archiver.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou rend un verdict hors vocabulaire.
#[tauri::command]
pub async fn get_focus_verdict() -> Result<FocusVerdict, AppError> {
  let raw = off_thread(native::focus_verdict).await?;
  FocusVerdict::parse(&raw)
}

#[cfg(test)]
mod tests {
  use super::{FocusVerdict, InjectionOutcome, accepted};

  #[test]
  fn the_three_focus_verdicts_travel_in_camel_case() {
    let json = |verdict: FocusVerdict| serde_json::to_string(&verdict).expect("sérialisation");
    assert_eq!(json(FocusVerdict::Editable), "\"editable\"");
    assert_eq!(json(FocusVerdict::NotEditable), "\"notEditable\"");
    assert_eq!(json(FocusVerdict::Unknown), "\"unknown\"");
  }

  #[test]
  fn the_focus_vocabulary_is_read_back_without_loss() {
    for (raw, expected) in [
      ("editable", FocusVerdict::Editable),
      ("notEditable", FocusVerdict::NotEditable),
      ("unknown", FocusVerdict::Unknown),
    ] {
      assert_eq!(FocusVerdict::parse(raw).expect("connu"), expected);
    }
  }

  #[test]
  fn an_unknown_focus_verdict_is_refused_rather_than_guessed() {
    let error = FocusVerdict::parse("peutEtre").expect_err("un verdict inconnu doit échouer");
    assert_eq!(error.kind(), "native");
  }

  #[test]
  fn the_two_outcomes_travel_in_camel_case() {
    let json = |outcome: InjectionOutcome| serde_json::to_string(&outcome).expect("sérialisation");
    assert_eq!(json(InjectionOutcome::Inserted), "\"inserted\"");
    assert_eq!(
      json(InjectionOutcome::NoEditableField),
      "\"noEditableField\""
    );
  }

  #[test]
  fn the_bridge_vocabulary_is_read_back_without_loss() {
    assert_eq!(
      InjectionOutcome::parse("inserted").expect("connu"),
      InjectionOutcome::Inserted
    );
    assert_eq!(
      InjectionOutcome::parse("noEditableField").expect("connu"),
      InjectionOutcome::NoEditableField
    );
  }

  /// Les deux côtés du pont portent le même vocabulaire, écrit deux fois. Une dérive doit
  /// donner une erreur franche, pas un résultat par défaut qui prétendrait avoir collé.
  #[test]
  fn an_unknown_outcome_is_refused_rather_than_guessed() {
    let error = InjectionOutcome::parse("peutEtre").expect_err("un résultat inconnu doit échouer");
    assert_eq!(error.kind(), "native");
    assert!(error.to_string().contains("peutEtre"), "reçu : {error}");
  }

  /// ⚠️ **Le vide est refusé AVANT que quoi que ce soit ne touche au presse-papiers.** Une
  /// dictée qui n'a rien produit ne doit pas écraser ce que l'utilisateur avait copié.
  #[test]
  fn empty_text_never_reaches_the_pasteboard() {
    for blank in ["", "   ", "\n\t "] {
      let error = accepted(blank.to_owned()).expect_err("le vide doit être refusé");
      assert_eq!(error.kind(), "invalidArgument");
    }
  }

  /// ⚠️ **Le texte accepté n'est PAS rogné.** Une dictée peut légitimement commencer ou finir
  /// par une espace — c'est ce qui la sépare du mot déjà tapé dans le champ.
  #[test]
  fn an_accepted_text_crosses_untouched() {
    assert_eq!(
      accepted(" bonjour ".to_owned()).expect("accepté"),
      " bonjour "
    );
  }
}
