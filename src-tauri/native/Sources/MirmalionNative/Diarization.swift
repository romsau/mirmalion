import AVFoundation
import FluidAudio
import Foundation

// La diarisation : qui parle, et quand.
//
// FluidAudio est le seul composant tiers obligatoire du produit : Apple ne fournit aucune
// diarisation, ni `Speech` ni `SoundAnalysis` ne savent dire « qui parle ». La bibliothèque
// porte Pyannote Community-1 en CoreML, exécuté sur le Neural Engine.
//
// ⚠️ Les modèles de FluidAudio se téléchargent depuis HuggingFace au premier usage, en
// silence — c'est le comportement de `DiarizerModels.load()`. On passe exclusivement par
// `load(localSegmentationModel:localEmbeddingModel:)`, « No models are downloaded ». Ne
// jamais y substituer `load()` ni `downloadIfNeeded()` : les deux rouvrent le réseau.
//
// ⚠️ La diarisation exige du 16 kHz mono en Float, qui n'est ni la cadence du média ni celle
// du moteur de transcription. À sa cadence native, une piste ne produit pas d'erreur : elle
// produit des tours de parole faux, décalés dans le temps.

/// La cadence qu'attend Pyannote. Toute autre valeur rend des tours de parole décalés.
private let diarizationSampleRate = 16_000.0

/// Un tour de parole rendu au pont : une voix, un début, une fin.
struct SpeakerTurn: Encodable {
  let speaker: UInt32
  let startMs: UInt64
  let endMs: UInt64
}

/// Ce qu'un regroupement rend : des tours de parole, et une empreinte par voix.
struct Clustering {
  let turns: [SpeakerTurn]
  let profiles: [UInt32: VoiceProfile]
}

/// Le verdict d'une diarisation, tel qu'il traverse le pont.
private struct DiarizationOutcome: Encodable {
  let segments: [SpeakerTurn]
  let speakers: Int
}

/// L'empreinte moyenne d'une voix sur un média, et le temps qu'elle a tenu.
///
/// - Warning: ⚠️ ce type ne traverse jamais le pont : une empreinte vocale est une donnée
///   biométrique, elle ne doit atteindre ni un log, ni le frontend, ni un fichier en clair.
///   Ce qui sort d'ici est une distance — un nombre dont on ne peut reconstruire aucune des
///   deux voix. Le vecteur, lui, reste dans ce processus.
struct VoiceProfile {
  let speaker: UInt32
  /// L'empreinte moyenne, pondérée par la durée et re-normalisée.
  let centroid: [Float]
  let speechMs: UInt64
}

/// Ce qu'une analyse rend : des tours de parole, et une voix par locuteur.
struct Analysis {
  let turns: [SpeakerTurn]
  let profiles: [VoiceProfile]
}

func modelLocations() throws -> (segmentation: URL, embedding: URL) {
  let names = ["pyannote_segmentation", "wespeaker_v2"]

  if let resources = Bundle.main.resourceURL {
    let bundled = resources.appendingPathComponent("DiarizerModels", isDirectory: true)
    let segmentation = bundled.appendingPathComponent("\(names[0]).mlmodelc")
    let embedding = bundled.appendingPathComponent("\(names[1]).mlmodelc")
    if FileManager.default.fileExists(atPath: segmentation.path),
      FileManager.default.fileExists(atPath: embedding.path)
    {
      return (segmentation, embedding)
    }
  }

  let cached = DiarizerModels.defaultModelsDirectory()
  let segmentation = cached.appendingPathComponent("\(names[0]).mlmodelc")
  let embedding = cached.appendingPathComponent("\(names[1]).mlmodelc")
  guard FileManager.default.fileExists(atPath: segmentation.path),
    FileManager.default.fileExists(atPath: embedding.path)
  else {
    throw BridgeError.audio(
      "les modèles de diarisation sont absents du bundle et du cache local (\(cached.path))")
  }
  return (segmentation, embedding)
}

