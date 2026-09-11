import { Component, DestroyRef, Injector, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { Header, type ScreenId } from '../../shared/components/header/header';
import {
  UpdateModal,
  type UpdateAction,
  type UpdateModalData,
  type UpdateState,
} from '../../shared/components/update-modal/update-modal';
import { Permissions } from '../../core/services/permissions/permissions';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { Modal } from '../../core/services/modal/modal';
import type { ModalRef } from '../../core/services/modal/modal-ref';
import { LanguageAssets } from '../../core/services/language-assets/language-assets';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { installConfirmHeading } from '../../core/models/language';
import { PanelStore } from '../../core/store/panel/panel.store';
import { UpdateStore } from '../../core/store/update/update.store';
import { SystemBridge } from '../../core/services/bridge/system/system.bridge';

/**
 * La largeur de la modale de mise à jour, telle que la maquette la dessine (`.up-modal`).
 *
 * @remarks
 * ⚠️ Elle est ici et non dans la feuille du composant : c'est la BOÎTE qui la porte, et la
 * boîte appartient au service de modales. Le contenu ne connaît pas sa propre largeur.
 */
const UPDATE_MODAL_WIDTH = 460;

/** L'ordre du header, et la liste de référence des segments d'URL reconnus. */
const SCREENS: readonly ScreenId[] = ['dictee', 'direct', 'options'];

/**
 * Les écrans qui portent un panneau d'historique repliable — donc dont la largeur suit son état.
 *
 * @remarks
 * ⚠️ Une liste, et non des conditions cousues à la main : un écran à panneau s'ajoute ici, en un
 * mot. Nommer un écran en dur en avait déjà fait oublier un, qui s'ouvrait en 900 px avec une
 * moitié vide.
 */
const SCREENS_WITH_PANEL: readonly ScreenId[] = ['dictee', 'direct'];

/**
 * Le battement qui rappelle au magasin de mise à jour qu'il peut redemander.
 *
 * @remarks
 * ⚠️ Il n'est PAS l'intervalle entre deux contrôles — celui-là vit dans le magasin, qui compare
 * des horodatages. Cinq minutes, parce qu'un Mac qui dort et une fenêtre cachée étirent les
 * minuteurs sans prévenir : un battement court rattrape un réveil, un minuteur de six heures
 * réglé avant une nuit de sommeil, non.
 */
const UPDATE_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * L'écran désigné par une URL. Tout ce qui n'est pas un écran connu retombe sur l'accueil.
 *
 * @param url - L'URL courante, avec ou sans requête ni fragment.
 * @returns L'identifiant d'écran, qui est le premier segment de l'URL : une table de
 * correspondance en plus serait une deuxième vérité à tenir à jour.
 */
export function screenFromUrl(url: string): ScreenId {
  const segment = url.split(/[?#]/, 1)[0].split('/')[1];
  return SCREENS.find((screen) => screen === segment) ?? 'dictee';
}

/**
 * La coquille de la fenêtre principale : le header, et l'écran affiché sous lui. Déclarée
 * composant de route parente, elle n'est traversée par aucune fenêtre secondaire.
 *
 * @remarks
 * ⚠️ `Theme` n'est pas injecté ici mais dans `App` : les fenêtres secondaires ne passent pas par
 * la coquille et doivent être peintes elles aussi.
 * ⚠️ `UpdateStore` l'est ici et nulle part ailleurs : `providedIn: 'root'`, il n'est instancié
 * qu'à sa première injection — d'où un seul contrôle réseau et une seule barre de mise à jour.
 */
@Component({
  selector: 'app-window-shell',
  imports: [Header, RouterOutlet],
  templateUrl: './window-shell.html',
  styleUrl: './window-shell.scss',
})
export class WindowShell {
  private readonly router = inject(Router);
  private readonly panel = inject(PanelStore);
  private readonly system = inject(SystemBridge);
  private readonly update = inject(UpdateStore);
  private readonly snackbar = inject(Snackbar);
  private readonly permissions = inject(Permissions);
  private readonly assets = inject(LanguageAssets);
  private readonly settings = inject(SettingsStore);
  private readonly modal = inject(Modal);
  private readonly injector = inject(Injector);

  protected readonly banner = this.update.banner;
  protected readonly version = this.update.version;
  protected readonly percent = this.update.percent;

  /**
   * L'état que la modale affiche : le dernier que la coquille ait vu.
   *
   * @remarks
   * ⚠️ Il ne retombe jamais à `null`, contrairement à `banner()` : la modale se démonte un tour
   * après sa fermeture, et lire la source telle quelle lui ferait repasser une image par son
   * état de repli.
   */
  private readonly shown = signal<UpdateState>('available');

  /** La modale ouverte, ou `null`. C'est elle qui rend l'ouverture idempotente. */
  private updateModal: ModalRef<void> | null = null;

  protected readonly screen = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => screenFromUrl(event.urlAfterRedirects)),
    ),
    { initialValue: screenFromUrl(this.router.url) },
  );

  /**
   * La fenêtre est-elle étroite ?
   *
   * Dictée et Direct ont un panneau d'historique, replié par défaut, dont l'état ne survit pas à
   * la fermeture. Les Options sont larges : leur rail et leur panneau font deux colonnes.
   *
   * @remarks
   * ⚠️ La condition suit l'état réel du panneau : une fenêtre large sur un écran à une colonne
   * laisserait une moitié vide, une fenêtre étroite couperait le panneau déplié.
   */
  protected readonly compact = computed(
    () => SCREENS_WITH_PANEL.includes(this.screen()) && this.panel.collapsed(),
  );

  constructor() {
    // ⚠️ L'échec est absorbé ici, contrairement à la règle qui veut que toute erreur remonte en
    // snackbar : un redimensionnement raté est cosmétique — la fenêtre garde sa largeur et tout
    // reste utilisable. Le signaler ferait du bruit pour une gêne déjà sous les yeux.
    effect(() => {
      this.system.setWindowCompact(this.compact()).catch(() => undefined);
    });

    // ⚠️ Un échec de téléchargement ou d'installation se dit, un contrôle en échec se tait : la
    // règle vit dans `UpdateStore.error`, qui n'est rempli que par les deux premiers. La remise
    // à zéro est ce qui empêche de le redire à chaque cycle de détection.
    effect(() => {
      const failure = this.update.error();
      if (failure !== null) {
        this.snackbar.error(failure);
        this.update.clearError();
      }
    });

    // ⚠️ Le contrôle part de la construction de la coquille : la fenêtre principale peut être
    // fermée puis rouverte sans que l'application quitte, et c'est le moment où reproposer une
    // mise à jour a du sens — il y a quelqu'un pour la voir. Le store est idempotent.
    // ⚠️ **La modale de mise à jour s'ouvre ICI, et seulement ici.** Chaque fenêtre porte sa
    // propre instance d'Angular : l'ouvrir aussi depuis une fenêtre-document ferait autant de
    // contrôles réseau et autant de modales qu'il y a de fenêtres. C'est ce que
    // `capabilities/updates.json` verrouille côté Rust, en n'accordant les permissions qu'à
    // « main ».
    //
    // ⚠️ La référence retenue est ce qui rend l'effet idempotent : `banner()` change à chaque
    // étape — proposée, téléchargement, prête — et la modale doit les traverser sans se rouvrir.
    effect(() => {
      const state = this.banner();
      if (state === null) {
        this.updateModal?.close();
        return;
      }
      this.shown.set(state);
      if (this.updateModal === null) {
        this.openUpdateModal();
      }
    });

    void this.startupNotices();

    // ⚠️ Un battement, et non un contrôle : c'est le magasin qui décide s'il est temps. La
    // coquille ne sait pas au bout de combien de temps on redemande, et n'a pas à le savoir.
    const heartbeat = setInterval(() => void this.update.check(), UPDATE_HEARTBEAT_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(heartbeat));
  }

  /**
   * Explique une autorisation d'Accessibilité qui a disparu — jamais une qui n'a jamais existé.
   *
   * @remarks
   * ⚠️ Ne peut pas se déclencher au premier lancement : le message exige que l'autorisation ait
   * été accordée une fois, ce que l'onboarding est seul à obtenir. Il constate sans accuser, et
   * dit où rendre l'autorisation plutôt que ce qui l'a retirée — nous ne le savons pas.
   * ⚠️ Une lecture en échec se tait, comme le contrôle de mise à jour : ne pas savoir n'est pas
   * une nouvelle à annoncer, et ce serait le premier mot de l'application au démarrage.
   */
  private async tellIfAccessibilityVanished(): Promise<void> {
    const status = await this.permissions.refresh().catch(() => null);
    if (status !== null && this.permissions.accessibilityLost()) {
      this.snackbar.info(
        $localize`:@@permissions.accessibility.lost:Mirmalion n'a plus l'autorisation d'Accessibilité : le raccourci de dictée ne répond plus. Elle se rétablit dans Réglages Système ▸ Confidentialité et sécurité ▸ Accessibilité.`,
      );
    }
  }

  /**
   * Les avis du lancement, **dans l'ordre et jamais en parallèle**.
   *
   * @remarks
   * ⚠️ La mise à jour passe devant, toujours. Laissés côte à côte, les deux avis s'ouvraient
   * dans l'ordre de leur latence : le contrôle des langues est local et répond tout de suite,
   * celui des mises à jour passe par le réseau, et la langue arrivait donc la première.
   * ⚠️ Conséquence assumée : une modale de mise à jour laissée sans réponse retient l'avis de
   * langue pour toute la session. Il revient au lancement suivant.
   */
  private async startupNotices(): Promise<void> {
    await this.tellIfAccessibilityVanished();
    // ⚠️ Sans garde : `UpdateStore.check` avale hors-ligne, serveur muet et manifeste illisible
    // — il ne rejette jamais. Un `catch` ici serait du code que rien ne peut atteindre.
    await this.update.check();
    await this.noUpdatePending();
    await this.offerToReinstallAVanishedLanguage();
  }

  /**
   * Se résout dès que plus aucune mise à jour n'attend de réponse.
   *
   * @remarks
   * ⚠️ Sans mise à jour, l'effet voit `null` à son premier tour et rend la main tout de suite :
   * l'attente ne coûte rien au cas courant.
   * ⚠️ « Redémarrer maintenant » ne la résout jamais, et c'est sans conséquence — le processus
   * s'en va avant que quiconque attende encore quelque chose.
   */
  private noUpdatePending(): Promise<void> {
    return new Promise((resolve) => {
      const watcher = effect(
        () => {
          if (this.banner() !== null) {
            return;
          }
          watcher.destroy();
          resolve();
        },
        { injector: this.injector },
      );
    });
  }

  /**
   * Propose de réinstaller une langue **choisie** dont le moteur n'a plus les ressources.
   *
   * @remarks
   * ⚠️ macOS reprend les modèles de transcription qu'il a donnés : une langue cochée la semaine
   * dernière peut avoir disparu ce matin, et l'apprendre en lançant une session la coûte.
   * ⚠️ Le téléchargement ne part pas d'ici : « Réinstaller » mène à l'écran des langues, qui
   * porte le seul chemin d'installation de l'application. Le réseau reste sur un geste.
   * ⚠️ Un moteur qui ne dit rien de ce qu'il a rend les six langues pour présentes : ne pas
   * savoir n'est pas une nouvelle, et ce serait le premier mot de l'application au démarrage.
   */
  private async offerToReinstallAVanishedLanguage(): Promise<void> {
    await this.settings.load();
    const installed = await this.assets.installedLanguages().catch(() => null);
    if (installed === null) {
      return;
    }
    const vanished = this.settings
      .settings()
      .spokenLanguages.find((chosen) => !installed.includes(chosen));
    if (vanished === undefined) {
      return;
    }

    const confirmed = await this.modal.confirm({
      heading: installConfirmHeading(vanished),
      message: $localize`:@@languages.vanished.message:macOS a retiré les ressources de transcription de cette langue, que Mirmalion avait installées. Tant qu'elles manquent, la dictée et les sessions dans cette langue ne peuvent pas transcrire.`,
      confirmLabel: $localize`:@@languages.vanished.reinstall:Réinstaller`,
      cancelLabel: $localize`:@@common.cancel:Annuler`,
    });
    if (confirmed) {
      await this.router.navigate(['/options', 'langues', 'parlees'], {
        queryParams: { installer: vanished },
      });
    }
  }

  /**
   * Ouvre la modale de mise à jour et retient sa référence.
   *
   * @remarks
   * ⚠️ `blocking` et non `dismissible` : les trois états portent chacun leur sortie — « Plus
   * tard », « Annuler » —, et un téléchargement escamoté par Échap continuerait sans rien qui
   * le montre, ni moyen d'y revenir. Même raison que la modale d'installation d'une langue.
   * ⚠️ `bare` : le contenu porte son propre message, et le titre passé ici ne sert qu'à nommer
   * la boîte pour un lecteur d'écran.
   */
  private openUpdateModal(): void {
    const data: UpdateModalData = {
      state: this.shown,
      version: this.version,
      percent: this.percent,
      action: (action) => this.applyUpdate(action),
    };
    this.updateModal = this.modal.open<void, UpdateModalData>(UpdateModal, {
      heading: $localize`:@@update.heading:Mise à jour`,
      data,
      bare: true,
      blocking: true,
      dismissible: false,
      width: UPDATE_MODAL_WIDTH,
    });
    void this.updateModal.closed.then(() => {
      this.updateModal = null;
    });
  }

  /** Va à l'écran demandé par le header. */
  protected go(screen: ScreenId): void {
    void this.router.navigate([screen]);
  }

  /**
   * Traduit l'intention de la barre de mise à jour en geste du store.
   *
   * @remarks
   * ⚠️ « Plus tard » et « Annuler » mènent au même endroit, et ce n'est pas un raccourci :
   * renoncer avant le téléchargement, pendant, ou une fois prêt revient chaque fois à ne rien
   * installer et à ne plus rien afficher — voir `UpdateStore.dismiss`.
   */
  protected applyUpdate(action: UpdateAction): void {
    if (action === 'install') {
      void this.update.install();
    } else if (action === 'restart') {
      void this.update.restart();
    } else {
      void this.update.dismiss();
    }
  }
}
