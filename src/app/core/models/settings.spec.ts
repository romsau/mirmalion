import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LANGUAGES, sanitiseSettings, type AppSettings } from './settings';
import { ACCENT_IDS } from './accent-palette';

describe('DEFAULT_SETTINGS', () => {
  it('matches the defaults that were settled', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'light',
      accentLight: 'klein',
      accentDark: 'magenta',
      interfaceLanguage: 'en',
      dictationLanguage: 'en',
      spokenLanguages: ['en'],
      translationLanguages: [],
      microphoneId: null,
      liveIncludeMicrophone: true,
      liveLanguage: 'en',
      liveReportType: 'none',
      liveReportPromptId: null,
      liveOverlayVisible: true,
      liveTranslationTarget: 'none',
      dictationMode: 'hold',
      rephrasingMode: 'none',
      translationTarget: 'none',
      dictationRetention: 200,
      liveRetention: '6m',
      soundsEnabled: true,
      showInDock: true,
      onboardingCompleted: false,
      accessibilityGranted: false,
    } satisfies AppSettings);
  });

  it('falls back to English, never to the language of whoever wrote the app', () => {
    expect(DEFAULT_SETTINGS.interfaceLanguage).toBe('en');
    expect(DEFAULT_SETTINGS.dictationLanguage).toBe('en');
  });

  it('carries nothing that would be sensitive in a plaintext file', () => {
    const suspicious = /text|transcript|summary|token|secret|key|embedding|password/i;
    const leaks = Object.keys(DEFAULT_SETTINGS).filter((key) => suspicious.test(key));
    expect(leaks).toEqual([]);
  });

  it('covers the six languages the app handles end to end', () => {
    expect([...LANGUAGES]).toEqual(['fr', 'en', 'es', 'de', 'it', 'pt']);
  });
});