/// Lit toute la piste audio d'un média en 16 kHz mono Float.
///
/// - Parameter asset: le média local à lire.
/// - Returns: tous ses échantillons, dans l'ordre.
/// - Throws: `BridgeError.audio` si le média n'a pas de piste audio, si le format cible est
///   impossible à construire ou si aucun échantillon n'est lisible.
/// - Warning: ⚠️ tout le média entre en mémoire — une heure de parole pèse environ 230 Mo, et
///   `performCompleteDiarization` veut de toute façon la totalité des échantillons : le
///   regroupement des voix est global, il ne se fait pas par tranche.
private func monoSamples(of asset: AVURLAsset) async throws -> [Float] {
  guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
    throw BridgeError.audio("le média ne porte aucune piste audio")
  }

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

  guard
    let target = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: diarizationSampleRate,
      channels: 1,
      interleaved: false
    )
  else {
    throw BridgeError.audio("format de diarisation impossible à construire")
  }

  reader.startReading()
  var samples: [Float] = []
  var converter: AVAudioConverter?

  while let sample = output.copyNextSampleBuffer() {
    defer { CMSampleBufferInvalidate(sample) }
    guard let buffer = pcmBuffer(from: sample) else { continue }
    if converter == nil {
      converter = AVAudioConverter(from: buffer.format, to: target)
    }
    guard let converter, let converted = convertBuffer(buffer, with: converter, to: target),
      let channel = converted.floatChannelData?[0]
    else { continue }
    samples.append(
      contentsOf: UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
  }

  guard !samples.isEmpty else {
    throw BridgeError.audio("aucun échantillon audio lisible dans le média")
  }
  return samples
}

/// Diarise un média : ses tours de parole et une empreinte moyenne par voix.
///
/// Les empreintes sont calculées ici parce que c'est ici qu'elles sont gratuites :
/// `TimedSpeakerSegment` en porte déjà une par segment.
///
/// - Parameters:
///   - path: le chemin du média local.
///   - threshold: le seuil de regroupement des voix.
/// - Throws: `BridgeError.audio` si la lecture, le chargement des modèles ou le regroupement
///   échoue.
private func analyse(path: String, threshold: Float) throws -> Analysis {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))

  // ⚠️ Aucune borne : la diarisation est proportionnelle au média — 1,4 s sur six minutes,
  // davantage sur une heure. Une borne fixe couperait le média long, qui est justement celui
  // qu'on ne peut pas se permettre de perdre.
  return try awaiting("la diarisation", within: nil) { () async throws -> Analysis in
    do {
      let samples = try await monoSamples(of: asset)
      let locations = try modelLocations()
      let models = try DiarizerModels.load(
        localSegmentationModel: locations.segmentation,
        localEmbeddingModel: locations.embedding
      )

      var config = DiarizerConfig()
      // ⚠️ `clusteringThreshold` est le seul réglage qui agisse : `numClusters`, que la
      // bibliothèque documente comme « expected number of speakers », est sans effet, mesuré.
      // ⚠️ Aucune valeur fixe ne convient — 0,80 sur un audio propre à deux voix, 0,60 sur un
      // plateau bruité à quatre —, d'où le paramètre : le calibrage se fait au-dessus.
      config.clusteringThreshold = threshold

      let manager = DiarizerManager(config: config)
      manager.initialize(models: models)
      defer { manager.cleanup() }

      let result = try manager.performCompleteDiarization(
        samples, sampleRate: Int(diarizationSampleRate))

      let clustering = regroup(result.segments)
      return Analysis(
        turns: clustering.turns,
        profiles: clustering.profiles.sorted { $0.key < $1.key }.map { $0.value }
      )
    } catch {
      // ⚠️ Le message est repris par `bridgeMessage` ici et pas plus loin : une
      // `localizedDescription` de FluidAudio porterait le chemin du modèle.
      throw BridgeError.audio(bridgeMessage(error))
    }
  }
}

/// Assemble l'empreinte moyenne d'une voix, segment après segment.
///
/// - Warning: ⚠️ la moyenne est pondérée par la durée, pas par le nombre de segments : à poids
///   égal, les interjections — les plus courtes, les plus bruitées — tireraient le centroïde.
/// - Warning: ⚠️ elle est re-normalisée à la fin. Les empreintes de WeSpeaker arrivent
///   normalisées, leur moyenne ne l'est plus, et une distance cosinus calculée sur des normes
///   différentes n'est plus comparable d'une voix à l'autre.
struct EmbeddingAccumulator {
  private var sum: [Float] = []
  private var weight: Double = 0
  private var speechMs: UInt64 = 0

  /// Ajoute l'empreinte d'un segment, pondérée par la durée qu'il a tenue.
  ///
  /// - Parameters:
  ///   - embedding: l'empreinte du segment ; une empreinte vide ne pèse que sa durée.
  ///   - durationMs: la durée du segment, en millisecondes.
  mutating func add(_ embedding: [Float], holding durationMs: UInt64) {
    speechMs &+= durationMs
    guard !embedding.isEmpty else { return }
    // ⚠️ Un segment de durée nulle pèse tout de même, d'où le plancher : le diariseur rend des
    // tours arrondis à la milliseconde, et un tour de 0 ms est un tour court, pas un tour
    // absent. À poids zéro, une voix n'ayant que de tels tours n'aurait aucune empreinte.
    let holding = Double(max(durationMs, 1))
    if sum.isEmpty {
      sum = [Float](repeating: 0, count: embedding.count)
    }
    guard sum.count == embedding.count else { return }
    for index in 0..<sum.count {
      sum[index] += embedding[index] * Float(holding)
    }
    weight += holding
  }

