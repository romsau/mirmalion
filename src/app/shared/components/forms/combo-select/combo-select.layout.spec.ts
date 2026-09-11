import { describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ComboSelect } from './combo-select';
import type { FormOption } from '../form-option';
import type { LockedGroup } from './combo-select';
import { expectNoContrastViolations, waitForAnimations } from '../../../../../testing/axe';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ÉPREUVE DE MISE EN PAGE — dans un VRAI navigateur. Voir `history-panel.layout.spec.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le défaut gardé : l'enveloppe `.cselect-cascade`, arrivée avec le sous-menu des comptes rendus
 * (P4-21), est un élément flex du panneau d'overlay. Sans largeur, un élément flex se rétracte sur
 * son contenu — et le `width: 100%` du menu valait alors 100 % de cette enveloppe rétractée. Le
 * panneau recevait pourtant la bonne largeur. Mesuré : déclencheur **1124 px**, panneau
 * **1124 px**, menu **206 px** *(porteur, 2026-08-13)*.
 *
 * ⚠️ **L'invariant est une ÉGALITÉ entre deux mesures**, pas une largeur attendue : il reste vrai
 * quelle que soit la place que l'écran donne au champ, donc il ne se périme pas.
 */
@Component({
  imports: [ComboSelect],
  // Une largeur franche et **plus large que le texte des options** : c'est la seule façon de
  // distinguer « le menu suit son déclencheur » de « le menu suit son contenu ». Étroit, le
  // défaut serait invisible.
  styles: `
    .champ {
      width: 520px;
    }
  `,
  template: `
    <div class="champ">
      <app-combo-select [options]="options" [value]="value()" [ariaLabel]="'Langue parlée'" />
    </div>
  `,
})
class Host {
  readonly options: readonly FormOption[] = [
    { value: 'fr', label: 'Français' },
    { value: 'en', label: 'Anglais' },
  ];
  readonly value = signal('fr');
}

describe('ComboSelect — mise en page réelle', () => {
  it('ouvre un menu exactement aussi large que son déclencheur', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await fixture.whenStable();
    fixture.detectChanges();

    const trigger = root.querySelector<HTMLButtonElement>('.cselect-trigger');
    expect(trigger).not.toBeNull();
    trigger!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    // ⚠️ Le menu vit dans l'overlay, donc **hors** de l'arbre du composant : on le cherche dans
    // le document. Le chercher sous `root` ne trouverait rien et le test passerait sur du vide.
    const menu = document.querySelector<HTMLElement>('.cselect-menu');
    expect(menu).not.toBeNull();

    const largeurDeclencheur = trigger!.getBoundingClientRect().width;
    const largeurMenu = menu!.getBoundingClientRect().width;

    expect(largeurDeclencheur).toBeGreaterThan(0);
    expect(Math.abs(largeurMenu - largeurDeclencheur)).toBeLessThan(1);

    root.remove();
  });
});

/**
 * La cascade, et de quel côté son sous-menu s'ouvre.
 *
 * @remarks
 * ⚠️ Le déclencheur est posé en `fixed` contre un bord : c'est la seule façon de créer, dans le
 * navigateur de l'épreuve, le manque de place que la fenêtre de l'application crée pour de vrai.
 */
@Component({
  imports: [ComboSelect],
  styles: `
    .champ {
      position: fixed;
      top: 40px;
      width: 330px;
    }

    .champ.contre-la-droite {
      right: 24px;
    }

    .champ.contre-la-gauche {
      left: 24px;
    }
  `,
  template: `
    <div class="champ" [class.contre-la-droite]="!aGauche()" [class.contre-la-gauche]="aGauche()">
      <app-combo-select
        [options]="options"
        [value]="value()"
        [ariaLabel]="'Type de compte rendu'"
      />
    </div>
  `,
})
class HoteCascade {
  readonly options: readonly FormOption[] = [
    { value: 'none', label: 'Pas de compte rendu' },
    { value: 'standup', label: "Point d'équipe", group: 'Réunions' },
    { value: 'client', label: 'Point client', group: 'Réunions' },
    { value: 'custom', label: 'Personnalisé…' },
  ];
  readonly value = signal('none');
  readonly aGauche = signal(false);
}

/** Ouvre le menu, puis sa première branche, et rend le menu et le sous-menu déployés. */
const ouvreLaBranche = async (aGauche: boolean) => {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(HoteCascade);
  const root = fixture.nativeElement as HTMLElement;
  fixture.componentInstance.aGauche.set(aGauche);
  document.body.appendChild(root);
  await fixture.whenStable();
  fixture.detectChanges();

  root.querySelector<HTMLButtonElement>('.cselect-trigger')!.click();
  await fixture.whenStable();
  fixture.detectChanges();

  // Les deux vivent dans l'overlay, donc hors de l'arbre du composant.
  document.querySelector<HTMLElement>('.cselect-branch')!.click();
  await fixture.whenStable();
  fixture.detectChanges();

  const menu = document.querySelector<HTMLElement>('.cselect-menu')!.getBoundingClientRect();
  const sous = document.querySelector<HTMLElement>('.cselect-sub')!.getBoundingClientRect();
  return { menu, sous, root };
};

describe('ComboSelect — le côté du sous-menu', () => {
  it('bascule à gauche quand le déclencheur est contre le bord droit', async () => {
    const { menu, sous, root } = await ouvreLaBranche(false);

    expect(sous.width).toBeGreaterThan(0);
    expect(sous.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(sous.right).toBeLessThanOrEqual(menu.left);

    root.remove();
  });

  it('reste à droite quand le déclencheur a la place devant lui', async () => {
    const { menu, sous, root } = await ouvreLaBranche(true);

    expect(sous.width).toBeGreaterThan(0);
    expect(sous.left).toBeGreaterThanOrEqual(menu.right);
    expect(sous.right).toBeLessThanOrEqual(document.documentElement.clientWidth);

    root.remove();
  });
});

/**
 * Le rapport de contraste entre deux couleurs **calculées par le navigateur**, formule WCAG 2.x.
 *
 * ⚠️ Il est ici et non dans `testing/axe.ts` parce qu'AXE ne peut pas le rendre : sa règle
 * `color-contrast` **saute les nœuds `aria-disabled`**, au titre de l'exemption « composant
 * inactif ». Mesuré : la ligne grisée peinte en `var(--surface)` — invisible — laissait
 * `expectNoContrastViolations` au vert.
 */
function rapportDeContraste(premierPlan: string, fond: string): number {
  const luminance = (couleur: string) =>
    (couleur.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .reduce((total, valeur, rang) => {
        const canal = valeur / 255;
        const lineaire = canal <= 0.03928 ? canal / 12.92 : ((canal + 0.055) / 1.055) ** 2.4;
        return total + [0.2126, 0.7152, 0.0722][rang]! * lineaire;
      }, 0);

  const [clair, sombre] = [luminance(premierPlan), luminance(fond)].sort((a, b) => b - a);
  return (clair! + 0.05) / (sombre! + 0.05);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * LA RUBRIQUE VERROUILLÉE, DANS UN VRAI NAVIGATEUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Son encre est `--muted`, posée par le mixin `disabled-control`. Une ligne grisée reste du
 * texte à lire : elle dit ce que la rubrique deviendra. jsdom ne calcule aucune couleur, et
 * `expectNoAxeViolations` coupe la règle de contraste partout ailleurs — ce rendu-ci est donc le
 * seul endroit où l'encre de cette ligne est mesurée.
 */
@Component({
  imports: [ComboSelect],
  styles: `
    .champ {
      width: 330px;
    }
  `,
  template: `
    <div class="champ">
      <app-combo-select
        [options]="options"
        [value]="'none'"
        [lockedGroups]="verrous"
        [ariaLabel]="'Type de compte rendu'"
      />
    </div>
  `,
})
class HoteVerrouille {
  readonly options: readonly FormOption[] = [
    { value: 'none', label: 'Pas de compte rendu' },
    { value: 'standup', label: "Point d'équipe", group: 'Réunions' },
  ];
  readonly verrous: readonly LockedGroup[] = [{ group: 'Personnalisé', index: 1 }];
}

describe('ComboSelect — la rubrique verrouillée', () => {
  it('reste lisible dans les deux thèmes', async () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.setAttribute('data-theme', theme);
      TestBed.resetTestingModule();
      const fixture = TestBed.createComponent(HoteVerrouille);
      const root = fixture.nativeElement as HTMLElement;
      document.body.appendChild(root);
      await fixture.whenStable();
      fixture.detectChanges();

      root.querySelector<HTMLButtonElement>('.cselect-trigger')!.click();
      await fixture.whenStable();
      fixture.detectChanges();

      // ⚠️ Le panneau entre en fondu (`popover-in`) : mesuré trop tôt, AXE ne rend que des
      // « indéterminés » sur un texte encore translucide, et n'affirme rien. On attend donc la
      // FIN RÉELLE des animations du panneau, jamais un délai — un délai est un pari, et il se
      // perd sur une machine chargée, où le fondu démarre en retard.
      const menu = document.querySelector<HTMLElement>('.cselect-menu')!;
      await waitForAnimations(menu);

      // Le reste du menu, mesuré par AXE.
      await expectNoContrastViolations(menu);

      // ⚠️ Et la ligne grisée à part, à la main : AXE ne la regarde pas (voir
      // `rapportDeContraste`). C'est ce qui fait mordre cette épreuve sur elle.
      const grisee = document.querySelector<HTMLElement>('.cselect-branch.is-locked .lbl')!;
      expect(grisee.textContent).toContain('Personnalisé');
      const encre = getComputedStyle(grisee).color;
      const fond = getComputedStyle(menu).backgroundColor;
      expect(rapportDeContraste(encre, fond)).toBeGreaterThanOrEqual(4.5);

      root.remove();
      document.querySelector('.cdk-overlay-container')?.remove();
      document.documentElement.removeAttribute('data-theme');
    }
  });
});
