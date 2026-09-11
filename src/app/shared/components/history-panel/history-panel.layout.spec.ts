import { describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HistoryPanel, type HistoryEntry } from './history-panel';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — elle tourne dans un VRAI navigateur, pas dans jsdom.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ **NE PAS DÉPLACER CES ASSERTIONS DANS `history-panel.spec.ts`.** Elles y passeraient
 * toutes, tout le temps, sur un composant cassé : jsdom ne calcule aucune géométrie, toute
 * hauteur y vaut zéro et toute largeur aussi. C'est la raison d'être du fichier séparé et de la
 * cible `npm run verify:layout`.
 *
 * ⚠️ **Elle n'affirme aucun pixel**, et c'est délibéré : une capture de dimensions se périmerait
 * au premier ajustement de dessin et il faudrait la rebaser sans la lire. Elle affirme des
 * **invariants** — « la liste a une hauteur », « une ligne est réellement visible » — qui restent
 * vrais quelle que soit la maquette.
 *
 * Le défaut gardé : la CDK pose `contain: strict` sur son viewport, qui se dimensionne donc comme
 * s'il était vide. Un simple `max-height` ne lui donnant pas de hauteur, la boîte s'effondrait à
 * **0 px** et les six sessions de l'historique du Direct étaient invisibles *(porteur,
 * 2026-08-13)*.
 */
@Component({
  imports: [HistoryPanel],
  // La colonne qui l'accueille dans l'application : une hauteur bornée, et le plafond de l'hôte.
  // Sans elles, le panneau n'aurait aucune contrainte et le défaut ne pourrait pas se produire.
  styles: `
    .colonne {
      display: flex;
      flex-direction: column;
      height: 600px;

      --hist-max-h: 424px;
    }
  `,
  template: `
    <div class="colonne">
      <app-history-panel
        [entries]="entries()"
        [label]="'Dernières sessions'"
        [empty]="false"
        [search]="''"
        [searchLabel]="'Rechercher'"
        [searchPlaceholder]="'Rechercher…'"
        [noResultLabel]="'Aucune session trouvée.'"
        [itemSize]="69"
      >
        <p emptyState>Aucune session</p>
      </app-history-panel>
    </div>
  `,
})
class Host {
  readonly entries = signal<readonly HistoryEntry[]>(
    Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      text: `Session ${index + 1}`,
      meta: '5 août · 48 min',
    })),
  );
}

describe('HistoryPanel — mise en page réelle', () => {
  it('donne une hauteur à sa liste, et y rend des lignes visibles', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await fixture.whenStable();
    fixture.detectChanges();

    const viewport = root.querySelector<HTMLElement>('cdk-virtual-scroll-viewport.hist');
    expect(viewport).not.toBeNull();

    const boite = viewport!.getBoundingClientRect();
    // Le cœur de l'épreuve : sans hauteur, tout le reste est décoratif.
    expect(boite.height).toBeGreaterThan(0);
    // …et elle s'arrête au plafond de l'hôte plutôt que de s'étirer sur les dix lignes.
    expect(boite.height).toBeLessThanOrEqual(424);

    // Une ligne RÉELLEMENT visible, pas seulement présente dans le DOM : c'était toute la
    // différence — trois lignes existaient, rognées par une boîte de zéro pixel.
    const visibles = [...root.querySelectorAll('.hist-item')].filter((ligne) => {
      const l = ligne.getBoundingClientRect();
      return l.height > 0 && l.bottom > boite.top && l.top < boite.bottom;
    });
    expect(visibles.length).toBeGreaterThan(0);

    root.remove();
  });
});
