import { describe, expect, it } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DirectRecording } from './direct-recording';
import type { LiveLine } from '../../../../core/services/live/live';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — dans un VRAI navigateur. Voir `history-panel.layout.spec.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le défaut gardé : `DirectTranscript` colle au bas du texte à mesure qu'il arrive, et il le fait
 * sur **son propre élément hôte**. Or `document-panel` laissait `.done-content` en bloc, où le
 * `flex: 1; min-height: 0` de l'hôte est **inerte** : la boîte grandissait avec son texte, c'est
 * l'ancêtre qui défilait, et le composant poussait `scrollTop` sur un élément qui ne défile pas.
 * Mesuré : `.done-content` haute de 883 px, transcript de **53** *(porteur, 2026-08-13)*.
 *
 * ⚠️ **L'invariant est « QUI défile », pas une hauteur** : c'est la seule formulation qui reste
 * juste si la fenêtre change de taille ou si le dessin de la barre évolue.
 */
@Component({
  imports: [DirectRecording],
  // La fenêtre-document : une hauteur bornée, sans quoi rien ne peut déborder et le défaut ne
  // peut pas se produire.
  styles: `
    .fenetre {
      display: flex;
      flex-direction: column;
      height: 500px;
    }
  `,
  template: `
    <div class="fenetre">
      <app-direct-recording
        [title]="'Session d’épreuve'"
        [meta]="'13 août · 2 min'"
        [elapsedSeconds]="42"
        [level]="0.3"
        [lines]="lines"
        [pending]="{ system: null, microphone: null }"
      />
    </div>
  `,
})
class Host {
  // Assez de lignes pour dépasser 500 px : sans débordement, tout défileur a l'air de marcher.
  readonly lines: readonly LiveLine[] = Array.from({ length: 60 }, (_, index) => ({
    id: index + 1,
    stream: 'system' as const,
    text: `Réplique numéro ${index + 1} de la session d’épreuve.`,
    // Chaque réplique ouvre son paragraphe : c'est le cas qui prend le plus de hauteur, donc
    // celui qui garantit le débordement que cette épreuve cherche à provoquer.
    paragraph: true,
  }));
}

describe('DirectRecording — mise en page réelle', () => {
  it('fait défiler le transcript lui-même, et lui seul', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const transcript = root.querySelector<HTMLElement>('app-direct-transcript');
    const contenu = root.querySelector<HTMLElement>('.done-content');
    expect(transcript).not.toBeNull();
    expect(contenu).not.toBeNull();

    // 1. Le transcript déborde donc peut défiler. C'est ce qui manquait : sa boîte épousait son
    //    texte, donc `scrollHeight` valait `clientHeight` et `scrollTop` restait cloué à zéro.
    expect(transcript!.scrollHeight).toBeGreaterThan(transcript!.clientHeight + 1);

    // 2. …et son ancêtre, lui, ne défile PAS : deux défileurs imbriqués donneraient deux barres,
    //    et le suivi automatique agirait sur la mauvaise.
    expect(contenu!.scrollHeight).toBeLessThanOrEqual(contenu!.clientHeight + 1);

    // 3. Le geste exact de `followBottom()` a un effet réel.
    transcript!.scrollTop = 0;
    transcript!.scrollTop = transcript!.scrollHeight;
    expect(transcript!.scrollTop).toBeGreaterThan(0);

    root.remove();
  });
});
