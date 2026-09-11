import AVFoundation
import Foundation
import NaturalLanguage
import Speech

// Identifier la langue parlée d'un média : une brique qu'Apple ne fournit pas.
//
// `NLLanguageRecognizer` travaille sur du texte et `SpeechTranscriber` exige qu'on lui dise la
// langue avant d'ouvrir une session : il n'y a rien à appeler. On transcrit donc un échantillon
// avec chaque langue installée, puis on demande au reconnaisseur laquelle des sorties est bien
// écrite dans la langue qui l'a produite — c'est ce désaccord qui trie.
//
// ⚠️ Le coût se compte en langues installées, pas en langues du périmètre : mesuré à 3 s sur le
// média de référence, verdict « fr » à 0,9999.
// ⚠️ Une langue non installée ne peut pas être détectée. Le message d'erreur doit distinguer
// « langue hors des neuf » de « langue des neuf dont les ressources manquent » : dans le premier
// cas l'utilisateur n'a rien à faire, dans le second il lui suffit d'installer la langue.

/// La durée d'écoute pour trancher : 30 s, assez pour plusieurs phrases complètes, soit environ
/// un tiers de seconde par langue essayée.
///
/// - Warning: ⚠️ trop court, la détection est instable — une salutation ressemble à beaucoup de
///   langues ; trop long, l'utilisateur attend avant même que la transcription ne commence.
private let sampleSeconds = 30.0

/// Ce que la détection rend.
private struct LanguageVerdict: Encodable {
  /// L'étiquette primaire retenue — `fr`, `en`… `nil` si rien n'a pu être décidé.
  let language: String?
  /// Ce qui a empêché de décider, le cas échéant : un code, jamais une phrase.
  let problem: String?
  /// La confiance du reconnaisseur sur la langue retenue, entre 0 et 1.
  let confidence: Double
  /// Les langues effectivement essayées — utile aux mesures, et au message d'erreur.
  let tried: [String]
}

/// Ce qui a empêché de décider d'une langue. Le code voyage tel quel jusqu'à l'interface.
enum LanguageProblem: String {
  /// Le média ne porte aucune parole exploitable.
  case noSpeech
  /// Aucune des langues installées ne correspond.
  ///
  /// - Warning: ⚠️ distinct de `noSpeech` : ici il y a de la parole, elle n'est simplement dans
  ///   aucune langue qu'on sache traiter.
  case unsupportedLanguage
  /// Le média porte de la parole, mais trop peu pour trancher.
  ///
  /// - Warning: ⚠️ distinct d'`unsupportedLanguage` : renvoyer l'utilisateur installer une langue
  ///   ne l'avancerait pas, le texte resterait trop court pour être jugé.
  case tooShort
  /// Aucune des six langues n'a ses ressources sur cette machine.
  case noInstalledLanguage
}

/// En deçà de ce nombre de caractères, un échantillon n'est pas jugeable.
///
/// - Warning: ⚠️ Le reconnaisseur est confiant à tort sur deux mots : « Bonjour » ressemble à
///   beaucoup de choses.
private let judgeableLength = 20

@available(macOS 26.0, *)
private func sampleText(asset: AVURLAsset, locale: Locale, seconds: Double) async throws -> String {
  guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
    return ""
  }

  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  guard
    let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
  else {
    return ""
  }

  let reader = try AVAssetReader(asset: asset)
  reader.timeRange = CMTimeRange(
    start: .zero, duration: CMTime(seconds: seconds, preferredTimescale: 600))
  let output = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMIsFloatKey: true,
      AVLinearPCMBitDepthKey: 32,
      AVLinearPCMIsNonInterleaved: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
  )
  reader.add(output)

  let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(modules: [transcriber])

  let collected = ResultCollector()
  let drain = Task {
    for try await result in transcriber.results where result.isFinal {
      collected.append(String(result.text.characters))
    }
  }

  try await analyzer.prepareToAnalyze(in: format)
  async let running: Void = analyzer.start(inputSequence: stream)

  reader.startReading()
  var converter: AVAudioConverter?
  while let sample = output.copyNextSampleBuffer() {
    defer { CMSampleBufferInvalidate(sample) }
    guard let buffer = pcmBuffer(from: sample) else { continue }
    if converter == nil {
      converter = AVAudioConverter(from: buffer.format, to: format)
    }
    if let converter, let converted = convertBuffer(buffer, with: converter, to: format) {
      continuation.yield(AnalyzerInput(buffer: converted))
    }
  }

  continuation.finish()
  try await analyzer.finalizeAndFinishThroughEndOfInput()
  _ = try? await running
  _ = try? await drain.value

  return collected.text
}

/// Accumule le texte d'un échantillon depuis une tâche concurrente.
private final class ResultCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var pieces: [String] = []

  func append(_ piece: String) {
    lock.lock()
    pieces.append(piece)
    lock.unlock()
  }

  var text: String {
    lock.lock()
    defer { lock.unlock() }
    return pieces.joined()
  }
}

/// Note à quel point `text` ressemble à du `language`.
///
/// - Parameters:
///   - text: la transcription à juger.
///   - language: l'étiquette de la langue qui l'a produite.
/// - Returns: la probabilité entre 0 et 1 ; 0 si la langue n'est pas dans les cinq hypothèses.
/// - Warning: ⚠️ on interroge le reconnaisseur sur une langue précise, jamais sur la dominante :
///   une transcription faite avec le mauvais moteur a une dominante quelconque, mais une
///   probabilité basse d'être écrite dans la langue qui l'a produite.
private func score(text: String, as language: String) -> Double {
  // ⚠️ Un échantillon trop court n'est pas jugé : le reconnaisseur est confiant à tort sur
  // deux mots, et « Bonjour » ressemble à beaucoup de choses.
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.count >= judgeableLength else { return 0 }

  let recognizer = NLLanguageRecognizer()
  recognizer.processString(trimmed)
  let hypotheses = recognizer.languageHypotheses(withMaximum: 5)
  return hypotheses[NLLanguage(language)] ?? 0
}

