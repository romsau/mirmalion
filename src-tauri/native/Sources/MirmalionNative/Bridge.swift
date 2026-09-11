import Foundation

// La frontière C du pont : statuts, erreurs, propriété des chaînes.
//
// Ajouter un export, en cinq points :
//
// 1. `@_cdecl("mirmalion_<nom>")` — le symbole C doit correspondre au caractère près au
//    `extern "C"` déclaré dans `src-tauri/src/native/mod.rs` ; le nom Swift, lui, est libre.
// 2. Entrées en `UnsafePointer<CChar>`, résultat par le paramètre `out`, retour = un `Int32`
//    de statut (`statusOK`, `statusError`, `statusNotFound`).
// 3. Envelopper tout le corps dans `withBridgeResult`, ou `withOptionalBridgeResult` si
//    l'absence de résultat est un cas nominal.
// 4. Swift alloue, Swift libère : Rust lit la chaîne puis rappelle `mirmalion_free_string`.
// 5. Déclarer l'export côté Rust, enveloppé dans une fonction rendant `Result<_, AppError>`.
//
// ⚠️ Une erreur qui atteint la frontière C tue le processus — elle ne traverse pas la FFI, et
// un `panic!` Rust ne traverse pas dans l'autre sens. `withBridgeResult` rattrape ce qui est
// lancé, et rien d'autre : dans le code du pont, jamais de `!` ni de `fatalError`, on lance.

/// L'appel a réussi ; `out` contient le résultat.
let statusOK: Int32 = 0
/// L'appel a échoué ; `out` contient le message d'erreur, remonté en `AppError`.
let statusError: Int32 = 1
/// Ce qui était demandé n'existe pas, et ce n'est pas une erreur.
///
/// - Warning: ⚠️ Confondre « absent » et « illisible » sur la clé de chiffrement détruit
///   l'historique : une lecture en échec prise pour « pas encore de clé » ferait générer une
///   clé neuve par-dessus une base existante, illisible pour toujours. Voir
///   `mirmalion_keychain_read`.
let statusNotFound: Int32 = 2

/// Les erreurs du pont. Le message traverse la frontière, pas le type.
enum BridgeError: LocalizedError {
  case invalidArgument(String)
  case keychain(String)
  case window(String)
  case permission(String)
  /// Capture ou transcription en échec. Distinct de `.permission` : ici l'autorisation est
  /// accordée, c'est le matériel ou le moteur qui n'a pas suivi.
  case audio(String)
  /// L'insertion au curseur a échoué. Distinct de `.permission` pour la même raison : le
  /// presse-papiers a refusé, ou macOS n'a pas voulu de l'évènement — pas l'utilisateur.
  case injection(String)
  /// Le modèle de langue est indisponible, a refusé, ou a dépassé sa fenêtre de contexte.
  ///
  /// - Warning: ⚠️ Ce n'est pas un chemin exceptionnel : il porte le repli « insérer le texte
  ///   brut », et l'appelant doit le traiter comme une issue prévue.
  case languageModel(String)
  /// La traduction a échoué. Distinct d'une paire de langues absente, qui n'est pas une erreur
  /// mais une issue nominale rendue en JSON — voir `Translation.swift`.
  case translation(String)
  /// Un export a échoué : PDF impossible à écrire, presse-papiers qui refuse. Distinct de
  /// `.injection`, qui parle du collage au curseur et non d'un fichier livré à un tiers.
  case export(String)

  var errorDescription: String? {
    switch self {
    case .invalidArgument(let detail), .keychain(let detail), .window(let detail),
      .permission(let detail), .audio(let detail), .injection(let detail),
      .languageModel(let detail), .translation(let detail), .export(let detail):
      return detail
    }
  }
}

