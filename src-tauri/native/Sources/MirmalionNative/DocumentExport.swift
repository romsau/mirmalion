import AppKit
import CoreText
import Foundation

// Les deux sorties qui ne sont pas du texte : le PDF paginé et le presse-papiers riche. Les
// formats texte sont rendus en Rust (`src/export/mod.rs`), le DOCX par une caisse Rust.
//
// ⚠️ On n'imprime pas le webview : un fichier livré à un tiers dépendrait alors de l'état du
// frontend — largeur, thème, défilement, police chargée — et sa pagination serait celle du
// navigateur. Le PDF se construit depuis le modèle, fenêtre ouverte, réduite ou fermée.
// ⚠️ L'importateur HTML de `NSAttributedString` exige le fil principal ; l'export part de
// `spawn_blocking`, et pendant un `cargo test` le fil principal attend les fils de test — un
// aller-retour serait un interblocage. L'attribué se construit à la main, Core Text pagine.
// ⚠️ Aucun libellé n'est fabriqué ici : tout ce qui s'imprime vient de la charge utile, déjà
// localisé. Ni numéro de page, ni en-tête, ni pied — « Page 3 sur 7 » est une phrase à
// traduire, et ce fichier ne connaît pas les six langues de l'interface.

/// La mise en page du PDF, arrêtée ici et nulle part ailleurs.
///
/// - Warning: ⚠️ A4, et non le format papier du système : `NSPrintInfo.shared` rendrait un
///   fichier différent selon la région de la machine qui exporte, donc deux paginations pour
///   le même document. Un export est un livrable, il doit être reproductible.
private enum PageLayout {
  /// A4 portrait, en points typographiques (72 ppp).
  static let width = 595.28
  static let height = 841.89
  /// ≈ 2 cm sur les quatre bords.
  static let margin = 56.0

  static let titleSize = 20.0
  /// La taille d'une rubrique de compte rendu : les mêmes 13 pt que le DOCX, pour que les deux
  /// exports du même document se ressemblent.
  static let headingSize = 13.0
  static let bodySize = 11.0
  /// L'air entre deux paragraphes, qui rend un transcript lisible en diagonale.
  static let paragraphSpacing = 8.0
  /// L'air sous le titre, plus généreux : il ouvre le document.
  static let titleSpacing = 16.0
  /// L'air au-dessus d'une rubrique, qui la fait lire comme un début de section et non comme
  /// une suite du paragraphe précédent.
  static let headingSpacingBefore = 12.0
  static let lineSpacing = 2.0
}

/// Ce que Rust envoie pour un PDF : un titre, et des blocs de texte.
///
/// Un bloc porte un seul bit de structure, `heading` : un compte rendu est une suite de
/// rubriques, et un PDF où « Résumé » et « Décisions » se lisent comme du corps de texte n'est
/// plus un document. Un transcript, lui, n'en pose jamais.
private struct ExportPayload: Decodable {
  let title: String
  let blocks: [Block]

  /// Un bloc du document : son texte, et s'il s'agit d'une rubrique. Un bloc sans `heading` est
  /// un paragraphe, le cas de tous les transcripts.
  ///
  /// - Warning: ⚠️ L'`init(from:)` écrit à la main est obligatoire : une valeur par défaut ne
  ///   rend pas sa clé facultative — la synthèse de `Decodable` appelle `decode` et non
  ///   `decodeIfPresent`, et un bloc sans `heading` faisait échouer tout l'export.
  struct Block: Decodable {
    let text: String
    let heading: Bool

    private enum CodingKeys: String, CodingKey {
      case text, heading
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      text = try container.decode(String.self, forKey: .text)
      heading = try container.decodeIfPresent(Bool.self, forKey: .heading) ?? false
    }
  }
}

/// Compose le document attribué : un titre, puis un paragraphe par bloc.
///
/// - Parameters:
///   - payload: le document décodé ; un titre vide n'écrit rien.
/// - Returns: l'attribué prêt à paginer, rubriques en gras.
private func attributedDocument(_ payload: ExportPayload) -> NSAttributedString {
  let document = NSMutableAttributedString()

  if !payload.title.isEmpty {
    let style = NSMutableParagraphStyle()
    style.paragraphSpacing = PageLayout.titleSpacing
    document.append(
      NSAttributedString(
        string: payload.title + "\n",
        attributes: [
          .font: NSFont.boldSystemFont(ofSize: PageLayout.titleSize),
          .paragraphStyle: style,
        ]))
  }

  let style = NSMutableParagraphStyle()
  style.paragraphSpacing = PageLayout.paragraphSpacing
  style.lineSpacing = PageLayout.lineSpacing
  let body: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: PageLayout.bodySize),
    .paragraphStyle: style,
  ]

  let headingStyle = NSMutableParagraphStyle()
  headingStyle.paragraphSpacing = PageLayout.paragraphSpacing
  headingStyle.paragraphSpacingBefore = PageLayout.headingSpacingBefore
  headingStyle.lineSpacing = PageLayout.lineSpacing
  let heading: [NSAttributedString.Key: Any] = [
    .font: NSFont.boldSystemFont(ofSize: PageLayout.headingSize),
    .paragraphStyle: headingStyle,
  ]

  for block in payload.blocks {
    document.append(
      NSAttributedString(
        string: block.text + "\n", attributes: block.heading ? heading : body))
  }
  return document
}

