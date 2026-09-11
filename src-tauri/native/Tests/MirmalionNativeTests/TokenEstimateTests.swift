import Testing

@testable import MirmalionNative

// L'estimateur qui décide si un texte entre dans la fenêtre du modèle.
//
// ⚠️ Son sens d'erreur n'est pas symétrique, et c'est tout ce qui compte : surestimer refuse un
// texte qui serait passé — l'utilisateur reçoit son texte brut, c'est un repli prévu.
// Sous-estimer laisse tenter un appel qui dépassera la fenêtre, et le modèle rend alors une
// erreur là où la garde existait précisément pour l'éviter.

@Suite("L'estimation du nombre de tokens")
struct TokenEstimateTests {

  /// Les six langues du périmètre, plus ce qui casse un compteur naïf : accents, ligatures,
  /// emoji hors du plan de base.
  private static let samples = [
    "",
    "a",
    "Bonjour",
    "Alors, le rapport est prêt pour la réunion de jeudi.",
    "Guten Tag, der Bericht ist fertig.",
    "Buenos días, el informe está listo.",
    "Ecco il resoconto della riunione.",
    "Bom dia, o relatório está pronto.",
    "Œuvre, cœur, naïf, çà et là — ligatures et accents.",
    "🙂🎧👋 des emoji hors du plan de base",
    String(repeating: "Très bien, merci. ", count: 200),
  ]

  /// ⚠️ **Le contrat, écrit comme une inégalité.** L'estimateur compte un token pour quatre
  /// scalaires ; le vérifier revient à dire qu'il ne rend jamais moins que ce qu'il promet.
  /// Un `/ 5` glissé ici passerait tous les autres tests de ce fichier.
  @Test("l'estimation ne descend jamais sous un token pour quatre scalaires")
  func neverUndercounts() {
    for text in Self.samples {
      let estimate = estimatedTokenCount(text)
      #expect(
        estimate * 4 >= text.unicodeScalars.count,
        "« \(text.prefix(24)) » : \(estimate) tokens pour \(text.unicodeScalars.count) scalaires")
    }
  }

  /// ⚠️ Le `+ 1` final, et la raison pour laquelle il est là : sans lui, tout texte de moins de
  /// quatre scalaires vaut zéro token, et une garde `estimation <= plafond` laisse passer ce
  /// qu'elle n'a pas mesuré.
  @Test("un texte non vide vaut toujours au moins un token")
  func neverZeroForRealText() {
    #expect(estimatedTokenCount("") >= 1)
    #expect(estimatedTokenCount("a") >= 1)
    #expect(estimatedTokenCount("oui") >= 1)
  }

  /// Un texte plus long ne peut pas coûter moins cher : c'est ce qui rend l'estimateur utilisable
  /// comme garde.
  @Test("l'estimation ne décroît jamais quand le texte s'allonge")
  func staysMonotonic() {
    var previous = 0
    for length in 0...300 {
      let estimate = estimatedTokenCount(String(repeating: "é", count: length))
      #expect(estimate >= previous, "à \(length) caractères")
      previous = estimate
    }
  }
}
