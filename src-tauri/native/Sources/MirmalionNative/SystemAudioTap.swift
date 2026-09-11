import AVFoundation
import AppKit
import CoreAudio
import Foundation

// La capture de session : deux flux qui ne se rejoignent jamais — le système, la voix des
// autres, par un Core Audio Process Tap ; le micro, la voix de l'utilisateur, par
// `AudioCapture` réutilisé tel quel. Ils restent distincts jusqu'au disque.
//
// ⚠️ On n'écrit jamais un fichier mixé. La capture applicative ne rend que le flux descendant :
// sans le micro, l'utilisateur est absent de son propre transcript. Et un mixage n'est pas
// inversible — séparés, « Moi » est certain sans inférence. Le mixage n'existe que comme un
// nombre, celui du VU-mètre : voir `LiveCapture.status()`.
//
// ⚠️ 16 kHz mono, et pas la cadence native : c'est le format qu'exige FluidAudio
// (`Diarization.swift`) et celui vers lequel `SpeechTranscriber` convertit de toute façon.
// Une heure par flux tient dans ~115 Mo.
//
// ⚠️ Jamais `ScreenCaptureKit`, qui ferait le même travail contre l'autorisation
// « Enregistrement de l'écran » : une seule catégorie TCC, `NSAudioCaptureUsageDescription`.

/// La cadence d'écriture et d'analyse, commune aux deux flux. Voir l'en-tête.
private let liveSampleRate: Double = 16_000

/// L'identifiant réservé à « Tout le système ».
///
/// Une constante et non un `pid` : le tap global n'appartient à aucun processus, et lui
/// inventer un numéro obligerait l'appelant à connaître la convention.
private let systemSourceIdentifier = "system"

/// Le nom des deux fichiers, dans le dossier que Rust désigne.
private let systemFileName = "system.wav"
private let microphoneFileName = "microphone.wav"

/// Ce que l'utilisateur a choisi pour le micro : trois cas, jamais deux.
///
/// - Warning: ⚠️ `none` et `system` ne se confondent pas. « Ne pas inclure de micro » est une
///   option de l'écran de configuration — enregistrer une conférence qu'on écoute sans y
///   parler — et la replier sur « le micro par défaut » la ferait disparaître. Un `Optional`
///   n'aurait porté que deux cas.
enum MicrophoneChoice {
  case none
  case system
  case device(AudioDeviceID)
}

// MARK: - Charges utiles

/// Une source captable, telle que le sélecteur de l'écran Direct la présentera.
struct AudioSourcePayload: Encodable {
  /// `"system"` pour tout le système, sinon le `pid` en texte. Opaque côté frontend.
  let id: String
  let name: String
  /// Vrai pour la seule entrée « Tout le système ». Elle se place en tête de liste.
  let isSystem: Bool
}

/// L'état de la capture de session, tel que Rust peut le lire à tout moment.
struct LiveCaptureStatusPayload: Encodable {
  let running: Bool
  let sourceId: String?
  let sourceName: String?
  /// Les échantillons écrits par flux — la seule preuve que le flux coule.
  ///
  /// - Warning: ⚠️ un `running: true` avec un compteur figé n'est pas une capture : c'est un
  ///   tap ouvert sur une application qui n'émet rien, ou un micro coupé au niveau matériel.
  ///   Un test de bon fonctionnement regarde les compteurs, jamais le drapeau.
  let systemFrames: UInt64
  let microphoneFrames: UInt64
  /// Ce que le tap et le micro ont livré, avant conversion, et ce qui s'est perdu.
  ///
  /// - Warning: ⚠️ comparer l'entrée à la sortie est le seul moyen de distinguer « la source
  ///   est silencieuse » de « on perd des échantillons ».
  let systemInputFrames: UInt64
  let microphoneInputFrames: UInt64
  let systemInputSampleRate: Double
  let microphoneInputSampleRate: Double
  let systemDroppedBuffers: UInt64
  let microphoneDroppedBuffers: UInt64
  /// Les tampons que le disque a refusés, par flux.
  ///
  /// - Warning: ⚠️ Ce sont eux, et non `systemFrames`, qui disent que l'enregistrement atteint
  ///   vraiment le fichier : les compteurs de trames s'incrémentent à la conversion, avant que
  ///   l'écriture ait lieu. Un disque plein les laisse grimper sur un WAV qui n'avance plus.
  let systemWriteFailures: UInt64
  let microphoneWriteFailures: UInt64
  /// Le niveau combiné des deux flux, de 0 à 1 — ce que le VU-mètre affiche.
  let level: Double
  /// Les deux fichiers en cours d'écriture. `nil` pour le micro quand il est exclu.
  let systemPath: String?
  let microphonePath: String?
}

// MARK: - Lecture de la HAL

/// Lit une propriété de la HAL dont la taille n'est pas connue d'avance.
///
/// - Parameters:
///   - object: l'objet HAL interrogé, `selector` désignant la propriété.
///   - placeholder: la valeur qui remplit le tableau avant que la HAL n'écrive dedans — Swift
///     refuse un tableau non initialisé, et la HAL ne dit sa taille qu'en deux temps.
/// - Returns: les valeurs lues, ou un tableau vide en cas d'échec.
private func hardwareArrayProperty<T: BitwiseCopyable>(
  _ object: AudioObjectID,
  _ selector: AudioObjectPropertySelector,
  filling placeholder: T
) -> [T] {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else {
    return []
  }

  let count = Int(size) / MemoryLayout<T>.size
  guard count > 0 else { return [] }

  var values = [T](repeating: placeholder, count: count)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &values) == noErr else {
    return []
  }
  return values
}

