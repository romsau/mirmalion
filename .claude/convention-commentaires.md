# Convention de commentaire

Le détail de ce que `.claude/CLAUDE.md` résume. À lire quand un cas se discute : où passe la
ligne, ce qui compte dans un plafond, ce que chaque langage attend.

Le juge n'est pas ce document : c'est `scripts/check-comments.mjs`, et ce qu'il ne mesure pas est
signalé comme tel ci-dessous.

## 1. La ligne de partage

| Catégorie   | Ce que c'est                                                          | Sort         |
| ----------- | --------------------------------------------------------------------- | ------------ |
| **Contrat** | Ce que fait le symbole, ses paramètres, ce qu'il rend, ses erreurs      | Reste        |
| **Piège**   | La contrainte externe qui casse si on l'ignore                         | Reste        |
| **Journal** | Alternatives écartées, justification d'approche, dates, décisions, campagnes | **Supprimé** |

> **Un piège dit ce qui casse et comment l'éviter. Un journal raconte comment on en est arrivé là.**

Trois cas pour caler le jugement.

**Piège** — une limite externe et sa conséquence :

> La fenêtre du modèle fait 4 096 tokens ; une session d'une heure en fait 12 000. Découper est
> obligatoire dès ~20 minutes.

**Journal** — il argumente un choix déjà fait :

> « Pourquoi un map-reduce, et pourquoi ce n'est pas une optimisation […] c'est la seule façon
> d'aller au bout. »

**Piège malgré sa forme narrative** — il protège une donnée qui voyage :

> Les identifiants ne bougent jamais : ils voyagent en clair dans le fichier de réglages, un
> renommage ferait retomber les utilisateurs sur le défaut sans le dire.

**La règle de doute** : garder le piège, raccourcir la prose. Jamais l'inverse — un piège supprimé
par erreur ne se voit pas, il se paie plus tard.

**Le `⚠️` prévient, il n'insiste pas.** Ce qui **explique** va dans le corps du bloc, ce qui
**prévient** sous le marqueur. « Miroir de `ReportKind` côté Rust » explique. « Les identifiants
ne bougent jamais : ils voyagent en persistance » prévient. Marquer ce qui explique dilue le
marqueur jusqu'à le rendre invisible — le défaut même qu'on corrige.

**Le périmètre est le fichier.** Un module `#[cfg(test)]` vit dans le `.rs` qu'il éprouve : il est
couvert. Un `*.spec.ts` est un fichier à part : il ne l'est pas. Les migrations `.sql` sont
couvertes — cela vise leur prose, pas leurs instructions, qu'on ne modifie jamais une fois livrées.

**Ce qui n'a pas à être redit** : les fonctions retirées après mesure sont dans `CLAUDE.md`
(« Ne pas reproposer ») et dans `docs/v2/`.

## 2. Les plafonds

| Élément                                | Maximum, en lignes non vides | Vérifié ? |
| -------------------------------------- | ---------------------------- | --------- |
| En-tête de module (`//!`, 1er bloc TS)  | 12                           | oui       |
| Documentation d'un item                | 8                            | oui       |
| Un piège                               | 4                            | **non**   |

⚠️ **Les 8 lignes d'un item comptent TOUT le bloc, pièges compris** — c'est le dépassement le plus
fréquent, et il surprend parce qu'on compte sa prose en oubliant ses puces. L'arithmétique :

```
1 résumé + 1 « # Pièges » + 2 pièges de 3 lignes = 7   ✓
2 résumé + 1 « # Pièges » + 2 pièges de 4 lignes = 11  ✗
```

Deux pièges détaillés ne tiennent pas avec un résumé bavard. Couper la prose, garder les pièges.

⚠️ **Un bloc d'exemple entre ` ``` ` ne compte pas** : c'est du code, et le plafond vise le récit.
Sans cette exception, documenter l'usage d'un composant obligerait à choisir entre l'exemple et
les pièges.

Le plafond du piège n'étant pas outillé, il se tient à l'œil : au-delà de quatre lignes, une
prévention est devenue un récit.

## 3. Les formats

### Angular — TSDoc

- Un bloc `/** */` par symbole exporté et par membre public.
- **Première ligne = phrase complète** : c'est elle que Compodoc affiche en liste. Puis, si besoin,
  un paragraphe qui dit _comment on s'en sert_, jamais _pourquoi ce choix_.
- Tags admis : `@param`, `@returns`, `@throws`, `@see`, `@example`, `@deprecated`, `{@link}`.
- Les pièges dans un `@remarks` unique, ouvert par `⚠️`.
- Dans un corps de fonction, `//` pour un piège réel — jamais pour paraphraser la ligne suivante.

```ts
/**
 * Une ligne du transcript en direct.
 *
 * @remarks
 * ⚠️ La clé de rendu n'est ni l'index ni le texte : l'index rejouerait tout le DOM à chaque ligne
 * ajoutée, et le texte se répète — deux lignes de même clé font s'effondrer le suivi.
 */
export interface LiveLine {
  readonly id: number;
}
```

### Rust — rustdoc

- `//!` en tête de module : ce qu'il fait, ses invariants, sa frontière.
- `///` sur chaque item ; `# Errors` sur tout ce qui rend `Result`, `# Panics` et `# Safety` là où
  ça s'applique.
- Les pièges dans une section `# Pièges`, une puce chacun, ouverte par `⚠️`.
- Liens intra-doc (`` [`ReportKind`] ``) plutôt que des noms nus.
- ⚠️ **Aucun bloc ` ``` ` qui ne compile pas** : c'est un doctest, `cargo test` le lance. À défaut,
  ` ```text ` ou ` ```ignore `.

```rust
/// Découpe le transcript en tranches respectant les frontières de sens.
///
/// # Errors
///
/// Rend [`SliceError::Empty`] si le transcript ne porte aucun tour de parole.
///
/// # Pièges
///
/// - ⚠️ La fenêtre du modèle fait 4 096 tokens ; au-delà, il refuse la requête.
/// - ⚠️ Couper au compte de tokens dégrade le rappel : couper aux frontières de sens.
pub fn slice() {}
```

### Swift — DocC

`///` : phrase de résumé, puis `- Parameters:`, `- Returns:`, `- Warning:` pour les pièges.

```swift
/// Capture le son du système.
///
/// - Parameters:
///   - source: la source retenue.
/// - Returns: le flux ouvert.
/// - Warning: ⚠️ le tap Core Audio se ferme si le périphérique change en cours de session.
func capture() {}
```

## 4. Les interdits, tous outillés

| Motif                           | Pourquoi                        |
| ------------------------------- | ------------------------------- |
| `⚠️⚠️`                          | Un piège se signale une fois    |
| Bandeaux `═══` et `────────`    | Ornement                        |
| `*(porteur…)*`                  | Datation de décision            |
| `*(décision 6)*`                | Renvoi à une décision numérotée |
| `P4-21` et autres campagnes     | Identifiant de campagne         |
| `2026-08-13`                    | Datation                        |
| Lignes entièrement en capitales | Ornement                        |

Le `⚠️` **simple** reste le marqueur de piège.

```bash
node scripts/check-comments.mjs <chemin>   # un fichier ou un dossier
node scripts/check-comments.mjs --selftest # éprouve les règles elles-mêmes
```

`npm run verify:docs` y ajoute la couverture Compodoc et un `cargo doc` qui dénie tout
avertissement.

⚠️ **Le seuil Compodoc se pose quelques points SOUS la mesure**, jamais dessus ni à sa valeur :
calé sur la mesure, il ne refuserait que ce qui a déjà régressé. Il est à 76 pour 82 mesurés.
