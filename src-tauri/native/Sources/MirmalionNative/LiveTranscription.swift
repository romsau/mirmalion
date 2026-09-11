import AVFoundation
import Foundation
import Speech

// Transcrire une session en direct : un moteur par flux.
//
// ⚠️ Deux `SpeechAnalyzer` tournent en même temps — mesuré, rien chez Apple ne le documente
// (`cargo test --test concurrent_stt -- --ignored`). Ne pas les fusionner en croyant
// économiser : la séparation des flux est ce qui rend « Moi » certain sans la moindre
// inférence, et le micro l'est par construction.
//
// ⚠️ On n'émet jamais le transcript entier, contrairement à la dictée : chaque évènement ne
// porte que ce qui vient d'arriver — un segment `final`, qui s'ajoute, ou l'hypothèse
// `partial`, qui remplace la précédente du même flux. C'est l'écran qui accumule ; republier
// tout ferait passer des dizaines de milliers de mots par l'IPC plusieurs fois par seconde.
//
// ⚠️ Un moteur qui ne démarre pas n'empêche pas d'enregistrer : l'audio est la seule chose
// irremplaçable. Une langue absente fait échouer la transcription, jamais la capture.

/// D'où vient un morceau de transcript. Deux flux, et ils ne se rejoignent jamais.
enum LiveStream: String {
  /// L'audio de l'application captée : la voix des autres.
  case system
  /// Le micro de l'utilisateur : « Moi », par construction.
  case microphone
}

/// Ce qu'un flux vient de produire. Traverse le pont en JSON.
///
/// - Warning: ⚠️ `text` ne porte que le nouveau morceau, jamais le transcript accumulé : c'est
///   ce qui rend le coût d'une session de deux heures indépendant de sa durée.
/// - Warning: ⚠️ `words` n'accompagne que les segments finalisés et ne va pas à l'écran — les
///   hypothèses sont réécrites plusieurs fois par seconde. Côté Rust, ces mots s'arrêtent au
///   backend : ils servent à la consolidation, pas à l'affichage.
private struct LiveTranscriptEvent: Encodable {
  let stream: LiveStream
  /// `partial`, `final`, `failed` ou `finished`.
  let kind: String
  let text: String
  let words: [TimedWord]

  init(stream: LiveStream, kind: String, text: String, words: [TimedWord] = []) {
    self.stream = stream
    self.kind = kind
    self.text = text
    self.words = words
  }

  enum CodingKeys: String, CodingKey {
    case stream, kind, text, words
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(stream.rawValue, forKey: .stream)
    try container.encode(kind, forKey: .kind)
    try container.encode(text, forKey: .text)
    try container.encode(words, forKey: .words)
  }

  /// L'évènement encodé en JSON, tel qu'il traverse le pont.
  var json: String {
    guard let data = try? JSONEncoder().encode(self),
      let encoded = String(data: data, encoding: .utf8)
    else {
      // ⚠️ Un évènement inencodable ne disparaît pas en silence : il part en `failed`, ce que
      // l'écran sait dire. Le perdre laisserait un flux muet sans que rien n'explique pourquoi.
      return
        "{\"stream\":\"\(stream.rawValue)\",\"kind\":\"failed\",\"text\":\"transcript inencodable\",\"words\":[]}"
    }
    return encoded
  }
}

@available(macOS 26.0, *)
private final class StreamTranscriber: @unchecked Sendable {
  private let stream: LiveStream
  private let emit: (LiveTranscriptEvent) -> Void

  private let lock = NSLock()
  private var analyzer: SpeechAnalyzer?
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?
  private var resultsTask: Task<Void, Never>?
  private var closed = false
  /// Le signal de fin est-il déjà parti ? Voir `complete`.
  private var announced = false
  /// La capture a-t-elle été abandonnée ?
  ///
  /// - Warning: ⚠️ distinct de `closed`, que posent aussi la finalisation et l'échec : seul
  ///   l'abandon interdit le signal de fin.
  private var abandoned = false

  /// - Parameters:
  ///   - stream: le flux dont ce moteur a la charge.
  ///   - emit: le rappel qui reçoit chaque évènement produit.
  init(stream: LiveStream, emit: @escaping (LiveTranscriptEvent) -> Void) {
    self.stream = stream
    self.emit = emit
  }