/// L'UID d'un périphérique — la chaîne stable que réclame la description d'un agrégat.
///
/// - Returns: l'UID, ou `nil` si la HAL ne le donne pas.
/// - Warning: ⚠️ un `AudioDeviceID` ne convient pas ici : il change d'un démarrage à l'autre,
///   et un agrégat se décrit en UID.
private func deviceUID(_ device: AudioDeviceID) -> String? {
  hardwareStringProperty(device, kAudioDevicePropertyDeviceUID)
}

/// La sortie que macOS utilise en ce moment.
private func defaultOutputDevice() -> AudioDeviceID {
  hardwareProperty(
    AudioObjectID(kAudioObjectSystemObject),
    kAudioHardwarePropertyDefaultOutputDevice,
    default: AudioDeviceID(kAudioObjectUnknown)
  )
}

// MARK: - Énumération des sources

/// Les objets « processus » que connaît la HAL.
private func audioProcessObjects() -> [AudioObjectID] {
  hardwareArrayProperty(
    AudioObjectID(kAudioObjectSystemObject),
    kAudioHardwarePropertyProcessObjectList,
    filling: AudioObjectID(kAudioObjectUnknown)
  )
}

/// Ce processus émet-il du son en ce moment ?
///
/// - Warning: ⚠️ c'est `IsRunningOutput`, pas `IsRunning`. Le second est vrai de toute
///   application ayant seulement ouvert une unité audio — Safari en compte une en permanence.
///   La liste contiendrait la moitié des applications ouvertes, dont aucune n'émet un son.
private func processIsEmitting(_ process: AudioObjectID) -> Bool {
  hardwareProperty(
    process,
    kAudioProcessPropertyIsRunningOutput,
    default: UInt32(0)
  ) != 0
}

/// Le `pid` derrière un objet processus de la HAL.
private func processIdentifier(_ process: AudioObjectID) -> pid_t {
  hardwareProperty(process, kAudioProcessPropertyPID, default: pid_t(-1))
}

/// L'objet processus de la HAL correspondant à un `pid`, ou `nil`.
///
/// Traduction inverse de `processIdentifier`, nécessaire au démarrage : le frontend rend un
/// `pid`, stable et lisible, quand le tap veut un objet HAL.
private func processObject(for pid: pid_t) -> AudioObjectID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var input = pid
  var object = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject),
    &address,
    UInt32(MemoryLayout<pid_t>.size),
    &input,
    &size,
    &object
  )
  guard status == noErr, object != AudioObjectID(kAudioObjectUnknown) else { return nil }
  return object
}

/// Les applications qui émettent réellement du son, plus « Tout le système » en tête.
///
/// Mirmalion s'exclut lui-même : les sons de démarrage et d'arrêt nous feraient apparaître, et
/// se capter soi-même n'a aucun sens.
///
/// - Warning: ⚠️ un processus sans application est écarté. `coreaudiod` et les démons émettent
///   sans nom lisible ni icône : les afficher donnerait une liste où l'on ne reconnaît rien.
/// - Warning: ⚠️ c'est un instantané. Une application qui se met à émettre ensuite n'y est
///   pas : l'écran de configuration relit la liste à chaque ouverture du sélecteur.
func emittingAudioSources() -> [AudioSourcePayload] {
  let ours = ProcessInfo.processInfo.processIdentifier
  var seen = Set<pid_t>()

  let applications = audioProcessObjects()
    .filter(processIsEmitting)
    .map(processIdentifier)
    .filter { $0 > 0 && $0 != ours && seen.insert($0).inserted }
    .compactMap { pid -> AudioSourcePayload? in
      guard let name = NSRunningApplication(processIdentifier: pid)?.localizedName else {
        return nil
      }
      return AudioSourcePayload(id: String(pid), name: name, isSystem: false)
    }
    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

  // ⚠️ « Tout le système » est toujours proposé, même quand rien n'émet : c'est le choix qui
  // marche à coup sûr, et le seul qui reste juste si l'application visée se met à émettre
  // après le démarrage de l'enregistrement.
  let everything = AudioSourcePayload(
    id: systemSourceIdentifier,
    name: NSLocalizedString(
      "Tout le système", comment: "Source audio : l'ensemble de la machine"),
    isSystem: true
  )
  return [everything] + applications
}

/// Ce qu'un tap global ne doit pas capter : nous-mêmes.
///
/// Ne concerne que le tap global, et rend un tableau vide si notre objet processus est
/// introuvable : deux bips valent mieux que pas d'enregistrement.
///
/// - Warning: ⚠️ sans cette exclusion, Mirmalion s'enregistre lui-même — le bip de démarrage
///   arrive dans `system.wav` à 0,95 de niveau, mesuré. Une salve brève et forte est ce qu'un
///   diariseur prend pour une voix, et le STT y perd les premiers mots.
/// - Warning: ⚠️ non prouvé : le bip vient du webview, dont WebKit rend le son depuis un autre
///   processus. Seul un enregistrement réel dira si exclure notre `pid` suffit.
private func excludedFromGlobalTap() -> [AudioObjectID] {
  guard let ours = processObject(for: ProcessInfo.processInfo.processIdentifier) else {
    return []
  }
  return [ours]
}

// MARK: - L'écriture d'un flux

