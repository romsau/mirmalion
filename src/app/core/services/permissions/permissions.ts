import { Service, computed, inject, signal } from '@angular/core';
import type { Permission, PermissionsStatus } from '../bridge/permissions/permissions.bridge';
import { SettingsStore } from '../../store/settings/settings.store';
import { PermissionsBridge } from '../bridge/permissions/permissions.bridge';
import { ShortcutBridge } from '../bridge/shortcut/shortcut.bridge';

/**
 * L'état des autorisations macOS, et les trois gestes qui permettent de les obtenir.
 *
 * L'état sort en signal de lecture seule : un magasin pourra se glisser derrière ce service
 * sans que ses appelants changent.
 *
 * @remarks
 * - ⚠️ Lire ne demande jamais rien : seuls les trois `request*` agissent, et au clic seul.
 * - ⚠️ L'état se périme de lui-même — l'Accessibilité et l'enregistrement audio s'accordent
 *   hors de l'application, sans rien pour prévenir. D'où {@link Permissions.refresh}.
 */
@Service()
export class Permissions {
  private readonly bridge = inject(PermissionsBridge);
  private readonly shortcut = inject(ShortcutBridge);
  private readonly settings = inject(SettingsStore);

  private readonly state = signal<PermissionsStatus | null>(null);

  /**
   * L'état des quatre autorisations, ou `null` tant que rien n'a été lu — et hors contexte
   * Tauri, où il n'y a pas de TCC du tout.
   */
  readonly status = this.state.asReadonly();

  /**
   * Vrai quand la dictée est utilisable de bout en bout : le micro capte la voix,
   * l'Accessibilité détecte le raccourci global.
   *
   * @remarks
   * ⚠️ L'automatisation n'entre pas dans le compte, même si elle sert au collage : l'y ajouter
   * désactiverait la dictée pour une autorisation dont le besoin n'est pas tranché.
   * L'enregistrement audio, lui, ne concerne que le Direct.
   */
  readonly dictationReady = computed(() => {
    const status = this.state();
    return (
      status !== null &&
      status.microphone.status === 'granted' &&
      status.accessibility.status === 'granted'
    );
  });

  /**
   * L'Accessibilité a-t-elle été accordée autrefois, et ne l'est-elle plus ?
   *
   * @remarks
   * ⚠️ Le seul cas de perte qui soit muet. Le micro, lui, se redemande tout seul : macOS
   * repropose son pop-up au premier usage. L'Accessibilité n'a pas de pop-up du tout — le
   * raccourci global cesse de répondre, et rien à l'écran ne relie les deux.
   * ⚠️ Faux tant que rien n'a été lu et tant que les réglages ne sont pas relus : sans état, on
   * ne conclut pas.
   */
  readonly accessibilityLost = computed(() => {
    const status = this.state();
    return (
      status !== null &&
      this.settings.loaded() &&
      this.settings.settings().accessibilityGranted &&
      status.accessibility.status !== 'granted'
    );
  });

  /**
   * Relit l'état des autorisations. Ne déclenche ni pop-up, ni tap audio.
   *
   * Lecture bon marché, qu'un écran peut répéter sans y penser. Voir
   * {@link Permissions.recheck} pour la version exhaustive, réservée à un geste explicite.
   *
   * @returns l'état lu, ou `null` hors contexte Tauri.
   *
   * @remarks
   * ⚠️ Un verdict déjà rendu sur l'enregistrement audio est conservé : faute de préflight, une
   * lecture le rend toujours `unknown`, et l'écraser effacerait ce qui vient d'être accordé.
   */
  async refresh(): Promise<PermissionsStatus | null> {
    const status = await this.bridge.getPermissionsStatus();
    if (status === null) {
      this.state.set(null);
      return null;
    }
    const previous = this.state();
    const known = previous?.audioCapture;
    const merged = {
      ...status,
      audioCapture: known !== undefined && known.status !== 'unknown' ? known : status.audioCapture,
    };
    this.state.set(merged);

    // ⚠️ L'Accessibilité vient d'être accordée : le tap clavier doit être remis en place. Il a
    // été tenté au démarrage et, sans autorisation, il n'existe pas — sans cet appel ⌃⌥ reste
    // muet jusqu'au prochain lancement alors que la case est cochée.
    //
    // ⚠️ Sur la transition seulement : `start_shortcut` est idempotent, mais il réinitialise la
    // machine du raccourci, et le rappeler pendant une dictée en cours la couperait.
    if (previous?.accessibility.status !== 'granted' && merged.accessibility.status === 'granted') {
      await this.shortcut.startShortcut();
    }

    // ⚠️ La mémoire s'écrit ici et nulle part ailleurs : toute lecture d'état passe par cette
    // méthode, quel que soit l'écran, alors que l'octroi lui-même se constate n'importe quand —
    // l'Accessibilité s'accorde dans Réglages Système, sans revenir dans l'application.
    //
    // ⚠️ Rien avant que les réglages ne soient relus : la valeur en mémoire vaut alors le défaut,
    // et l'écrire ferait croire à un octroi qui n'a peut-être jamais eu lieu.
    if (
      merged.accessibility.status === 'granted' &&
      this.settings.loaded() &&
      !this.settings.settings().accessibilityGranted
    ) {
      await this.settings.update({ accessibilityGranted: true });
    }

    return merged;
  }