  /// Prépare et démarre le moteur pour ce flux.
  ///
  /// - Parameter locale: la langue de transcription.
  /// - Throws: `BridgeError.audio` si le moteur ne peut pas être préparé.
  /// - Warning: ⚠️ synchrone à dessein. L'appelant est `LiveCapture.start` : rendre la main
  ///   avant que le moteur soit prêt ferait arriver les premiers tampons dans le vide — et ce
  ///   sont les premiers mots de la session.
  func start(locale: String) throws {
    let prepared = try prepare(locale: locale)

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [prepared.transcriber])

    lock.lock()
    self.analyzer = analyzer
    self.continuation = continuation
    self.analyzerFormat = prepared.format
    self.converter = nil
    self.closed = false
    lock.unlock()

    let transcriber = prepared.transcriber
    let drain = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          self?.publish(result)
        }
      } catch {
        self?.fail("le moteur de transcription a échoué : \(bridgeMessage(error))")
      }
      // ⚠️ La fin de cette boucle est le seul signal fiable de finalisation : `finish()` rend
      // la main tout de suite, les derniers segments arrivent après, et l'appelant ne sait pas
      // combien il en reste. Sans ce signal, la consolidation attendrait un délai au jugé —
      // trop court elle perd la fin de la session, trop long elle fait patienter pour rien.
      self?.complete()
    }
    lock.lock()
    resultsTask = drain
    lock.unlock()

    let format = prepared.format
    Task { [weak self] in
      do {
        // ⚠️ Pré-chauffe avant démarrage, comme en dictée : sans elle le modèle se charge à la
        // première analyse, les tampons s'accumulent, et le texte ne sort qu'à la fin — un
        // moteur qui a l'air muet puis recrache tout d'un coup.
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: stream)
      } catch {
        self?.fail(
          "le moteur de transcription n'a pas démarré : \(bridgeMessage(error))")
      }
    }
  }

  /// Ce qu'il faut obtenir avant d'ouvrir une session, et qui ne s'obtient qu'en asynchrone.
  private struct Prepared {
    let transcriber: SpeechTranscriber
    let format: AVAudioFormat
  }

  /// Résout la langue et obtient le format d'analyse.
  ///
  /// - Returns: le transcripteur de `locale` et le format audio à lui donner.
  /// - Throws: `BridgeError.audio` si la langue n'est pas installée ou si aucun format
  ///   compatible n'est exposé.
  /// - Warning: ⚠️ un préréglage, jamais des options à la main : composer `[.volatileResults]`
  ///   soi-même fait taire le moteur jusqu'à la finalisation, faute de `.fastResults`.
  /// - Warning: ⚠️ le préréglage horodaté fait porter `audioTimeRange` aux résultats ; sans ces
  ///   fenêtres, la consolidation n'a rien à rapprocher des tours de parole.
  private func prepare(locale: String) throws -> Prepared {
    try awaiting("la préparation du moteur", within: BridgeDeadline.engineSetup) {
      do {
        // ⚠️ On transcrit avec la locale installée, pas avec celle qu'Apple résout : d'où
        // `installedLocale`, partagée avec la dictée et la transcription de fichier.
        let usable = try await installedLocale(matching: locale)
        let transcriber = SpeechTranscriber(
          locale: usable, preset: .timeIndexedProgressiveTranscription)
        guard
          let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber])
        else {
          throw BridgeError.audio(
            "le moteur n'expose aucun format audio compatible pour « \(locale) »")
        }
        return Prepared(transcriber: transcriber, format: format)
      } catch let ours as BridgeError {
        throw ours
      } catch {
        throw BridgeError.audio(bridgeMessage(error))
      }
    }
  }

  /// Reçoit un tampon et l'envoie à l'analyseur, converti au format attendu.
  ///
  /// - Parameter buffer: le tampon, dans le format du périphérique.
  /// - Warning: ⚠️ appelée depuis un fil temps réel de Core Audio. La conversion y reste parce
  ///   qu'elle est bornée ; ce qui est interdit, c'est une attente, et `yield` sur un
  ///   `AsyncStream` ne bloque pas.
  /// - Warning: ⚠️ le tampon système ne survit pas à l'appel — il enveloppe la mémoire de Core
  ///   Audio sans copie. `convertBuffer` recopie synchroniquement : ne pas différer.
  func feed(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    guard let continuation, let target = analyzerFormat, !closed else {
      lock.unlock()
      return
    }
    if converter == nil || converter?.inputFormat != buffer.format {
      // ⚠️ Le format d'entrée change quand la sortie change en cours de session : un
      // convertisseur gardé sur l'ancien échouerait en silence, et le flux se tairait.
      converter = AVAudioConverter(from: buffer.format, to: target)
    }
    let converter = self.converter
    lock.unlock()

    guard let converter, let converted = convertBuffer(buffer, with: converter, to: target)
    else { return }
    continuation.yield(AnalyzerInput(buffer: converted))
  }

  /// Ferme l'entrée et demande la finalisation.
  ///
  /// - Warning: ⚠️ les derniers segments arrivent après le retour de cet appel ; c'est la fin
  ///   de la boucle de résultats, et elle seule, qui dit que le flux a tout rendu.
  func finish() {
    lock.lock()
    let continuation = self.continuation
    let analyzer = self.analyzer
    self.continuation = nil
    self.closed = true
    lock.unlock()

    continuation?.finish()
    Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
  }

  /// Abandonne : rien n'en sortira, pas même ce qui était déjà en vol, ni le signal de fin.
  func cancel() {
    lock.lock()
    let continuation = self.continuation
    let analyzer = self.analyzer
    let drain = self.resultsTask
    self.continuation = nil
    self.resultsTask = nil
    self.analyzer = nil
    self.closed = true
    self.abandoned = true
    lock.unlock()

    continuation?.finish()
    drain?.cancel()
    Task { await analyzer?.cancelAndFinishNow() }
  }

  /// Émet le morceau qu'un résultat vient d'apporter, jamais l'accumulation.
  ///
  /// - Parameter result: le résultat rendu par le transcripteur.
  /// - Warning: ⚠️ un morceau vide n'est pas émis. Le moteur en produit entre deux énoncés, et
  ///   chacun effacerait l'hypothèse affichée pour la réafficher au tampon suivant : le
  ///   transcript clignoterait.
  /// - Warning: ⚠️ les mots n'accompagnent que les segments finalisés — voir
  ///   `LiveTranscriptEvent`.
  private func publish(_ result: SpeechTranscriber.Result) {
    let text = String(result.text.characters)
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    emit(
      LiveTranscriptEvent(
        stream: stream,
        kind: result.isFinal ? "final" : "partial",
        text: text,
        words: result.isFinal ? timedWords(in: result.text) : []
      ))
  }

  /// Annonce que ce flux a rendu tout ce qu'il avait, une fois et une seule.
  ///
  /// - Warning: ⚠️ rien après une annulation : `cancel()` veut dire « rien n'en sortira », ce
  ///   signal compris. Un consommateur qui l'attendrait après une capture avortée croirait à
  ///   une session terminée normalement.
  private func complete() {
    lock.lock()
    guard !announced, !abandoned else {
      lock.unlock()
      return
    }
    announced = true
    lock.unlock()
    emit(LiveTranscriptEvent(stream: stream, kind: "finished", text: ""))
  }

  /// Signale un échec, une fois et une seule, quel que soit l'ordre d'arrivée des pannes.
  ///
  /// - Parameter message: le message destiné à l'écran.
  private func fail(_ message: String) {
    lock.lock()
    guard !closed else {
      lock.unlock()
      return
    }
    closed = true
    lock.unlock()
    emit(LiveTranscriptEvent(stream: stream, kind: "failed", text: message))
  }
}

