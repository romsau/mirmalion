import { LANGUAGES } from './settings';
import { LANGUAGE_NAMES, interfaceLanguageOptions, languageCount, sortedByName } from './language';

describe('Modèle de langue', () => {
  it('nomme les six langues, et aucune en écriture native', () => {
    for (const language of LANGUAGES) {
      const name = LANGUAGE_NAMES[language];
      expect(name).toBeTruthy();
      // Un nom écrit hors de l'alphabet latin trahirait la règle : le nom s'écrit dans la
      // langue de l'interface, pas dans celle qu'il désigne.
      expect(name).toMatch(/^[\p{Script=Latin}\s'-]+$/u);
    }
  });

  it('range les langues par leur nom traduit, pas par leur code', () => {
    // Rangées par code, 'de' viendrait après 'en' ; par nom, Allemand précède Anglais.
    const labels = sortedByName(['en', 'de', 'fr']).map((option) => option.label);
    expect(labels).toEqual(['Allemand', 'Anglais', 'Français']);
  });

  it('ne range que ce qu’on lui donne, et rend une copie', () => {
    const source: readonly ('fr' | 'it')[] = ['it', 'fr'];
    const options = sortedByName(source);
    expect(options.map((option) => option.value)).toEqual(['fr', 'it']);
    expect(source).toEqual(['it', 'fr']);
  });

  describe('sélecteur de langue d’interface', () => {
    it('double chaque nom de son équivalent anglais', () => {
      const labels = interfaceLanguageOptions('fr').map((option) => option.label);
      expect(labels).toContain('Allemand (German)');
      expect(labels).toContain('Portugais (Portuguese)');
    });

    it('double AUSSI l’option « Anglais » quand l’interface est française', () => {
      // L'exception porte sur la langue d'interface courante, pas sur l'option anglaise.
      const anglais = interfaceLanguageOptions('fr').find((option) => option.value === 'en');
      expect(anglais?.label).toBe('Anglais (English)');
    });

    it('ne double rien quand l’interface est déjà en anglais', () => {
      // La parenthèse ne ferait que répéter le libellé.
      for (const option of interfaceLanguageOptions('en')) {
        expect(option.label).not.toContain('(');
      }
    });

    it('offre les six langues, rangées sur le nom de gauche', () => {
      const options = interfaceLanguageOptions('fr');
      expect(options).toHaveLength(LANGUAGES.length);
      // Allemand avant Anglais : le tri suit le nom d'interface, jamais la parenthèse.
      expect(options[0]?.value).toBe('de');
      expect(options[1]?.value).toBe('en');
    });

    it('lit la locale AFFICHÉE, région comprise', () => {
      // `LOCALE_ID` vaut « en-US » ou « fr-CA » aussi souvent que « en » : ne comparer que la
      // chaîne entière ferait réapparaître la parenthèse au milieu d'une interface anglaise.
      for (const option of interfaceLanguageOptions('en-US')) {
        expect(option.label).not.toContain('(');
      }
      expect(interfaceLanguageOptions('fr-CA')[0]?.label).toBe('Allemand (German)');
    });
  });

  describe('le compte de langues', () => {
    it('accorde au-delà de un', () => {
      expect(languageCount(3)).toBe('3 langues');
    });

    it('ne l’accorde pas à un', () => {
      expect(languageCount(1)).toBe('1 langue');
    });

    it('dit « Aucune » plutôt que « 0 langue »', () => {
      // Un compte nu à côté d'une liste vide se lit comme une donnée manquante ; le mot dit
      // que c'est un choix.
      expect(languageCount(0)).toBe('Aucune');
    });
  });
});
