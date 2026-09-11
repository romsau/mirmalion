// swift-tools-version: 6.2
import PackageDescription

// Bibliothèque native de Mirmalion : tout ce qui doit passer par les frameworks Apple
// (SpeechTranscriber, Translation, FoundationModels, Core Audio Taps) et par FluidAudio.
//
// SwiftPM plutôt qu'un `swiftc` appelé à la main : FluidAudio se distribue en paquet Swift
// (phase 3). Le jour où on l'ajoute, c'est une ligne dans `dependencies`, pas une refonte
// de la chaîne de compilation.
//
// Compilée par `src-tauri/build.rs`, jamais à la main.
let package = Package(
  name: "MirmalionNative",
  // ⚠️ `.v26` n'existe qu'à partir de `swift-tools-version: 6.2` — redescendre la ligne 1
  // fait échouer le manifeste, pas la compilation des sources.
  // ⚠️ Les gardes `#available(macOS 26.0, *)` des sources ne sont pas devenues inutiles :
  // elles seules permettront de redescendre ce socle.
  platforms: [.macOS(.v26)],
  products: [
    .library(name: "MirmalionNative", type: .dynamic, targets: ["MirmalionNative"])
  ],
  dependencies: [
    // ⚠️ **LE SEUL COMPOSANT TIERS OBLIGATOIRE DU PRODUIT.** Apple ne fournit **aucune**
    // diarisation : ni Speech, ni SoundAnalysis ne savent dire « qui parle ». FluidAudio porte
    // Pyannote Community-1 en CoreML, sur le Neural Engine.
    //
    // ⚠️⚠️ **SES MODÈLES SE TÉLÉCHARGENT DEPUIS HUGGINGFACE AU PREMIER USAGE**, par défaut, et
    // en silence. C'est incompatible avec « rien ne sort sans geste explicite » : voir
    // `Diarization.swift`, qui pose `offlineMode` et charge depuis un dossier local.
    //
    // ⚠️ `upToNextMinor` et non `from` : `from: "0.12.0"` acceptait tout `0.x` ultérieur. Sur le
    // seul composant tiers d'une application hors-ligne, dont le comportement PAR DÉFAUT est de
    // télécharger, la plage doit être aussi étroite que possible. `Package.resolved` est
    // versionné et rend déjà les builds reproductibles ; ceci ferme le geste — un
    // `swift package update` distrait.
    .package(
      url: "https://github.com/FluidInference/FluidAudio.git",
      .upToNextMinor(from: "0.15.5"))
  ],
  targets: [
    .target(
      name: "MirmalionNative",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      // ⚠️ Le pendant du `-D warnings` de clippy, et il n'a de valeur que parce qu'il est
      // atteignable : les avertissements dormants — quatre propriétés Core Audio lues dans une
      // variable porteuse de référence, deux tampons audio capturés par une fermeture
      // `@Sendable` — ont été traités d'abord. Un drapeau qu'on ne peut pas activer ne garantit
      // rien.
      // ⚠️ Ne vaut que pour cette cible : FluidAudio compile avec ses propres réglages.
      swiftSettings: [.treatAllWarnings(as: .error)],
      linkerSettings: [
        // ⚠️ SANS CECI, RIEN NE CHARGE À L'EXÉCUTION.
        // Par défaut, la .dylib porte comme nom d'installation le chemin ABSOLU de la
        // machine de compilation. Une fois l'app installée ailleurs, dyld cherche ce
        // chemin, ne le trouve pas, et le processus meurt au démarrage.
        // `@rpath` délègue la résolution aux rpath du binaire Rust — que build.rs pose.
        .unsafeFlags([
          "-Xlinker", "-install_name",
          "-Xlinker", "@rpath/libMirmalionNative.dylib",
        ])
      ]
    ),
    // ⚠️ Ce que cette cible peut couvrir, et ce qu'elle ne peut PAS : le tap Core Audio, le tap
    // clavier et le trousseau demandent du matériel, une autorisation TCC ou un bundle signé —
    // les éprouver ici n'a pas de sens, et c'est déjà ce que font les tests d'intégration Rust
    // (`src-tauri/tests/`). Ce qui se teste ici est ce qui est PUR ou dont l'état est
    // observable : les estimateurs, les décisions, et les invariants que ce paquet énonce sur
    // lui-même sans que rien ne les vérifie.
    //
    // ⚠️ `swift test` ne construit pas la `.dylib` livrée : `build.rs` la compile en `release`
    // avec son propre `--scratch-path`. Les deux ne se marchent pas dessus.
    .testTarget(
      name: "MirmalionNativeTests",
      dependencies: ["MirmalionNative"],
      swiftSettings: [.treatAllWarnings(as: .error)]
    )
  ]
)