/// Décide de la langue d'un média.
///
/// - Parameters:
///   - path: chemin du média.
/// - Returns: le verdict, porteur d'un code de problème quand rien n'a pu être décidé.
/// - Warning: ⚠️ on ne refuse que sur preuve positive : seul un score nul — la langue n'est même
///   pas dans les cinq hypothèses du texte obtenu — rend `unsupportedLanguage`.
/// - Warning: ⚠️ un moteur français nourri d'anglais rend du charabia d'allure française, que le
///   reconnaisseur peut classer français : le score ne tranche que les cas nets.
private func detect(path: String) throws -> LanguageVerdict {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))

  return try awaiting(
    "la détection de langue", within: BridgeDeadline.languageDetection
  ) { () async throws -> LanguageVerdict in
    do {
      guard #available(macOS 26.0, *) else {
        throw BridgeError.audio("la détection de langue exige macOS 26")
      }

      // Les langues du périmètre dont les ressources sont réellement là.
      let installed = await SpeechTranscriber.installedLocales
      let candidates = supportedLanguages.compactMap { language -> (String, Locale)? in
        guard
          let locale = installed.first(where: { $0.language.languageCode?.identifier == language })
        else { return nil }
        return (language, locale)
      }

      guard !candidates.isEmpty else {
        return LanguageVerdict(
          language: nil, problem: LanguageProblem.noInstalledLanguage.rawValue,
          confidence: 0, tried: [])
      }

      // ⚠️ Un seul candidat passe par la même boucle que dix : la question n'est pas « laquelle »
      // mais « est-ce bien celle-là ». Court-circuiter ce cas ferait recevoir du français à
      // l'utilisateur qui n'a que le français installé et dépose un podcast anglais.
      var best: (language: String, confidence: Double)?
      var sawSpeech = false
      var sawJudgeableSample = false
      for (language, locale) in candidates {
        let text = try await sampleText(asset: asset, locale: locale, seconds: sampleSeconds)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
          sawSpeech = true
        }
        if trimmed.count >= judgeableLength {
          sawJudgeableSample = true
        }
        let confidence = score(text: text, as: language)
        if confidence > (best?.confidence ?? 0) {
          best = (language, confidence)
        }
      }

      guard sawSpeech else {
        // ⚠️ « Aucune parole » est un cas distinct de « langue non couverte » : l'utilisateur n'a
        // pas la même chose à faire, et un message unique le laisserait sans issue.
        return LanguageVerdict(
          language: nil, problem: LanguageProblem.noSpeech.rawValue, confidence: 0,
          tried: candidates.map(\.0))
      }

      guard sawJudgeableSample else {
        return LanguageVerdict(
          language: nil, problem: LanguageProblem.tooShort.rawValue, confidence: 0,
          tried: candidates.map(\.0))
      }

      guard let best, best.confidence > 0 else {
        return LanguageVerdict(
          language: nil, problem: LanguageProblem.unsupportedLanguage.rawValue, confidence: 0,
          tried: candidates.map(\.0))
      }

      return LanguageVerdict(
        language: best.language, problem: nil, confidence: best.confidence,
        tried: candidates.map(\.0))
    } catch {
      throw BridgeError.audio(bridgeMessage(error))
    }
  }
}

/// Identifie la langue parlée d'un média local.
///
/// - Parameters:
///   - path: chemin du média.
///   - out: reçoit le JSON du verdict, ou le message d'erreur.
/// - Returns: `statusOK` ou `statusError`.
@_cdecl("mirmalion_detect_language")
public func mirmalionDetectLanguage(
  _ path: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let path = try requireArgument(path, "chemin du média")
    let verdict = try detect(path: path)
    return try bridgeJSON(verdict)
  }
}

/// La confiance minimale pour qu'une langue de texte soit affirmée.
///
/// - Warning: ⚠️ En dessous, on ne rend rien plutôt qu'un verdict tiède : l'appelant refait la
///   passe la plus longue du compte rendu sur cette réponse, et une hésitation la ferait payer
///   pour rien. Mesuré sur des rubriques courtes, où un titre de trois mots suffit à faire
///   hésiter le reconnaisseur entre deux langues latines.
private let minimumTextConfidence = 0.5

/// Identifie la langue dominante d'un texte.
///
/// - Parameters:
///   - text: le texte à examiner.
///   - out: reçoit le code de langue, ou le message d'erreur.
/// - Returns: `statusOK`, `statusNotFound` si la langue n'est pas décidable, ou `statusError`.
/// - Warning: ⚠️ Rien à voir avec `mirmalion_detect_language`, qui écoute un média et transcrit
///   un échantillon par langue installée. Celle-ci lit du texte, instantanément, sans moteur.
@_cdecl("mirmalion_detect_text_language")
public func mirmalionDetectTextLanguage(
  _ text: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withOptionalBridgeResult(out) {
    let value = try requireArgument(text, "le texte à examiner")
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(value)
    guard let dominant = recognizer.dominantLanguage else { return nil }
    let confidence = recognizer.languageHypotheses(withMaximum: 1)[dominant] ?? 0
    return confidence >= minimumTextConfidence ? dominant.rawValue : nil
  }
}
