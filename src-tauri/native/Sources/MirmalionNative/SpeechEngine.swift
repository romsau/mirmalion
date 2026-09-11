import AVFoundation
import Foundation
import Speech

// L'abstraction moteur, et pourquoi elle vit en Swift.
//
// Les moteurs envisagés — Apple `SpeechTranscriber`, le seul livré, Cohere via FluidAudio,
// Whisper via `whisper.cpp` — sont tous atteignables depuis Swift. La polymorphie vit donc du
// côté de l'audio : remonter le flux PCM à Rust coûterait une copie par tampon pour aboutir
// au même endroit. Le trait Rust (`src-tauri/src/stt/mod.rs`) répond à un autre besoin, une
// couture de test pour l'orchestrateur de dictée, qui doit être éprouvable sans micro.
//
// ⚠️ L'abstraction doit absorber un moteur qui ne produit aucun partiel : Whisper et Cohere
// sont batch, rien ne sort avant la fin de l'énoncé. D'où `EngineCapabilities.streaming`,
// dont l'interface se sert pour choisir ce qu'elle montre, jamais ce qu'elle appelle — les
// quatre gestes sont identiques pour tous les moteurs.
//
// La ponctuation est automatique et partielle, mesuré : seuls « virgule », « point
// d'interrogation » et « point d'exclamation » sont convertis, et aucun réglage n'existe.

/// Ce qu'un moteur déclare savoir faire. Traverse le pont en JSON.
struct EngineCapabilities: Encodable {
  /// Identifiant stable du moteur — `apple`, plus tard `whisper`, `cohere`.
  let id: String
  /// Rend-il des partiels au fil de l'eau ? Faux pour Whisper et Cohere.
  let streaming: Bool
  /// Les langues du périmètre que ce moteur couvre, en étiquettes primaires.
  let locales: [String]
  /// Celles dont les ressources sont réellement présentes sur cette machine.
  ///
  /// - Warning: ⚠️ « couverte » et « utilisable » diffèrent, et l'écart est la règle : sur un
  ///   Mac ordinaire, une ou deux des six langues ont leurs ressources. Une langue absente
  ///   d'ici ne transcrit rien, le moteur démarre et reste muet. C'est cette liste que le
  ///   sélecteur de langue doit consommer.
  let installedLocales: [String]
  /// Ce qui empêche de l'utiliser tout de suite, quand quelque chose l'empêche.
  let detail: String?
}

/// Ce qu'un moteur émet.
///
/// - Warning: ⚠️ un seul `final` ou `failed` par session, jamais les deux.
enum TranscriptionEvent {
  /// Texte provisoire : il remplace le précédent, il ne s'y ajoute pas.
  case partial(String)
  /// Texte définitif de la session. Arrive une fois et une seule.
  case final(String)
  /// Le moteur a renoncé. La session est terminée.
  case failed(String)

  /// La charge utile qui traverse le pont.
  var json: String {
    let (kind, payload): (String, String) = {
      switch self {
      case .partial(let text): return ("partial", text)
      case .final(let text): return ("final", text)
      case .failed(let message): return ("failed", message)
      }
    }()
    let escaped =
      String(data: (try? JSONEncoder().encode(payload)) ?? Data("\"\"".utf8), encoding: .utf8)
      ?? "\"\""
    return "{\"kind\":\"\(kind)\",\"text\":\(escaped)}"
  }
}

/// Le contrat que tout moteur de transcription remplit.
///
/// Quatre gestes, et ils suffisent : `start` prépare, `feed` alimente, `finish` clôt en
/// produisant le final, `cancel` abandonne sans rien produire. Un moteur batch se contente
/// d'accumuler dans `feed` et de tout transcrire dans `finish`.
protocol TranscriptionEngine: AnyObject {
  var capabilities: EngineCapabilities { get }
  func start(locale: String, emit: @escaping (TranscriptionEvent) -> Void) throws
  func feed(_ buffer: AVAudioPCMBuffer)
  func finish()
  func cancel()
}

