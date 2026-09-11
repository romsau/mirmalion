import { Service, inject } from '@angular/core';
import { DICTATION_RECORDED_EVENT } from '../bridge/dictation/dictation.bridge';
import type { DictationRecord, InputDevice } from '../bridge/dictation/dictation.bridge';
import type { DictationMode } from '../../models/settings';
import { ShortcutBridge } from '../bridge/shortcut/shortcut.bridge';
import { DictationBridge } from '../bridge/dictation/dictation.bridge';
import { Invoke } from '../bridge/invoke/invoke';

/**
 * Ce que l'écran Dictée a besoin de demander au backend.
 *
 * Le magasin n'injecte jamais le pont : c'est ce service qui pousse, le magasin tient l'état.
 *
 * @remarks
 * ⚠️ Le changement de mode passe par ici et nulle part ailleurs. Écrire `dictationMode` dans
 * les réglages ne suffit pas : le backend ne relit ce fichier qu'au démarrage, et le raccourci
 * garderait son ancien comportement jusqu'au prochain lancement.
 */
@Service()
export class Dictation {
  private readonly bridge = inject(DictationBridge);
  private readonly core = inject(Invoke);
  private readonly shortcut = inject(ShortcutBridge);

  /**
   * Les entrées audio de la machine.
   *
   * N'ouvre aucun micro et ne déclenche aucun prompt : la liste se remplit dès l'affichage de
   * l'écran, que le micro soit autorisé ou non. Hors contexte Tauri, elle est vide — le
   * sélecteur retombe sur la seule entrée qu'il sait nommer sans le système.
   */
  async inputDevices(): Promise<readonly InputDevice[]> {
    return (await this.bridge.listInputDevices()) ?? [];
  }

  /**
   * Applique le mode de dictée au raccourci en cours d'exécution, sans redémarrage.
   *
   * @remarks
   * ⚠️ À appeler en plus de l'écriture dans les réglages, jamais à la place : les réglages font
   * survivre le choix au redémarrage, cet appel le rend effectif tout de suite.
   */
  async applyMode(mode: DictationMode): Promise<void> {
    await this.shortcut.setShortcutMode(mode);
  }

  /**
   * Le prompt de reformulation personnalisé, ou `''` s'il n'y en a pas.
   *
   * Rend `''` et non `null` : l'appelant remplit un champ de saisie, qui ne connaît que la
   * chaîne vide.
   *
   * @remarks
   * ⚠️ Il n'est pas dans les réglages, contrairement aux autres choix de cet écran : c'est du
   * texte libre écrit par l'utilisateur, donc il vit dans la base chiffrée.
   */
  async rephrasingPrompt(): Promise<string> {
    return (await this.bridge.getRephrasingPrompt()) ?? '';
  }

  /** Enregistre le prompt de reformulation. Un texte vide efface celui qui existait. */
  async saveRephrasingPrompt(prompt: string): Promise<void> {
    await this.bridge.setRephrasingPrompt(prompt);
  }

  /**
   * Les dictées archivées, la plus récente d'abord.
   *
   * @remarks
   * ⚠️ Rend une liste vide et non `null` hors contexte Tauri : le magasin qui appelle porte de
   * l'état, et lui faire distinguer « historique vide » de « pas de backend » lui donnerait une
   * branche qu'aucun geste ne peut atteindre.
   */
  async dictations(): Promise<readonly DictationRecord[]> {
    return (await this.bridge.listDictations()) ?? [];
  }

  /** Supprime une dictée. Sans confirmation — c'est « Tout supprimer » qui en demande une. */
  async deleteDictation(id: number): Promise<void> {
    await this.bridge.deleteDictation(id);
  }

  /** Vide l'historique de dictée. */
  async clearDictations(): Promise<void> {
    await this.bridge.clearDictations();
  }

  /**
   * S'abonne à l'archivage d'une dictée. Rend la fonction de désabonnement.
   *
   * @remarks
   * ⚠️ Seul moyen pour la fenêtre d'apprendre que son historique a bougé : le pipeline est
   * natif et aboutit fenêtre fermée. Sans cet évènement, une fenêtre restée ouverte — elle
   * n'est jamais détruite, seulement cachée — montrerait l'état de son dernier chargement.
   */
  async observeRecorded(handler: () => void): Promise<() => void> {
    return this.core.listen<void>(DICTATION_RECORDED_EVENT, handler);
  }
}
