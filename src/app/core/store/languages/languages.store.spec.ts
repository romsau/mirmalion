import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LanguagesStore } from './languages.store';
import { LanguageAssets } from '../../services/language-assets/language-assets';
import type { AssetInstallEvent } from '../../services/bridge/languages/languages.bridge';
import type { Language } from '../../models/settings';

/**
 * Monte le store sur une doublure du service. `emit` rejoue ce que le backend enverrait :
 * c'est le seul chemin qui fait avancer une barre, donc le seul qui vaille d'être simulé.
 */
function harness(overrides: Record<string, unknown> = {}) {
  let listener: ((event: AssetInstallEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const assets = {
    installedLanguages: vi.fn().mockResolvedValue(['fr'] as readonly Language[]),
    inFlight: vi.fn().mockResolvedValue(null),
    install: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    // Le quota de réservations : `maximum: 0` veut dire « hors contexte Tauri », donc aucun
    // plafond à faire respecter — c'est le défaut, et il laisse passer toutes les demandes.
    reservations: vi.fn().mockResolvedValue({ held: [], maximum: 0 }),
    release: vi.fn().mockResolvedValue(undefined),
    observe: vi.fn().mockImplementation((handler: (event: AssetInstallEvent) => void) => {
      listener = handler;
      return Promise.resolve(unsubscribe);
    }),
    ...overrides,
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: LanguageAssets, useValue: assets }],
  });
  const store = TestBed.inject(LanguagesStore);
  return {
    assets,
    store,
    unsubscribe,
    emit: (event: AssetInstallEvent) => listener?.(event),
  };
}