/// Les 6 langues traitées de bout en bout.
///
/// - Warning: ⚠️ toutes les langues ne sont pas ouvrables, mesuré : `SpeechTranscriber` ne couvre
///   ni le néerlandais ni le turc, et `DictationTranscriber` — qui couvre 33 langues — ne
///   ponctue pas les textes longs (0 point sur 72 mots). Ne pas rouvrir sans nouvelle mesure.
let supportedLanguages = ["fr", "en", "es", "de", "it", "pt"]

/// Choisit la locale réellement installée avec laquelle transcrire.
///
/// Partagée par la dictée, le direct et la transcription de fichier, et elle doit le rester :
/// une copie finirait par dériver.
///
/// - Throws: `BridgeError.audio` si la langue est inconnue du moteur ou sans ressources.
/// - Warning: ⚠️ on transcrit avec la locale installée, pas avec celle qu'Apple résout.
///   `installedLocales` rend des locales complètes (`es_419`, `es-ES`…) que
///   `supportedLocale(equivalentTo:)` ne désigne pas forcément : comparer par identifiant
///   exact fait refuser une langue pourtant installée.
@available(macOS 26.0, *)
func installedLocale(matching locale: String) async throws -> Locale {
  // ⚠️ Une sous-étiquette ne suffit pas : `SpeechTranscriber(locale: Locale("fr"))` échoue sur
  // « initialized with unsupported locale ». Le moteur veut une locale complète et résolue, que
  // seule `supportedLocale(equivalentTo:)` donne — ne pas écrire l'identifiant en dur, la
  // variante retenue par Apple n'est pas devinable et peut changer.
  let asked = Locale(identifier: locale)
  guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: asked) else {
    throw BridgeError.audio(
      "la langue « \(locale) » n'est pas prise en charge par le moteur d'Apple")
  }

  // ⚠️ L'ordre des candidates compte : la variante qu'Apple désigne d'abord, à défaut
  // n'importe quelle installée de la même langue — un pack présent vaut mieux qu'un refus.
  // Aucun identifiant n'est deviné : on choisit parmi ce que la machine annonce.
  let installed = await SpeechTranscriber.installedLocales
  let usable =
    installed.first { $0.identifier == resolved.identifier }
    ?? installed.first { $0.language.languageCode == asked.language.languageCode }
  guard let usable else {
    // ⚠️ Le message nomme ce qui a été trouvé : sans cela, « pas installées » ne distingue pas
    // « rien pour cette langue » de « une variante que nous refusions ». Aucun contenu
    // utilisateur — des identifiants de locale, rien d'autre.
    throw BridgeError.audio(
      "les ressources de transcription de « \(locale) » ne sont pas installées sur cette machine (demandé \(resolved.identifier) ; présentes : \(installed.map(\.identifier).joined(separator: ", ")))"
    )
  }
  return usable
}

/// Convertit un tampon vers le format qu'attend l'analyseur.
///
/// - Returns: le tampon converti, ou `nil` si la conversion échoue ou ne rend rien.
/// - Warning: ⚠️ le format de l'analyseur n'est pas celui de la source — le micro rend du
///   44,1 kHz, un fichier la cadence de sa piste. Sans conversion, les tampons sont refusés en
///   silence : le moteur tourne et ne transcrit rien.
/// - Warning: ⚠️ la marge de 1 024 trames n'est pas décorative : `AVAudioConverter` peut rendre
///   un peu plus que le ratio théorique, et un tampon de sortie trop court fait échouer la
///   conversion entière plutôt que de la tronquer.
func convertBuffer(
  _ buffer: AVAudioPCMBuffer,
  with converter: AVAudioConverter,
  to target: AVAudioFormat
) -> AVAudioPCMBuffer? {
  let ratio = target.sampleRate / buffer.format.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
  guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
    return nil
  }

  // ⚠️ `nonisolated(unsafe)` et non une boîte synchronisée : AVFoundation déclare ce bloc
  // `@Sendable`, mais `convert(to:error:)` l'appelle **sur ce fil-ci et avant de rendre la
  // main**. Il n'y a donc pas d'autre fil pour lire `consumed` ni le tampon source. Un verrou
  // ici mentirait sur ce qui se passe ; le jour où AVFoundation appellerait le bloc en différé,
  // c'est la durée de vie du tampon système qui serait le problème, pas le décompte.
  nonisolated(unsafe) var consumed = false
  nonisolated(unsafe) let source = buffer
  var error: NSError?
  converter.convert(to: output, error: &error) { _, status in
    if consumed {
      status.pointee = .noDataNow
      return nil
    }
    consumed = true
    status.pointee = .haveData
    return source
  }

  guard error == nil, output.frameLength > 0 else { return nil }
  return output
}

