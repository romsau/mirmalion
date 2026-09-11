import AppKit
import Foundation
import SwiftUI
// ⚠️ `@preconcurrency` est nécessaire pour compiler l'hôte de la feuille : `.translationTask` livre
// une `TranslationSession` isolée au fil principal alors que `prepareTranslation()` est
// `nonisolated`, et Swift 6 strict refuse ce franchissement (`SendingRisksDataRace`). Ni un
// paramètre `sending`, ni une isolation au `MainActor` n'y changent rien — ne pas les réessayer.
@preconcurrency import Translation

// La traduction passe par le framework Translation d'Apple, entièrement sur la machine. Le LLM
// (Foundation Models) nettoie et reformule ; il ne traduit jamais.
//
// ⚠️ Le framework exige une boucle d'exécution principale vivante — pas un bundle `.app`, contre ce
// qu'on lit souvent : il livre ses continuations par elle. D'où deux conséquences : n'appeler ces
// exports que depuis un fil de fond (`spawn_blocking` côté Rust), sinon interblocage définitif ; et
// `cargo test` ne peut pas les exercer, faute de boucle principale.
// ⚠️ Rien ne part sans un clic : le téléchargement d'une paire est une opération réseau, et aucun
// appel de ce fichier ne l'engage.
// ⚠️ Aucun contenu utilisateur ne doit être journalisé — ni texte source, ni traduction. Ce fichier
// ne journalise rien du tout.

private func pairStatusName(_ status: LanguageAvailability.Status) -> String {
  switch status {
  case .installed: return "installed"
  case .supported: return "supported"
  case .unsupported: return "unsupported"
  @unknown default: return "unsupported"
  }
}

/// Une paire ordonnée et son état. Traverse le pont en JSON.
private struct PairAvailability: Encodable {
  let source: String
  let target: String
  /// `installed` — utilisable tout de suite · `supported` — téléchargeable · `unsupported` —
  /// jamais disponible.
  let status: String
}

/// Ce que la traduction sait faire sur cette machine, ici et maintenant.
private struct TranslationAvailability: Encodable {
  /// Les langues du périmètre que le framework reconnaît.
  let languages: [String]
  /// Les 72 paires ordonnées du périmètre, chacune avec son état.
  let pairs: [PairAvailability]
}

/// Encode une charge utile en JSON UTF-8 pour la traversée du pont.
private func encodedTranslation(_ payload: some Encodable) throws -> String {
  return try bridgeJSON(payload)
}

/// Valide une langue du périmètre. Une langue hors des 9 ne doit jamais atteindre le
/// framework — c'est la même garde que côté STT, au plus près du moteur.
private func requireScopeLanguage(_ value: String, _ name: String) throws -> String {
  guard supportedLanguages.contains(value) else {
    throw BridgeError.invalidArgument("\(name) : « \(value) » est hors des 6 langues du périmètre")
  }
  return value
}

/// L'état de chaque paire du périmètre. Ne traduit rien et ne télécharge rien.
///
/// - Parameters:
///   - out: reçoit le JSON de `TranslationAvailability`, ou le message d'erreur.
/// - Returns: `statusOK` ou `statusError`.
/// - Warning: ⚠️ 72 interrogations sans effet de bord : `LanguageAvailability.status` est une
///   lecture, il ne consomme aucun quota comme `AssetInventory.assetInstallationRequest` côté STT.
/// - Warning: ⚠️ `.installed` ne désigne pas la liste des Réglages Système, qui décrit un autre jeu
///   d'actifs : ne pas y renvoyer l'utilisateur en croyant lui montrer notre état.
@_cdecl("mirmalion_translation_availability")
public func mirmalionTranslationAvailability(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let scope = supportedLanguages
    let pairs = try awaiting(
      "l'état des couples de traduction", within: BridgeDeadline.translation
    ) { () async -> [PairAvailability] in
      let availability = LanguageAvailability()
      let known = await availability.supportedLanguages
      let recognised = scope.filter { language in
        known.contains { $0.languageCode?.identifier == language }
      }
      var rows: [PairAvailability] = []
      for source in recognised {
        for target in recognised where source != target {
          let status = await availability.status(
            from: Locale.Language(identifier: source),
            to: Locale.Language(identifier: target))
          rows.append(
            PairAvailability(source: source, target: target, status: pairStatusName(status)))
        }
      }
      return rows
    }

    let languages = Array(Set(pairs.map(\.source))).sorted()
    return try encodedTranslation(TranslationAvailability(languages: languages, pairs: pairs))
  }
}