/// Un flux qui se convertit, se mesure et s'écrit — sans jamais bloquer le fil audio.
///
/// - Warning: ⚠️ l'écriture disque ne se fait pas sur le fil qui reçoit les tampons : c'est un
///   fil temps réel de Core Audio, et une écriture qui attend le disque y produit un
///   décrochage audible pour tout le système. La conversion, elle, reste sur place — bornée,
///   et elle divise par six ce qui traverse la file.
private final class StreamWriter: @unchecked Sendable {
  /// Le format d'écriture, commun aux deux flux.
  static let target: AVAudioFormat? = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: liveSampleRate,
    channels: 1,
    interleaved: false
  )

  let url: URL

  private let file: AVAudioFile
  private let format: AVAudioFormat
  /// De quel flux ce fichier est le fichier.
  private let stream: LiveStream
  private let queue: DispatchQueue
  private let lock = NSLock()
  private var converter: AVAudioConverter?
  private var frames: UInt64 = 0
  private var level: Double = 0
  private var closed = false

  /// Ce qui entre, avant conversion — et ce qui se perd en chemin.
  ///
  /// - Warning: ⚠️ ne pas les retirer en croyant nettoyer : sans eux, une mesure a menti. Le
  ///   flux système écrivait 14 848 trames par seconde là où le micro en écrivait 16 000 — 7 %
  ///   de perte, invisible sur dix secondes, plus de quatre minutes de décalage sur une heure.
  ///   Le compteur de sortie seul ne distingue pas une source rare d'une conversion qui perd.
  private var inputFrames: UInt64 = 0
  private var inputBuffers: UInt64 = 0
  private var droppedBuffers: UInt64 = 0
  private var inputSampleRate: Double = 0

  /// Les tampons que le **disque** a refusés.
  ///
  /// - Warning: ⚠️ Distinct de `droppedBuffers`, qui compte les échecs de CONVERSION. `frames`
  ///   s'incrémente à la conversion, sur ce fil-ci, quand l'écriture a lieu plus tard sur la file
  ///   — il prouve donc qu'un tampon a été **converti**, jamais qu'il a atteint le fichier.
  /// - Warning: ⚠️ Sans ce compteur, un disque plein en pleine session laisse `frames` grimper et
  ///   le VU-mètre bouger pendant que le WAV s'arrête net. La consolidation transcrit ensuite un
  ///   fichier tronqué, et rien nulle part ne dit pourquoi.
  private var writeFailures: UInt64 = 0

  /// Ouvre le fichier d'un flux.
  ///
  /// - Parameters:
  ///   - url: le fichier à écrire.
  ///   - stream: le flux dont il porte le son.
  /// - Throws: `BridgeError.audio` si le format est inconstructible ou le fichier inouvrable.
  init(url: URL, stream: LiveStream) throws {
    guard let format = StreamWriter.target else {
      throw BridgeError.audio("le format d'enregistrement de session est inconstructible")
    }

    // ⚠️ Du PCM 16 bits, pas du Float 32 : le fichier ne sert qu'à la transcription et à la
    // diarisation, qui n'entendent pas la différence, et le Float doublerait le disque d'une
    // session de deux heures pour rien.
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: liveSampleRate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]

    do {
      self.file = try AVAudioFile(
        forWriting: url,
        settings: settings,
        commonFormat: .pcmFormatFloat32,
        interleaved: false
      )
    } catch {
      throw BridgeError.audio(
        "le fichier d'enregistrement n'a pas pu être ouvert : \(bridgeMessage(error))")
    }

    self.url = url
    self.format = format
    self.stream = stream
    self.queue = DispatchQueue(label: "com.mirmalion.live.\(stream.rawValue)", qos: .utility)
  }

  /// Convertit un tampon, en mesure le niveau, puis le confie à la file d'écriture.
  ///
  /// - Parameter buffer: le tampon reçu de la source, dans son format natif.
  /// - Warning: ⚠️ appelée depuis un fil audio : rien qui puisse attendre.
  func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    if converter == nil || converter?.inputFormat != buffer.format {
      // ⚠️ Le convertisseur se refait quand le format d'entrée change, et cela arrive : un
      // changement de casque en cours d'enregistrement rouvre le tap avec la cadence du
      // nouveau device. Un convertisseur gardé sur l'ancien format échouerait en silence, et
      // le compteur se figerait sans que rien ne le dise.
      converter = AVAudioConverter(from: buffer.format, to: format)
    }
    let converter = self.converter
    inputFrames &+= UInt64(buffer.frameLength)
    inputBuffers &+= 1
    inputSampleRate = buffer.format.sampleRate
    lock.unlock()

    guard let converter, let converted = convertBuffer(buffer, with: converter, to: format) else {
      lock.lock()
      droppedBuffers &+= 1
      lock.unlock()
      return
    }

    let measured = rootMeanSquare(of: converted)
    lock.lock()
    frames &+= UInt64(converted.frameLength)
    // ⚠️ Le niveau se lisse, il ne se remplace pas : un VU-mètre piloté par la dernière valeur
    // brute clignote à chaque syllabe, et la descente lente est ce qui le rend lisible.
    level = max(measured, level * 0.82)
    lock.unlock()

    // ⚠️ `nonisolated(unsafe)` parce que ce qui traverse ici est une **remise**, pas un partage :
    // `convertBuffer` vient de fabriquer ce tampon, il n'enveloppe plus la mémoire de Core Audio,
    // et ce fil-ci n'y touche plus après cette ligne. La file d'écriture en devient seule
    // propriétaire. ⚠️ Toute lecture ajoutée **après** ce point rouvrirait la course que cette
    // remise ferme.
    nonisolated(unsafe) let owned = converted
    queue.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let stillOpen = !self.closed
      self.lock.unlock()
      guard stillOpen else { return }
      do {
        try self.file.write(from: owned)
      } catch {
        // ⚠️ On n'arrête pas la capture pour autant : une capture dégradée vaut mieux qu'une
        // capture coupée, et l'autre flux continue peut-être d'écrire. Ce qui manquait n'était
        // pas un arrêt, c'était un aveu — voir `writeFailures`.
        // ⚠️ Rien du message d'erreur n'est retenu : il porterait le chemin du fichier.
        self.lock.lock()
        self.writeFailures &+= 1
        self.lock.unlock()
      }
    }
  }

  /// Ferme le flux et attend que la file d'écriture se vide. Idempotente.
  ///
  /// - Warning: ⚠️ l'attente n'est pas facultative : rendre la main avant que les derniers
  ///   tampons soient sur le disque tronquerait la fin de la session.
  func close() {
    lock.lock()
    let alreadyClosed = closed
    closed = true
    lock.unlock()
    guard !alreadyClosed else { return }
    queue.sync {}
  }

  /// - Returns: les compteurs et le niveau de ce flux, à l'instant de l'appel.
  func snapshot() -> StreamSnapshot {
    lock.lock()
    defer { lock.unlock() }
    return StreamSnapshot(
      frames: frames,
      level: level,
      inputFrames: inputFrames,
      inputBuffers: inputBuffers,
      droppedBuffers: droppedBuffers,
      inputSampleRate: inputSampleRate,
      writeFailures: writeFailures
    )
  }
}