@available(macOS 26.0, *)
private final class AppleSpeechEngine: TranscriptionEngine, @unchecked Sendable {
  private let lock = NSLock()

  private var analyzer: SpeechAnalyzer?
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?
  private var collected = AttributedString()
  private var emit: ((TranscriptionEvent) -> Void)?
  private var resultsTask: Task<Void, Never>?
  private var closed = false

  /// Ce que ce moteur déclare savoir faire, langues installées comprises.
  var capabilities: EngineCapabilities {
    // ⚠️ La seule capacité que le pont rend sans pouvoir lancer : un moteur muet doit se décrire
    // comme n'ayant aucune langue installée, pas empêcher la lecture de ses capacités.
    let installed: [String] =
      (try? awaiting("les langues installées", within: BridgeDeadline.speechAssets) {
        let installed = await SpeechTranscriber.installedLocales
        return supportedLanguages.filter { language in
          installed.contains { $0.identifier.hasPrefix(language) }
        }
      }) ?? []

    return EngineCapabilities(
      id: "apple",
      streaming: true,
      locales: supportedLanguages,
      installedLocales: installed,
      detail: SpeechTranscriber.isAvailable
        ? nil : "le moteur de transcription d'Apple n'est pas disponible sur cette machine"
    )
  }

  /// Ouvre une session de transcription et branche le rappel qui en recevra les évènements.
  ///
  /// - Parameters:
  ///   - locale: la langue de transcription.
  ///   - emit: le rappel qui reçoit partiels, final et échec.
  /// - Throws: `BridgeError.audio` si le moteur ne peut pas être préparé.
  func start(locale: String, emit: @escaping (TranscriptionEvent) -> Void) throws {
    let prepared = try prepare(locale: locale)
    let transcriber = prepared.transcriber
    let format = prepared.format

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    lock.lock()
    self.analyzer = analyzer
    self.continuation = continuation
    self.analyzerFormat = format
    self.converter = nil
    self.collected = AttributedString()
    self.emit = emit
    self.closed = false
    lock.unlock()

    // Les résultats arrivent en séquence asynchrone. Une tâche les draine et les traduit en
    // évènements ; elle s'éteint d'elle-même quand le flux se ferme.
    let drain = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          self?.publish(result)
        }
        self?.publishFinal()
      } catch {
        self?.close(
          with: .failed("le moteur de transcription a échoué : \(bridgeMessage(error))"))
      }
    }
    lock.lock()
    resultsTask = drain
    lock.unlock()

    Task { [weak self] in
      do {
        // ⚠️ Pré-chauffe avant démarrage. Sans elle, le modèle se charge à la première
        // analyse : les tampons s'accumulent en attendant, et le texte ne sort qu'à la
        // finalisation — un moteur qui a l'air muet puis recrache tout d'un coup. C'est aussi
        // ce qui pèse sur le budget de latence.
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: stream)
      } catch {
        self?.close(
          with: .failed(
            "le moteur de transcription n'a pas démarré : \(bridgeMessage(error))")
        )
      }
    }
  }

  /// Tout ce qui doit être obtenu avant d'ouvrir une session, et qui ne s'obtient qu'en
  /// asynchrone.
  private struct Prepared {
    let transcriber: SpeechTranscriber
    let format: AVAudioFormat
  }

  /// Résout la langue, vérifie que ses ressources sont là, et obtient le format d'analyse.
  ///
  /// Le sémaphore fait le joint entre ces API asynchrones et le pont, qui est synchrone. Sans
  /// danger : Rust appelle depuis `spawn_blocking`, jamais depuis le fil principal.
  ///
  /// - Returns: le transcripteur de `locale` et le format audio à lui donner.
  /// - Throws: `BridgeError.audio` si la langue n'est pas installée — ⚠️ « supportée » et
  ///   « installée » diffèrent, et une langue supportée sans ressources ne transcrit rien. On
  ///   le dit ici plutôt que de laisser le moteur démarrer et rester muet.
  private func prepare(locale: String) throws -> Prepared {
    try awaiting("la préparation du moteur", within: BridgeDeadline.engineSetup) {
      let usable: Locale
      do {
        usable = try await installedLocale(matching: locale)
      } catch {
        throw BridgeError.audio(bridgeMessage(error))
      }

      // ⚠️ Le préréglage d'Apple, et non des options assemblées à la main : composer
      // `reportingOptions: [.volatileResults]` soi-même fait taire le moteur jusqu'à la
      // finalisation, puis tout recracher d'un coup — 72 évènements en 140 ms, mesuré. Il y
      // manque le `.fastResults` que le préréglage inclut.
      let transcriber = SpeechTranscriber(locale: usable, preset: .progressiveTranscription)

      // ⚠️ Le format de l'analyseur n'est pas celui du micro, qui rend du 44,1 kHz. Sans
      // conversion, les tampons sont refusés en silence : le moteur tourne et ne transcrit
      // rien.
      guard
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
      else {
        throw BridgeError.audio(
          "le moteur n'expose aucun format audio compatible pour « \(locale) »")
      }

      return Prepared(transcriber: transcriber, format: format)
    }
  }

  /// Convertit un tampon micro au format de l'analyseur et le lui donne.
  ///
  /// - Parameter buffer: le tampon capté, dans le format du périphérique.
  func feed(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    guard let continuation, let target = analyzerFormat else {
      lock.unlock()
      return
    }
    if converter == nil {
      converter = AVAudioConverter(from: buffer.format, to: target)
    }
    let converter = self.converter
    lock.unlock()

    guard let converter, let converted = convert(buffer, with: converter, to: target) else {
      return
    }
    continuation.yield(AnalyzerInput(buffer: converted))
  }

  /// Clôt l'entrée et demande la finalisation : le texte définitif suivra par `emit`.
  func finish() {
    lock.lock()
    let continuation = self.continuation
    let analyzer = self.analyzer
    self.continuation = nil
    lock.unlock()

    // Fermer l'entrée suffit à déclencher la finalisation ; on la demande explicitement en
    // plus, pour ne pas dépendre d'un enchaînement implicite.
    continuation?.finish()
    Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
  }

  /// Abandonne la session : aucun évènement n'en sortira.
  func cancel() {
    // ⚠️ `emit` est vidé avant d'arrêter quoi que ce soit, et c'est tout l'intérêt d'une
    // annulation : rien ne doit passer, pas même le résultat déjà en vol au moment du clic.
    lock.lock()
    let continuation = self.continuation
    let analyzer = self.analyzer
    let drain = self.resultsTask
    self.continuation = nil
    self.resultsTask = nil
    self.analyzer = nil
    self.emit = nil
    self.closed = true
    self.collected = AttributedString()
    lock.unlock()

    continuation?.finish()
    drain?.cancel()
    Task { await analyzer?.cancelAndFinishNow() }
  }

  /// Convertit un tampon micro au format de l'analyseur.
  ///
  /// Voir `convertBuffer` : la conversion est partagée avec la transcription de fichier.
  private func convert(
    _ buffer: AVAudioPCMBuffer,
    with converter: AVAudioConverter,
    to target: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    convertBuffer(buffer, with: converter, to: target)
  }

  /// Émet le texte complet à afficher : les segments acquis, plus l'hypothèse en cours.
  ///
  /// L'appelant n'a rien à recoller, contrairement au direct qui, lui, ne reçoit que le delta.
  ///
  /// - Parameter result: le résultat rendu par le transcripteur.
  /// - Warning: ⚠️ deux natures, et les confondre casse le texte. Un résultat volatile
  ///   (`isFinal == false`) remplace le précédent — l'accumuler répéterait le même bout de
  ///   phrase ; un résultat finalisé s'ajoute — le remplacer perdrait le début de la dictée.
  private func publish(_ result: SpeechTranscriber.Result) {
    lock.lock()
    if result.isFinal {
      collected += result.text
    }
    let visible = result.isFinal ? collected : collected + result.text
    let emit = self.emit
    lock.unlock()

    emit?(.partial(String(visible.characters)))
  }

  /// Le flux est clos proprement : publie le texte accumulé, une fois.
  private func publishFinal() {
    lock.lock()
    let text = String(collected.characters)
    lock.unlock()
    close(with: .final(text))
  }

  /// Ferme la session sur un évènement terminal.
  ///
  /// Idempotente : c'est ce qui garantit « un seul `final` ou `failed` par session », quel que
  /// soit l'ordre d'arrivée des échecs et de la fin de flux.
  ///
  /// - Parameter event: l'évènement terminal à émettre.
  private func close(with event: TranscriptionEvent) {
    lock.lock()
    guard !closed else {
      lock.unlock()
      return
    }
    closed = true
    let emit = self.emit
    self.emit = nil
    lock.unlock()

    emit?(event)
  }
}

