import AVFoundation
import Foundation
import Speech

// Transcrire un média local : la seconde forme d'appel du moteur.
//
// La dictée pousse des tampons venus du micro et attend des partiels ; ici l'entrée est un fichier,
// et ce qu'on veut à la fin n'est pas du texte mais des mots horodatés.
//
// ⚠️ `SpeechTranscriber` reste un moteur de flux même sur un fichier : c'est nous qui déroulons le
// média à la place de la carte son. La progression se calcule donc sur la position dans le média,
// jamais sur le nombre de partiels reçus — le moteur peut rester muet sur un passage sans parole.
// ⚠️ `AVAssetReader`, et non `AVAudioFile` : ce dernier n'ouvre pas les conteneurs vidéo. Un seul
// chemin de code pour un `.mp3` comme pour un `.mp4`, et aucun fichier temporaire à effacer.
// ⚠️ Le préréglage `timeIndexedProgressiveTranscription`, jamais des options assemblées à la main :
// c'est lui qui demande l'attribut `audioTimeRange`. Composer les options soi-même avait fait taire
// le moteur jusqu'à la finalisation, faute d'une option que le préréglage incluait.

/// Ce que la transcription d'un fichier rend.
private struct FileTranscript: Encodable {
  let words: [TimedWord]
  let durationMs: UInt64
}

/// Le rappel de progression, qui sert aussi d'interrupteur : rendre `false` arrête le travail.
///
/// - Warning: ⚠️ un seul rappel pour les deux, délibérément : le point de sortie est le même que le
///   point de mesure, donc aucune boucle ne peut progresser sans demander si elle doit continuer.
/// - Warning: ⚠️ `@convention(c)`, et pas une fermeture Swift : c'est ce qui la rend non capturante,
///   donc utilisable dans une tâche concurrente sans `@escaping` ni preuve de `Sendable`.
typealias ProgressGate = @convention(c) (UnsafeMutableRawPointer?, Double) -> Bool

/// Le rappel et son contexte, réunis pour traverser la frontière d'une tâche.
///
/// - Warning: ⚠️ `@unchecked Sendable` : le rappel est un pointeur de fonction C non capturant, et
///   le contexte un pointeur que Rust garde vivant jusqu'au retour de l'appel. Rien à protéger,
///   mais le compilateur ne voit qu'un pointeur brut.
private struct Gate: @unchecked Sendable {
  let context: UnsafeMutableRawPointer?
  let call: ProgressGate

  func allows(_ ratio: Double) -> Bool { call(context, ratio) }
}

// `TimedWord`, `splitTimed` et `timedWords` vivent dans `TimedWords.swift`, partagés avec la
// transcription de session.

/// Transforme un échantillon du lecteur en tampon PCM utilisable par le moteur.
///
/// Partagée avec la diarisation et la détection de langue, qui déroulent le même média pour
/// d'autres moteurs.
///
/// - Parameters:
///   - sample: l'échantillon rendu par `AVAssetReader`.
/// - Returns: le tampon PCM, ou `nil` si l'échantillon est illisible.
/// - Warning: ⚠️ le format vient de la description de l'échantillon, jamais d'un format supposé :
///   un son interprété à la mauvaise cadence rend une transcription vide, sans la moindre erreur.
func pcmBuffer(from sample: CMSampleBuffer) -> AVAudioPCMBuffer? {
  guard
    let description = CMSampleBufferGetFormatDescription(sample),
    let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(description)
  else { return nil }

  let format = AVAudioFormat(streamDescription: streamDescription)
  let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
  guard let format, frames > 0,
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
  else { return nil }
  buffer.frameLength = frames

  guard
    CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sample,
      at: 0,
      frameCount: Int32(frames),
      into: buffer.mutableAudioBufferList
    ) == noErr
  else { return nil }

  return buffer
}

/// L'erreur qu'on lance quand l'utilisateur a demandé l'arrêt.
///
/// - Warning: ⚠️ distincte d'un échec, et elle doit le rester jusqu'à l'interface : une annulation
///   ne s'affiche pas en snackbar d'erreur.
private struct Cancelled: Error {}

