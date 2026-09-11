import AppKit
import Foundation

// Le presse-papiers de l'utilisateur : emprunté le temps d'un collage, puis rendu intact.
//
// Coller au curseur passe par le presse-papiers, il n'y a pas d'autre voie sur macOS. Ce que
// l'utilisateur avait copié est donc écrasé, puis restauré — c'est la seule donnée du parcours
// qui soit irrécupérable si on la perd.
//
// ⚠️ Restaurer la seule chaîne rend 2 représentations sur 8 : un même contenu y est écrit en
// texte brut, RTF, HTML et ce que l'application source y a ajouté. Parcourir tous les types de
// tous les éléments et conserver leurs données telles quelles.

/// Le contenu du presse-papiers, tel quel : chaque élément, chacun de ses types, ses octets.
///
/// - Warning: ⚠️ Les types seulement promis sont perdus : une application peut déclarer un type
///   sans en fournir les données, et le promettant peut avoir disparu. On ne copie que ce qui
///   existe — rendre un type déclaré et vide ferait échouer un collage au lieu de le dégrader.
struct PasteboardSnapshot {
  let items: [[String: Data]]

  var isEmpty: Bool { items.allSatisfy(\.isEmpty) }
}

/// Photographie le presse-papiers avant qu'on y touche.
///
/// - Parameters:
///   - pasteboard: le presse-papiers visé. ⚠️ Le paramètre n'existe que pour les tests, qui
///     travaillent sur un presse-papiers nommé : sans lui, éprouver l'emprunt écraserait ce que
///     l'utilisateur vient de copier, à chaque `npm run verify`.
/// - Returns: un instantané de tous les éléments et de tous leurs types disponibles.
func snapshotPasteboard(_ pasteboard: NSPasteboard = .general) -> PasteboardSnapshot {
  var items: [[String: Data]] = []

  for item in pasteboard.pasteboardItems ?? [] {
    var stored: [String: Data] = [:]
    for type in item.types {
      if let data = item.data(forType: type) {
        stored[type.rawValue] = data
      }
    }
    items.append(stored)
  }
  return PasteboardSnapshot(items: items)
}

/// Rend à l'utilisateur ce qu'il avait copié.
///
/// - Parameters:
///   - snapshot: l'instantané pris avant l'écriture.
/// - Warning: ⚠️ Un presse-papiers vide au départ se rend vide. Sortir sans effacer y
///   laisserait la dictée, que l'utilisateur retrouverait en collant ailleurs.
func restorePasteboard(_ snapshot: PasteboardSnapshot, to pasteboard: NSPasteboard = .general) {
  pasteboard.clearContents()

  guard !snapshot.isEmpty else { return }

  let items = snapshot.items.compactMap { stored -> NSPasteboardItem? in
    guard !stored.isEmpty else { return nil }
    let item = NSPasteboardItem()
    for (type, data) in stored {
      item.setData(data, forType: NSPasteboard.PasteboardType(type))
    }
    return item
  }
  guard !items.isEmpty else { return }
  pasteboard.writeObjects(items)
}

/// Dépose le texte à coller, en remplaçant tout ce que le presse-papiers portait.
///
/// - Parameters:
///   - text: le texte à déposer.
/// - Returns: `false` si le presse-papiers a refusé l'écriture.
func writeToPasteboard(_ text: String, to pasteboard: NSPasteboard = .general) -> Bool {
  pasteboard.clearContents()
  return pasteboard.setString(text, forType: .string)
}

/// Le verrou de l'emprunt. **Un seul emprunt à la fois dans tout le processus.**
///
/// - Warning: ⚠️ Sans lui, deux emprunts entrelacés font photographier au second le texte que le
///   premier vient de déposer. Le premier rend son instantané — celui de l'utilisateur —, puis le
///   second rend le sien, et le presse-papiers finit sur la dictée. C'est la seule donnée
///   irrécupérable du parcours, et ce verrou est tout ce qui la protège.
private let pasteboardLoan = NSLock()

/// Emprunte le presse-papiers : dépose `text`, exécute `body`, puis rend ce qui s'y trouvait.
///
/// - Throws: `BridgeError.injection` si le presse-papiers refuse le texte, sinon ce que `body` lance.
/// - Warning: ⚠️ **L'ordre des deux `defer` n'est pas indifférent.** Swift les déroule à l'envers
///   de leur déclaration : celui du verrou, écrit en premier, s'exécute en dernier. Les permuter
///   rendrait le verrou avant d'avoir restauré, et rouvrirait la fenêtre qu'il ferme.
/// - Warning: ⚠️ Le presse-papiers est rendu même si `body` lance, sinon ce que l'utilisateur
///   avait copié serait perdu.
/// - Warning: ⚠️ Bloquant pendant `settling` ; un second appel attend, il ne corrompt pas.
func borrowingPasteboard<T>(
  _ pasteboard: NSPasteboard = .general,
  for text: String,
  settling: TimeInterval,
  _ body: () throws -> T
) throws -> T {
  pasteboardLoan.lock()
  defer { pasteboardLoan.unlock() }

  let previous = snapshotPasteboard(pasteboard)
  guard writeToPasteboard(text, to: pasteboard) else {
    restorePasteboard(previous, to: pasteboard)
    throw BridgeError.injection("le presse-papiers a refusé le texte à insérer")
  }
  defer {
    Thread.sleep(forTimeInterval: settling)
    restorePasteboard(previous, to: pasteboard)
  }

  return try body()
}

/// Dépose un document en deux représentations : HTML pour qui sait le lire, Markdown sinon.
/// Le contenu précédent n'est pas restauré, contrairement à la dictée : l'utilisateur copie.
///
/// - Parameters:
///   - html: la représentation mise en forme, proposée en premier.
///   - plain: le repli en Markdown.
/// - Returns: `false` si le presse-papiers a refusé l'écriture.
/// - Warning: ⚠️ Un seul élément portant deux types, jamais deux écritures : deux `setString`
///   successifs ne laisseraient que le dernier, et le collage perdrait la mise en forme.
func writeRichTextToPasteboard(html: String, plain: String) -> Bool {
  let item = NSPasteboardItem()
  // L'ordre compte : le type déclaré en premier est celui que retient une application qui en
  // accepte plusieurs. Le HTML d'abord, donc, le Markdown en repli.
  guard item.setString(html, forType: .html), item.setString(plain, forType: .string) else {
    return false
  }
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  return pasteboard.writeObjects([item])
}