  /**
   * Relit tout, y compris ce qui coûte cher. C'est ce que fait « Revérifier ».
   *
   * La différence avec {@link Permissions.refresh} tient à l'enregistrement audio : il ne se
   * lit pas, il se retente — silencieusement une fois le choix fait, mais en créant puis
   * détruisant un tap audio.
   *
   * @remarks
   * ⚠️ Tant qu'il n'a jamais été demandé, on ne le retente pas : un simple « Revérifier » ferait
   * alors surgir un prompt.
   */
  async recheck(): Promise<PermissionsStatus | null> {
    const status = await this.refresh();
    if (status === null || status.audioCapture.status === 'unknown') {
      return status;
    }
    const audioCapture = await this.bridge.requestAudioCapture();
    if (audioCapture === null) {
      return status;
    }
    const merged = { ...status, audioCapture };
    this.state.set(merged);
    return merged;
  }

  /**
   * Demande l'accès au micro, en faisant surgir le pop-up de macOS.
   *
   * Si l'autorisation a déjà été refusée, macOS ne réaffiche rien : l'appel rend l'état courant
   * sans rien demander. L'interface doit donc proposer les Réglages Système, et non un second
   * « Autoriser », dès que l'état vaut `denied`.
   *
   * @remarks
   * ⚠️ À n'appeler qu'au clic explicite sur « Autoriser ». La promesse attend la réponse de
   * l'utilisateur, sans délai maximal : prévoir un état d'attente.
   */
  async requestMicrophone(): Promise<Permission | null> {
    const microphone = await this.bridge.requestMicrophone();
    if (microphone !== null) {
      this.state.update((status) => (status === null ? null : { ...status, microphone }));
    }
    return microphone;
  }

  /**
   * Demande l'enregistrement audio, en créant la chose elle-même.
   *
   * @remarks
   * ⚠️ À n'appeler qu'au clic explicite sur « Autoriser » : cette catégorie TCC n'expose aucun
   * état à consulter avant. Le tap créé pour déclencher le prompt est détruit aussitôt et ne
   * produit aucun échantillon.
   */
  async requestAudioCapture(): Promise<Permission | null> {
    const audioCapture = await this.bridge.requestAudioCapture();
    if (audioCapture !== null) {
      this.state.update((status) => (status === null ? null : { ...status, audioCapture }));
    }
    return audioCapture;
  }

  /**
   * Demande l'Accessibilité : inscrit l'application dans la liste, puis ouvre le volet.
   *
   * @remarks
   * ⚠️ L'Accessibilité n'a pas de pop-up d'octroi ; ce qui compte est l'inscription, sans quoi
   * l'utilisateur n'a aucune case à son nom dans le volet. L'octroi se constate au prochain
   * {@link Permissions.refresh}, pas au retour de cette promesse.
   */
  async requestAccessibility(): Promise<Permission | null> {
    const accessibility = await this.bridge.requestAccessibility();
    if (accessibility !== null) {
      this.state.update((status) => (status === null ? null : { ...status, accessibility }));
    }
    return accessibility;
  }
}

// ⚠️ « Quel bouton afficher pour cet état » n'est pas ici : le geste dépend du couple
// permission × état, jamais de l'état seul. `notDetermined` autorise un pop-up pour le micro et
// jamais pour l'Accessibilité ; `unknown` ne propose rien, sauf pour l'enregistrement audio.
// Une fonction qui ne lirait que l'état afficherait « Autoriser » là où le clic ne fait rien.
// La décision vit dans `gestureFor`, côté écran d'autorisations, qui sait de quoi il parle.