describe('sanitiseSettings', () => {
  it('returns the defaults for anything that is not an object', () => {
    expect(sanitiseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitiseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitiseSettings('cassé')).toEqual(DEFAULT_SETTINGS);
    expect(sanitiseSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns the defaults for an empty store', () => {
    expect(sanitiseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps every valid stored value', () => {
    const stored: AppSettings = {
      theme: 'dark',
      accentLight: 'rose',
      accentDark: 'teal',
      interfaceLanguage: 'it',
      dictationLanguage: 'es',
      spokenLanguages: ['es', 'fr'],
      translationLanguages: ['de'],
      microphoneId: 'micro-usb-1',
      liveIncludeMicrophone: false,
      liveLanguage: 'fr',
      liveReportType: 'client',
      liveReportPromptId: 7,
      liveOverlayVisible: false,
      liveTranslationTarget: 'de',
      dictationMode: 'toggle',
      rephrasingMode: 'professional',
      translationTarget: 'de',
      dictationRetention: 500,
      liveRetention: '1y',
      soundsEnabled: false,
      showInDock: true,
      onboardingCompleted: true,
      accessibilityGranted: true,
    };
    expect(sanitiseSettings(stored)).toEqual(stored);
  });

  /**
   * ⚠️⚠️ **UNE CIBLE DE TRADUCTION QU'ON VIENT D'ÉTEINDRE NE SURVIT PAS À LA RELECTURE**, et
   * c'est la même garde que pour la dictée : le formulaire du Direct afficherait une valeur que
   * son propre menu ne propose plus, et l'utilisateur ne pourrait plus la re-choisir. On retombe
   * sur « pas de traduction », toujours valide.
   */
  it('drops a live translation target that is no longer enabled', () => {
    expect(
      sanitiseSettings({ translationLanguages: ['it'], liveTranslationTarget: 'de' })
        .liveTranslationTarget,
    ).toBe('none');
    expect(
      sanitiseSettings({ translationLanguages: ['it'], liveTranslationTarget: 'it' })
        .liveTranslationTarget,
    ).toBe('it');
  });

  /**
   * ⚠️ **La langue parlée du Direct est la sienne**, `liveLanguage`, et non celle de la dictée :
   * on peut dicter en français pendant qu'une session tourne en anglais. Comparer à
   * `dictationLanguage` retirerait la mauvaise cible sur cet écran-là.
   */
  it('drops a live translation target that is the spoken language of the session', () => {
    const sanitised = sanitiseSettings({
      spokenLanguages: ['fr', 'en'],
      dictationLanguage: 'fr',
      liveLanguage: 'en',
      translationLanguages: ['fr', 'en'],
      liveTranslationTarget: 'en',
      translationTarget: 'en',
    });
    expect(sanitised.liveTranslationTarget).toBe('none');
    expect(sanitised.translationTarget).toBe('en');
  });

  /**
   * ⚠️ **« Ne pas inclure de micro » doit survivre à la relecture.** `'none'` n'est pas un
   * identifiant de périphérique : c'est une valeur du produit. La ramener à `null` ferait
   * réapparaître le micro dans chaque session, sans que rien ne l'explique.
   */
  it('keeps the no-microphone choice, which is a value and not a device', () => {
    expect(sanitiseSettings({ liveIncludeMicrophone: false }).liveIncludeMicrophone).toBe(false);
    // ⚠️ **Le défaut est `true` sur une valeur illisible**, jamais `false` : le contraire
    // enregistrerait une session entière sans la voix de l'utilisateur, sans rien dire.
    expect(sanitiseSettings({ liveIncludeMicrophone: 42 }).liveIncludeMicrophone).toBe(true);
    expect(sanitiseSettings({}).liveIncludeMicrophone).toBe(true);
  });

  /**
   * Même garde que pour la dictée : afficher une langue que le menu de l'écran ne propose pas
   * donne un champ dont la valeur ne peut pas être re-choisie.
   */
  it('pulls the live language back into the enabled languages', () => {
    const sanitised = sanitiseSettings({
      spokenLanguages: ['de', 'it'],
      liveLanguage: 'pt',
    });
    expect(sanitised.liveLanguage).toBe('de');

    const kept = sanitiseSettings({ spokenLanguages: ['de', 'it'], liveLanguage: 'it' });
    expect(kept.liveLanguage).toBe('it');
  });

  /**
   * ⚠️ **Les sons sont réglés PAR DOMAINE** (porteur, 2026-07-30) : couper le bip d'une dictée
   * qu'on déclenche vingt fois par jour n'implique pas de couper celui d'une session, qui arrive
   * une fois. Les deux drapeaux sont donc indépendants.
   */
  /**
   * ⚠️⚠️ **UN SEUL RÉGLAGE DE SONS, DEPUIS LE 2026-08-06** *(porteur)*. Il y en avait deux —
   * dictée et Direct —, chacun seul dans sa famille de réglages. Ce test gardait leur
   * indépendance ; il garde désormais l'inverse : **le défaut est `true`**, et une valeur
   * illisible n'éteint pas les sons en silence.
   */
  it('keeps the sounds on unless they are explicitly turned off', () => {
    expect(sanitiseSettings({}).soundsEnabled).toBe(true);
    expect(sanitiseSettings({ soundsEnabled: 'non' }).soundsEnabled).toBe(true);
    expect(sanitiseSettings({ soundsEnabled: false }).soundsEnabled).toBe(false);
  });

  /**
   * ⚠️⚠️ **LE REPLI EST « PAS DE COMPTE RENDU », ET C'EST LA DÉCISION 8** *(porteur,
   * 2026-08-06)*. Il valait `'team'` avant : l'arrêt d'une session ne génère rien, et un type
   * pré-choisi laisserait croire qu'il sera produit.
   */
  it('falls back to no report at all for anything unknown', () => {
    expect(sanitiseSettings({ liveReportType: 'poème' }).liveReportType).toBe('none');
    expect(sanitiseSettings({ liveReportType: 'custom' }).liveReportType).toBe('custom');
  });

  it('retient le prompt choisi à côté du type, et non à sa place', () => {
    // ⚠️ Deux champs : `liveReportType` garde sa liste close, `liveReportPromptId` dit LEQUEL.
    // Les fondre en `custom:<id>` casserait la validation par liste.
    const settings = sanitiseSettings({ liveReportType: 'custom', liveReportPromptId: 7 });
    expect(settings.liveReportType).toBe('custom');
    expect(settings.liveReportPromptId).toBe(7);
  });

  it('refuse tout ce qui n’est pas un entier positif', () => {
    for (const value of ['7', 0, -1, 1.5, null, undefined, {}, Number.NaN]) {
      expect(sanitiseSettings({ liveReportPromptId: value }).liveReportPromptId).toBeNull();
    }
  });

  it('vaut null par défaut', () => {
    expect(DEFAULT_SETTINGS.liveReportPromptId).toBeNull();
  });

  /**
   * ⚠️⚠️ **L'INDICATEUR RESTE VISIBLE SUR UNE VALEUR ILLISIBLE**, jamais l'inverse. Un fichier
   * tronqué ne doit pas laisser un enregistrement tourner sans le moindre repère à l'écran :
   * c'est ainsi qu'on laisse un micro ouvert trois heures.
   */
  it('keeps the live indicator visible unless it is explicitly turned off', () => {
    expect(sanitiseSettings({}).liveOverlayVisible).toBe(true);
    expect(sanitiseSettings({ liveOverlayVisible: 'non' }).liveOverlayVisible).toBe(true);
    expect(sanitiseSettings({ liveOverlayVisible: false }).liveOverlayVisible).toBe(false);
  });

  it('replaces only the fields that are invalid, never the whole file', () => {
    const sanitised = sanitiseSettings({
      theme: 'fluorescent',
      interfaceLanguage: 'it',
      dictationRetention: 999,
      soundsEnabled: 'oui',
      onboardingCompleted: true,
    });

    expect(sanitised.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(sanitised.dictationRetention).toBe(DEFAULT_SETTINGS.dictationRetention);
    expect(sanitised.soundsEnabled).toBe(DEFAULT_SETTINGS.soundsEnabled);
    // Les champs valides autour ont survécu.
    expect(sanitised.interfaceLanguage).toBe('it');
    expect(sanitised.onboardingCompleted).toBe(true);
  });

  it('accepts a microphone identifier only when it is a string', () => {
    expect(sanitiseSettings({ microphoneId: 'abc' }).microphoneId).toBe('abc');
    expect(sanitiseSettings({ microphoneId: 12 }).microphoneId).toBeNull();
    expect(sanitiseSettings({ microphoneId: null }).microphoneId).toBeNull();
  });

  // ⚠️ Le drapeau éprouvé ici doit avoir `false` pour défaut, sans quoi le test ne prouve plus
  // rien : sur un drapeau vrai par défaut, « refusé » et « accepté » rendent la même valeur.
  it('refuses a truthy non-boolean for a flag', () => {
    expect(sanitiseSettings({ soundsEnabled: 1 }).soundsEnabled).toBe(true);
    expect(sanitiseSettings({ accessibilityGranted: 'oui' }).accessibilityGranted).toBe(false);
  });

  it('accepts only the sixteen known accent tints, one per theme', () => {
    expect([...ACCENT_IDS]).toHaveLength(16);
    // Un identifiant inconnu — teinte retirée d'une version à l'autre, fichier édité à la
    // main — retombe sur le défaut du thème concerné, sans emporter l'autre.
    const sanitised = sanitiseSettings({ accentLight: 'chartreuse', accentDark: 'olive' });
    expect(sanitised.accentLight).toBe(DEFAULT_SETTINGS.accentLight);
    expect(sanitised.accentDark).toBe('olive');
  });

  it('ignores keys a future version of the app might have written', () => {
    const sanitised = sanitiseSettings({ theme: 'dark', futureSetting: 'inconnu' });
    expect(sanitised).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
    expect('futureSetting' in sanitised).toBe(false);
  });

  describe('les listes de langues activées', () => {
    it('refuse tout ce qui n’est pas un tableau, sans emporter le reste', () => {
      const sanitised = sanitiseSettings({
        spokenLanguages: 'fr,en',
        translationLanguages: { 0: 'it' },
        interfaceLanguage: 'it',
      });
      // La liste parlée ne peut pas être vide : elle retombe sur la langue de dictée.
      expect(sanitised.spokenLanguages).toEqual([DEFAULT_SETTINGS.dictationLanguage]);
      expect(sanitised.translationLanguages).toEqual([]);
      expect(sanitised.interfaceLanguage).toBe('it');
    });

    it('écarte les codes inconnus un par un, jamais la liste entière', () => {
      const sanitised = sanitiseSettings({
        spokenLanguages: ['fr', 'klingon', 'it', 42, null],
        translationLanguages: ['en', 'nl'],
      });
      expect(sanitised.spokenLanguages).toEqual(['fr', 'it']);
      expect(sanitised.translationLanguages).toEqual(['en']);
    });

    it('écrase les doublons, qu’un fichier édité à la main peut contenir', () => {
      expect(
        sanitiseSettings({ spokenLanguages: ['fr', 'fr', 'en', 'fr'] }).spokenLanguages,
      ).toEqual(['fr', 'en']);
    });

    it('conserve l’ordre enregistré, sans le trier', () => {
      // Le tri dépend de la langue d'interface : le figer ici serait juste dans une langue et
      // faux dans les cinq autres.
      expect(sanitiseSettings({ spokenLanguages: ['it', 'de', 'fr'] }).spokenLanguages).toEqual([
        'it',
        'de',
        'fr',
      ]);
    });

    /** La migration : un fichier écrit avant l'existence de ces listes. */
    it('reprend la langue de dictée déjà enregistrée quand aucune liste n’existe', () => {
      const sanitised = sanitiseSettings({ dictationLanguage: 'pt', theme: 'dark' });
      expect(sanitised.spokenLanguages).toEqual(['pt']);
      expect(sanitised.dictationLanguage).toBe('pt');
      // Rien d'autre n'a bougé : la migration n'est pas une réinitialisation.
      expect(sanitised.theme).toBe('dark');
    });

    it('ne laisse jamais la liste parlée vide, même écrite vide', () => {
      expect(
        sanitiseSettings({ spokenLanguages: [], dictationLanguage: 'it' }).spokenLanguages,
      ).toEqual(['it']);
    });

    it('ramène la langue de dictée dans la liste quand elle n’y est plus', () => {
      // Ce qui arrive en éteignant, dans les Options, la langue qu'on utilisait.
      const sanitised = sanitiseSettings({
        spokenLanguages: ['it', 'pt'],
        dictationLanguage: 'fr',
      });
      expect(sanitised.dictationLanguage).toBe('it');
    });

    it('ramène la traduction à « aucune » quand sa cible n’est plus activée', () => {
      expect(
        sanitiseSettings({ translationLanguages: ['it'], translationTarget: 'de' })
          .translationTarget,
      ).toBe('none');
      // Une cible bien activée survit, et « none » est toujours valide.
      expect(
        sanitiseSettings({ translationLanguages: ['de'], translationTarget: 'de' })
          .translationTarget,
      ).toBe('de');
      expect(
        sanitiseSettings({ translationLanguages: [], translationTarget: 'none' }).translationTarget,
      ).toBe('none');
    });

    it('ramène la traduction à « aucune » quand sa cible est la langue parlée', () => {
      expect(
        sanitiseSettings({
          spokenLanguages: ['fr'],
          dictationLanguage: 'fr',
          translationLanguages: ['fr', 'en'],
          translationTarget: 'fr',
        }).translationTarget,
      ).toBe('none');
    });

    /**
     * ⚠️ La cible se juge sur la langue **corrigée**, pas sur celle du fichier : `it` n'est plus
     * parlée, la dictée retombe donc sur `fr`, et c'est à ce `fr`-là que la cible se compare.
     * Comparer à la valeur lue laisserait passer « traduire le français en français ».
     */
    it('compare la cible à la langue de dictée déjà rabattue, pas à celle du fichier', () => {
      expect(
        sanitiseSettings({
          spokenLanguages: ['fr'],
          dictationLanguage: 'it',
          translationLanguages: ['fr'],
          translationTarget: 'fr',
        }).translationTarget,
      ).toBe('none');
    });
  });
});
