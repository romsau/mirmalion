import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { LanguageAssets } from '../../services/language-assets/language-assets';
import { SettingsStore } from '../settings/settings.store';
import { toAppError, type AppError } from '../../models/app-error';
import type { Language } from '../../models/settings';
import type { AssetInstallEvent } from '../../services/bridge/languages/languages.bridge';

/** Un téléchargement de ressources en cours. */
export interface LanguageInstallState {
  /** La langue dont les ressources se téléchargent. */
  readonly language: Language;
  /**
   * De 0 à 100, ou `null` tant qu'aucun pourcentage n'est arrivé : la barre est alors
   * indéterminée.
   *
   * @remarks
   * ⚠️ `null` n'est pas 0 % : « on ne sait pas encore » et « rien n'est fait » se ressemblent
   * une seconde, puis divergent.
   */
  readonly progress: number | null;
}

/**
 * Ce que la machine sait des ressources de langue : lesquelles sont là, laquelle s'installe,
 * lesquelles attendent leur tour.
 *
 * @remarks
 * - ⚠️ La frontière avec {@link SettingsStore} est portante : ici les faits — langues installées,
 *   téléchargement en cours ; là-bas les choix de l'utilisateur. C'est leur écart qui déclenche
 *   une installation.
 * - ⚠️ Deux hôtes le partagent, Options ▸ Langues et l'onboarding : une installation survit à la
 *   fermeture d'une fenêtre, un état porté par un composant se perdrait aux deux endroits.
 */
interface LanguagesState {
  /**
   * Les langues utilisables, et non les langues couvertes.
   *
   * @remarks
   * ⚠️ Part vide, jamais « les six » : l'optimisme afficherait un écran normal puis ferait
   * surgir un manque une seconde plus tard. `loaded` distingue « pas encore lu » de « rien
   * d'installé », que cette liste seule confondrait.
   */
  readonly installedLanguages: readonly Language[];
  /**
   * Le quota de réservations est plein et rien ne peut être libéré : toutes les langues
   * réservées sont encore activées.
   *
   * @remarks
   * ⚠️ Un état à part et non une `error` : ce n'est pas une panne mais un arbitrage à proposer —
   * « pour en ajouter une, en retirer une ». Le confondre avec un échec afficherait un message
   * de dépannage là où il faut une consigne.
   */
  readonly quotaFull: boolean;
  /** Le plafond de la machine, relu en même temps que les réservations. `0` hors contexte Tauri. */
  readonly reservationCeiling: number;
  /**
   * Ce que l'utilisateur a demandé dans cette série, installé ou non.
   *
   * @remarks
   * ⚠️ Sans elle, l'onboarding se dévore lui-même : les langues choisies ne s'écrivent dans les
   * réglages qu'à la sortie de l'étape, si bien que « pour en ajouter une, en retirer une »
   * sacrifierait l'une de celles qu'on vient d'installer. Ce qui vient d'être demandé est donc
   * protégé au même titre que ce qui est activé.
   */
  readonly requested: readonly Language[];
  /** Le téléchargement en cours, `null` quand la machine est libre. */
  readonly install: LanguageInstallState | null;
  /**
   * Les langues qui attendent derrière celle qui s'installe.
   *
   * @remarks
   * ⚠️ L'installeur natif n'en traite qu'une à la fois : sans file, deux demandes rapprochées se
   * marcheraient dessus — l'onboarding en enchaîne jusqu'à six.
   */
  readonly queue: readonly Language[];
  /** La machine a-t-elle déjà été interrogée ? */
  readonly loaded: boolean;
  /** Le dernier échec, à dire dans une snackbar puis à oublier. */
  readonly error: AppError | null;
}

const initialState: LanguagesState = {
  installedLanguages: [],
  quotaFull: false,
  reservationCeiling: 0,
  requested: [],
  install: null,
  queue: [],
  loaded: false,
  error: null,
};