/// Ce qu'un flux a reçu, écrit et perdu.
struct StreamSnapshot {
  var frames: UInt64 = 0
  var level: Double = 0
  var inputFrames: UInt64 = 0
  var inputBuffers: UInt64 = 0
  var droppedBuffers: UInt64 = 0
  var inputSampleRate: Double = 0
  /// Les tampons refusés par le disque. Voir `StreamWriter.writeFailures`.
  var writeFailures: UInt64 = 0
}

/// L'énergie d'un tampon mono, de 0 à 1.
///
/// - Returns: sa valeur efficace, ou 0 si le tampon est vide.
private func rootMeanSquare(of buffer: AVAudioPCMBuffer) -> Double {
  guard let channel = buffer.floatChannelData?.pointee, buffer.frameLength > 0 else { return 0 }
  let count = Int(buffer.frameLength)
  var sum: Double = 0
  for index in 0..<count {
    let sample = Double(channel[index])
    sum += sample * sample
  }
  return (sum / Double(count)).squareRoot()
}

// MARK: - La capture

/// La capture d'une session : un tap système, un micro, deux fichiers.
///
/// Une seule instance (`sharedLiveCapture`) : une machine n'enregistre qu'une session à la
/// fois, et deux taps globaux sur le même device de sortie se disputeraient l'agrégat. Le
/// micro passe par `AudioCapture`, réutilisé tel quel, avec son repli sur débranchement et son
/// puits branchable ; aucune contention à craindre, la dictée étant coupée pendant un
/// enregistrement.
///
/// `@unchecked Sendable` : tout l'état mutable est gardé par `lock`. Les tampons arrivent d'un
/// fil temps réel de Core Audio, les commandes d'un fil de travail de Rust.
final class LiveCapture: @unchecked Sendable {
  private let lock = NSLock()

  private var running = false
  private var sourceId: String?
  private var sourceName: String?
  private var systemWriter: StreamWriter?
  private var microphoneWriter: StreamWriter?

  /// L'objet processus visé, `nil` pour un tap global. Retenu pour rouvrir le tap après un
  /// changement de device de sortie.
  private var targetProcess: AudioObjectID?

  private var tap = AudioObjectID(kAudioObjectUnknown)
  private var aggregate = AudioDeviceID(kAudioObjectUnknown)
  private var ioProc: AudioDeviceIOProcID?
  private var outputListener: AudioObjectPropertyListenerBlock?

  // MARK: Cycle de vie

  /// Démarre la capture.
  ///
  /// - Parameters:
  ///   - sourceId: `"system"`, ou le `pid` d'une application.
  ///   - microphone: voir [`MicrophoneChoice`] — `none` est un choix, pas une erreur.
  ///   - directory: le dossier des fichiers temporaires, désigné par Rust.
  ///   - locale: la langue de transcription ; `nil`, on enregistre sans transcrire en direct —
  ///     le fichier est là, et tout se refait depuis lui.
  /// - Throws: `BridgeError.audio` si une capture tourne déjà ; sinon l'erreur de l'ouverture.
  func start(
    sourceId: String, microphone: MicrophoneChoice, directory: URL, locale: String?
  ) throws {
    do {
      try open(
        sourceId: sourceId, microphone: microphone, directory: directory, locale: locale)
    } catch is AlreadyRunning {
      // ⚠️ Ce cas ne démonte rien, et c'est la raison d'être de ce type d'erreur à part : la
      // capture qui tourne n'est pas la nôtre, l'arrêter au nom d'un démarrage refusé couperait
      // l'enregistrement de quelqu'un d'autre.
      throw BridgeError.audio("un enregistrement de session est déjà en cours")
    } catch {
      // ⚠️ On annule plutôt qu'on ne finalise : une capture qui n'a pas su s'ouvrir n'a rien à
      // rendre, et un segment final émis ici arriverait sur un écran revenu à sa configuration.
      sharedLiveTranscription.cancel()
      // ⚠️ `stop()`, et non un démontage direct : le verrou est relâché ici, et démonter Core
      // Audio verrou tenu peut bloquer pour toujours — voir [`dismantle`].
      stop()
      throw error
    }
  }

