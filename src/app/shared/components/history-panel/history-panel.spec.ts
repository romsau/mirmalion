import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { HistoryPanel, type HistoryEntry } from './history-panel';
import { expectNoAxeViolations } from '../../../../testing/axe';

/** L'invitation de l'état vide est **projetée** : il faut un hôte pour la fournir. */
@Component({
  imports: [HistoryPanel],
  template: `
    <app-history-panel
      [entries]="entries()"
      [label]="'Dernières dictées'"
      [empty]="empty()"
      [search]="search()"
      [searchLabel]="'Rechercher une dictée'"
      [searchPlaceholder]="'Rechercher une dictée…'"
      [noResultLabel]="'Aucune dictée trouvée.'"
      [itemSize]="itemSize()"
      (searchChange)="onSearch($event)"
      (open)="opened.set($event)"
      (copy)="copied.set($event)"
      (remove)="removed.set($event)"
      (clearAll)="cleared.set(cleared() + 1)"
    >
      <p emptyState class="he-title">Aucune dictée pour l'instant</p>
    </app-history-panel>
  `,
})
class Host {
  readonly entries = signal<readonly HistoryEntry[]>([
    { id: 1, text: 'Rappelle-moi d’envoyer le devis.' },
    { id: 2, text: 'Réserve une table pour deux.' },
  ]);
  readonly empty = signal(false);
  readonly itemSize = signal(0);
  readonly opened = signal<number | null>(null);
  readonly search = signal('');
  readonly searches = signal('');

  /**
   * ⚠️ **L'hôte REND ce qu'on lui rapporte**, comme l'écran réel : le panneau n'a pas d'état de
   * recherche à lui, il lit `search`. Sans cette boucle, la fermeture ne verrait jamais de
   * filtre à effacer et le test passerait sur un composant cassé.
   */
  onSearch(value: string): void {
    this.searches.set(value);
    this.search.set(value);
  }
  readonly copied = signal<number | null>(null);
  readonly removed = signal<number | null>(null);
  readonly cleared = signal(0);
}

async function render(setup: (host: Host) => void = () => undefined) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  // ⚠️ **Avant le premier rendu** : un viewport de la CDK mesure à sa naissance, et le brancher
  // après coup demanderait de deviner combien de tours d'horloge lui rendent ses lignes.
  setup(fixture.componentInstance);
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    host: fixture.componentInstance,
    root,
    loupe: () => root.querySelector<HTMLButtonElement>('.search-toggle button'),
    field: () => root.querySelector<HTMLInputElement>('.hist-search-input'),
    /** Déplie la recherche, comme le ferait l'utilisateur. */
    openSearch: async () => {
      root.querySelector<HTMLButtonElement>('.search-toggle button')?.click();
      await fixture.whenStable();
      fixture.detectChanges();
    },
  };
}

