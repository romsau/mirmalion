import { Component, computed, input, output } from '@angular/core';
import { Button } from '../../../../shared/components/button/button';
import {
  PermissionRow,
  type PermissionGesture,
  type PermissionKey,
  type PermissionEntry,
} from '../permission-row/permission-row';
import type {
  PermissionStatus,
  PermissionsStatus,
} from '../../../../core/services/bridge/permissions/permissions.bridge';

/** Ce qui ne dépend pas de l'état : l'icône et les deux textes de chaque ligne. */
interface PermissionCopy {
  readonly key: PermissionKey;
  readonly icon: PermissionEntry['icon'];
  readonly title: string;
  readonly description: string;
}

/**
 * Les trois autorisations, dans l'ordre de la maquette, avec leur libellé mot pour mot.
 *
 * @remarks
 * ⚠️ Jamais le mot « écran » pour la troisième : l'enregistrement audio est une catégorie TCC
 * distincte de la capture d'écran, et l'écrire enverrait l'utilisateur dans le mauvais volet des
 * Réglages Système.
 */
const COPY: readonly PermissionCopy[] = [
  {
    key: 'microphone',
    icon: 'mic',
    title: $localize`:@@onboarding.permissions.microphone.title:Microphone`,
    description: $localize`:@@onboarding.permissions.microphone.desc:Capturer votre voix.`,
  },
  {
    key: 'accessibility',
    icon: 'keyboard',
    title: $localize`:@@onboarding.permissions.accessibility.title:Accessibilité`,
    description: $localize`:@@onboarding.permissions.accessibility.desc:Déclencher la dictée avec le raccourci et coller le texte.`,
  },
  {
    key: 'audioCapture',
    icon: 'screen',
    title: $localize`:@@onboarding.permissions.audio.title:Enregistrement de l'audio`,
    description: $localize`:@@onboarding.permissions.audio.desc:Capter le son de vos sessions.`,
  },
];

/**
 * Le geste possible pour une autorisation donnée, dans l'état où elle se trouve.
 *
 * @remarks
 * ⚠️ Elle prend la permission **et** l'état, jamais l'état seul : `notDetermined` fait partir un
 * prompt sur le micro et ouvre les Réglages Système sur l'Accessibilité, qui n'en a aucun ;
 * `denied` laisse un geste sur la seconde et plus aucun sur le premier. Pour l'enregistrement
 * audio, `unknown` vaut « Autoriser » — macOS n'a aucun préflight, on ne saura qu'en essayant.
 */
function gestureFor(key: PermissionKey, status: PermissionStatus): PermissionGesture {
  if (status === 'granted') {
    return 'granted';
  }
  if (key === 'accessibility') {
    return 'settings';
  }
  if (key === 'audioCapture') {
    return status === 'denied' ? 'blocked' : 'request';
  }
  return status === 'notDetermined' ? 'request' : 'blocked';
}

/**
 * Ce qu'il reste à expliquer une fois la description lue, ou `null` s'il n'y a rien à ajouter.
 *
 * @remarks
 * ⚠️ Une note n'apparaît que sur un refus : au premier lancement tout est `notDetermined`, et
 * commenter un état normal alourdirait trois lignes qui doivent se lire d'un coup d'œil. Rien
 * n'y parle donc de la signature de code, qui fait réapparaître l'Accessibilité comme non
 * accordée après une mise à jour — ce cas se traite là où il se produit, pas ici.
 */
function noteFor(key: PermissionKey, gesture: PermissionGesture): string | null {
  if (gesture !== 'blocked') {
    return null;
  }
  // ⚠️ Aucun nom de volet pour l'enregistrement audio : il n'a jamais été constaté sur une
  // machine, et l'inventer enverrait l'utilisateur au mauvais endroit. Le micro, lui, a un volet
  // dont le nom est connu.
  return key === 'microphone'
    ? $localize`:@@onboarding.permissions.microphone.note:Elle se rétablit dans Réglages Système ▸ Confidentialité et sécurité ▸ Microphone.`
    : $localize`:@@onboarding.permissions.blocked.note:Elle se rétablit dans les Réglages Système, à la section Confidentialité et sécurité.`;
}

/**
 * La seconde étape du premier lancement : les autorisations, une par une.
 *
 * Chaque ligne dit quoi et pourquoi avant tout appel système, puis montre son état ; le pied de
 * page re-scanne, l'Accessibilité et l'audio s'accordant hors de l'application.
 *
 * @remarks
 * - ⚠️ Ce composant n'appelle rien : il émet, la coquille agit. Aucun pop-up ne peut donc partir
 *   d'un rendu.
 * - ⚠️ « Continuer » ne se désactive jamais, pas même sans aucune autorisation accordée : ce
 *   sont les fonctions qui en dépendent qui s'éteignent, pas le parcours.
 */
@Component({
  selector: 'app-onboarding-permissions',
  imports: [Button, PermissionRow],
  templateUrl: './onboarding-permissions.html',
  styleUrl: './onboarding-permissions.scss',
})
export class OnboardingPermissions {
  /**
   * L'état des autorisations, ou `null` tant que rien n'a été lu — et hors contexte Tauri, où
   * il n'y a pas de TCC du tout. Un état absent est traité comme « jamais demandée » : c'est
   * le seul repli qui propose un geste utile plutôt qu'un verdict inventé.
   */
  readonly status = input<PermissionsStatus | null>(null);

  /** La ligne dont le prompt système est en cours, s'il y en a une. */
  readonly pending = input<PermissionKey | null>(null);

  /** Le bouton d'une ligne a été cliqué. */
  readonly act = output<PermissionKey>();

  /** « Revérifier » : re-scanner l'état des autorisations. */
  readonly recheck = output<void>();

  /** « Continuer » : marquer l'onboarding comme fait et ouvrir l'application. */
  readonly finish = output<void>();

  /** Les trois lignes prêtes à rendre : texte, geste possible, note et état d'attente. */
  protected readonly rows = computed<readonly PermissionEntry[]>(() => {
    const status = this.status();
    const pending = this.pending();
    return COPY.map((copy) => {
      const gesture = gestureFor(copy.key, status?.[copy.key].status ?? 'notDetermined');
      return {
        ...copy,
        gesture,
        note: noteFor(copy.key, gesture),
        busy: pending === copy.key,
      };
    });
  });
}