/// Le moteur du processus, et le fil qui le relie à la capture.
///
/// Une seule session à la fois : la dictée est mono-source, et rien dans le produit ne demande
/// deux transcriptions simultanées.
private final class SpeechSession: @unchecked Sendable {
  private let lock = NSLock()
  private var engine: TranscriptionEngine?

  /// L'observateur côté Rust. Voir `mirmalion_stt_set_observer`.
  private var observer: TranscriptionObserver?

  /// - Parameter observer: le destinataire des évènements, ou `nil` pour le débrancher.
  func setObserver(_ observer: TranscriptionObserver?) {
    lock.lock()
    defer { lock.unlock() }
    self.observer = observer
  }

  /// - Returns: ce que le moteur sait faire sur cette machine.
  func capabilities() throws -> EngineCapabilities {
    guard #available(macOS 26.0, *) else {
      return EngineCapabilities(
        id: "apple",
        streaming: true,
        locales: [],
        installedLocales: [],
        detail: "SpeechTranscriber demande macOS 26 ; Whisper prendra le relais (phase 5)"
      )
    }
    return AppleSpeechEngine().capabilities
  }

  /// Ouvre une session et branche le puits de la capture sur le moteur.
  ///
  /// - Parameter locale: la langue de transcription, dans le périmètre du produit.
  /// - Throws: `BridgeError.invalidArgument` si la langue est hors périmètre,
  ///   `BridgeError.audio` si le moteur ne démarre pas.
  func start(locale: String) throws {
    guard supportedLanguages.contains(locale) else {
      throw BridgeError.invalidArgument("langue hors périmètre : « \(locale) »")
    }
    guard #available(macOS 26.0, *) else {
      throw BridgeError.audio("SpeechTranscriber demande macOS 26")
    }

    // Une session en cours est abandonnée, pas empilée : redémarrer vaut « on recommence ».
    cancel()

    let engine = AppleSpeechEngine()
    try engine.start(locale: locale) { [weak self] event in
      self?.notify(event)
    }

    lock.lock()
    self.engine = engine
    lock.unlock()

    // ⚠️ Le puits se branche après le démarrage du moteur. L'inverse ferait arriver des
    // tampons à un moteur qui n'a pas encore son flux d'entrée : ils seraient perdus, et ce
    // sont les premiers mots de la dictée.
    sharedCapture.setSink { [weak engine] buffer in
      engine?.feed(buffer)
    }
  }

  /// Débranche le puits et demande au moteur son texte définitif.
  func finish() {
    lock.lock()
    let engine = self.engine
    lock.unlock()

    // ⚠️ Le puits part d'abord : plus un seul tampon ne doit entrer pendant la finalisation.
    sharedCapture.setSink(nil)
    engine?.finish()
  }

  /// Abandonne la session en cours. Sans effet si aucune ne tourne.
  func cancel() {
    lock.lock()
    let engine = self.engine
    self.engine = nil
    lock.unlock()

    sharedCapture.setSink(nil)
    engine?.cancel()
  }

  /// Pousse un évènement à l'observateur, s'il y en a un.
  private func notify(_ event: TranscriptionEvent) {
    lock.lock()
    let observer = self.observer
    lock.unlock()

    guard let observer else { return }
    event.json.withCString { observer($0) }
  }
}