  /// - Parameter speaker: le numéro de la voix accumulée.
  /// - Returns: son empreinte moyenne re-normalisée, ou `nil` si rien d'exploitable n'a été
  ///   accumulé.
  func profile(for speaker: UInt32) -> VoiceProfile? {
    guard weight > 0, !sum.isEmpty else { return nil }
    let norm = sum.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
    guard norm > 0 else { return nil }
    return VoiceProfile(
      speaker: speaker,
      centroid: sum.map { $0 / norm },
      speechMs: speechMs
    )
  }
}

/// Renumérote les voix d'un regroupement et calcule leur empreinte moyenne.
///
/// - Parameter segments: les segments rendus par le diariseur, dans un ordre quelconque.
/// - Returns: les tours triés par début, et une empreinte par voix.
/// - Warning: ⚠️ les identifiants de locuteur de FluidAudio sont des chaînes arbitraires ; on
///   renumérote par ordre d'apparition, le seul ordre constatable.
/// - Warning: ⚠️ ces numéros sont locaux à ce regroupement. Deux regroupements du même audio
///   ne numérotent pas forcément pareil : c'est l'empreinte qui rapproche, pas le numéro.
func regroup(_ segments: [TimedSpeakerSegment]) -> Clustering {
  var numbering: [String: UInt32] = [:]
  var turns: [SpeakerTurn] = []
  var accumulators: [UInt32: EmbeddingAccumulator] = [:]

  for segment in segments.sorted(by: { $0.startTimeSeconds < $1.startTimeSeconds }) {
    let number = numbering[segment.speakerId] ?? UInt32(numbering.count)
    numbering[segment.speakerId] = number
    let startMs = UInt64(max(0, segment.startTimeSeconds) * 1_000)
    let endMs = UInt64(max(0, segment.endTimeSeconds) * 1_000)
    turns.append(SpeakerTurn(speaker: number, startMs: startMs, endMs: endMs))

    var accumulator = accumulators[number] ?? EmbeddingAccumulator()
    accumulator.add(segment.embedding, holding: endMs >= startMs ? endMs - startMs : 0)
    accumulators[number] = accumulator
  }

  var profiles: [UInt32: VoiceProfile] = [:]
  for (number, accumulator) in accumulators {
    // ⚠️ Une voix sans empreinte lisible garde ses tours mais n'a pas de profil : elle reste
    // affichable et simplement irrapprochable. On n'écarte et on ne fusionne que sur preuve
    // positive.
    if let profile = accumulator.profile(for: number) {
      profiles[number] = profile
    }
  }
  return Clustering(turns: turns, profiles: profiles)
}

/// Regroupe un bloc d'échantillons déjà en 16 kHz mono, avec un gestionnaire déjà chargé.
///
/// - Parameters:
///   - samples: les échantillons, à la cadence de diarisation.
///   - manager: un diariseur déjà initialisé.
/// - Returns: le regroupement, ou `nil` — un bloc trop court ou silencieux n'est pas une
///   panne, c'est un passage sans résultat, d'où l'absence d'erreur lancée.
func cluster(_ samples: [Float], with manager: DiarizerManager) -> Clustering? {
  guard !samples.isEmpty,
    let result = try? manager.performCompleteDiarization(
      samples, sampleRate: Int(diarizationSampleRate))
  else { return nil }
  return regroup(result.segments)
}

/// La distance cosinus entre deux empreintes : 0 pour deux voix identiques, 2 à l'opposé.
///
/// - Parameters:
///   - first: la première empreinte.
///   - second: la seconde, de même dimension.
/// - Returns: leur distance, ou `Double.infinity` si elles sont incomparables.
/// - Warning: ⚠️ même convention que `clusteringThreshold`, qui est lui aussi une distance.
///   Compter en similarité ici inverserait le sens de deux nombres du même ordre.
func cosineDistance(_ first: [Float], _ second: [Float]) -> Double {
  guard first.count == second.count, !first.isEmpty else { return Double.infinity }
  var dot: Double = 0
  var firstNorm: Double = 0
  var secondNorm: Double = 0
  for index in 0..<first.count {
    dot += Double(first[index]) * Double(second[index])
    firstNorm += Double(first[index]) * Double(first[index])
    secondNorm += Double(second[index]) * Double(second[index])
  }
  guard firstNorm > 0, secondNorm > 0 else { return Double.infinity }
  return 1 - dot / (firstNorm.squareRoot() * secondNorm.squareRoot())
}