/// Le message d'une erreur, tel qu'il a le droit de traverser la frontière.
///
/// - Parameters:
///   - error: ce qui a été lancé, du pont ou d'ailleurs.
/// - Returns: notre phrase si l'erreur est une `BridgeError`, sinon le domaine et le code système.
/// - Warning: ⚠️ **`localizedDescription` ne traverse jamais.** Elle est en anglais quelle que
///   soit la langue de l'interface et va jusqu'à l'écran ; celle d'une erreur de fichier porte
///   **le nom du fichier**, qu'aucun message n'a le droit de citer.
func bridgeMessage(_ error: Error) -> String {
  if let ours = error as? BridgeError {
    return ours.errorDescription ?? "erreur du pont sans description"
  }
  let system = error as NSError
  return "erreur système (\(system.domain) \(system.code))"
}

/// Encode une charge utile en JSON, sous la forme que le pont transmet.
///
/// - Returns: le JSON, en UTF-8.
/// - Throws: `BridgeError.invalidArgument` si l'encodage échoue.
/// - Warning: ⚠️ Le seul encodeur du pont : une stratégie commune — dates, clés, tri — se pose
///   ici et vaut pour les quatorze exports.
/// - Warning: ⚠️ Le repli UTF-8 ne se déclenche pas en pratique, `JSONEncoder` n'en produit pas
///   d'autre ; il reste parce qu'un `guard` gratuit vaut mieux qu'une supposition.
func bridgeJSON<T: Encodable>(_ payload: T) throws -> String {
  let data = try JSONEncoder().encode(payload)
  guard let json = String(data: data, encoding: .utf8) else {
    throw BridgeError.invalidArgument("la charge utile n'est pas encodable en UTF-8")
  }
  return json
}

/// Le résultat d'un travail asynchrone, rapporté au fil synchrone qui l'attend.
///
/// - Warning: ⚠️ **`@unchecked Sendable` ne tient que par le sémaphore** : l'écriture précède
///   `signal()`, la lecture suit `wait()`. **Hors de ce motif la boîte n'est pas sûre** — deux
///   fils qui l'écriraient sans se synchroniser seraient une course, et rien ici ne l'empêche.
final class ResultBox<Value>: @unchecked Sendable {
  var value: Value?
}

/// Combien de temps le pont accepte d'attendre un travail asynchrone, par nature d'appel.
///
/// - Warning: ⚠️ **Une borne trop courte est pire que pas de borne** : elle coupe un travail qui
///   aurait abouti, et l'utilisateur perd un résultat que la machine était en train de produire.
///   Chaque valeur est un large multiple d'une durée mesurée, jamais une cible de performance.
/// - Warning: ⚠️ Ces bornes ne sont pas là pour l'utilisateur, qui n'attendra jamais si longtemps
///   devant son écran. Elles sont là pour le **fil** : chaque attente retient un fil du pool
///   bloquant de Rust, et un moteur qui ne rend jamais sa continuation le retiendrait pour la
///   durée du processus.
enum BridgeDeadline {
  /// Une passe de modèle de langue. Mesuré : 65 passes en 135 s au banc de reformulation, soit
  /// 2,1 s en moyenne ; 4,7 s sur la plus grosse tranche d'un compte rendu de 8 034 mots. La
  /// réponse est de toute façon plafonnée à 2 048 jetons produits. Vingt-cinq fois le pire.
  static let languageModel: TimeInterval = 120

  /// Une lecture ou une libération d'inventaire de langues. Mesuré : 0,09 s pour l'inventaire
  /// et les langues installées réunis (`tests/locale_reservations.rs`). Ce sont des accès locaux.
  static let speechAssets: TimeInterval = 30

  /// La préparation d'un moteur de transcription : résolution de langue, format d'analyse.
  /// Mesuré de biais : ~600 ms séparent le geste du premier échantillon de dictée, préparation
  /// comprise.
  static let engineSetup: TimeInterval = 60

  /// La lecture des métadonnées d'un média par AVFoundation — pistes et durée, aucun décodage.
  /// ⚠️ Borne raisonnée et non mesurée : le corpus de mesure vit hors du dépôt.
  static let mediaMetadata: TimeInterval = 60