  /// Le démarrage qui échoue sans rien démonter — voir [`LiveCapture.start`].
  private struct AlreadyRunning: Error {}

  private func open(
    sourceId: String, microphone: MicrophoneChoice, directory: URL, locale: String?
  ) throws {
    lock.lock()
    defer { lock.unlock() }

    guard !running else { throw AlreadyRunning() }

    let process: AudioObjectID?
    let name: String
    if sourceId == systemSourceIdentifier {
      process = nil
      name = NSLocalizedString(
        "Tout le système", comment: "Source audio : l'ensemble de la machine")
    } else {
      guard let pid = pid_t(sourceId), let object = processObject(for: pid) else {
        throw BridgeError.invalidArgument(
          "cette source audio n'existe plus : l'application a peut-être été fermée")
      }
      process = object
      name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? sourceId
    }

    try prepareDirectory(directory)

    systemWriter = try StreamWriter(
      url: directory.appendingPathComponent(systemFileName), stream: .system)
    if case .none = microphone {
      // Pas de fichier micro du tout : un WAV vide traînerait sur le disque et laisserait
      // croire, à la finalisation, qu'un flux a été capté puis perdu.
    } else {
      microphoneWriter = try StreamWriter(
        url: directory.appendingPathComponent(microphoneFileName), stream: .microphone)
    }
    targetProcess = process

    // ⚠️ Les moteurs démarrent avant les sources, et l'ordre n'est pas négociable : un moteur
    // branché après la capture reçoit ses premiers tampons dans le vide — et ce sont les
    // premiers mots. La transcription ne lance jamais : une langue absente laisse la capture
    // tourner et part en évènement `failed` (voir `LiveTranscription.start`).
    if let locale {
      var streams: [LiveStream] = [.system]
      if microphoneWriter != nil {
        streams.append(.microphone)
      }
      sharedLiveTranscription.start(locale: locale, streams: streams)
    }

    try openSystemTap()
    try openMicrophone(microphone)

    self.sourceId = sourceId
    self.sourceName = name
    running = true
    observeDefaultOutputDevice()
  }

  /// Arrête la capture et ferme les deux fichiers. Sans effet si rien ne tourne.
  ///
  /// D'où deux temps : [`detach`] prend l'état sous verrou, [`dismantle`] démonte sans verrou.
  ///
  /// - Warning: ⚠️ Le verrou se relâche avant de toucher à Core Audio : `AudioDeviceStop` attend
  ///   que le rappel d'entrée/sortie ait rendu la main, et ce rappel (`consumeSystem`) prend ce
  ///   même verrou — l'appeler verrou tenu, c'est un arrêt qui ne revient jamais.
  /// - Warning: ⚠️ Le défaut est intermittent : il faut un rappel en vol à l'instant de l'arrêt.
  ///   Trois arrêts réussis ne prouvent rien — la fenêtre fait quelques millisecondes, et elle
  ///   s'élargit avec la charge de la machine.
  func stop() {
    lock.lock()
    let work = detach()
    lock.unlock()
    dismantle(work)
  }

  func status() -> LiveCaptureStatusPayload {
    lock.lock()
    let isRunning = running
    let identifier = sourceId
    let name = sourceName
    let system = systemWriter
    let microphone = microphoneWriter
    lock.unlock()

    let systemSnapshot = system?.snapshot() ?? StreamSnapshot()
    let microphoneSnapshot = microphone?.snapshot() ?? StreamSnapshot()

    // ⚠️ Le seul « mixage » du fichier, et il ne produit aucun échantillon : l'énergie de deux
    // signaux décorrélés s'ajoute quadratiquement, ce qui donne exactement le niveau du flux
    // mixé sans jamais le construire.
    let combined =
      (systemSnapshot.level * systemSnapshot.level
      + microphoneSnapshot.level * microphoneSnapshot.level).squareRoot()

    return LiveCaptureStatusPayload(
      running: isRunning,
      sourceId: isRunning ? identifier : nil,
      sourceName: isRunning ? name : nil,
      systemFrames: systemSnapshot.frames,
      microphoneFrames: microphoneSnapshot.frames,
      systemInputFrames: systemSnapshot.inputFrames,
      microphoneInputFrames: microphoneSnapshot.inputFrames,
      systemInputSampleRate: systemSnapshot.inputSampleRate,
      microphoneInputSampleRate: microphoneSnapshot.inputSampleRate,
      systemDroppedBuffers: systemSnapshot.droppedBuffers,
      microphoneDroppedBuffers: microphoneSnapshot.droppedBuffers,
      systemWriteFailures: systemSnapshot.writeFailures,
      microphoneWriteFailures: microphoneSnapshot.writeFailures,
      level: min(1, combined),
      systemPath: system?.url.path,
      microphonePath: microphone?.url.path
    )
  }

  // MARK: Le dossier des fichiers temporaires

  /// Prépare le dossier des fichiers temporaires : vidé d'abord, puis créé en 0700.
  ///
  /// Le vidage est le troisième filet — la finalisation supprime l'audio et `sweep_live_audio`
  /// (côté Rust) rattrape ce qu'un crash a laissé ; celui-ci garantit qu'aucune session ne
  /// commence sur les restes d'une autre.
  ///
  /// - Warning: ⚠️ Ne pas chiffrer ces fichiers : `SpeechTranscriber` et FluidAudio lisent un
  ///   fichier par `AVAssetReader` et ne déchiffrent pas — il faudrait en écrire un second en
  ///   clair, celui-là même qu'on voulait éviter. Ce qui protège : durée de vie bornée à la
  ///   session, emplacement en cache, droits 0700, FileVault ; la base, elle, reste chiffrée.
  private func prepareDirectory(_ directory: URL) throws {
    let manager = FileManager.default
    if manager.fileExists(atPath: directory.path) {
      try? manager.removeItem(at: directory)
    }
    do {
      // ⚠️ Les droits sont posés à la création, jamais après coup : entre `createDirectory` et
      // un `setAttributes` séparé, le dossier existerait un instant avec les droits par défaut,
      // et c'est précisément l'instant où les fichiers s'y créent.
      try manager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    } catch {
      throw BridgeError.audio(
        "le dossier d'enregistrement n'a pas pu être créé : \(bridgeMessage(error))")
    }
  }

