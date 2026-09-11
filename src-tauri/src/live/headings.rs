//! Les intitulés de rubrique, quand le modèle les recopie en anglais.
//!
//! Le prompt le demande deux fois (`LanguageModel.swift`) et le modèle désobéit quand même : une
//! session française sort son corps en français et ses rubriques en anglais, mot pour mot celles
//! de `reportSections`. D'où ce garde-fou déterministe, qui ne se dédit pas d'une génération à
//! l'autre. L'intitulé qu'il pose reste du contenu, traduit à l'affichage comme le reste.
//!
//! # Pièges
//!
//! - ⚠️ On ne corrige que sur preuve positive : un intitulé n'est réécrit que s'il est exactement
//!   l'une des formes anglaises écrites dans le prompt. Un titre inventé par le modèle reste
//!   intact — rien ne le distingue d'une rubrique légitime, et y toucher effacerait du travail.
//! - ⚠️ Ce module duplique les phrases de `reportSections`, à dessein : le garde-fou doit être
//!   éprouvable sans modèle, en `cargo test`. La dérive est tenue par deux tests qui lisent le
//!   fichier Swift, même motif que `i18n.rs` pour `CFBundleLocalizations`.

use crate::i18n::SUPPORTED_LOCALES;

/// Une rubrique, telle que le prompt la demande et telle qu'on veut la lire.
struct Rubric {
  /// La phrase exacte de `reportSections`, côté Swift. C'est la forme que le modèle recopie.
  prompt: &'static str,
  /// Les six intitulés, dans l'ordre de [`SUPPORTED_LOCALES`] : fr, en, es, de, it, pt.
  ///
  /// # Pièges
  ///
  /// - ⚠️ L'anglais (indice 1) sert deux fois : c'est l'intitulé d'une session anglaise, et c'est
  ///   aussi une forme reconnue — le modèle abrège souvent « Tasks (with their deadline when
  ///   said) » en « Tasks ».
  labels: [&'static str; 6],
}

/// Les rubriques des types de compte rendu, sans doublon.
///
/// Un intitulé est un libellé, pas la traduction de la consigne : le prompt écrit « Tasks (with
/// their deadline when said) », la table rend « Tâches ». C'est pourquoi une session anglaise
/// passe aussi par ici — elle y gagne le nettoyage de ces parenthèses.
///
/// # Pièges
///
/// - ⚠️ Une phrase ajoutée à `reportSections` sans sa ligne ici fait échouer un test ; c'est le
///   seul rappel qui existe.
const RUBRICS: &[Rubric] = &[
  Rubric {
    prompt: "Summary",
    labels: [
      "Résumé",
      "Summary",
      "Resumen",
      "Zusammenfassung",
      "Riepilogo",
      "Resumo",
    ],
  },
  Rubric {
    prompt: "Topics covered",
    labels: [
      "Sujets abordés",
      "Topics covered",
      "Temas tratados",
      "Behandelte Themen",
      "Argomenti trattati",
      "Temas abordados",
    ],
  },
  Rubric {
    prompt: "Feedback and how each person felt",
    labels: [
      "Retours et ressentis",
      "Feedback",
      "Comentarios y percepciones",
      "Rückmeldungen und Eindrücke",
      "Riscontri e impressioni",
      "Comentários e perceções",
    ],
  },
  Rubric {
    prompt: "Goals and next steps",
    labels: [
      "Objectifs et prochaines étapes",
      "Goals and next steps",
      "Objetivos y próximos pasos",
      "Ziele und nächste Schritte",
      "Obiettivi e prossimi passi",
      "Objetivos e próximos passos",
    ],
  },
  Rubric {
    prompt: "Follow-ups",
    labels: [
      "Points de suivi",
      "Follow-ups",
      "Seguimiento",
      "Nachverfolgung",
      "Punti da seguire",
      "Acompanhamento",
    ],
  },
  Rubric {
    prompt: "What the client needs and asks for",
    labels: [
      "Besoins et demandes du client",
      "Client needs",
      "Necesidades y peticiones del cliente",
      "Bedarf und Wünsche des Kunden",
      "Esigenze e richieste del cliente",
      "Necessidades e pedidos do cliente",
    ],
  },
  Rubric {
    prompt: "What we committed to",
    labels: [
      "Nos engagements",
      "Commitments",
      "Nuestros compromisos",
      "Unsere Zusagen",
      "I nostri impegni",
      "Os nossos compromissos",
    ],
  },
  Rubric {
    prompt: "Objections and things to watch",
    labels: [
      "Objections et points de vigilance",
      "Objections and risks",
      "Objeciones y puntos de atención",
      "Einwände und Aufmerksamkeitspunkte",
      "Obiezioni e punti di attenzione",
      "Objeções e pontos de atenção",
    ],
  },
  Rubric {
    prompt: "Next steps with their deadlines",
    labels: [
      "Prochaines étapes et échéances",
      "Next steps",
      "Próximos pasos y plazos",
      "Nächste Schritte und Fristen",
      "Prossimi passi e scadenze",
      "Próximos passos e prazos",
    ],
  },
  Rubric {
    prompt: "Key notions and definitions",
    labels: [
      "Notions clés et définitions",
      "Key notions and definitions",
      "Nociones clave y definiciones",
      "Schlüsselbegriffe und Definitionen",
      "Nozioni chiave e definizioni",
      "Noções-chave e definições",
    ],
  },
  Rubric {
    prompt: "Examples",
    labels: [
      "Exemples",
      "Examples",
      "Ejemplos",
      "Beispiele",
      "Esempi",
      "Exemplos",
    ],
  },
  Rubric {
    prompt: "What to remember",
    labels: [
      "À retenir",
      "What to remember",
      "Para recordar",
      "Zum Merken",
      "Da ricordare",
      "A reter",
    ],
  },
  Rubric {
    prompt: "References mentioned",
    labels: [
      "Références citées",
      "References",
      "Referencias mencionadas",
      "Genannte Quellen",
      "Riferimenti citati",
      "Referências mencionadas",
    ],
  },
  Rubric {
    prompt: "Open questions",
    labels: [
      "Questions ouvertes",
      "Open questions",
      "Preguntas abiertas",
      "Offene Fragen",
      "Domande aperte",
      "Questões em aberto",
    ],
  },
  Rubric {
    prompt: "Every idea raised (be exhaustive)",
    labels: [
      "Idées émises",
      "Ideas raised",
      "Ideas planteadas",
      "Genannte Ideen",
      "Idee proposte",
      "Ideias apresentadas",
    ],
  },
  Rubric {
    prompt: "Ideas kept or worth exploring",
    labels: [
      "Idées retenues",
      "Ideas kept",
      "Ideas retenidas",
      "Weiterverfolgte Ideen",
      "Idee da approfondire",
      "Ideias retidas",
    ],
  },
  Rubric {
    prompt: "Ideas set aside and why",
    labels: [
      "Idées écartées et pourquoi",
      "Ideas set aside",
      "Ideas descartadas y por qué",
      "Verworfene Ideen und warum",
      "Idee scartate e perché",
      "Ideias postas de lado e porquê",
    ],
  },
  Rubric {
    prompt: "Next actions",
    labels: [
      "Actions à mener",
      "Next actions",
      "Próximas acciones",
      "Nächste Aktionen",
      "Azioni successive",
      "Ações seguintes",
    ],
  },
  Rubric {
    prompt: "Main points",
    labels: [
      "Points principaux",
      "Main points",
      "Puntos principales",
      "Hauptpunkte",
      "Punti principali",
      "Pontos principais",
    ],
  },
  Rubric {
    prompt: "Standout points and quotes",
    labels: [
      "Passages marquants et citations",
      "Standout points and quotes",
      "Momentos destacados y citas",
      "Auffällige Stellen und Zitate",
      "Passaggi salienti e citazioni",
      "Passagens marcantes e citações",
    ],
  },
  Rubric {
    prompt: "References and names mentioned",
    labels: [
      "Références et noms cités",
      "References and names",
      "Referencias y nombres mencionados",
      "Genannte Quellen und Namen",
      "Riferimenti e nomi citati",
      "Referências e nomes mencionados",
    ],
  },
  Rubric {
    prompt: "Background and context given",
    labels: [
      "Parcours et contexte",
      "Background",
      "Trayectoria y contexto",
      "Hintergrund und Kontext",
      "Percorso e contesto",
      "Percurso e contexto",
    ],
  },
  Rubric {
    prompt: "Strong points",
    labels: [
      "Points forts",
      "Strong points",
      "Puntos fuertes",
      "Stärken",
      "Punti di forza",
      "Pontos fortes",
    ],
  },
  Rubric {
    prompt: "Reservations and open questions",
    labels: [
      "Réserves et questions ouvertes",
      "Reservations",
      "Reservas y preguntas abiertas",
      "Vorbehalte und offene Fragen",
      "Riserve e domande aperte",
      "Reservas e questões em aberto",
    ],
  },
  Rubric {
    prompt: "What happens next",
    labels: [
      "Suite du processus",
      "What happens next",
      "Siguientes pasos del proceso",
      "Weiteres Vorgehen",
      "Prossimi passi del processo",
      "Continuação do processo",
    ],
  },
  Rubric {
    prompt: "Decisions",
    labels: [
      "Décisions",
      "Decisions",
      "Decisiones",
      "Entscheidungen",
      "Decisioni",
      "Decisões",
    ],
  },
  Rubric {
    prompt: "Tasks (with their deadline when said)",
    labels: [
      "Tâches",
      "Tasks",
      "Tareas",
      "Aufgaben",
      "Attività",
      "Tarefas",
    ],
  },
  Rubric {
    prompt: "Key points and risks",
    labels: [
      "Points clés et risques",
      "Key points and risks",
      "Puntos clave y riesgos",
      "Kernpunkte und Risiken",
      "Punti chiave e rischi",
      "Pontos-chave e riscos",
    ],
  },
];

/// L'intitulé localisé d'une rubrique recopiée en anglais, ou `None` s'il n'y a rien à corriger.
///
/// # Pièges
///
/// - ⚠️ `None` est le cas normal : un modèle qui a obéi rend déjà un titre traduit, et une langue
///   hors des six n'a pas de colonne. Dans les deux cas, l'intitulé reste tel quel.
pub fn localised(heading: &str, language: &str) -> Option<&'static str> {
  let column = SUPPORTED_LOCALES
    .iter()
    .position(|code| *code == language)?;
  let looked_for = folded(heading);
  RUBRICS
    .iter()
    .find(|rubric| folded(rubric.prompt) == looked_for || folded(rubric.labels[1]) == looked_for)
    .map(|rubric| rubric.labels[column])
}

