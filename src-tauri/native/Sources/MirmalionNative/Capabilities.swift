import Foundation

#if canImport(FoundationModels)
  import FoundationModels
#endif

// Le seul fichier du projet qui a le droit de parler de versions de macOS.
//
// Partout ailleurs — Rust, Angular, Swift — on consomme les drapeaux produits ici, jamais un
// numéro de version : le jour où Apple rétroporte, retire ou renomme une brique, il n'y a qu'un
// endroit à corriger. `#available` reste confiné ici ; quand une API expose une vraie
// disponibilité runtime, c'est elle qui fait foi, pas le numéro d'OS.
//
// Trois états, et la distinction compte — une brique peut être présente sans être utilisable,
// faute de modèle téléchargé :
//
//   unavailable   — la brique n'existe pas sur cet OS, ou est désactivée
//   needsDownload — présente, mais son modèle n'est pas installé
//   ready         — utilisable tout de suite

/// L'état d'une brique native, tel qu'il traverse la frontière.
private struct CapabilityPayload: Encodable {
  let status: String
  let detail: String?

  static func ready(_ detail: String? = nil) -> Self {
    Self(status: "ready", detail: detail)
  }
  static func needsDownload(_ detail: String) -> Self {
    Self(status: "needsDownload", detail: detail)
  }
  static func unavailable(_ detail: String) -> Self {
    Self(status: "unavailable", detail: detail)
  }
}

/// L'inventaire complet rendu par `mirmalion_capabilities`, sérialisé en JSON.
private struct CapabilitiesPayload: Encodable {
  let osVersion: String
  let architecture: String
  let speechTranscriber: CapabilityPayload
  let foundationModels: CapabilityPayload
  let translation: CapabilityPayload
}

/// L'état de l'audio → texte : `SpeechTranscriber`, du framework Speech, arrivé avec macOS 26.
///
/// - Returns: `ready` sur macOS 26, `unavailable` en deçà. Les ressources de la langue
///   choisie, elles, ne se vérifient qu'au moment de l'usage.
private func speechTranscriberCapability() -> CapabilityPayload {
  if #available(macOS 26.0, *) {
    return .ready("les ressources de la langue choisie sont vérifiées au moment de l'usage")
  }
  return .unavailable("SpeechTranscriber demande macOS 26")
}

/// L'état du LLM local, seule des trois briques à exposer une vraie disponibilité runtime.
///
/// - Returns: `needsDownload` tant que le modèle Apple n'est pas installé, `unavailable` si
///   Apple Intelligence est désactivé ou l'appareil inéligible, `ready` sinon.
private func foundationModelsCapability() -> CapabilityPayload {
  #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
      switch SystemLanguageModel.default.availability {
      case .available:
        return .ready()
      case .unavailable(let reason):
        switch reason {
        case .modelNotReady:
          return .needsDownload("le modèle Apple n'a pas fini d'être téléchargé")
        case .appleIntelligenceNotEnabled:
          return .unavailable("Apple Intelligence est désactivé dans les Réglages Système")
        case .deviceNotEligible:
          return .unavailable("cet appareil ne prend pas en charge Apple Intelligence")
        @unknown default:
          return .unavailable("indisponible, raison inconnue de cette version de l'app")
        }
      @unknown default:
        return .unavailable("état de disponibilité inconnu de cette version de l'app")
      }
    }
  #endif
  return .unavailable("FoundationModels demande macOS 26")
}

/// L'état de la traduction : le framework `Translation` est natif depuis macOS 14.4, donc
/// toujours présent sous le plancher du paquet.
///
/// - Returns: toujours `ready`. Ce qui peut manquer est une paire de langues, et cela ne se
///   teste que paire par paire, au moment où l'on sait laquelle.
private func translationCapability() -> CapabilityPayload {
  .ready("la paire de langues demandée est vérifiée au moment de l'usage")
}

/// L'architecture du binaire, résolue à la compilation.
///
/// L'app n'est distribuée qu'en arm64 : un Mac Intel ne la lance pas du tout.
private var architecture: String {
  #if arch(arm64)
    return "arm64"
  #else
    return "x86_64"
  #endif
}

/// Renvoie, en JSON, ce dont cette machine dispose.
///
/// - Parameters:
///   - out: reçoit le JSON alloué, que l'appelant rend par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si l'inventaire n'est pas encodable en UTF-8.
/// - Warning: ⚠️ Le schéma est repris à l'identique côté Rust, dans
///   `src-tauri/src/commands/system.rs` : un champ ajouté ici doit l'être là aussi.
@_cdecl("mirmalion_capabilities")
public func mirmalionCapabilities(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    let payload = CapabilitiesPayload(
      osVersion: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
      architecture: architecture,
      speechTranscriber: speechTranscriberCapability(),
      foundationModels: foundationModelsCapability(),
      translation: translationCapability()
    )
    return try bridgeJSON(payload)
  }
}