/// Les deux moteurs d'une session, et le fil qui les relie à Rust.
///
/// Une seule instance (`sharedLiveTranscription`) : la capture est unique, sa transcription
/// l'est aussi.
final class LiveTranscription: @unchecked Sendable {
  private let lock = NSLock()
  private var observer: TranscriptionObserver?
  private var transcribers: [LiveStream: AnyObject] = [:]

  /// - Parameter observer: le destinataire des évènements, ou `nil` pour le débrancher.
  func setObserver(_ observer: TranscriptionObserver?) {
    lock.lock()
    defer { lock.unlock() }
    self.observer = observer
  }

  /// Ouvre un moteur par flux demandé.
  ///
  /// - Parameters:
  ///   - locale: la langue de transcription.
  ///   - streams: les flux à transcrire — le micro en est absent quand l'utilisateur l'exclut.
  /// - Warning: ⚠️ ne lance jamais. L'appelant est le démarrage de la capture : faire échouer
  ///   une session parce qu'une langue n'est pas installée perdrait l'audio, la seule chose
  ///   irremplaçable. L'échec part en évènement `failed` et le magnétophone tourne.
  func start(locale: String, streams: [LiveStream]) {
    cancel()
    guard #available(macOS 26.0, *) else {
      for stream in streams {
        notify(
          LiveTranscriptEvent(
            stream: stream,
            kind: "failed",
            text: "la transcription en direct exige macOS 26"
          ))
      }
      return
    }