/// La forme sur laquelle deux intitulés se comparent.
///
/// # Pièges
///
/// - ⚠️ La parenthèse tombe : le prompt en met — « Tasks (with their deadline when said) » — et
///   le modèle écrit tantôt la phrase entière, tantôt « Tasks » seul.
/// - ⚠️ Le repli est Unicode (`to_lowercase`), pas ASCII : la comparaison porte aussi sur des
///   intitulés accentués, et un repli ASCII laisserait « Résumé » et « résumé » distincts.
fn folded(heading: &str) -> String {
  let trimmed = heading.trim().trim_end_matches([':', '.', '·', '—', '-']);
  let without_aside = match trimmed.rfind('(') {
    Some(open) if trimmed.trim_end().ends_with(')') => &trimmed[..open],
    _ => trimmed,
  };
  without_aside
    .to_lowercase()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

#[cfg(test)]
mod tests {
  use super::{RUBRICS, folded, localised};
  use crate::i18n::SUPPORTED_LOCALES;

  /// Le fichier Swift qui écrit les prompts. ⚠️ Lu **à l'exécution du test**, pas inclus : le
  /// crate ne doit pas embarquer du Swift dans son binaire.
  fn swift_source() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("native/Sources/MirmalionNative/LanguageModel.swift");
    std::fs::read_to_string(&path).expect("LanguageModel.swift lisible")
  }

  /// Les phrases de `reportSections`, telles que Swift les écrit.
  fn swift_headings() -> Vec<String> {
    let source = swift_source();
    let body = source
      .split_once("private func reportSections")
      .expect("`reportSections` présente")
      .1;
    let body = body
      .split_once("\nextension ")
      .map_or(body, |(head, _)| head);
    // ⚠️ On scanne les chaînes, on ne lit pas les lignes : les listes courtes tiennent sur la
    // ligne du `return`, et ne garder que les lignes entièrement entre guillemets — la forme que
    // `swift-format` donne aux listes longues — en laisserait passer la moitié.
    let mut lists: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('"') {
      let after = &rest[open + 1..];
      let Some(close) = after.find('"') else { break };
      let literal = &after[..close];
      // Les clés du `switch` sont des identifiants en un mot ; les listes portent des espaces.
      if literal.contains(' ') {
        lists.push(literal.to_owned());
      }
      rest = &after[close + 1..];
    }
    lists
      .iter()
      // ⚠️ **Le découpage sur « , » tient** parce qu'aucune phrase n'en contient, pas même celles
      // à parenthèse. Une rubrique qui en porterait une casserait ce test, pas le produit.
      .flat_map(|list| list.split(", ").map(str::to_owned).collect::<Vec<_>>())
      .collect()
  }

  #[test]
  fn every_prompt_heading_is_in_the_swift_source() {
    let source = swift_source();
    for rubric in RUBRICS {
      assert!(
        source.contains(rubric.prompt),
        "« {} » n'est plus dans LanguageModel.swift : la rubrique a été renommée d'un seul côté",
        rubric.prompt
      );
    }
  }

  #[test]
  fn every_swift_heading_is_in_this_table() {
    let headings = swift_headings();
    // ⚠️ Le compte est vérifié, pas seulement la non-vacuité : les types de compte rendu tiennent
    // en huit listes — `custom` n'en a pas — et 37 phrases, doublons compris. Un extracteur qui en
    // manquerait une rendrait ce test vert sur une table incomplète.
    assert_eq!(headings.len(), 37, "découpage du Swift : {headings:?}");
    for heading in headings {
      assert!(
        RUBRICS.iter().any(|rubric| rubric.prompt == heading),
        "« {heading} » est demandée au modèle et n'a pas d'intitulé localisé"
      );
    }
  }

  #[test]
  fn a_copied_english_heading_is_replaced() {
    assert_eq!(localised("Topics covered", "fr"), Some("Sujets abordés"));
    assert_eq!(
      localised("Standout points and quotes", "pt"),
      Some("Passagens marcantes e citações")
    );
  }

  /// ⚠️ Le cas qui a motivé le module : le modèle abrège la consigne à parenthèse.
  #[test]
  fn the_short_form_of_an_instruction_heading_is_recognised_too() {
    assert_eq!(localised("Tasks", "fr"), Some("Tâches"));
    assert_eq!(
      localised("Tasks (with their deadline when said)", "de"),
      Some("Aufgaben")
    );
    // Une session anglaise y gagne le nettoyage de la parenthèse.
    assert_eq!(
      localised("Tasks (with their deadline when said)", "en"),
      Some("Tasks")
    );
  }

  #[test]
  fn casing_spacing_and_trailing_punctuation_do_not_matter() {
    assert_eq!(
      localised("  OPEN   QUESTIONS :", "es"),
      Some("Preguntas abiertas")
    );
  }

  /// ⚠️ Preuve positive : un titre inventé par le modèle ne bouge pas.
  #[test]
  fn an_invented_heading_is_left_alone() {
    assert_eq!(localised("L'importance de la mémoire cache", "fr"), None);
    assert_eq!(localised("Sujets abordés", "fr"), None);
    // Une langue hors des six n'a pas de colonne : on ne devine pas.
    assert_eq!(localised("Decisions", "nl"), None);
  }

  #[test]
  fn every_rubric_has_a_label_in_each_language() {
    for rubric in RUBRICS {
      for (index, label) in rubric.labels.iter().enumerate() {
        assert!(
          !label.trim().is_empty(),
          "« {} » n'a pas d'intitulé en {}",
          rubric.prompt,
          SUPPORTED_LOCALES[index]
        );
      }
    }
  }

  /// Deux rubriques qui se replieraient sur la même forme se voleraient leur intitulé.
  #[test]
  fn no_two_rubrics_collide() {
    let mut seen = std::collections::BTreeSet::new();
    for rubric in RUBRICS {
      assert!(seen.insert(folded(rubric.prompt)), "{}", rubric.prompt);
      let short = folded(rubric.labels[1]);
      assert!(
        short == folded(rubric.prompt) || seen.insert(short),
        "{}",
        rubric.labels[1]
      );
    }
  }
}
