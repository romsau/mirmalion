import { afterEach, describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  OptionsRail,
  OPTIONS_CATEGORIES,
  OPTIONS_RAIL_CATEGORIES,
  type OptionsCategoryId,
} from './options-rail';
import { expectNoAxeViolations } from '../../../../../testing/axe';

@Component({
  imports: [OptionsRail],
  template: `<app-options-rail
    [current]="current()"
    (select)="chosen.set([...chosen(), $event])"
  />`,
})
class Host {
  readonly current = signal<OptionsCategoryId>('general');
  readonly chosen = signal<readonly OptionsCategoryId[]>([]);
}

function render() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    element,
    host: fixture.componentInstance,
    refresh: () => {
      fixture.detectChanges();
    },
    entries: () => [...element.querySelectorAll<HTMLButtonElement>('.nav')],
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('OptionsRail', () => {
  it('propose les six catégories affichées, dans l’ordre acté', () => {
    const { entries } = render();
    expect(entries().map((entry) => entry.textContent?.trim())).toEqual([
      'Général',
      'Direct',
      'Fichiers',
      'Dictionnaire',
      'Langues',
      'Historique',
    ]);
  });

  it('n’affiche pas « Moteurs », qui existe pourtant — et affiche « Fichiers », qui n’est plus vide', () => {
    expect(OPTIONS_RAIL_CATEGORIES).toContain('fichiers');
    expect(OPTIONS_RAIL_CATEGORIES).not.toContain('moteurs');
    expect(OPTIONS_RAIL_CATEGORIES).toEqual(
      OPTIONS_CATEGORIES.filter((category) => category !== 'moteurs'),
    );
  });

  /**
   * `aria-current` est la **seule** indication de la catégorie active pour un lecteur d'écran :
   * le panneau de droite ne porte aucun titre. Une régression ici rendrait l'écran
   * muet, sans que rien ne se voie.
   */
  it('marque l’élément actif, et lui seul, y compris pour l’assistance', () => {
    const { host, refresh, entries } = render();

    for (const [index, category] of OPTIONS_RAIL_CATEGORIES.entries()) {
      host.current.set(category);
      refresh();
      const current = entries().filter((entry) => entry.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(entries().indexOf(current[0])).toBe(index);
      expect(current[0].classList.contains('is-current')).toBe(true);
    }
  });

  /**
   * ⚠️ **Une famille masquée n'allume RIEN, et c'est le choix assumé.** L'alternative aurait été
   * de faire retomber son URL sur « Général » — mais elle l'aurait rendue inatteignable, alors
   * qu'elle doit rester ouvrable le jour où on veut la revoir. Le panneau, lui, s'affiche.
   */
  it('n’allume aucune entrée sur la seule famille encore masquée', () => {
    const { host, refresh, entries } = render();
    host.current.set('moteurs');
    refresh();
    expect(entries().filter((e) => e.getAttribute('aria-current') === 'page')).toEqual([]);
  });

  it('émet la catégorie demandée plutôt que d’y naviguer lui-même', () => {
    const { host, refresh, entries } = render();

    for (const entry of entries()) {
      entry.click();
    }
    refresh();

    expect(host.chosen()).toEqual([...OPTIONS_RAIL_CATEGORIES]);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const { element } = render();
    await expectNoAxeViolations(element);
  });
});