/// Le rappel que Rust enregistre pour recevoir les évènements de transcription.
///
/// - Warning: ⚠️ la chaîne n'est valide que pendant l'appel : Rust doit la copier
///   immédiatement et ne jamais la conserver. C'est le seul endroit du pont où la propriété
///   des chaînes s'inverse — partout ailleurs, Swift alloue et Swift libère.
/// - Warning: ⚠️ appelé depuis un fil quelconque, jamais le fil principal : le rappel doit
///   être réentrant et bon marché.
public typealias TranscriptionObserver = @convention(c) (UnsafePointer<CChar>?) -> Void

/// L'unique session de dictée du processus.
private let sharedSession = SpeechSession()

/// Écrit dans `out` le JSON de ce que le moteur de transcription sait faire.
///
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
@_cdecl("mirmalion_stt_capabilities")
public func mirmalionSttCapabilities(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    return try bridgeJSON(sharedSession.capabilities())
  }
}

/// Enregistre — ou retire, avec `nil` — le destinataire des évènements de transcription.
///
/// - Returns: `statusOK`.
@_cdecl("mirmalion_stt_set_observer")
public func mirmalionSttSetObserver(
  _ observer: TranscriptionObserver?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedSession.setObserver(observer)
    return ""
  }
}

/// Démarre une session de transcription dans la langue donnée.
///
/// - Parameter locale: le code de la langue, dans le périmètre du produit.
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
/// - Warning: ⚠️ n'ouvre pas le micro : la capture se démarre séparément, par
///   `mirmalion_start_capture`. L'ordre est imposé à l'appelant Rust — moteur d'abord, capture
///   ensuite, sans quoi les premiers tampons arrivent dans le vide.
@_cdecl("mirmalion_stt_start")
public func mirmalionSttStart(
  _ locale: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let locale else {
      throw BridgeError.invalidArgument("aucune langue fournie au moteur de transcription")
    }
    try sharedSession.start(locale: String(cString: locale))
    return ""
  }
}

/// Termine la session : le moteur finalise et émet son texte définitif.
///
/// - Returns: `statusOK`.
@_cdecl("mirmalion_stt_finish")
public func mirmalionSttFinish(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedSession.finish()
    return ""
  }
}

/// Abandonne la session : aucun évènement n'en sortira, ni final, ni partiel.
///
/// - Returns: `statusOK`.
@_cdecl("mirmalion_stt_cancel")
public func mirmalionSttCancel(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedSession.cancel()
    return ""
  }
}