/// Traduit `text` de `source` vers `target`, entièrement sur la machine.
///
/// Rend un JSON discriminé, jamais une chaîne nue : `{"kind":"translated","text":"…"}` ;
/// `{"kind":"pairMissing",…}` quand la paire est téléchargeable mais absente — le signal qui fait
/// proposer le téléchargement, jamais celui qui l'engage ; `{"kind":"pairUnsupported",…}` quand la
/// paire n'existe pas chez Apple.
///
/// - Warning: ⚠️ bloquant : à n'appeler que depuis `spawn_blocking`.
/// - Warning: ⚠️ `source == target` rend le texte inchangé : c'est un cas nominal quand
///   l'utilisateur dicte déjà dans la langue cible, et le framework refuserait la paire.
@_cdecl("mirmalion_translate")
public func mirmalionTranslate(
  _ source: UnsafePointer<CChar>?,
  _ target: UnsafePointer<CChar>?,
  _ text: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let sourceLanguage = try requireScopeLanguage(
      try requireArgument(source, "la langue source"), "la langue source")
    let targetLanguage = try requireScopeLanguage(
      try requireArgument(target, "la langue cible"), "la langue cible")
    let content = try requireArgument(text, "le texte à traduire")

    if sourceLanguage == targetLanguage {
      return try encodedTranslation(TranslationResult.translated(content))
    }

    guard #available(macOS 26.0, *) else {
      // Socle 15–25 : `init(installedSource:)` n'existe pas, seule `.translationTask` — donc un
      // hôte SwiftUI — peut vendre une session.
      throw BridgeError.translation(
        "la traduction hors ligne demande un socle plus récent sur cette machine")
    }

    return try awaiting("la traduction", within: BridgeDeadline.translation) {
      () async throws -> String in
      let from = Locale.Language(identifier: sourceLanguage)
      let to = Locale.Language(identifier: targetLanguage)

      // On décide sur l'état déclaré, pas sur l'erreur levée : `.notInstalled` ne distingue
      // pas « téléchargeable » de « inexistant », et le produit doit les traiter différemment.
      switch await LanguageAvailability().status(from: from, to: to) {
      case .supported:
        return try encodedTranslation(
          TranslationResult.pairMissing(source: sourceLanguage, target: targetLanguage))
      case .unsupported:
        return try encodedTranslation(
          TranslationResult.pairUnsupported(source: sourceLanguage, target: targetLanguage))
      case .installed:
        break
      @unknown default:
        return try encodedTranslation(
          TranslationResult.pairUnsupported(source: sourceLanguage, target: targetLanguage))
      }

      do {
        let session = TranslationSession(installedSource: from, target: to)
        let response = try await session.translate(content)
        return try encodedTranslation(TranslationResult.translated(response.targetText))
      } catch {
        // ⚠️ Jamais le texte dans le message : c'est du contenu utilisateur.
        throw BridgeError.translation("la traduction a échoué")
      }
    }
  }
}

/// Les trois issues d'une traduction, et leur JSON.
private enum TranslationResult {
  case translated(String)
  case pairMissing(source: String, target: String)
  case pairUnsupported(source: String, target: String)
}

