import { Component, computed, input, output } from '@angular/core';
import { Button } from '../../../../shared/components/button/button';
import { Icon } from '../../../../shared/components/icon/icon';
import type { IconName } from '../../../../shared/components/icon/icons';

/**
 * Les trois autorisations que l'onboarding présente.
 *
 * @remarks
 * ⚠️ L'automatisation n'en fait pas partie : elle ne sert qu'au collage au curseur et se demande
 * au premier collage réel. La montrer ici ferait accorder une permission avant de savoir si elle
 * servira.
 */
export type PermissionKey = 'microphone' | 'accessibility' | 'audioCapture';

/**
 * Ce que l'utilisateur peut faire, ici et maintenant, pour une autorisation donnée.
 *
 * @remarks
 * ⚠️ Ce n'est pas l'état de l'autorisation mais le geste possible, et l'un ne se déduit pas de
 * l'autre : `notDetermined` ouvre un prompt pour le micro et aucun pour l'Accessibilité. Le
 * geste dépend du couple permission × état, que seul `OnboardingPermissions` résout.
 */
export type PermissionGesture =
  /** Accordée : il n'y a rien à faire, on le montre. */
  | 'granted'
  /** Un clic fait surgir le prompt macOS. Le micro et l'enregistrement audio. */
  | 'request'
  /** Un clic ouvre le volet des Réglages Système. Aucun prompt ne viendra. */
  | 'settings'
  /** Refusée. Aucune API ne peut la re-demander : cela se règle hors de l'application. */
  | 'blocked';

/** Une ligne de l'étape Autorisations, telle que l'étape la calcule. */
export interface PermissionEntry {
  readonly key: PermissionKey;
  readonly icon: IconName;
  readonly title: string;
  readonly description: string;
  readonly gesture: PermissionGesture;
  /** Ce qu'il faut expliquer en plus, ou `null` quand la description suffit. */
  readonly note: string | null;
  /** Un prompt système est en cours pour cette ligne : le bouton attend la réponse. */
  readonly busy: boolean;
}

/**
 * Une ligne de l'étape Autorisations : la permission, et ce qu'on peut en faire.
 *
 * Un seul libellé d'action pour les trois lignes — « Autoriser » —, que le clic ouvre un prompt
 * macOS ou le volet des Réglages Système : le verbe annonce une intention, pas une modalité. Le
 * bouton est `Button`, sans motif propre.
 *
 * @remarks
 * ⚠️ Elle n'interprète aucun état : elle reçoit un {@link PermissionGesture} déjà résolu. Le
 * résoudre ici demanderait de savoir de quelle permission il s'agit, et une ligne qui l'ignore
 * finit par afficher un bouton dont le clic ne fait rien.
 */
@Component({
  selector: 'app-permission-row',
  imports: [Button, Icon],
  templateUrl: './permission-row.html',
  styleUrl: './permission-row.scss',
  host: {
    class: 'onb-item onb-perm',
  },
})
export class PermissionRow {
  /** Tout ce que la ligne affiche, déjà résolu par l'étape. */
  readonly row = input.required<PermissionEntry>();

  /** L'utilisateur a cliqué le bouton de cette ligne. L'étape décide de ce qu'il déclenche. */
  readonly act = output<PermissionKey>();

  /**
   * Le nom accessible du bouton — les trois lignes portant le même libellé visible, « Autoriser »
   * ne dit pas quoi hors contexte.
   *
   * @remarks
   * ⚠️ Il contient le libellé visible, comme l'exige WCAG 2.5.3 : il le complète, il ne le
   * remplace pas.
   */
  protected readonly buttonLabel = computed(
    () =>
      $localize`:@@onboarding.permissions.grant.aria:Autoriser : ${this.row().title}:PERMISSION:`,
  );
}