  // MARK: Le tap système

  /// Ouvre le tap et l'agrégat qui le porte. À appeler verrou tenu.
  private func openSystemTap() throws {
    let description: CATapDescription
    if let targetProcess {
      description = CATapDescription(stereoMixdownOfProcesses: [targetProcess])
    } else {
      // ⚠️ `stereoGlobalTapButExcludeProcesses`, jamais `stereoMixdownOfProcesses: []` : une
      // liste vide de processus à mixer reste vide et ne capte rien, quand une liste de
      // processus à exclure dit « tout, sauf eux ».
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: excludedFromGlobalTap())
    }
    description.name = "Mirmalion"
    description.isPrivate = true
    // On n'altère pas ce que l'utilisateur entend : le tap écoute, il ne coupe rien.
    description.muteBehavior = .unmuted

    var created = AudioObjectID(kAudioObjectUnknown)
    let status = AudioHardwareCreateProcessTap(description, &created)
    guard status == noErr, created != AudioObjectID(kAudioObjectUnknown) else {
      throw BridgeError.audio(
        "l'audio de cette source n'a pas pu être capté (\(status)) — l'autorisation d'enregistrement audio est-elle accordée ?"
      )
    }
    tap = created

    try openAggregate(around: description)
  }

  /// Construit l'agrégat qui rend le tap lisible, et démarre son flux.
  ///
  /// À appeler verrou tenu, `tap` déjà ouvert.
  private func openAggregate(around description: CATapDescription) throws {
    // ⚠️ L'agrégat doit inclure le device de sortie par défaut, sinon il ne démarre pas. Ce
    // n'est pas une redondance avec le tap : le tap dit quoi capter, le sous-device dit quelle
    // horloge mène le flux. Sans horloge, `AudioDeviceStart` échoue.
    let output = defaultOutputDevice()
    guard output != AudioDeviceID(kAudioObjectUnknown), let outputUID = deviceUID(output) else {
      throw BridgeError.audio("aucune sortie audio par défaut sur cette machine")
    }

    let layout: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Mirmalion Live",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      // Privé : l'agrégat n'apparaît pas dans les Réglages Système et meurt avec le processus.
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapUIDKey: description.uuid.uuidString,
          kAudioSubTapDriftCompensationKey: true,
        ]
      ],
    ]

    var device = AudioDeviceID(kAudioObjectUnknown)
    let created = AudioHardwareCreateAggregateDevice(layout as CFDictionary, &device)
    guard created == noErr, device != AudioDeviceID(kAudioObjectUnknown) else {
      throw BridgeError.audio("le périphérique de capture n'a pas pu être assemblé (\(created))")
    }
    aggregate = device

    // ⚠️ Après la création de l'agrégat, jamais avant : c'est lui qui décide de la cadence
    // livrée, et il n'existe pas encore une ligne plus haut.
    let format = try inputFormat()
    var procId: AudioDeviceIOProcID?
    let attached = AudioDeviceCreateIOProcIDWithBlock(&procId, device, nil) {
      [weak self] _, input, _, _, _ in
      self?.consumeSystem(input, format: format)
    }
    guard attached == noErr, let procId else {
      throw BridgeError.audio("le flux de capture n'a pas pu être ouvert (\(attached))")
    }
    ioProc = procId

    let started = AudioDeviceStart(device, procId)
    guard started == noErr else {
      throw BridgeError.audio("le flux de capture n'a pas démarré (\(started))")
    }
  }

  /// Le format des tampons que l'IO proc va réellement recevoir : celui du tap, sa cadence
  /// remplacée par l'horloge du device de sortie ; horloge illisible, on garde la déclaration.
  ///
  /// - Warning: ⚠️ `kAudioTapPropertyFormat` ment sur la cadence : 48 000 Hz déclarés pour
  ///   44 100 livrés, mesuré. Le convertisseur bâti dessus comprime le fichier de 8,1 % et le
  ///   transpose — un 220 Hz ressort à 239, dix secondes rendent 9,23 s, une heure fait diverger
  ///   les flux de cinq minutes. Ni erreur ni tampon perdu : rien ne le signale.
  /// - Warning: ⚠️ L'agrégat sur `kAudioDevicePropertyStreamFormat` répète le mensonge du tap —
  ///   essayé, il rend 48 000 lui aussi. Ce n'est pas une piste de repli.
  private func inputFormat() throws -> AVAudioFormat {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var stream = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &stream) == noErr else {
      throw BridgeError.audio("le format du flux capté est illisible")
    }

    let clock = hardwareProperty(
      defaultOutputDevice(),
      kAudioDevicePropertyNominalSampleRate,
      default: Double(0)
    )
    if clock > 0 {
      stream.mSampleRate = clock
    }

    guard let format = AVAudioFormat(streamDescription: &stream) else {
      throw BridgeError.audio("le format du flux capté est inexploitable")
    }
    return format
  }

  /// Un paquet du tap vient d'arriver.
  ///
  /// - Warning: ⚠️ Fil temps réel de Core Audio : rien de coûteux ici.
  private func consumeSystem(_ list: UnsafePointer<AudioBufferList>, format: AVAudioFormat) {
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format,
        bufferListNoCopy: list,
        deallocator: nil
      )
    else { return }

    lock.lock()
    let writer = systemWriter
    lock.unlock()
    // ⚠️ Le fichier d'abord, le moteur ensuite : le fichier est ce qui reste quand tout le
    // reste a échoué, c'est de lui qu'on refait un transcript et jamais l'inverse.
    writer?.append(buffer)
    sharedLiveTranscription.feed(buffer, from: .system)
  }

  // MARK: Le micro

  /// Démarre le micro, ou ne fait rien si l'utilisateur l'a exclu.
  ///
  /// - Warning: ⚠️ Exclure le micro n'est pas une erreur : c'est une option de l'écran de
  ///   configuration, pour enregistrer une conférence qu'on écoute sans y parler.
  private func openMicrophone(_ choice: MicrophoneChoice) throws {
    let deviceId: AudioDeviceID?
    switch choice {
    case .none: return
    case .system: deviceId = nil
    case .device(let identifier): deviceId = identifier
    }

    sharedCapture.setSink { [weak self] buffer in
      guard let self else { return }
      self.lock.lock()
      let writer = self.microphoneWriter
      self.lock.unlock()
      writer?.append(buffer)
      sharedLiveTranscription.feed(buffer, from: .microphone)
    }

    do {
      try sharedCapture.start(deviceId: deviceId)
    } catch {
      sharedCapture.setSink(nil)
      throw error
    }
  }

  // MARK: Le changement de sortie en cours d'enregistrement

  /// Surveille le device de sortie par défaut. À appeler verrou tenu.
  ///
  /// - Warning: ⚠️ Un changement de sortie n'est pas suivi tout seul, et c'est un cas fréquent :
  ///   brancher un casque en pleine session laisse l'agrégat sur une horloge disparue, et le
  ///   flux se tarit en silence.
  private func observeDefaultOutputDevice() {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      self?.rebuildAfterOutputChange()
    }
    let status = AudioObjectAddPropertyListenerBlock(
      AudioObjectID(kAudioObjectSystemObject), &address, nil, listener)
    // ⚠️ On n'échoue pas le démarrage pour autant : une session sans rattrapage vaut mieux que
    // pas de session. Mais l'écouteur doit rester à `nil`, sans quoi `dismantle` tenterait de
    // retirer un écouteur jamais posé.
    // ⚠️ Ce qu'on perd alors est ce que le commentaire ci-dessus décrit : brancher un casque en
    // pleine session tarira le flux système, et le compteur figé sera la seule trace.
    guard status == noErr else {
      outputListener = nil
      return
    }
    outputListener = listener
  }

  /// Reconstruit l'agrégat autour du nouveau device de sortie.
  ///
  /// Le tap survit : il n'est pas lié au device, et le refaire perdrait les échantillons du
  /// temps de la reconstruction. Les fichiers non plus ne se rouvrent pas — mêmes
  /// `StreamWriter`, donc aucun trou et des compteurs qui continuent ; seul le convertisseur se
  /// refait, le nouveau device pouvant avoir une autre cadence.
  ///
  /// - Warning: ⚠️ Le verrou de [`stop`], en pire : appelée depuis un fil de la HAL pendant que
  ///   la capture tourne, donc avec un rappel presque certainement en vol. Détruire l'agrégat
  ///   verrou tenu bloquerait le fil de la HAL, c'est-à-dire tout le son de la machine.
  private func rebuildAfterOutputChange() {
    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    let previous = detachAggregate()
    lock.unlock()
    destroy(previous)

    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    var failed: AggregateHandles?
    do {
      try openAggregate(around: currentTapDescription())
    } catch {
      // On ne coupe pas la session pour autant : le micro continue d'écrire, et le compteur
      // système figé dira ce qui s'est passé. Couper serait perdre ce qui est déjà capté.
      failed = detachAggregate()
    }
    lock.unlock()
    if let failed {
      destroy(failed)
    }
  }

  /// Reconstruit une description équivalente à celle du tap ouvert.
  ///
  /// Core Audio ne rend pas la description d'un tap existant : on la refabrique à l'identique
  /// depuis ce qu'on a retenu.
  private func currentTapDescription() -> CATapDescription {
    let description: CATapDescription
    if let targetProcess {
      description = CATapDescription(stereoMixdownOfProcesses: [targetProcess])
    } else {
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: excludedFromGlobalTap())
    }
    description.name = "Mirmalion"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    return description
  }

  // MARK: Fermeture

  /// L'agrégat et son flux, sortis de l'état pour être détruits sans verrou.
  private struct AggregateHandles {
    var device = AudioDeviceID(kAudioObjectUnknown)
    var ioProc: AudioDeviceIOProcID?
  }

  /// Tout ce qu'un arrêt doit démonter, sorti de l'état d'un seul geste.
  private struct Dismantling {
    var listener: AudioObjectPropertyListenerBlock?
    var aggregate = AggregateHandles()
    var tap = AudioObjectID(kAudioObjectUnknown)
    var stopsMicrophone = false
    var writers: [StreamWriter] = []
  }

  /// Sort l'agrégat de l'état. À appeler verrou tenu.
  private func detachAggregate() -> AggregateHandles {
    let handles = AggregateHandles(device: aggregate, ioProc: ioProc)
    aggregate = AudioDeviceID(kAudioObjectUnknown)
    ioProc = nil
    return handles
  }

  /// Détruit un agrégat et son flux. À appeler verrou non tenu — voir [`stop`].
  private func destroy(_ handles: AggregateHandles) {
    guard handles.device != AudioDeviceID(kAudioObjectUnknown) else { return }
    if let ioProc = handles.ioProc {
      AudioDeviceStop(handles.device, ioProc)
      AudioDeviceDestroyIOProcID(handles.device, ioProc)
    }
    AudioHardwareDestroyAggregateDevice(handles.device)
  }

  /// Vide l'état de la capture et rend ce qu'il reste à démonter. À appeler verrou tenu.
  ///
  /// - Warning: ⚠️ Après cet appel, l'objet se croit à l'arrêt alors que le tap tourne encore,
  ///   et c'est l'intention : un rappel d'entrée/sortie arrivant entre-temps ne trouve plus de
  ///   `StreamWriter` et repart sans rien faire, au lieu d'attendre un verrou.
  private func detach() -> Dismantling {
    var work = Dismantling()
    work.listener = outputListener
    work.aggregate = detachAggregate()
    work.tap = tap
    work.stopsMicrophone = microphoneWriter != nil
    work.writers = [systemWriter, microphoneWriter].compactMap { $0 }

    outputListener = nil
    tap = AudioObjectID(kAudioObjectUnknown)
    systemWriter = nil
    microphoneWriter = nil
    targetProcess = nil
    sourceId = nil
    sourceName = nil
    running = false
    return work
  }

  /// Démonte ce que [`detach`] a sorti. À appeler verrou non tenu, jamais autrement.
  ///
  /// L'ordre est l'inverse du démarrage, et il n'est pas négociable — voir [`stop`].
  private func dismantle(_ work: Dismantling) {
    // ⚠️ Les moteurs se closent en premier, à l'inverse du démarrage : ils ont encore des
    // tampons en vol, et leur demander la finalisation avant de couper les sources leur laisse
    // rendre les derniers mots.
    // ⚠️ `finish` ne les attend pas — la finalisation est asynchrone, et bloquer l'arrêt de la
    // capture sur un moteur qui a du travail ferait paraître le bouton « Arrêter » planté. Les
    // derniers segments arrivent après.
    sharedLiveTranscription.finish()

    if let listener = work.listener {
      var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      AudioObjectRemovePropertyListenerBlock(
        AudioObjectID(kAudioObjectSystemObject), &address, nil, listener)
    }

    destroy(work.aggregate)

    if work.tap != AudioObjectID(kAudioObjectUnknown) {
      AudioHardwareDestroyProcessTap(work.tap)
    }

    if work.stopsMicrophone {
      sharedCapture.stop()
      sharedCapture.setSink(nil)
    }

    // ⚠️ Les fichiers se ferment après l'arrêt des sources, jamais avant : un tampon qui
    // arriverait sur un fichier fermé serait perdu sans bruit, et c'est la fin de la session
    // qu'on perdrait.
    for writer in work.writers {
      writer.close()
    }
  }
}