  /// Une interrogation ou une préparation du framework Translation. ⚠️ Borne raisonnée : les
  /// 72 interrogations du périmètre sont des lectures, mais une préparation peut demander à
  /// macOS un pack qu'il n'a pas — c'est le seul appel d'ici qui touche potentiellement le
  /// réseau, et il le fait sur geste explicite de l'utilisateur.
  static let translation: TimeInterval = 120

  /// La détection de langue d'un média : un échantillon de 30 s transcrit **par langue
  /// installée**, 3 s mesurées par langue, six langues au plus — décodage compris.
  static let languageDetection: TimeInterval = 300
}

/// Exécute un travail asynchrone depuis un appelant synchrone, et attend son résultat.
///
/// - Parameter within: la borne, ou `nil` pour attendre sans fin — un choix, jamais un oubli.
/// - Returns: ce que `body` a produit.
/// - Throws: ce que `body` lance, ou `BridgeError.audio` si la borne est dépassée.
/// - Warning: ⚠️ Le dépassement **n'annule pas** le travail, qui continue sans lecteur.
/// - Warning: ⚠️ Sur dépassement, la boîte n'est **pas lue** : la tâche l'écrit peut-être au même
///   instant, et `ResultBox` ne tient que par le sémaphore.
func awaiting<Value>(
  _ what: String,
  within deadline: TimeInterval?,
  _ body: @escaping @Sendable () async throws -> Value
) throws -> Value {
  let box = ResultBox<Result<Value, Error>>()
  let ready = DispatchSemaphore(value: 0)
  Task {
    do { box.value = .success(try await body()) } catch { box.value = .failure(error) }
    ready.signal()
  }

  if let deadline {
    guard ready.wait(timeout: .now() + deadline) == .success else {
      throw BridgeError.audio("\(what) : rien n'est revenu en \(Int(deadline)) s")
    }
  } else {
    ready.wait()
  }

  guard let outcome = box.value else {
    throw BridgeError.audio("\(what) : la tâche s'est terminée sans rien rendre")
  }
  return try outcome.get()
}

/// Exécute `body` sur le fil principal, ou **échoue proprement** si on n'y est pas.
///
/// - Parameter what: le geste, nommé dans le message d'erreur.
/// - Throws: `BridgeError.window` hors du fil principal ; sinon ce que `body` lance.
/// - Warning: ⚠️ **`MainActor.assumeIsolated` seul ne lance pas : il TRAPPE.** Un appelant venu du
///   mauvais fil tuerait le processus sans un mot ; le contrôle explicite en fait une erreur.
/// - Warning: ⚠️ On ne re-poste pas vers le fil principal : `DispatchQueue.main.async` rendrait la
///   main avant le travail, et la frontière C ne saurait pas l'attendre.
/// - Warning: ⚠️ `T: Sendable` est ce qu'exige `assumeIsolated`.
func onMainActor<T: Sendable>(_ what: String, _ body: @MainActor () throws -> T) throws -> T {
  guard Thread.isMainThread else {
    throw BridgeError.window("\(what) : appelé hors du fil principal")
  }
  return try MainActor.assumeIsolated(body)
}

/// Exécute `body` et écrit son résultat — ou son message d'erreur — dans `out`.
///
/// - Parameters:
///   - out: reçoit la chaîne allouée, que l'appelant rend par `mirmalion_free_string`.
///   - body: le corps de l'export, libre de lancer.
/// - Returns: `statusOK`, ou `statusError` si `body` a lancé, si `out` est nul, ou si la copie
///   de la chaîne échoue.
/// - Warning: ⚠️ Aucune erreur ne doit franchir la frontière C : tout corps d'export passe
///   par ici.
func withBridgeResult(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
  _ body: () throws -> String
) -> Int32 {
  guard let out else { return statusError }
  do {
    guard let copy = strdup(try body()) else { return statusError }
    out.pointee = copy
    return statusOK
  } catch {
    out.pointee = strdup(bridgeMessage(error))
    return statusError
  }
}

