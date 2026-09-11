import { defineConfig } from 'vitest/config';

/**
 * Configuration Vitest **minimale**, branchée par `runnerConfig` dans `angular.json`. Elle ne
 * porte que le fournisseur de couverture ; inclusions, seuils et rapporteurs restent dans
 * `angular.json`, seule source de vérité.
 *
 * @remarks
 * ⚠️ **Ne pas revenir à `v8`** : le compilateur Angular émet dans chaque composant traduit un
 * bloc mort par construction (`if (false) { …goog.getMsg… }`), et l'instrumentation `v8` passe
 * avant son élimination. Mesuré : 23 fichiers sur 87 échouaient à un seuil de branches à 100 %,
 * entre 88,88 % et 97,72 %, sans qu'une ligne de notre code soit en cause. Istanbul ne la voit
 * pas, et le seuil devient atteignable sans aucune exclusion. Coût mesuré : nul.
 * ⚠️ L'équipe Angular ne soutient pas le contenu de ce fichier. Le risque est borné à un champ :
 * si le builder change, `verify:angular` échoue bruyamment.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
    },
  },
});
