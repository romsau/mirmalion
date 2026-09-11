//! Identité de l'application : nom, version, version de Tauri, plateforme.

use crate::error::AppError;

/// Ce que [`get_app_info`] renvoie au frontend.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
  /// Le nom du bundle, tel que déclaré dans `tauri.conf.json`.
  pub name: String,
  /// La version de l'application.
  pub version: String,
  /// La version de Tauri avec laquelle l'application a été construite.
  pub tauri_version: String,
  /// L'identifiant de plateforme, `"macos"` sur les builds livrées.
  pub platform: String,
}

/// Rend l'identité de l'application : nom, version, version de Tauri, plateforme.
///
/// # Errors
///
/// Ne rend jamais d'erreur ; le `Result` n'est là que pour suivre le contrat commun des
/// commandes IPC.
#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> Result<AppInfo, AppError> {
  let info = app.package_info();
  Ok(AppInfo {
    name: info.name.clone(),
    version: info.version.to_string(),
    tauri_version: tauri::VERSION.to_string(),
    platform: std::env::consts::OS.to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::AppInfo;

  #[test]
  fn serializes_in_camel_case() {
    let info = AppInfo {
      name: "Mirmalion".into(),
      version: "1.0.0".into(),
      tauri_version: "2.11.3".into(),
      platform: "macos".into(),
    };
    let json = serde_json::to_value(&info).expect("sérialisation");
    assert_eq!(json["name"], "Mirmalion");
    assert_eq!(json["version"], "1.0.0");
    assert_eq!(json["tauriVersion"], "2.11.3");
    assert_eq!(json["platform"], "macos");
  }
}