extension TranslationResult: Encodable {
  private enum CodingKeys: String, CodingKey {
    case kind, text, source, target
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .translated(let text):
      try container.encode("translated", forKey: .kind)
      try container.encode(text, forKey: .text)
    case .pairMissing(let source, let target):
      try container.encode("pairMissing", forKey: .kind)
      try container.encode(source, forKey: .source)
      try container.encode(target, forKey: .target)
    case .pairUnsupported(let source, let target):
      try container.encode("pairUnsupported", forKey: .kind)
      try container.encode(source, forKey: .source)
      try container.encode(target, forKey: .target)
    }
  }
}

// Proposer le téléchargement : la feuille d'Apple, greffée dans la fenêtre de Tauri. Seul endroit
// du projet qui engage un téléchargement de traduction, et seulement sur un clic. Refermer la
// feuille sans cliquer « Download » n'installe rien : le consentement se donne langue par langue.
//
// ⚠️ La feuille liste des langues, pas des paires : une session par langue cible manquante, jamais
// une par paire. Plusieurs sessions ne mutualisent rien, elles empilent une feuille et un « Done »
// chacune, et aucune API ne regroupe plusieurs paires derrière une feuille unique.
// ⚠️ La greffe elle-même n'a jamais été éprouvée : un `NSHostingView` dans une `NSWindow` ordinaire
// suffit, mais la fenêtre de Tauri héberge un `WKWebView` et rien ne dit que la feuille s'y attache
// aussi bien.

/// La vue porteuse : invisible, et sa seule raison d'être est de recevoir `.translationTask`.
///
/// - Warning: ⚠️ elle ne traduit rien : `prepareTranslation()` demande à Apple de rendre la paire
///   utilisable, et c'est lui qui fait surgir la feuille quand la session peut télécharger.
@available(macOS 15.0, *)
private struct TranslationSheetCarrier: View {
  let configuration: TranslationSession.Configuration
  let onFinish: @MainActor () -> Void

  var body: some View {
    // ⚠️ 1 × 1 et transparent, mais jamais de taille nulle ni d'alpha zéro : la feuille s'attache
    // à la fenêtre de la vue hôte, et une vue qu'AppKit considère comme non rendue n'a pas de
    // fenêtre.
    Color.clear
      .frame(width: 1, height: 1)
      .translationTask(configuration) { session in
        try? await session.prepareTranslation()
        // ⚠️ Pas d'`await` : le corps de `translationTask` est déjà isolé au fil principal, et
        // `onFinish` l'est aussi. L'`await` qui était ici n'attendait rien — le compilateur le
        // disait, et un `await` qui ne saute aucune frontière fait croire à une attente.
        onFinish()
      }
  }
}

/// Garde en vie les hôtes greffés, un par langue cible.
///
/// - Warning: ⚠️ un `NSHostingView` qu'on ne retient pas est libéré avant que la feuille
///   n'apparaisse. La clé est la langue cible : re-demander la même pendant que sa feuille est
///   ouverte ne doit pas en empiler une seconde.
@available(macOS 15.0, *)
@MainActor
private final class TranslationSheetHost {
  static let shared = TranslationSheetHost()
  private var hosted: [String: NSView] = [:]

  /// Ce qu'une demande de greffe a donné.
  enum Outcome {
    /// La feuille vient d'être greffée.
    case presented
    /// Une feuille est déjà ouverte pour cette langue : la demande n'a rien fait.
    case alreadyPending
    /// La fenêtre n'a pas de vue de contenu, il n'y a nulle part où greffer.
    case noContentView
  }

  /// Greffe la feuille de traduction d'Apple pour `target`, si elle ne l'est pas déjà.
  ///
  /// - Returns: laquelle des trois issues s'est produite.
  func present(in window: NSWindow, target: String, source: String) -> Outcome {
    guard hosted[target] == nil else { return .alreadyPending }
    guard let content = window.contentView else { return .noContentView }

    let configuration = TranslationSession.Configuration(
      source: Locale.Language(identifier: source),
      target: Locale.Language(identifier: target))
    let view = NSHostingView(
      rootView: TranslationSheetCarrier(configuration: configuration) { [weak self] in
        self?.dismiss(target: target)
      })
    view.frame = NSRect(x: 0, y: 0, width: 1, height: 1)
    content.addSubview(view)
    hosted[target] = view
    return .presented
  }