/// Diarise un média local et écrit dans `out` le JSON de ses tours de parole.
///
/// - Parameters:
///   - path: le chemin du média.
///   - threshold: le seuil de regroupement, strictement entre 0 et 1.
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
@_cdecl("mirmalion_diarize")
public func mirmalionDiarize(
  _ path: UnsafePointer<CChar>?,
  _ threshold: Double,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let path = try requireArgument(path, "chemin du média")
    guard threshold > 0, threshold < 1 else {
      throw BridgeError.invalidArgument("seuil de regroupement hors bornes : \(threshold)")
    }
    let analysis = try analyse(path: path, threshold: Float(threshold))
    let outcome = DiarizationOutcome(
      segments: analysis.turns,
      speakers: analysis.profiles.count
    )
    return try bridgeJSON(outcome)
  }
}

// MARK: - Rapprocher deux enregistrements

/// Une voix d'un média, telle qu'elle sort du pont : son numéro et son poids, jamais son
/// empreinte.
private struct VoiceSummary: Encodable {
  let speaker: UInt32
  let speechMs: UInt64
}

/// Ce que deux médias ont en commun.
///
/// - Warning: ⚠️ les tours de parole voyagent avec les distances. Les rendre par deux appels
///   séparés ferait deux regroupements du même audio, dont rien ne garantit qu'ils numérotent
///   les voix pareil : le verdict porterait sur des numéros désignant d'autres personnes.
private struct VoiceMatchOutcome: Encodable {
  let first: [VoiceSummary]
  let second: [VoiceSummary]
  /// Les tours de parole du premier média, numérotés comme `first`.
  let firstSegments: [SpeakerTurn]
  /// Les tours de parole du second, numérotés comme `second`.
  let secondSegments: [SpeakerTurn]
  /// `distances[i][j]` — la distance entre la voix `i` du premier média et la voix `j` du
  /// second.
  ///
  /// - Warning: ⚠️ `null` veut dire « incomparable », jamais « différentes ». Une empreinte
  ///   vide ou de dimension inattendue donne une distance infinie, que JSON ne porte pas ;
  ///   l'écrire `2` la ferait passer pour une mesure là où rien n'a été mesuré.
  let distances: [[Double?]]
}

/// Rapproche les voix de deux enregistrements et écrit leurs distances deux à deux dans `out`.
///
/// C'est l'instrument de l'écho. Sur haut-parleurs, le micro réentend les interlocuteurs : la
/// question posée n'est pas « ces deux signaux se ressemblent-ils ? » mais « cette voix du
/// micro est-elle une voix déjà connue ? ». Cette question d'identité ne dépend ni du délai
/// entre les flux, ni du volume des haut-parleurs, ni de l'acoustique de la pièce.
///
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
/// - Warning: ⚠️ ce qui sort est une distance, jamais un vecteur — voir `VoiceProfile`. Le
///   seuil est décidé côté Rust, où il est éprouvable sans média.
@_cdecl("mirmalion_voice_match")
public func mirmalionVoiceMatch(
  _ firstPath: UnsafePointer<CChar>?,
  _ secondPath: UnsafePointer<CChar>?,
  _ threshold: Double,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let first = try requireArgument(firstPath, "chemin du premier média")
    let second = try requireArgument(secondPath, "chemin du second média")
    guard threshold > 0, threshold < 1 else {
      throw BridgeError.invalidArgument("seuil de regroupement hors bornes : \(threshold)")
    }

    let left = try analyse(path: first, threshold: Float(threshold))
    let right = try analyse(path: second, threshold: Float(threshold))

    let distances = left.profiles.map { profile in
      right.profiles.map { other -> Double? in
        let distance = cosineDistance(profile.centroid, other.centroid)
        return distance.isFinite ? distance : nil
      }
    }

    let outcome = VoiceMatchOutcome(
      first: left.profiles.map { VoiceSummary(speaker: $0.speaker, speechMs: $0.speechMs) },
      second: right.profiles.map { VoiceSummary(speaker: $0.speaker, speechMs: $0.speechMs) },
      firstSegments: left.turns,
      secondSegments: right.turns,
      distances: distances
    )
    return try bridgeJSON(outcome)
  }
}