/// Déroule le média et rend ses mots horodatés.
private func transcribe(
  path: String,
  locale: String,
  context: UnsafeMutableRawPointer?,
  gate: ProgressGate
) throws -> FileTranscript {
  guard #available(macOS 26.0, *) else {
    throw BridgeError.audio("la transcription de fichier exige macOS 26")
  }

  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  let door = Gate(context: context, call: gate)

  // ⚠️ Aucune borne, et c'est le seul appel du pont pour lequel une borne fixe n'aurait pas de
  // sens : la durée est proportionnelle au média — « de l'ordre de la minute » sur une heure
  // d'audio. Ce chemin a déjà son point de sortie, la barrière de progression, que
  // `cancel_file_transcription` actionne.
  return try awaiting("la transcription du fichier", within: nil) {
    do {
      guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
        throw BridgeError.audio("le média ne porte aucune piste audio")
      }
      let duration = try await asset.load(.duration)
      let totalSeconds = max(duration.seconds, 0.001)

      let transcriber = SpeechTranscriber(
        locale: try await installedLocale(matching: locale),
        preset: .timeIndexedProgressiveTranscription
      )
      guard
        let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
          compatibleWith: [transcriber])
      else {
        throw BridgeError.audio("le moteur n'expose aucun format audio compatible")
      }

      // Le lecteur rend du PCM flottant à la cadence native de la piste ; l'analyseur veut la
      // sienne. ⚠️ Sans conversion, les tampons sont refusés en silence : le moteur tourne et ne
      // transcrit rien.
      let reader = try AVAssetReader(asset: asset)
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

      let collector = ResultBox<AttributedString>()
      collector.value = AttributedString()
      let drain = Task {
        for try await result in transcriber.results where result.isFinal {
          collector.value = (collector.value ?? AttributedString()) + result.text
        }
      }

      try await analyzer.prepareToAnalyze(in: analyzerFormat)
      async let running: Void = analyzer.start(inputSequence: stream)

      reader.startReading()
      var converter: AVAudioConverter?
      var lastReported = -1.0

      while let sample = output.copyNextSampleBuffer() {
        let at = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        if let buffer = pcmBuffer(from: sample) {
          if converter == nil {
            converter = AVAudioConverter(from: buffer.format, to: analyzerFormat)
          }
          if let converter,
            let converted = convertBuffer(buffer, with: converter, to: analyzerFormat)
          {
            continuation.yield(AnalyzerInput(buffer: converted))
          }
        }
        CMSampleBufferInvalidate(sample)

        // ⚠️ La progression vient de la position dans le média, pas des partiels reçus.
        let ratio = min(1.0, max(0.0, at / totalSeconds))
        if ratio - lastReported >= 0.005 || ratio >= 1.0 {
          lastReported = ratio
          if !door.allows(ratio) {
            reader.cancelReading()
            continuation.finish()
            drain.cancel()
            throw Cancelled()
          }
        }
      }

      continuation.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      _ = try? await running
      _ = try? await drain.value

      return FileTranscript(
        words: timedWords(in: collector.value ?? AttributedString()),
        durationMs: UInt64(max(0, duration.seconds * 1_000))
      )
    } catch is Cancelled {
      throw BridgeError.audio(cancellationMarker)
    } catch {
      throw BridgeError.audio(bridgeMessage(error))
    }
  }
}

/// Le marqueur d'annulation, reconnu tel quel côté Rust et traduit en `AppError::Cancelled`.
///
/// - Warning: ⚠️ une chaîne convenue plutôt qu'un statut de plus : le contrat du pont est arrêté à
///   trois statuts, en ajouter un quatrième obligerait à revisiter tous les appelants.
let cancellationMarker = "mirmalion:cancelled"

/// Transcrit un média local et rend le JSON de ses mots horodatés.
///
/// - Parameters:
///   - path: chemin du média.
///   - locale: langue de transcription.
///   - context: contexte opaque rendu tel quel au rappel.
///   - onProgress: rappel de progression ; rendre `false` annule la transcription.
///   - out: reçoit le JSON, ou le message d'erreur.
/// - Returns: `statusOK` ou `statusError`.
@_cdecl("mirmalion_file_transcribe")
public func mirmalionFileTranscribe(
  _ path: UnsafePointer<CChar>?,
  _ locale: UnsafePointer<CChar>?,
  _ context: UnsafeMutableRawPointer?,
  _ onProgress: @convention(c) (UnsafeMutableRawPointer?, Double) -> Bool,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let path = try requireArgument(path, "chemin du média")
    let locale = try requireArgument(locale, "langue de transcription")
    let transcript = try transcribe(path: path, locale: locale, context: context, gate: onProgress)
    return try bridgeJSON(transcript)
  }
}