/// Rend le document attribué en PDF paginé.
///
/// - Parameters:
///   - document: l'attribué composé par `attributedDocument`.
///   - path: le fichier à écrire.
/// - Throws: `BridgeError.export` si le PDF ne s'ouvre pas en écriture.
/// - Warning: ⚠️ Une page vide plutôt qu'aucune page : un PDF de zéro page n'est pas un fichier
///   dégradé, c'est un fichier qu'aucun lecteur n'ouvre. D'où la boucle `repeat`.
private func renderPDF(_ document: NSAttributedString, to path: String) throws {
  var box = CGRect(x: 0, y: 0, width: PageLayout.width, height: PageLayout.height)
  let url = URL(fileURLWithPath: path) as CFURL

  guard let context = CGContext(url, mediaBox: &box, nil) else {
    throw BridgeError.export("le PDF n'a pas pu être ouvert en écriture")
  }

  let content = box.insetBy(dx: PageLayout.margin, dy: PageLayout.margin)
  let frame = CGPath(rect: content, transform: nil)
  let setter = CTFramesetterCreateWithAttributedString(document)
  let total = document.length
  var start = 0

  repeat {
    let page = CTFramesetterCreateFrame(setter, CFRange(location: start, length: 0), frame, nil)
    context.beginPDFPage(nil)
    CTFrameDraw(page, context)
    context.endPDFPage()

    let drawn = CTFrameGetVisibleStringRange(page).length
    // ⚠️ Le garde-fou contre un fichier infini : un paragraphe plus haut que la page n'entre
    // dans aucune page, et une boucle qui n'avance pas écrirait des pages jusqu'à remplir le
    // disque. On s'arrête plutôt que de ne jamais rendre la main.
    guard drawn > 0 else { break }
    start += drawn
  } while start < total

  context.closePDF()
}

/// Écrit un document en PDF paginé.
///
/// - Parameters:
///   - payload: le JSON d'`ExportPayload`.
///   - path: le chemin choisi par l'utilisateur dans la boîte « Enregistrer sous ».
///   - out: reçoit `"exported"`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si la charge est illisible ou le PDF inécrivable.
/// - Warning: ⚠️ Bloquant : la mise en page traverse tout le document, d'où l'appel depuis
///   `spawn_blocking` côté Rust.
@_cdecl("mirmalion_export_pdf")
public func mirmalionExportPDF(
  _ payload: UnsafePointer<CChar>?,
  _ path: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let raw = try requireArgument(payload, "document à exporter")
    let path = try requireArgument(path, "chemin du PDF")
    guard let data = raw.data(using: .utf8) else {
      throw BridgeError.export("le document à exporter n'est pas de l'UTF-8")
    }
    let decoded: ExportPayload
    do {
      decoded = try JSONDecoder().decode(ExportPayload.self, from: data)
    } catch {
      throw BridgeError.export("le document à exporter est illisible")
    }
    try renderPDF(attributedDocument(decoded), to: path)
    return "exported"
  }
}

/// Dépose le document dans le presse-papiers, en deux représentations.
///
/// - Parameters:
///   - html: le document en HTML, que prennent Mail, Word ou Pages.
///   - plain: le document en Markdown, que prend un terminal.
///   - out: reçoit `"copied"`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si le presse-papiers a refusé l'écriture.
/// - Warning: ⚠️ Les deux types cohabitent sur un seul `NSPasteboardItem` : deux écritures
///   successives ne laisseraient que la seconde. Voir l'en-tête de `Pasteboard.swift`.
@_cdecl("mirmalion_copy_rich_text")
public func mirmalionCopyRichText(
  _ html: UnsafePointer<CChar>?,
  _ plain: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let html = try requireArgument(html, "le document en HTML")
    let plain = try requireArgument(plain, "le document en Markdown")
    guard writeRichTextToPasteboard(html: html, plain: plain) else {
      throw BridgeError.export("le presse-papiers a refusé l'écriture")
    }
    return "copied"
  }
}