  private func dismiss(target: String) {
    hosted.removeValue(forKey: target)?.removeFromSuperview()
  }
}

/// Demande à Apple de préparer la traduction vers `target`, en présentant sa feuille.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` que Rust obtient de `WebviewWindow::ns_window()`.
///   - target: la langue cible ; `source`, celle de la paire manquante à faire valoir.
///   - out: reçoit `"presented"`, `"alreadyPending"` si la feuille est déjà ouverte, ou l'erreur.
/// - Warning: ⚠️ à appeler depuis le fil principal (`run_on_main_thread` côté Rust), qu'AppKit et
///   SwiftUI exigent, à l'inverse des deux autres exports qui bloquent sur un sémaphore.
/// - Warning: ⚠️ le téléchargement est asynchrone : `"presented"` ne promet aucune installation.
@_cdecl("mirmalion_prepare_translation")
public func mirmalionPrepareTranslation(
  _ window: UnsafeMutableRawPointer?,
  _ target: UnsafePointer<CChar>?,
  _ source: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.window("fenêtre hôte absente : la feuille n'a nulle part où s'attacher")
    }
    // ⚠️ La garde de périmètre s'ouvre à la paire de mesure, et à elle seule : là où les 72 paires
    // du périmètre sont installées, aucune feuille ne peut surgir et la greffe resterait
    // invérifiable. Rust ne substitue cette paire qu'en développement (`commands/translation.rs`,
    // `probe_pair`) ; cette porte-ci ne s'ouvre qu'à la valeur exacte qu'il a substituée.
    let probe = ProcessInfo.processInfo.environment["MIRMALION_TRANSLATION_PROBE"]
      .flatMap { forced -> (source: String, target: String)? in
        let parts = forced.split(separator: "-", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return (parts[0], parts[1])
      }
    let requestedTarget = try requireArgument(target, "la langue cible")
    let requestedSource = try requireArgument(source, "la langue source")
    let targetLanguage =
      requestedTarget == probe?.target
      ? requestedTarget : try requireScopeLanguage(requestedTarget, "la langue cible")
    let sourceLanguage =
      requestedSource == probe?.source
      ? requestedSource : try requireScopeLanguage(requestedSource, "la langue source")
    guard sourceLanguage != targetLanguage else {
      throw BridgeError.invalidArgument(
        "la langue source et la langue cible sont identiques : rien à préparer")
    }
    guard #available(macOS 15.0, *) else {
      throw BridgeError.translation("la traduction demande un socle plus récent sur cette machine")
    }

    // ⚠️ Le pointeur se déballe ici, hors de la fermeture : capturer un pointeur brut dans une
    // fermeture isolée au fil principal lui fait franchir une frontière d'isolation, ce que
    // Swift 6 refuse. `NSWindow`, lui, est déjà `@MainActor`.
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    // ⚠️ Déjà sur le fil principal — Rust appelle par `run_on_main_thread`. On l'affirme plutôt
    // que de re-poster : un `DispatchQueue.main.async` ici rendrait la main avant la greffe, et
    // masquerait un appel fait du mauvais fil au lieu de le faire échouer.
    return try onMainActor("présentation de la feuille de traduction") {
      switch TranslationSheetHost.shared.present(
        in: nsWindow, target: targetLanguage, source: sourceLanguage)
      {
      case .presented: return "presented"
      case .alreadyPending: return "alreadyPending"
      case .noContentView:
        throw BridgeError.window("la fenêtre hôte n'a pas de vue de contenu")
      }
    }
  }
}
