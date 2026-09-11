import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Header, type ScreenId } from './header';
import { ICONS, type IconName } from '../icon/icons';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { SystemBridge } from '../../../core/services/bridge/system/system.bridge';

@Component({
  imports: [Header],
  template: `
    <app-header
      [current]="current()"
      [compact]="compact()"
      (navigate)="visited.set([...visited(), $event])"
    />
  `,
})
class Host {
  readonly current = signal<ScreenId | null>('dictee');
  readonly compact = signal(false);
  readonly visited = signal<readonly ScreenId[]>([]);
}

const SCREENS: readonly ScreenId[] = ['dictee', 'direct', 'options'];

/** Ce que le header demande à macOS. Une doublure : aucun test ne redimensionne de fenêtre. */
const zoom = vi.fn();

function render() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: SystemBridge, useValue: { toggleWindowZoom: zoom } }],
  });
  zoom.mockClear();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    host: fixture.componentInstance,
    refresh: () => {
      fixture.detectChanges();
    },
    /** Les noms accessibles des entrées, dans l'ordre où elles sont rendues. */
    entries: () =>
      [...element.querySelectorAll<HTMLButtonElement>('nav button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Header', () => {
  it('ne propose que les autres écrans — jamais celui où l’on est', () => {
    const { host, refresh, entries } = render();

    for (const screen of SCREENS) {
      host.current.set(screen);
      refresh();
      expect(entries()).toHaveLength(SCREENS.length - 1);
      expect(entries()).not.toContain(labelOf(screen));
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE DIRECT NE PORTE PLUS UNE ICÔNE DE RÉUNION.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(porteur, 2026-08-06)*. L'entrée portait `users` — trois personnages —, ce qui était juste
   * tant que le mode s'appelait « Réunion ». Elle porte maintenant `screen-wave` : un écran d'où
   * sort du son. ⚠️ **`users` a quitté le registre le 2026-08-07** (P4-16) : elle n'y restait que
   * pour P4-07, la tâche des participants, close avec les locuteurs.
   *
   * ⚠️ **Ce que ce test garde n'est pas le goût, c'est la PAIRE** : `mic` pour ma voix,
   * `screen-wave` pour l'écran. Les deux destinations nomment leur **source**, qui est l'axe sur
   * lequel le nom « Direct » a été choisi. Remettre `users` — ou poser une icône d'audio
   * générique — casserait cette lecture sans qu'aucune autre vérification ne bronche.
   */
  it('nomme les deux destinations par leur source : micro, écran', () => {
    const { element, host, refresh } = render();

    host.current.set('options');
    refresh();

    const drawn = [...element.querySelectorAll('nav button svg')].map((svg) =>
      [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')).join('|'),
    );
    const shapesOf = (name: IconName) => ICONS[name].shapes.map((shape) => shape.d).join('|');

    expect(drawn).toEqual([shapesOf('mic'), shapesOf('screen-wave')]);
    // ⚠️ **Le garde est maintenant sur le REGISTRE, pas sur le rendu** — et il est plus fort :
    // l'icône de réunion n'existe plus du tout, donc elle ne peut revenir nulle part sans que
    // quelqu'un la redessine.
    expect(Object.keys(ICONS)).not.toContain('users');
  });

  it('garde l’ordre de la maquette : Dictée, Direct, puis Options', () => {
    const { host, refresh, entries } = render();

    host.current.set('direct');
    refresh();
    expect(entries()).toEqual(['Dictée', 'Options']);

    host.current.set('options');
    refresh();
    expect(entries()).toEqual(['Dictée', 'Direct']);
  });

  it('ne propose plus, depuis la Dictée, que Direct et Options', () => {
    // ⚠️ Fichiers a quitté la navigation principale : elle vit dans le rail des Options.
    const { host, refresh, entries } = render();

    host.current.set('dictee');
    refresh();
    expect(entries()).toEqual(['Direct', 'Options']);
  });

  it('émet l’écran demandé plutôt que d’y naviguer lui-même', () => {
    const { element, host, refresh } = render();

    for (const button of element.querySelectorAll<HTMLButtonElement>('nav button')) {
      button.click();
    }
    refresh();

    expect(host.visited()).toEqual(['direct', 'options']);
  });

  it('ne fait tomber qu’Options en icône seule, sans perdre le nom accessible', () => {
    const { element, host, refresh, entries } = render();

    const labels = () =>
      [...element.querySelectorAll<HTMLElement>('nav .label')].map((span) => span.textContent);
    expect(labels()).toEqual(['Direct', 'Options']);

    host.compact.set(true);
    refresh();

    // ⚠️ Les destinations gardent leur mot ; seul Options se réduit à son icône. C'est un
    // arbitrage du porteur contre `docs/ui/ui.html:1324`, qui les réduit toutes.
    expect(labels()).toEqual(['Direct', '']);
    // `ariaLabel`, posé dans les deux modes, garantit que le nom d'Options ne bouge pas.
    expect(entries()).toEqual(['Direct', 'Options']);
  });

  /**
   * ⚠️ **Ce qui borne la largeur de la barre repliée.** La destination courante n'a pas d'entrée
   * vers elle-même, et seuls Dictée et Direct se replient — `WindowShell.compact`. Un libellé au
   * plus, donc, et `header.layout.spec.ts` mesure qu'il tient dans les 450 px. Rendre Options
   * repliable en ajouterait un second, sans mesure.
   */
  it('ne montre jamais plus d’un libellé sur un écran qui se replie', () => {
    const { element, host, refresh } = render();
    host.compact.set(true);

    for (const screen of ['dictee', 'direct'] as const) {
      host.current.set(screen);
      refresh();

      const written = [...element.querySelectorAll<HTMLElement>('nav .label')].filter(
        (span) => (span.textContent ?? '') !== '',
      );
      expect(written.length).toBe(1);
    }
  });

  it('porte le nom de la marque à côté du logo, et le retire en mode compact', () => {
    // ⚠️ Il disparaît du **gabarit**, pas seulement de l'affichage : la maquette le masque en
    // CSS, ce qui le laisserait dans l'arbre d'accessibilité d'une fenêtre où il n'est plus
    // visible.
    const { element, host, refresh } = render();
    const name = () => element.querySelector('.brand-name');

    expect(name()?.textContent).toBe('Mirmalion');
    // Le logo est décoratif — le nom, lui, est ce qui dit à quoi ce header appartient.
    expect(name()?.getAttribute('aria-hidden')).toBeNull();

    host.compact.set(true);
    refresh();
    expect(name()).toBeNull();
  });

  it('ne nomme pas la marque hors de l’application', () => {
    // Dans la fenêtre d'onboarding, l'application se présente encore : le logo l'identifie, et
    // un titre de plus concurrencerait celui de l'étape.
    const { element, host, refresh } = render();

    host.current.set(null);
    refresh();
    expect(element.querySelector('.brand-name')).toBeNull();
    expect(element.querySelector('.mark')).not.toBeNull();
  });

  it('laisse déplacer la fenêtre en attrapant la marque', () => {
    // Tauri compare la cible EXACTE du clic : un enfant sans l'attribut ne déplace rien.
    const { element } = render();

    for (const selector of ['.brand', '.mark', '.brand-name']) {
      expect(element.querySelector(selector)?.hasAttribute('data-tauri-drag-region')).toBe(true);
    }
  });

  it('pose la classe compacte sur son hôte, et l’enlève', () => {
    const { element, host, refresh } = render();
    const header = element.querySelector('app-header');

    expect(header?.classList.contains('compact')).toBe(false);

    host.compact.set(true);
    refresh();
    expect(header?.classList.contains('compact')).toBe(true);
  });

  it('ne dessine pas les boutons de fenêtre : macOS les peint par-dessus', () => {
    const { element } = render();

    // Une réserve, pas des pastilles — sinon on en aurait deux jeux superposés.
    const reserved = element.querySelector('.traffic-space');
    expect(reserved).not.toBeNull();
    expect(reserved?.children).toHaveLength(0);
    expect(reserved?.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * ⚠️ **Sans cette zone, la fenêtre ne se déplace plus du tout.** En `titleBarStyle: Overlay`
   * le webview couvre la barre de titre et avale les évènements souris ; Tauri ne rétablit le
   * déplacement que sur les éléments portant l'attribut, et il compare la **cible exacte** du
   * clic — un enfant sans l'attribut ne déplace rien. Un oubli ne casse aucun rendu et ne se
   * verrait qu'à l'usage.
   */
  it('offre une zone de déplacement sur tout le fond du header', () => {
    const { element } = render();
    const header = element.querySelector('app-header');

    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);
    for (const selector of ['.tb-left', '.traffic-space', '.mark', '.tb-right']) {
      expect(
        header?.querySelector(selector)?.hasAttribute('data-tauri-drag-region'),
        `${selector} n’est pas saisissable`,
      ).toBe(true);
    }
    // Les boutons, eux, ne doivent PAS la porter : ils seraient transformés en poignées.
    for (const button of header?.querySelectorAll('button') ?? []) {
      expect(button.hasAttribute('data-tauri-drag-region')).toBe(false);
    }
  });

  // ⚠️⚠️ **MÊME ANGLE MORT QUE LE `<main>` DE LA COQUILLE** *(P6-07, 2026-08-10)*. La règle
  // `region` d'AXE est `pageLevel: true` : elle ne s'évalue jamais sur le fragment qu'analyse
  // `expectNoAxeViolations`, si bien que « Mirmalion » — le nom accessible de la fenêtre —
  // vivait hors de tout repère sans qu'aucun test ne s'en plaigne. Vu dans un navigateur.
  it('s’annonce comme la bannière de la fenêtre', () => {
    const { element } = render();
    const header = element.querySelector('app-header');

    expect(header?.getAttribute('role')).toBe('banner');
    expect(header?.querySelector('.brand-name')?.textContent?.trim()).toBe('Mirmalion');
  });

  /**
   * ⚠️ **Le fond du header EST la barre de titre**, et une barre de titre s'agrandit au
   * double-clic. En `titleBarStyle: Overlay` le webview la recouvre, si bien que macOS ne voit
   * plus le geste : c'est à nous de le rendre. Le backend refuse le zoom d'une fenêtre non
   * redimensionnable, donc ce geste est sans effet dans la fenêtre principale.
   */
  it('agrandit la fenêtre quand on double-clique son fond', () => {
    const { element } = render();

    element
      .querySelector<HTMLElement>('.tb-left')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(zoom).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ **Un double-clic sur une entrée navigue deux fois, il n'agrandit pas** : sans ce partage,
   * un utilisateur pressé changerait d'écran ET verrait la fenêtre sauter. Même règle que le
   * déplacement, qui ne vit que sur les éléments portant `data-tauri-drag-region`.
   */
  it('ne l’agrandit pas quand on double-clique une entrée', () => {
    const { element } = render();

    element
      .querySelector<HTMLButtonElement>('nav button')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(zoom).not.toHaveBeenCalled();
  });

  it('n’a aucune violation d’accessibilité, déplié comme replié', async () => {
    const { element, host, refresh } = render();
    await expectNoAxeViolations(element);

    host.compact.set(true);
    host.current.set('dictee');
    refresh();
    await expectNoAxeViolations(element);
  });
});

function labelOf(screen: ScreenId): string {
  return { dictee: 'Dictée', direct: 'Direct', options: 'Options' }[screen];
}
