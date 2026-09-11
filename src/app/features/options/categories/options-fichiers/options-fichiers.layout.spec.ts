import { describe, expect, it } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OptionsFichiers } from './options-fichiers';
import { MediaBridge } from '../../../../core/services/bridge/media/media.bridge';

/**
 * ÉPREUVE DE MISE EN PAGE — elle tourne dans un VRAI navigateur, pas dans jsdom.
 *
 * ⚠️ **Ne pas déplacer ces assertions dans `options-fichiers.spec.ts`** : jsdom ne calcule
 * aucune géométrie, toute hauteur y vaut zéro et tout rembourrage y est invisible.
 *
 * Le défaut gardé : l'écran a été déménagé dans le panneau des Options, qui **cadre déjà son
 * contenu** (`.content` d'`options.scss`). Un `screen-body` laissé sur l'hôte ajoutait son
 * rembourrage par-dessus celui du panneau — 48 px de marge latérale au lieu de 24.
 */
@Component({
  imports: [OptionsFichiers],
  // Le panneau des Options tel qu'`options.scss` le pose : c'est LUI qui rembourre.
  styles: `
    .panneau {
      display: flex;
      flex-direction: row;
      width: 900px;
      height: 520px;
    }

    .content {
      flex: 1;
      min-width: 0;
      padding: 18px 24px;
      overflow-y: auto;
    }
  `,
  template: `
    <div class="panneau">
      <div class="content"><app-options-fichiers /></div>
    </div>
  `,
})
class Host {}

describe('OptionsFichiers — mise en page réelle', () => {
  it('n’ajoute aucun rembourrage à celui du panneau, et remplit sa hauteur', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MediaBridge,
          useValue: { onFileDrop: () => Promise.resolve(() => undefined) },
        },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await fixture.whenStable();
    fixture.detectChanges();

    const panel = root.querySelector<HTMLElement>('app-options-fichiers')!;
    const box = getComputedStyle(panel);

    // ⚠️ Le rembourrage appartient au panneau des Options, jamais à la famille : les additionner
    // décalait le contenu de 24 px de plus que toutes les autres familles.
    expect([box.paddingTop, box.paddingRight, box.paddingBottom, box.paddingLeft]).toEqual([
      '0px',
      '0px',
      '0px',
      '0px',
    ]);

    // ⚠️ La zone de dépôt prend la hauteur qui reste : sans chaîne flex sur l'hôte, elle
    // s'effondre à la hauteur de son texte et la cible de dépôt devient une bande.
    const wrap = root.querySelector<HTMLElement>('.fi-drop-wrap')!;
    const content = root.querySelector<HTMLElement>('.content')!;
    expect(wrap.clientHeight).toBeGreaterThan(content.clientHeight / 2);

    root.remove();
  });
});