    var opened: [LiveStream: AnyObject] = [:]
    for stream in streams {
      let transcriber = StreamTranscriber(stream: stream) { [weak self] event in
        self?.notify(event)
      }
      do {
        try transcriber.start(locale: locale)
        opened[stream] = transcriber
      } catch {
        notify(
          LiveTranscriptEvent(
            stream: stream, kind: "failed", text: bridgeMessage(error)))
      }
    }

    lock.lock()
    transcribers = opened
    lock.unlock()
  }

  /// Alimente le moteur d'un flux. Sans effet si ce flux n'est pas transcrit.
  ///
  /// - Parameters:
  ///   - buffer: le tampon capté.
  ///   - stream: le flux dont il provient.
  func feed(_ buffer: AVAudioPCMBuffer, from stream: LiveStream) {
    guard #available(macOS 26.0, *) else { return }
    lock.lock()
    let transcriber = transcribers[stream] as? StreamTranscriber
    lock.unlock()
    transcriber?.feed(buffer)
  }

  /// Clôt les deux moteurs sans vider la table : elle se videra au prochain démarrage ou à
  /// l'annulation, quand plus rien ne sera attendu de ces moteurs-là.
  ///
  /// - Warning: ⚠️ les derniers segments arrivent après le retour de cet appel ; l'attendre
  ///   bloquerait l'arrêt de la capture sur un moteur qui a encore du travail.
  /// - Warning: ⚠️ ne pas vider `transcribers` ici : c'est la dernière référence forte aux
  ///   transcripteurs, que la tâche de drainage ne tient qu'en `weak`. Les lâcher au moment de
  ///   la finalisation les désalloue avant qu'elle n'aboutisse, et chaque segment finalisé part
  ///   dans le vide — mesuré : 94 hypothèses reçues, zéro segment acquis.
  func finish() {
    guard #available(macOS 26.0, *) else { return }
    lock.lock()
    let opened = transcribers
    lock.unlock()
    for transcriber in opened.values {
      (transcriber as? StreamTranscriber)?.finish()
    }
  }

  /// Abandonne les deux moteurs et vide la table. Rien n'en sortira.
  func cancel() {
    guard #available(macOS 26.0, *) else { return }
    lock.lock()
    let opened = transcribers
    transcribers = [:]
    lock.unlock()
    for transcriber in opened.values {
      (transcriber as? StreamTranscriber)?.cancel()
    }
  }

  /// Pousse un évènement à l'observateur, s'il y en a un.
  private func notify(_ event: LiveTranscriptEvent) {
    lock.lock()
    let observer = self.observer
    lock.unlock()
    guard let observer else { return }
    event.json.withCString { observer($0) }
  }
}

/// L'unique transcription de session du processus.
let sharedLiveTranscription = LiveTranscription()

// MARK: - Exports

/// Enregistre — ou retire, avec `nil` — le destinataire des évènements de transcript de
/// session.
///
/// - Returns: `statusOK`.
/// - Warning: ⚠️ un canal distinct de celui de la dictée : les deux ne portent pas la même
///   charge utile (celle-ci nomme son flux) et n'ont pas le même consommateur. Un observateur
///   commun obligerait chaque destinataire à trier ce qui ne le concerne pas.
@_cdecl("mirmalion_live_set_transcript_observer")
public func mirmalionLiveSetTranscriptObserver(
  _ observer: TranscriptionObserver?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedLiveTranscription.setObserver(observer)
    return ""
  }
}