/** Les ressources de langue : ce qui est installé, ce qui s'installe, ce qui attend son tour. */
export const LanguagesStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ install, queue, installedLanguages }) => ({
    /** Un téléchargement occupe-t-il la machine ? Un seul à la fois. */
    installing: computed(() => install() !== null),
    /** Ce qui reste à faire, celle en cours comprise — ce que l'onboarding compte. */
    remaining: computed(() => (install() ? 1 : 0) + queue().length),
    /**
     * Les langues qu'un téléchargement concerne déjà — installées, en cours ou en file.
     *
     * @remarks
     * ⚠️ Sert à ne pas redemander deux fois la même : sans elle, deux clics rapprochés mettraient
     * une langue en file derrière elle-même.
     */
    claimed: computed(() => {
      const current = install();
      return [...installedLanguages(), ...queue(), ...(current ? [current.language] : [])];
    }),
  })),
  /**
   * Les méthodes du magasin, et les deux dépendances qu'elles se donnent.
   *
   * @remarks
   * ⚠️ {@link SettingsStore} est injecté ici — seule dépendance entre deux magasins du projet.
   * « Pour en ajouter une, en retirer une » exige de savoir quelles langues l'utilisateur a
   * activées, et cette vérité vit dans les réglages. Aucun cycle : les réglages ne connaissent
   * pas les langues.
   */
  withMethods((store, assets = inject(LanguageAssets), settings = inject(SettingsStore)) => {
    /**
     * S'assure qu'un créneau de réservation est libre pour `language`. Rend `false` quand il n'y
     * a rien à sacrifier — à l'appelant de le dire.
     *
     * @remarks
     * - ⚠️ Le plafond d'`AssetInventory` compte les langues installées, pas les téléchargements
     *   simultanés : libérer une réservation fait reclamer le pack par macOS. La couverture
     *   atteignable est donc « langues système + plafond ».
     * - ⚠️ Ne libère que ce que l'utilisateur a lui-même éteint, et seulement quand la place
     *   manque : toucher à une langue encore activée la ferait disparaître sans le dire.
     */
    const freeSlotFor = async (language: Language): Promise<boolean> => {
      const { held, maximum } = await assets.reservations();
      patchState(store, { reservationCeiling: maximum });
      // Déjà réservée, ou plafond non atteint : rien à faire. Un plafond nul vient d'un contexte
      // sans pont — on laisse alors passer, l'installation échouera d'elle-même.
      if (maximum === 0 || held.includes(language) || held.length < maximum) {
        return true;
      }
      // ⚠️ Deux protections, et la seconde n'est pas redondante : ce qui est activé dans les
      // réglages, et ce qui vient d'être demandé dans cette série — voir `requested`.
      const spoken = settings.settings().spokenLanguages;
      const requested = store.requested();
      const expendable = held.find(
        (candidate) => !spoken.includes(candidate) && !requested.includes(candidate),
      );
      if (expendable === undefined) {
        return false;
      }
      await assets.release(expendable);
      patchState(store, {
        installedLanguages: store.installedLanguages().filter((kept) => kept !== expendable),
      });
      return true;
    };

    /**
     * Prend la suivante de la file, ou referme l'état.
     *
     * @remarks
     * ⚠️ Un échec ne vide pas la file : une langue qui ne s'installe pas ne dit rien des autres,
     * et l'onboarding doit pouvoir en réussir cinq sur six.
     */
    const advance = async (): Promise<void> => {
      const [next, ...rest] = store.queue();
      if (next === undefined) {
        // La série est finie : ce qu'elle protégeait n'a plus à l'être, les réglages ayant pris
        // le relais. Voir `requested`.
        patchState(store, { install: null, requested: [] });
        return;
      }
      patchState(store, { install: { language: next, progress: null }, queue: rest });
      try {
        await assets.install(next);
      } catch (error) {
        patchState(store, { error: toAppError(error) });
        await advance();
      }
    };

    /**
     * Le corps de `requestInstall`, qui lui a le droit de lever.
     *
     * @remarks
     * ⚠️ Séparé de la méthode publique pour que celle-ci ne porte que sa garde d'échec : mêlées,
     * la garde se relit à chaque retouche de la règle et finit par sauter « le temps de
     * comprendre ».
     */
    const beginInstall = async (language: Language): Promise<void> => {
      // Déjà installée, déjà en cours, déjà en file : le second clic ne fait rien plutôt que
      // de mettre une langue en attente derrière elle-même.
      if (store.claimed().includes(language)) {
        return;
      }
      // ⚠️ Le créneau se libère avant de demander, jamais après l'échec : laisser l'installation
      // échouer remonterait un message d'Apple non localisé à qui lit dans six langues.
      // ⚠️ La langue est inscrite avant la libération : sans cela, une demande répétée pourrait
      // sacrifier ce qu'elle vient d'obtenir.
      patchState(store, { requested: [...store.requested(), language] });
      if (!(await freeSlotFor(language))) {
        patchState(store, { quotaFull: true });
        return;
      }
      // ⚠️ L'erreur n'est pas effacée ici : l'onboarding empile jusqu'à six demandes, et la
      // deuxième effacerait l'échec de la première avant que quiconque ait pu le dire. L'oubli
      // se demande — `clearError`.
      patchState(store, { queue: [...store.queue(), language], quotaFull: false });
      if (!store.install()) {
        await advance();
      }
    };

    /** Prend en compte un évènement du backend : le seul chemin qui fait avancer la barre. */
    const applyInstallEvent = (event: AssetInstallEvent): void => {
      const current = store.install();
      // Un évènement qui ne concerne pas le téléchargement affiché est ignoré : il n'y en a
      // qu'un à la fois, et lui obéir ferait sauter la barre d'une langue à l'autre.
      if (!current || current.language !== event.language) {
        return;
      }
      switch (event.kind) {
        case 'progress':
          patchState(store, {
            install: { language: current.language, progress: Math.round(event.progress * 100) },
          });
          return;
        case 'installed':
          patchState(store, {
            installedLanguages: [...store.installedLanguages(), current.language],
          });
          void advance();
          return;
        // ⚠️ Le natif a refusé faute de place. `freeSlotFor` l'évite d'ordinaire, mais l'état du
        // quota peut avoir changé sous nos pieds : on retombe sur le même message localisé
        // plutôt que sur une erreur d'Apple en anglais.
        case 'full':
          patchState(store, { quotaFull: true });
          void advance();
          return;
        case 'failed':
          patchState(store, { error: toAppError(event.message) });
          void advance();
          return;
        // Annulé : rien n'est installé, et ce n'est pas une erreur — l'utilisateur a obtenu ce
        // qu'il demandait. `cancelInstall` a déjà vidé la file : on ne relance pas ce qu'il
        // vient d'abandonner.
        case 'cancelled':
          patchState(store, { install: null });
      }
    };

    /**
     * L'écoute des évènements d'installation est-elle déjà branchée ?
     *
     * @remarks
     * ⚠️ On ne se désabonne jamais : un téléchargement continue quand l'écran qui l'a lancé se
     * ferme, cas nominal de l'onboarding. Un abonnement démonté avec son hôte perdrait la fin de
     * l'installation, et l'écran suivant montrerait une langue « en cours » qui ne bouge plus.
     */
    let watching = false;

    return {
      /**
       * Branche l'écoute des évènements d'installation. Idempotent : les deux hôtes l'appellent
       * sans avoir à savoir lequel est passé le premier.
       */
      async watch(): Promise<void> {
        if (watching) {
          return;
        }
        watching = true;
        try {
          await assets.observe(applyInstallEvent);
        } catch (error) {
          watching = false;
          patchState(store, { error: toAppError(error) });
        }
      },

      /**
       * Lit ce que la machine offre, et reprend un téléchargement déjà en cours.
       *
       * @remarks
       * - ⚠️ Ne rejette jamais : un backend muet laisse l'écran utilisable, sans rien promettre
       *   qu'on ne puisse tenir.
       * - ⚠️ Relire `installedLanguages` à chaque ouverture est le seul garde-fou contre une purge
       *   différée par macOS : une langue activée mais disparue se re-propose au téléchargement
       *   plutôt que de dicter dans le vide.
       */
      async load(): Promise<void> {
        try {
          const [installedLanguages, inFlight] = await Promise.all([
            assets.installedLanguages(),
            assets.inFlight(),
          ]);
          patchState(store, {
            installedLanguages,
            // Une installation retrouvée en vol n'a pas de pourcentage connu : le prochain
            // évènement le donnera.
            install: inFlight ? { language: inFlight, progress: null } : null,
            loaded: true,
          });
        } catch (error) {
          patchState(store, { loaded: true, error: toAppError(error) });
        }
      },

      /**
       * Demande les ressources d'une langue : elle démarre, ou elle prend la file.
       *
       * @remarks
       * - ⚠️ Opération réseau : sur un geste explicite uniquement, jamais au chargement d'un écran.
       * - ⚠️ Ne pas la nommer `install` : `withMethods` écraserait silencieusement le signal d'état
       *   homonyme, et `store.install()` rendrait une promesse au lieu du téléchargement en cours.
       *   Rien ne le signale à la compilation.
       */
      async requestInstall(language: Language): Promise<void> {
        try {
          await beginInstall(language);
        } catch (error) {
          // ⚠️ Cette méthode ne rejette jamais : les deux hôtes l'appellent en `void`, et une
          // promesse `void`-ée qui rejette disparaît sans laisser de trace — ni journal, ni état,
          // ni snackbar. L'exiger des appelants ne ferait que déplacer le silence à deux endroits :
          // l'échec devient un état ici, parce que c'est ici qu'on sait qu'il y en a un.
          patchState(store, { error: toAppError(error) });
        }
      },

      /**
       * Abandonne le téléchargement et tout ce qui attendait derrière.
       *
       * L'état se referme sur l'évènement d'annulation, pas ici : c'est le natif qui dit quand
       * il a réellement lâché prise.
       *
       * @remarks
       * ⚠️ La file part avec : « Annuler » est la seule sortie de l'écran d'installation, et
       * n'abandonner que la langue courante ferait démarrer la suivante sous les yeux de qui
       * vient de dire non.
       */
      async cancelInstall(): Promise<void> {
        patchState(store, { queue: [] });
        try {
          await assets.cancel();
        } catch (error) {
          patchState(store, { install: null, error: toAppError(error) });
        }
      },

      /** Oublie le refus de quota, une fois qu'il a été dit. */
      clearQuotaFull(): void {
        patchState(store, { quotaFull: false });
      },

      /** Oublie la dernière erreur, une fois qu'elle a été dite. */
      clearError(): void {
        patchState(store, { error: null });
      },
    };
  }),
);