/// Variante de `withBridgeResult` pour un résultat qui peut légitimement ne pas exister.
///
/// - Parameters:
///   - out: reçoit la chaîne allouée, que l'appelant rend par `mirmalion_free_string`.
///   - body: le corps de l'export, dont `nil` est une issue nominale.
/// - Returns: `statusOK` ; `statusNotFound` quand `body` rend `nil`, que Rust lit `Ok(None)` ;
///   `statusError` si `body` a lancé, si `out` est nul ou si la copie échoue.
/// - Warning: ⚠️ Une copie en échec rend `statusError`, jamais `statusOK` : sur la clé de
///   chiffrement, un `statusOK` à pointeur nul se lirait « clé vide », pas « lecture impossible ».
func withOptionalBridgeResult(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
  _ body: () throws -> String?
) -> Int32 {
  guard let out else { return statusError }
  do {
    guard let value = try body() else { return statusNotFound }
    guard let copy = strdup(value) else { return statusError }
    out.pointee = copy
    return statusOK
  } catch {
    out.pointee = strdup(bridgeMessage(error))
    return statusError
  }
}

/// Lit un argument chaîne du pont, en refusant le pointeur nul et la chaîne vide.
///
/// - Parameters:
///   - pointer: l'argument reçu de Rust.
///   - name: le nom de l'argument, repris dans le message d'erreur.
/// - Returns: la chaîne lue.
/// - Throws: `BridgeError.invalidArgument` si le pointeur est nul ou la chaîne vide.
func requireArgument(_ pointer: UnsafePointer<CChar>?, _ name: String) throws -> String {
  guard let pointer else {
    throw BridgeError.invalidArgument("\(name) : pointeur nul")
  }
  let value = String(cString: pointer)
  guard !value.isEmpty else {
    throw BridgeError.invalidArgument("\(name) : chaîne vide")
  }
  return value
}

/// Lit un argument chaîne **facultatif** : pointeur nul ou chaîne vide valent « absent ».
///
/// - Returns: la chaîne lue, ou `nil` si l'argument n'a pas été fourni.
/// - Warning: ⚠️ Le pendant de `requireArgument`, et le contraire de son contrat : ici, « pas de
///   micro », « pas de transcription en direct » et « pas de prompt personnalisé » sont des
///   choix. Les replier sur un refus supprimerait des options du produit.
/// - Warning: ⚠️ La chaîne vide vaut « absent » alors que Rust n'en envoie plus — `optional`
///   (`native/mod.rs`) la refuse et passe un pointeur nul. C'est la ceinture qui a rendu la
///   migration sans risque quand les deux conventions coexistaient.
func optionalArgument(_ pointer: UnsafePointer<CChar>?) -> String? {
  guard let pointer else { return nil }
  let value = String(cString: pointer)
  return value.isEmpty ? nil : value
}

/// Libère une chaîne renvoyée par n'importe quel export du pont.
///
/// - Parameters:
///   - pointer: la chaîne allouée par Swift, déjà lue par Rust ; un pointeur nul est admis.
/// - Warning: ⚠️ C'est la seule voie de libération : Rust ne rend jamais lui-même une chaîne
///   venue d'ici, et doit rappeler cet export après chaque lecture.
@_cdecl("mirmalion_free_string")
public func mirmalionFreeString(_ pointer: UnsafeMutablePointer<CChar>?) {
  free(pointer)
}

/// Renvoie la chaîne reçue. L'export de référence, à recopier pour tout nouvel export.
///
/// - Parameters:
///   - input: la chaîne à renvoyer, ni nulle ni vide.
///   - out: reçoit la copie allouée, que l'appelant rend par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` — remonté en `AppError::Native` — sur entrée vide.
/// - Warning: ⚠️ Non exposé en IPC, mais support des tests de la frontière : le supprimer ferait
///   perdre le seul chemin d'erreur natif éprouvable.
@_cdecl("mirmalion_echo")
public func mirmalionEcho(
  _ input: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let input else {
      throw BridgeError.invalidArgument("mirmalion_echo : pointeur d'entrée nul")
    }
    let text = String(cString: input)
    guard !text.isEmpty else {
      throw BridgeError.invalidArgument("mirmalion_echo : chaîne d'entrée vide")
    }
    return text
  }
}
