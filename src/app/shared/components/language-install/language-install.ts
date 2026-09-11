import { Component, computed, inject, type Signal } from '@angular/core';
import { Button } from '../button/button';
import { ProgressBar } from '../progress-bar/progress-bar';
import { MODAL_DATA, ModalRef } from '../../../core/services/modal/modal-ref';
import { installConfirmHeading, installProgressLabel } from '../../../core/models/language';
import type { Language } from '../../../core/models/settings';

/** Ce que l'appelant fournit à la modale d'installation. */
export interface LanguageInstallData {
  /**
   * La langue à installer.
   *
   * @remarks
   * ⚠️ Le code, et non un nom déjà accordé : « Installer la langue portugaise » accorde un
   * adjectif, qui ne se compose pas en collant un nom de langue à une phrase. La table accordée
   * vit dans `core/models/language.ts`, avec la phrase elle-même.
   */
  readonly language: Language;
  /**
   * L'avancement du téléchargement, `null` tant que rien n'a été demandé.
   *
   * @remarks
   * ⚠️ `null` et `0` ne disent pas la même chose : `null`, c'est « on n'a pas encore demandé » ;
   * `0`, « le téléchargement a commencé et n'a rien reçu ». Les confondre ramènerait la question
   * au premier octet.
   */
  readonly progress: Signal<number | null>;
  /**
   * Le téléchargement tourne sans avoir encore rendu de pourcentage : la barre est alors
   * indéterminée.
   *
   * @remarks
   * ⚠️ Sans elle, une reprise après réouverture de la fenêtre afficherait un 0 % que personne
   * n'a mesuré.
   */
  readonly indeterminate: Signal<boolean>;
  /** Ce qu'on appelle quand l'utilisateur accepte le téléchargement. */
  readonly accept: () => void;
  /** Ce qu'on appelle quand il interrompt un téléchargement en cours. */
  readonly cancel: () => void;
}

/**
 * Les deux temps de l'installation d'une langue : demander, puis télécharger.
 *
 * Une seule modale pour les deux — seul le contenu change, la hauteur minimale est commune.
 * Elle ne télécharge rien et ne connaît ni le pont ni le store : elle affiche ce qu'on lui
 * donne et appelle ce qu'on lui passe.
 *
 * @remarks
 * ⚠️ Elle demande d'abord : choisir une langue dans un menu n'est pas demander plusieurs
 * centaines de mégaoctets, et rien ne part sans ce clic.
 */
@Component({
  selector: 'app-language-install',
  imports: [Button, ProgressBar],
  templateUrl: './language-install.html',
  styleUrl: './language-install.scss',
})
export class LanguageInstall {
  protected readonly data = inject(MODAL_DATA) as LanguageInstallData;
  private readonly ref = inject(ModalRef);

  /** Sommes-nous au second temps, celui du téléchargement ? */
  protected readonly downloading = computed(
    () => this.data.indeterminate() || this.data.progress() !== null,
  );

  /** La question posée au premier temps, avec la langue accordée. */
  protected readonly heading = installConfirmHeading(this.data.language);

  /** Ce que la barre annonce pendant le téléchargement. */
  protected readonly progressLabel = installProgressLabel([this.data.language]);

  /** Refuser ferme la modale sans rien engager — aucun octet n'a encore été demandé. */
  protected refuse(): void {
    this.ref.close();
  }
}