describe('LanguagesStore', () => {
  it('part vide plutôt qu’optimiste', () => {
    // `loaded` distingue « pas encore lu » de « rien d'installé » : afficher les six langues
    // comme présentes puis se raviser est pire que d'attendre.
    const { store } = harness();
    expect(store.installedLanguages()).toEqual([]);
    expect(store.loaded()).toBe(false);
    expect(store.installing()).toBe(false);
    // Rien en cours, rien en file : l'onboarding compte zéro et saute son étape d'installation.
    expect(store.remaining()).toBe(0);
  });

  it('lit les langues installées', async () => {
    const { store } = harness();
    await store.load();
    expect(store.installedLanguages()).toEqual(['fr']);
    expect(store.loaded()).toBe(true);
  });

  it('reprend un téléchargement retrouvé en vol, sans pourcentage', async () => {
    // La fenêtre peut être fermée puis rouverte pendant l'installation. Le pourcentage
    // n'est pas connu : le prochain évènement le donnera.
    const { store } = harness({ inFlight: vi.fn().mockResolvedValue('it') });
    await store.load();
    expect(store.install()).toEqual({ language: 'it', progress: null });
    expect(store.installing()).toBe(true);
  });

  it('reste utilisable quand le backend est muet', async () => {
    const { store } = harness({
      installedLanguages: vi.fn().mockRejectedValue(new Error('pas de moteur')),
    });
    await store.load();
    expect(store.loaded()).toBe(true);
    expect(store.error()).not.toBeNull();
  });

  describe('la file', () => {
    it('démarre la première demande tout de suite', async () => {
      const { store, assets } = harness();
      await store.requestInstall('it');
      expect(assets.install).toHaveBeenCalledWith('it');
      expect(store.install()).toEqual({ language: 'it', progress: null });
      expect(store.queue()).toEqual([]);
    });

    it('met les suivantes en attente — l’installeur natif n’en traite qu’une', async () => {
      const { store, assets } = harness();
      await store.requestInstall('it');
      await store.requestInstall('pt');
      await store.requestInstall('es');
      expect(assets.install).toHaveBeenCalledTimes(1);
      expect(store.queue()).toEqual(['pt', 'es']);
      expect(store.remaining()).toBe(3);
    });

    it('enchaîne la suivante à la fin de la précédente', async () => {
      const { store, assets, emit } = harness();
      await store.watch();
      await store.requestInstall('it');
      await store.requestInstall('pt');
      emit({ kind: 'installed', language: 'it' });
      await Promise.resolve();
      expect(store.installedLanguages()).toContain('it');
      expect(assets.install).toHaveBeenLastCalledWith('pt');
      expect(store.install()).toEqual({ language: 'pt', progress: null });
    });

    it('referme l’état quand la file est vide', async () => {
      const { store, emit } = harness();
      await store.watch();
      await store.requestInstall('it');
      emit({ kind: 'installed', language: 'it' });
      await Promise.resolve();
      expect(store.install()).toBeNull();
      expect(store.installing()).toBe(false);
    });

    it('ne redemande pas ce qui est déjà installé, en cours ou en file', async () => {
      const { store, assets } = harness();
      await store.load();
      await store.requestInstall('fr'); // déjà installée
      await store.requestInstall('it');
      await store.requestInstall('it'); // déjà en cours
      await store.requestInstall('pt');
      await store.requestInstall('pt'); // déjà en file
      expect(assets.install).toHaveBeenCalledTimes(1);
      expect(store.queue()).toEqual(['pt']);
    });

    it('un échec ne bloque pas les suivantes', async () => {
      // Une langue qui ne s'installe pas ne dit rien des autres : l'onboarding doit pouvoir
      // en réussir cinq sur six.
      const { store, assets, emit } = harness();
      await store.watch();
      await store.requestInstall('it');
      await store.requestInstall('pt');
      emit({ kind: 'failed', language: 'it', message: 'réseau' });
      await Promise.resolve();
      expect(store.error()).not.toBeNull();
      expect(assets.install).toHaveBeenLastCalledWith('pt');
    });

    it('un refus du natif au démarrage passe à la suivante', async () => {
      const install = vi
        .fn()
        .mockRejectedValueOnce(new Error('refus'))
        .mockResolvedValue(undefined);
      const { store, assets } = harness({ install });
      await store.requestInstall('it');
      await store.requestInstall('pt');
      expect(store.error()).not.toBeNull();
      expect(assets.install).toHaveBeenLastCalledWith('pt');
    });
  });

  describe('les évènements', () => {
    it('fait avancer la barre, en pourcentage entier', async () => {
      const { store, emit } = harness();
      await store.watch();
      await store.requestInstall('it');
      emit({ kind: 'progress', language: 'it', progress: 0.474 });
      expect(store.install()).toEqual({ language: 'it', progress: 47 });
    });

    it('ignore ce qui ne concerne pas le téléchargement affiché', async () => {
      // Sinon la barre sauterait d'une langue à l'autre.
      const { store, emit } = harness();
      await store.watch();
      await store.requestInstall('it');
      emit({ kind: 'progress', language: 'pt', progress: 0.9 });
      expect(store.install()).toEqual({ language: 'it', progress: null });
    });

    it('n’applique rien quand aucune installation ne tourne', async () => {
      const { store, emit } = harness();
      await store.watch();
      emit({ kind: 'installed', language: 'it' });
      expect(store.installedLanguages()).toEqual([]);
    });

    it('traite une annulation comme un abandon, jamais comme une erreur', async () => {
      // L'utilisateur a obtenu exactement ce qu'il demandait.
      const { store, emit } = harness();
      await store.watch();
      await store.requestInstall('it');
      emit({ kind: 'cancelled', language: 'it' });
      expect(store.install()).toBeNull();
      expect(store.error()).toBeNull();
    });
  });

  describe('l’annulation', () => {
    it('emporte la file avec elle', async () => {
      // « Annuler » est la seule sortie : laisser la suivante démarrer sous les yeux de qui
      // vient de dire non serait un défaut.
      const { store, assets } = harness();
      await store.requestInstall('it');
      await store.requestInstall('pt');
      await store.cancelInstall();
      expect(assets.cancel).toHaveBeenCalled();
      expect(store.queue()).toEqual([]);
    });

    it('referme l’état si le natif refuse d’annuler', async () => {
      const { store } = harness({ cancel: vi.fn().mockRejectedValue(new Error('bloqué')) });
      await store.requestInstall('it');
      await store.cancelInstall();
      expect(store.install()).toBeNull();
      expect(store.error()).not.toBeNull();
    });
  });

  describe('l’écoute', () => {
    it('ne s’abonne qu’une fois, quel que soit l’hôte qui appelle', async () => {
      const { store, assets } = harness();
      await store.watch();
      await store.watch();
      expect(assets.observe).toHaveBeenCalledTimes(1);
    });

    it('se laisse réessayer quand l’abonnement échoue', async () => {
      const observe = vi
        .fn()
        .mockRejectedValueOnce(new Error('pas de pont'))
        .mockResolvedValue(() => undefined);
      const { store } = harness({ observe });
      await store.watch();
      expect(store.error()).not.toBeNull();
      await store.watch();
      expect(observe).toHaveBeenCalledTimes(2);
    });
  });

  it('oublie une erreur une fois qu’elle a été dite', async () => {
    const { store } = harness({
      installedLanguages: vi.fn().mockRejectedValue(new Error('boum')),
    });
    await store.load();
    store.clearError();
    expect(store.error()).toBeNull();
  });

  /**
   * ⚠️⚠️ **« POUR EN AJOUTER UNE, EN RETIRER UNE »** *(porteur, 2026-08-01)*. Le plafond
   * d'`AssetInventory` est un plafond de langues **installées** et non de téléchargements
   * simultanés : libérer une réservation fait reclamer le pack par macOS. Ces quatre tests
   * tiennent la règle entière.
   */
  describe('quota de réservations', () => {
    it('libère la réservation d’une langue que l’utilisateur a ÉTEINTE', async () => {
      const { store, assets } = harness({
        reservations: vi.fn().mockResolvedValue({ held: ['es', 'pt'], maximum: 2 }),
      });

      await store.requestInstall('it');

      // `es` et `pt` occupent les deux créneaux ; aucune n'est activée (le défaut est `['en']`),
      // donc la première venue est sacrifiée et la demande passe.
      expect(assets.release).toHaveBeenCalledWith('es');
      expect(assets.install).toHaveBeenCalledWith('it');
      expect(store.quotaFull()).toBe(false);
    });

    /** Sacrifier une langue encore activée la ferait disparaître sans le dire. */
    it('refuse plutôt que de sacrifier une langue encore ACTIVÉE', async () => {
      const { store, assets } = harness({
        reservations: vi.fn().mockResolvedValue({ held: ['en'], maximum: 1 }),
      });

      await store.requestInstall('it');

      expect(assets.release).not.toHaveBeenCalled();
      expect(assets.install).not.toHaveBeenCalled();
      expect(store.quotaFull()).toBe(true);
      expect(store.reservationCeiling()).toBe(1);
    });

    /** Éteindre reste gratuit tant que la place ne manque pas : on ne libère rien d'avance. */
    it('ne libère RIEN tant que le plafond n’est pas atteint', async () => {
      const { store, assets } = harness({
        reservations: vi.fn().mockResolvedValue({ held: ['es'], maximum: 5 }),
      });

      await store.requestInstall('it');

      expect(assets.release).not.toHaveBeenCalled();
      expect(assets.install).toHaveBeenCalledWith('it');
    });

    /** Une langue déjà réservée n'a besoin d'aucun créneau : le plafond ne la concerne pas. */
    it('n’exige pas de créneau pour une langue déjà réservée', async () => {
      const { store, assets } = harness({
        installedLanguages: vi.fn().mockResolvedValue([] as readonly Language[]),
        reservations: vi.fn().mockResolvedValue({ held: ['it', 'en'], maximum: 2 }),
      });

      await store.requestInstall('it');

      expect(assets.release).not.toHaveBeenCalled();
      expect(assets.install).toHaveBeenCalledWith('it');
    });

    /**
     * ⚠️ **La langue libérée quitte AUSSI la liste des installées**, et sans attendre une
     * relecture : son pack vient d'être reclamé par macOS. L'y laisser afficherait comme prête
     * une langue que la dictée refuserait — exactement le défaut qu'on vient de corriger ailleurs.
     */
    it('retire de la liste des installées la langue qu’elle vient de sacrifier', async () => {
      const { store, assets } = harness({
        installedLanguages: vi.fn().mockResolvedValue(['fr', 'es'] as readonly Language[]),
        reservations: vi.fn().mockResolvedValue({ held: ['es'], maximum: 1 }),
      });
      await store.load();
      expect(store.installedLanguages()).toContain('es');

      await store.requestInstall('it');

      expect(assets.release).toHaveBeenCalledWith('es');
      expect(store.installedLanguages()).toEqual(['fr']);
    });

    /**
     * ⚠️⚠️ **LE CAS DE L'ONBOARDING, ET IL AURAIT MANGÉ SES PROPRES LANGUES.** Au premier
     * lancement, les langues choisies ne sont écrites dans les réglages qu'à la **sortie** de
     * l'étape : pendant l'installation, aucune n'est « activée ». Sans la protection de la série
     * en cours, la deuxième demande aurait libéré la première pour se faire de la place, et ainsi
     * de suite — une file qui se dévore elle-même, sans que rien ne le signale.
     */
    it('ne sacrifie pas une langue que la MÊME série vient de demander', async () => {
      const { store, assets } = harness({
        // Une seule place, et rien d'activé : sans la protection, `es` serait sacrifiée.
        reservations: vi.fn().mockResolvedValue({ held: ['es'], maximum: 1 }),
      });

      await store.requestInstall('es');
      await store.requestInstall('it');

      expect(assets.release).not.toHaveBeenCalled();
      expect(store.quotaFull()).toBe(true);
    });

    /** La protection ne vaut que pour la série : une fois la file vide, les réglages prennent
     * le relais et une langue non activée redevient sacrifiable. */
    it('cesse de protéger une série terminée', async () => {
      const { store, assets, emit } = harness({
        reservations: vi.fn().mockResolvedValue({ held: ['es'], maximum: 1 }),
      });
      // `watch` pose l'abonnement : sans lui, `emit` ne réveille personne.
      await store.watch();

      await store.requestInstall('es');
      emit({ kind: 'installed', language: 'es' });
      await Promise.resolve();

      await store.requestInstall('it');

      expect(assets.release).toHaveBeenCalledWith('es');
    });

    /**
     * ⚠️ **La ceinture, en plus des bretelles.** `freeSlotFor` évite d'ordinaire d'atteindre le
     * refus, mais l'état du quota peut avoir changé sous nos pieds — et rien ne garantit que tout
     * appelant passe par le magasin. Le natif rend alors un `kind` **typé** plutôt qu'un message
     * d'Apple en anglais, et on retombe sur le même état, donc sur le même texte localisé.
     */
    it('retombe sur le même refus quand c’est le NATIF qui dit non', async () => {
      const { store, emit } = harness();
      await store.watch();
      await store.requestInstall('it');

      emit({ kind: 'full', language: 'it' });

      expect(store.quotaFull()).toBe(true);
      // La file avance : une langue refusée ne dit rien des suivantes.
      expect(store.install()).toBeNull();
    });

    it('oublie le refus une fois qu’il a été dit', async () => {
      const { store } = harness({
        reservations: vi.fn().mockResolvedValue({ held: ['en'], maximum: 1 }),
      });

      await store.requestInstall('it');
      expect(store.quotaFull()).toBe(true);

      store.clearQuotaFull();
      expect(store.quotaFull()).toBe(false);
    });
  });

  /**
   * ⚠️⚠️ **LE DÉFAUT DU 2026-08-02, ET SA VRAIE LEÇON.** `requestInstall` laissait échapper le
   * moindre rejet de ses dépendances. Or ses **deux** hôtes l'appellent en `void requestInstall(…)`
   * — ils n'ont rien à attendre : l'écran vit d'évènements. Un rejet ne produisait donc **rien** :
   * pas d'état, pas de snackbar, pas de ligne de journal. Cliquer « Installer » était sans effet
   * visible, et il a fallu remonter tout le chemin à la main pour trouver l'endroit exact.
   *
   * ⚠️ Ce qui a **réellement** levé ce jour-là : `get_locale_reservations` rendait une chaîne JSON
   * côté Rust pendant que le TypeScript la déclarait objet, si bien que `raw.reserved` valait
   * `undefined`. La cause est corrigée à la source — la commande rend une structure typée. Ces
   * tests-ci gardent la **conséquence**, qui est la partie durable : quelle que soit la dépendance
   * qui lèvera demain, elle deviendra un état visible et non un silence.
   */
  describe('un échec de dépendance', () => {
    it('ne rejette JAMAIS, il devient un état', async () => {
      const { store } = harness({
        reservations: vi.fn().mockRejectedValue(new Error('le pont a rendu autre chose')),
      });

      await expect(store.requestInstall('it')).resolves.toBeUndefined();
      expect(store.error()).not.toBeNull();
      // Rien n'a démarré : l'écran ne doit pas afficher une barre pour un travail inexistant.
      expect(store.install()).toBeNull();
    });

    it('vaut aussi pour la libération d’un créneau', async () => {
      const { store } = harness({
        reservations: vi.fn().mockResolvedValue({ held: ['es'], maximum: 1 }),
        release: vi.fn().mockRejectedValue(new Error('libération refusée')),
      });

      await expect(store.requestInstall('it')).resolves.toBeUndefined();
      expect(store.error()).not.toBeNull();
    });
  });
});
