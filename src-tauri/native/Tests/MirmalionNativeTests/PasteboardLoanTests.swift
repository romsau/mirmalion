import AppKit
import Testing

@testable import MirmalionNative

// L'emprunt du presse-papiers, la seule donnée irrécupérable du parcours.
//
// ⚠️ Tout se joue sur un presse-papiers NOMMÉ, jamais `NSPasteboard.general` : éprouver
// l'emprunt sur le presse-papiers de la session effacerait, à chaque `npm run verify`, ce que
// la personne qui lance la vérification venait de copier. C'est la raison d'être du paramètre
// `pasteboard` de `snapshotPasteboard`, `restorePasteboard` et `writeToPasteboard`.

@Suite("L'emprunt du presse-papiers")
struct PasteboardLoanTests {

  /// Un presse-papiers jetable, vidé à la fin.
  ///
  /// - Warning: ⚠️ `@unchecked Sendable` parce que **l'accès concurrent est ce qui est éprouvé**,
  ///   pas un effet de bord à éviter : `NSPasteboard` n'est pas thread-safe, et c'est
  ///   `borrowingPasteboard` — pas cette boîte — qui doit sérialiser les emprunts. Sans le verrou
  ///   qu'il pose, seize emprunts concurrents font tomber le processus sur un signal 11.
  private final class ScratchBoard: @unchecked Sendable {
    let board: NSPasteboard

    init(_ name: String) {
      board = NSPasteboard(
        name: .init("com.mirmalion.tests.\(name).\(ProcessInfo().processIdentifier)"))
      board.clearContents()
    }

    deinit { board.releaseGlobally() }
  }

  /// Compte les emprunts en vol, pour dire s'il y en a jamais eu deux.
  private final class Concurrency: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    private(set) var peak = 0

    func enter() {
      lock.lock()
      current += 1
      peak = max(peak, current)
      lock.unlock()
    }

    func leave() {
      lock.lock()
      current -= 1
      lock.unlock()
    }
  }

  /// ⚠️ **Le test qui compte.** Il n'observe pas le résultat mais la propriété qui le produit :
  /// deux emprunts ne se recouvrent jamais. Sans le verrou, seize fils entrant dans un corps qui
  /// dure cinq millisecondes se recouvrent à coup sûr, et le pic dépasse 1.
  @Test("deux emprunts ne se recouvrent jamais")
  func loansNeverOverlap() {
    let scratch = ScratchBoard("overlap")
    let seen = Concurrency()

    DispatchQueue.concurrentPerform(iterations: 16) { index in
      try? borrowingPasteboard(scratch.board, for: "dictée \(index)", settling: 0.001) {
        seen.enter()
        Thread.sleep(forTimeInterval: 0.005)
        seen.leave()
      }
    }

    #expect(seen.peak == 1, "au plus un emprunt à la fois, observé : \(seen.peak)")
  }

  /// La conséquence, dite du point de vue de l'utilisateur : ce qu'il avait copié est toujours
  /// là, et surtout ce n'est pas une dictée.
  @Test("le presse-papiers survit à des emprunts concurrents")
  func theUserKeepsWhatTheyCopied() {
    let scratch = ScratchBoard("survivor")
    scratch.board.clearContents()
    scratch.board.setString("facture 2026", forType: .string)

    DispatchQueue.concurrentPerform(iterations: 16) { index in
      try? borrowingPasteboard(scratch.board, for: "dictée \(index)", settling: 0.001) {}
    }

    #expect(scratch.board.string(forType: .string) == "facture 2026")
  }

  /// ⚠️ La restauration parcourt **tous les types de tous les éléments**, pas seulement la
  /// chaîne : un même contenu y est écrit en texte brut, RTF, HTML et ce que l'application
  /// source y a ajouté. Ne rendre que `.string` en perdrait six sur huit — l'invariant que
  /// l'en-tête de `Pasteboard.swift` énonce, et que rien ne vérifiait.
  @Test("la restauration rend toutes les représentations, pas seulement le texte")
  func everyRepresentationComesBack() throws {
    let scratch = ScratchBoard("types")
    let item = NSPasteboardItem()
    item.setString("Alice — Bonjour", forType: .string)
    item.setString("<p><strong>Alice</strong> — Bonjour</p>", forType: .html)
    item.setData(Data([0x01, 0x02, 0x03]), forType: .init("com.mirmalion.test.opaque"))
    scratch.board.clearContents()
    scratch.board.writeObjects([item])

    try borrowingPasteboard(scratch.board, for: "la dictée qui écrase", settling: 0.001) {
      #expect(
        scratch.board.string(forType: .string) == "la dictée qui écrase",
        "pendant l'emprunt, c'est la dictée qui est déposée")
    }

    #expect(scratch.board.string(forType: .string) == "Alice — Bonjour")
    #expect(scratch.board.string(forType: .html) == "<p><strong>Alice</strong> — Bonjour</p>")
    #expect(
      scratch.board.data(forType: .init("com.mirmalion.test.opaque")) == Data([0x01, 0x02, 0x03]),
      "un type que nous ne connaissons pas revient comme il est parti")
  }

  /// ⚠️ Un presse-papiers vide au départ se rend vide. Sortir sans effacer y laisserait la
  /// dictée, que l'utilisateur retrouverait en collant ailleurs — le pire des deux défauts,
  /// parce qu'il est silencieux.
  @Test("un presse-papiers vide au départ ne garde pas la dictée")
  func anEmptyBoardStaysEmpty() throws {
    let scratch = ScratchBoard("empty")

    try borrowingPasteboard(scratch.board, for: "la dictée", settling: 0.001) {}

    #expect(scratch.board.string(forType: .string) == nil)
  }
}
