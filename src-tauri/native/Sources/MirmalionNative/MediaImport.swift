import AVFoundation
import Foundation

// L'import d'un média : valider ce qu'on a vraiment, pas ce que le nom annonce.
//
// Le fichier source n'est ni copié, ni déplacé, ni modifié — on l'ouvre pour l'inspecter, et
// c'est tout. C'est ce qui rend la ré-analyse possible à tout moment.
//
// ⚠️ La validation porte sur le contenu, jamais sur l'extension : `AVURLAsset` ouvre le
// conteneur réel, et un `.mp4` renommé en `.mp3` se lit très bien — il est donc accepté. Ce
// que cette lecture attrape est le fichier qui n'est pas un média du tout, et elle l'attrape
// au dépôt plutôt qu'au milieu d'une transcription déjà lancée.

/// Pourquoi un média est refusé : un code, jamais une phrase.
///
/// - Warning: ⚠️ L'interface est localisée au build dans six langues — un message rédigé ici
///   sortirait en français sur une interface allemande. Le pont transporte un identifiant
///   stable, le frontend choisit les mots.
enum MediaProblem: String {
  /// Le fichier est vide — zéro octet.
  case empty
  /// Le fichier n'est pas un média lisible : format non pris en charge, ou données corrompues.
  case unreadable
  /// Un média valide, mais **sans piste audio**. Le cas typique d'une vidéo muette.
  case noAudioTrack
}

private struct MediaInspection: Encodable {
  /// `nil` quand le média est accepté.
  let problem: String?
  let durationMs: UInt64
  let hasAudio: Bool
  let hasVideo: Bool

  static func rejected(_ problem: MediaProblem) -> MediaInspection {
    MediaInspection(problem: problem.rawValue, durationMs: 0, hasAudio: false, hasVideo: false)
  }
}

/// Ouvre le média et dit s'il est traitable.
///
/// - Parameters:
///   - path: le chemin du fichier déposé.
/// - Returns: l'inspection, avec un `problem` non nul quand le média est refusé.
/// - Warning: ⚠️ Aucune exception ne remonte : un média illisible est une réponse, pas une
///   erreur. L'appelant doit pouvoir distinguer « ce fichier ne convient pas », montré en
///   snackbar, de « la brique native est cassée », qui est un défaut.
private func inspect(path: String) -> MediaInspection {
  let url = URL(fileURLWithPath: path)

  // Le fichier vide se voit sans ouvrir quoi que ce soit, et `AVURLAsset` sur zéro octet
  // rendrait un « illisible » qui n'expliquerait rien à l'utilisateur.
  let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? UInt64) ?? nil
  if size == 0 {
    return .rejected(.empty)
  }

  let asset = AVURLAsset(url: url)

  // ⚠️ Aucune issue d'ici n'est une erreur : un fichier qu'AVFoundation ne sait pas ouvrir, un
  // média sans piste audio et un délai dépassé sont trois refus que l'utilisateur doit lire à
  // l'écran, pas trois échecs qui remonteraient jusqu'à la frontière C.
  let inspection = try? awaiting(
    "l'inspection du média", within: BridgeDeadline.mediaMetadata
  ) { () async throws -> MediaInspection in
    let audio = try await asset.loadTracks(withMediaType: .audio)
    let video = try await asset.loadTracks(withMediaType: .video)
    let duration = try await asset.load(.duration)

    guard duration.isNumeric, duration.seconds.isFinite, duration.seconds > 0 else {
      return MediaInspection.rejected(.unreadable)
    }
    // ⚠️ Distinct d'« illisible », et le message doit l'être aussi : l'utilisateur qui a
    // déposé une vidéo muette n'a rien à réparer, il s'est trompé de fichier.
    guard !audio.isEmpty else {
      return MediaInspection.rejected(.noAudioTrack)
    }

    return MediaInspection(
      problem: nil,
      durationMs: UInt64((duration.seconds * 1_000).rounded()),
      hasAudio: true,
      // ⚠️ Une piste vidéo peut n'être qu'une **pochette** : les `.mp3` et les `.m4a`
      // taggés en portent une, encodée en PNG ou JPEG. Ce drapeau dit donc « il y a des
      // images », pas « c'est un film » — ne rien en déduire sur le traitement.
      hasVideo: !video.isEmpty
    )
  }

  // AVFoundation lance sur un conteneur qu'il ne sait pas ouvrir. C'est le cas nominal d'un
  // fichier qui n'est pas un média.
  return inspection ?? MediaInspection.rejected(.unreadable)
}

/// Inspecte un média local, sans le copier ni le modifier.
///
/// - Parameters:
///   - path: le chemin du fichier, ni nul ni vide.
///   - out: reçoit le JSON de `MediaInspection`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si le chemin est invalide ou le JSON inencodable.
@_cdecl("mirmalion_media_inspect")
public func mirmalionMediaInspect(
  _ path: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let path = try requireArgument(path, "chemin du média")
    let inspection = inspect(path: path)
    return try bridgeJSON(inspection)
  }
}
