import { afterEach, describe, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { expectNoContrastViolations } from './axe';
import { Button } from '../app/shared/components/button/button';
import { SnackbarItem } from '../app/shared/components/snackbar-item/snackbar-item';
import { ProgressBar } from '../app/shared/components/progress-bar/progress-bar';
import {
  HistoryPanel,
  type HistoryEntry,
} from '../app/shared/components/history-panel/history-panel';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — elle tourne dans un VRAI navigateur, pas dans jsdom.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ **NE PAS DÉPLACER CES ASSERTIONS DANS UN SPEC ORDINAIRE.** Elles y passeraient sur un
 * rendu illisible : jsdom ne calcule aucune couleur, et c'est la raison pour laquelle
 * `expectNoAxeViolations` désactive `color-contrast` partout ailleurs.
 *
 * Ce que cette épreuve ajoute à `npm run verify:styles` : ce dernier mesure des **couples de
 * jetons** — il vérifie que `--text` sur `--surface` passe. Un composant qui poserait `--muted`
 * sur `--accent`, couple que personne n'a listé, lui échapperait entièrement. Ici, c'est le rendu
 * qui est mesuré : les couleurs sont celles que le navigateur a calculées, cascade comprise.
 *
 * ⚠️ **Elle ne voit aucun PSEUDO-ÉLÉMENT** : axe-core n'évalue que des nœuds de texte réels,
 * jamais un `::placeholder`. Mesuré, pas supposé — un texte d'attente à 2,43:1 la laisse verte.
 * Ces couleurs-là n'ont qu'un garde, `check-contrast.mjs`, par ses couples de jetons.
 *
 * Ce qu'elle ne prouve pas : que **tous** les composants passent. Elle couvre le vocabulaire
 * partagé — les quatre composants imposés —, là où les jetons se combinent. Un écran qui
 * inventerait son propre couple demande sa propre épreuve.
 */
const ENTRIES: readonly HistoryEntry[] = [
  { id: 1, text: 'Point produit hebdomadaire', meta: '5 août 16:30 · 48 min' },
  { id: 2, text: 'Note dictée au clavier' },
];

@Component({
  imports: [Button, SnackbarItem, ProgressBar, HistoryPanel],
  styles: `
    .galerie {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
      background: var(--surface);
    }

    .colonne {
      display: flex;
      flex-direction: column;
      height: 300px;

      --hist-max-h: 260px;
    }
  `,
  template: `
    <div class="galerie">
      <app-button variant="accent">Enregistrer</app-button>
      <app-button variant="accent" [disabled]="true">Indisponible</app-button>
      <app-button variant="neutral">Annuler</app-button>
      <app-button variant="neutral" size="large">Continuer</app-button>

      <app-snackbar-item message="Session exportée." tone="success" [duration]="0" />
      <app-snackbar-item message="La traduction n'est pas installée." tone="info" [duration]="0" />
      <app-snackbar-item message="Le disque est plein." tone="error" [duration]="0" />

      <app-progress-bar label="Finalisation de la session…" [progress]="42" detail="3 sur 7" />
      <app-progress-bar label="Compte rendu en cours…" [progress]="null" />

      <div class="colonne">
        <app-history-panel
          [entries]="entries()"
          label="Dernières sessions"
          [empty]="false"
          search=""
          searchLabel="Rechercher"
          searchPlaceholder="Rechercher…"
          noResultLabel="Aucune session trouvée."
          [itemSize]="69"
        >
          <p emptyState>Aucune session</p>
        </app-history-panel>
      </div>
    </div>
  `,
})
class Gallery {
  readonly entries = signal(ENTRIES);
}

/**
 * ⚠️ Le thème se pose sur la racine du document, pas sur l'hôte : les jetons sombres vivent sous
 * `:root[data-theme='dark']`, et un attribut posé plus bas ne les atteindrait pas.
 */
async function paint(theme: 'light' | 'dark'): Promise<HTMLElement> {
  document.documentElement.setAttribute('data-theme', theme);
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Gallery);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('Contraste du vocabulaire partagé', () => {
  it('tient le seuil AA en thème clair', async () => {
    await expectNoContrastViolations(await paint('light'));
  });

  it('tient le seuil AA en thème sombre', async () => {
    await expectNoContrastViolations(await paint('dark'));
  });
});