/// L'unique capture de session du processus. Voir l'en-tête de [`LiveCapture`].
let sharedLiveCapture = LiveCapture()

// MARK: - Exports

/// Les sources audio captables, en JSON. Ne demande aucune autorisation et n'ouvre rien.
@_cdecl("mirmalion_list_audio_sources")
public func mirmalionListAudioSources(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    return try bridgeJSON(emittingAudioSources())
  }
}

/// Démarre la capture d'une session.
///
/// - Parameters:
///   - sourceId: `"system"`, ou le `pid` d'une application.
///   - microphoneDeviceId: `"default"` pour le micro système, un identifiant de périphérique,
///     ou vide pour ne pas inclure de micro — un choix légitime, pas une erreur.
///   - directory: le dossier des fichiers temporaires.
///   - locale: la langue de transcription ; absente, on enregistre sans transcrire en direct.
///   - out: reçoit une chaîne vide, ou le message d'erreur.
@_cdecl("mirmalion_live_start")
public func mirmalionLiveStart(
  _ sourceId: UnsafePointer<CChar>?,
  _ microphoneDeviceId: UnsafePointer<CChar>?,
  _ directory: UnsafePointer<CChar>?,
  _ locale: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let source = try requireArgument(sourceId, "la source audio")
    let folder = try requireArgument(directory, "le dossier d'enregistrement")

    // ⚠️ Trois cas et non deux — voir [`MicrophoneChoice`]. Un identifiant qu'on ne sait pas
    // lire retombe sur le micro système plutôt que d'échouer : perdre la voix de
    // l'utilisateur pour un identifiant périmé serait une punition disproportionnée.
    let choice: MicrophoneChoice
    switch optionalArgument(microphoneDeviceId) {
    case nil: choice = .none
    case "default": choice = .system
    case let identifier?:
      choice = AudioDeviceID(identifier).map { MicrophoneChoice.device($0) } ?? .system
    }

    try sharedLiveCapture.start(
      sourceId: source,
      microphone: choice,
      directory: URL(fileURLWithPath: folder),
      locale: optionalArgument(locale)
    )
    return ""
  }
}

/// Arrête la capture et ferme les fichiers. Sans effet si rien ne tourne.
@_cdecl("mirmalion_live_stop")
public func mirmalionLiveStop(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedLiveCapture.stop()
    return ""
  }
}

/// L'état de la capture de session, en JSON — dont les deux compteurs et le niveau combiné.
@_cdecl("mirmalion_live_status")
public func mirmalionLiveStatus(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    return try bridgeJSON(sharedLiveCapture.status())
  }
}