beforeEach(() => {
  // ⚠️ **jsdom ne met rien en page** : sans cela, le viewport se croit haut de zéro pixel et le
  // virtual scroll ne rend **aucune** ligne — les tests vérifieraient du vide.
  vi.spyOn(CdkVirtualScrollViewport.prototype, 'getViewportSize').mockReturnValue(600);
});

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('HistoryPanel', () => {
  it('shows one row per entry, with its text', async () => {
    const { root } = await render();
    const rows = root.querySelectorAll('.hist-item');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.txt')?.textContent?.trim()).toBe(
      'Rappelle-moi d’envoyer le devis.',
    );
  });

  it('shows its title, and no counter', async () => {
    // ⚠️ La maquette affichait « (12/200) ». Le nombre exact n'aide à aucune décision, et le
    // plafond est un réglage — sa place est dans les Options (tranché le 2026-07-30).
    const { root } = await render();
    expect(root.querySelector('.label')?.textContent?.trim()).toBe('Dernières dictées');
    expect(root.querySelector('.hist-count')).toBeNull();
  });

  it('emits an intention rather than acting, for each of the three gestures', async () => {
    // ⚠️ Le panneau ne supprime ni ne copie : il ne connaît ni store ni presse-papiers. C'est
    // ce qui permettra à la session de le reprendre tel quel.
    const { fixture, root, host } = await render();
    root.querySelector<HTMLButtonElement>('.h-act.copy')?.click();
    root.querySelector<HTMLButtonElement>('.h-act.del')?.click();
    root.querySelector<HTMLButtonElement>('.clear-all')?.click();
    fixture.detectChanges();

    expect(host.copied()).toBe(1);
    expect(host.removed()).toBe(1);
    expect(host.cleared()).toBe(1);
  });

  it('hides the search field until the loupe asks for it', async () => {
    // ⚠️ Un champ de saisie occupe une place constante pour un usage occasionnel : on ouvre
    // l'historique pour relire, rarement pour chercher (2026-07-30).
    const { field, loupe, openSearch } = await render();

    expect(field()).toBeNull();
    expect(loupe()?.getAttribute('aria-expanded')).toBe('false');

    await openSearch();

    expect(field()).not.toBeNull();
    expect(loupe()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('puts the focus in the field it just opened', async () => {
    // Sans cela il faudrait cliquer une seconde fois pour taper — et le clavier seul n'y
    // arriverait pas du tout.
    const { field, openSearch } = await render();

    await openSearch();
    await Promise.resolve();

    expect(document.activeElement).toBe(field());
  });

  it('clears the search when the field is closed', async () => {
    // ⚠️ Garder le filtre en masquant le champ laisserait une liste incomplète sans que rien à
    // l'écran ne l'explique : l'utilisateur croirait avoir perdu des dictées.
    const { fixture, field, host, openSearch } = await render();
    await openSearch();

    const input = field();
    input!.value = 'devis';
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.searches()).toBe('devis');

    await openSearch();

    expect(field()).toBeNull();
    expect(host.searches()).toBe('');
  });

  it('says nothing more when closing an already empty field', async () => {
    // Émettre une chaîne vide sur un filtre déjà vide ferait relire la source pour rien.
    const { host, openSearch } = await render();
    await openSearch();
    const before = host.searches();

    await openSearch();

    expect(host.searches()).toBe(before);
  });

  it('reports what is typed without filtering anything itself', async () => {
    // ⚠️ Le filtre s'applique à la source, jamais au DOM : le panneau ne fait que rapporter.
    const { fixture, root, host, field, openSearch } = await render();
    await openSearch();
    const input = field();
    input!.value = 'devis';
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(host.searches()).toBe('devis');
    expect(root.querySelectorAll('.hist-item')).toHaveLength(2);
  });

  it('separates "nothing found" from "nothing yet"', async () => {
    // Deux écrans distincts dans la maquette : une recherche vaine n'est pas un historique
    // vide, et proposer de dicter à quelqu'un qui vient de chercher serait à côté.
    const { fixture, root, host } = await render();
    host.entries.set([]);
    fixture.detectChanges();

    expect(root.querySelector('.hist-noresult')?.textContent).toContain('Aucune dictée trouvée.');
    expect(root.querySelector('.hist-empty')).toBeNull();
  });

  it('hides the header and the search when the history is empty', async () => {
    // Chercher dans le vide n'a pas de sens : l'invitation occupe toute la colonne.
    const { fixture, root, host } = await render();
    host.entries.set([]);
    host.empty.set(true);
    fixture.detectChanges();

    expect(root.querySelector('.hist-empty')?.textContent).toContain('Aucune dictée');
    expect(root.querySelector('.hist-head-row')).toBeNull();
    expect(root.querySelector('.hist-search')).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UNE MÉTA CHANGE LA FORME DE LA LIGNE — ET ELLE SEULE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Sans elle, l'entrée est celle de la dictée : un texte qui s'étale. Avec elle, c'est celle de
   * la session : un titre, une méta dessous, et un **bouton** — parce qu'il y a un document
   * derrière. Un `<div (click))` n'est ni tabulable, ni annoncé, ni déclenché par Entrée.
   */
  it('turns a row into a button as soon as it carries a meta line', async () => {
    const { fixture, root, host } = await render();
    host.entries.set([{ id: 7, text: 'Point client', meta: '5 août 16:30 · 48 min' }]);
    fixture.detectChanges();

    expect(root.querySelector('.txt')).toBeNull();
    expect(root.querySelector('.rhist-title')?.textContent?.trim()).toBe('Point client');
    expect(root.querySelector('.rhist-meta')?.textContent?.trim()).toBe('5 août 16:30 · 48 min');

    root.querySelector<HTMLButtonElement>('button.rhist-main')?.click();
    expect(host.opened()).toBe(7);
  });

  /** ⚠️ **Une dictée n'ouvre rien** — elle est déjà tout entière sous les yeux. */
  it('leaves a row without a meta line inert', async () => {
    const { root, host } = await render();
    expect(root.querySelector('.rhist-main')).toBeNull();
    expect(host.opened()).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE VIRTUAL SCROLL EST UN CHOIX DE L'HÔTE, PAS UN DÉFAUT DU PANNEAU.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * La stratégie de la CDK est à **taille fixe** : elle ne convient qu'à des lignes dont la
   * hauteur ne dépend pas du contenu. Les dictées n'en sont pas — leur texte s'étale sur une ou
   * deux lignes —, d'où `itemSize` à zéro par défaut, qui rend une liste ordinaire.
   */
  it('renders a plain list until a row height is given', async () => {
    const { fixture, root, host } = await render();
    expect(root.querySelector('cdk-virtual-scroll-viewport')).toBeNull();

    host.itemSize.set(69);
    fixture.detectChanges();
    expect(root.querySelector('cdk-virtual-scroll-viewport')).not.toBeNull();
  });

  /**
   * ⚠️⚠️ **CE TEST GARDE UN DÉFAUT QUI A RENDU L'HISTORIQUE DES SESSIONS INVISIBLE** *(porteur,
   * 2026-08-13)*. La CDK pose `contain: strict` sur son viewport : il se dimensionne **comme s'il
   * était vide**, donc une hauteur `auto` l'effondre à 0 px et les lignes rendues sont rognées.
   * Mesuré dans un navigateur : 539 × **0**, six sessions en base, trois lignes dans le DOM, et
   * un panneau vide à l'écran.
   *
   * ⚠️ **Ce test ne mesure RIEN, et il ne le peut pas** : jsdom ne met pas en page, donc la
   * hauteur y vaut zéro quoi qu'on fasse — c'est précisément pourquoi 1 573 tests verts n'ont
   * jamais vu le défaut. Ce qu'il garde est la **liaison** : que le gabarit descende bien la
   * hauteur totale au style, qui la borne par le plafond de l'hôte. La retirer casserait de
   * nouveau l'affichage, et ce test tomberait.
   */
  it('hands the total height down to the style, since the CDK contains its own size', async () => {
    const { root } = await render((host) => {
      host.entries.set(
        Array.from({ length: 4 }, (_, index) => ({
          id: index + 1,
          text: `Session ${index + 1}`,
          meta: '5 août · 48 min',
        })),
      );
      host.itemSize.set(69);
    });

    const viewport = root.querySelector<HTMLElement>('cdk-virtual-scroll-viewport');
    expect(viewport?.style.getPropertyValue('--hist-total-h')).toBe('276px');
  });

  /** ⚠️ **Mille lignes, une poignée de nœuds** : c'est ce qui n'est PAS rendu qui le prouve. */
  it('recycles the DOM rather than rendering a thousand rows', async () => {
    const { root } = await render((host) => {
      host.entries.set(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: index + 1,
          text: `Session ${index + 1}`,
          meta: '5 août · 48 min',
        })),
      );
      host.itemSize.set(69);
    });

    const rendered = root.querySelectorAll('.hist-item').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(50);
  });

  it('still copies and deletes from a recycled row', async () => {
    const { root, host } = await render((ready) => {
      ready.entries.set([{ id: 7, text: 'Point client', meta: '5 août · 48 min' }]);
      ready.itemSize.set(69);
    });

    root.querySelector<HTMLButtonElement>('.h-act.copy')?.click();
    root.querySelector<HTMLButtonElement>('.h-act.del')?.click();

    expect(host.copied()).toBe(7);
    expect(host.removed()).toBe(7);
  });

  it('has no AXE violation', async () => {
    const { fixture } = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });

  it('has no AXE violation with two-line rows in a virtual viewport', async () => {
    const { fixture } = await render((host) => {
      host.entries.set([{ id: 7, text: 'Point client', meta: '5 août · 48 min' }]);
      host.itemSize.set(69);
    });
    await expectNoAxeViolations(fixture.nativeElement);
  });

  it('has no AXE violation when empty', async () => {
    const { fixture, host } = await render();
    host.entries.set([]);
    host.empty.set(true);
    fixture.detectChanges();
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
