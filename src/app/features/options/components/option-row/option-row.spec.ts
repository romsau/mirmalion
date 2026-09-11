import { afterEach, describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OptionRow } from './option-row';
import { expectNoAxeViolations } from '../../../../../testing/axe';

/**
 * Un hôte, parce que la ligne à contrôle projette son contrôle : sans projection, on
 * n'éprouverait que la moitié du composant.
 */
@Component({
  imports: [OptionRow],
  template: `
    <app-option-row
      [label]="label()"
      [sublabel]="sublabel()"
      [drillIn]="drillIn()"
      [hint]="hint()"
      [disabled]="disabled()"
      [passive]="passive()"
      (activate)="activations.set(activations() + 1)"
    >
      @if (withControl()) {
        <button class="control" type="button" aria-label="Sons">contrôle</button>
      }
    </app-option-row>
  `,
})
class Host {
  readonly label = signal('Sons de démarrage');
  readonly sublabel = signal<string | undefined>(undefined);
  readonly drillIn = signal(false);
  readonly hint = signal<string | undefined>(undefined);
  readonly disabled = signal(false);
  readonly passive = signal(false);
  readonly withControl = signal(true);
  readonly activations = signal(0);
}

function render() {
  TestBed.resetTestingModule();
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
    row: () => element.querySelector<HTMLElement>('.row'),
    more: () => element.querySelector<HTMLButtonElement>('.more'),
  };
}

/** Deux lignes à la suite : c'est là que se voit — ou non — le filet de séparation. */
@Component({
  imports: [OptionRow],
  template: `
    <!-- Un commentaire entre les deux, comme dans les vraies catégories. -->
    <app-option-row label="Micro" />
    <app-option-row label="Sons" />
  `,
})
class TwoRows {}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('OptionRow', () => {
  it('sépare les lignes qui se suivent, jamais la première', () => {
    // ⚠️ Le filet de la maquette (`.opt-row + .opt-row`). La traduction naïve — `:host + :host`
    // — n'est pas rendue par Angular, et le défaut est resté invisible tant que chaque
    // catégorie n'avait qu'une ligne (2026-07-30).
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(TwoRows);
    fixture.detectChanges();
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('app-option-row')];

    expect(rows).toHaveLength(2);
    expect(rows[0].matches(':first-of-type'), 'la première ligne ne porte pas de filet').toBe(true);
    expect(rows[1].matches(':not(:first-of-type)'), 'la suivante en porte un').toBe(true);
  });

  it('affiche le libellé, et le sous-libellé seulement s’il y en a un', () => {
    const { element, host, refresh } = render();

    expect(element.querySelector('.label')?.textContent).toBe('Sons de démarrage');
    expect(element.querySelector('.sublabel')).toBeNull();

    host.sublabel.set('Joue un son bref');
    refresh();
    expect(element.querySelector('.sublabel')?.textContent).toBe('Joue un son bref');
  });

  it('émet au clic sur la ligne — c’est l’appelant qui décide de la suite', () => {
    const { host, row, refresh } = render();

    row()?.click();
    refresh();

    expect(host.activations()).toBe(1);
  });

  /**
   * Le garde-fou du double envoi : en « drill-in », le bouton étiré émet déjà, et l'évènement
   * remonte jusqu'à la ligne. Sans la garde, un seul clic compterait double.
   */
  it('n’émet qu’une fois en drill-in, alors que le clic remonte deux fois', () => {
    const { host, more, refresh } = render();
    host.drillIn.set(true);
    host.withControl.set(false);
    refresh();

    more()?.click();
    refresh();

    expect(host.activations()).toBe(1);
  });

  it('affiche l’indication de fin de ligne quand elle est fournie', () => {
    const { element, host, refresh } = render();
    host.drillIn.set(true);
    host.withControl.set(false);
    refresh();
    expect(element.querySelector('.hint')).toBeNull();

    host.hint.set('14 termes');
    refresh();
    expect(element.querySelector('.hint')?.textContent).toBe('14 termes');
  });

  it('ne réagit plus une fois désactivée, dans les deux modes', () => {
    const { host, row, more, refresh } = render();
    host.disabled.set(true);
    refresh();

    row()?.click();
    refresh();
    expect(host.activations()).toBe(0);

    host.drillIn.set(true);
    host.withControl.set(false);
    refresh();
    expect(more()?.disabled).toBe(true);
    row()?.click();
    refresh();
    expect(host.activations()).toBe(0);
  });

  /**
   * ⚠️ **La ligne sans action propre ne s'allume pas au survol et ne prend pas le curseur main.**
   * Une ligne à menu déroulant ne peut pas être cliquable — aucun navigateur n'ouvre une liste
   * par programme —, et s'allumer sans rien faire promet une action qui n'arrivera jamais.
   *
   * ⚠️ La teinte elle-même est du CSS : jsdom n'en calcule aucune. On éprouve la classe, qui est
   * ce que le composant décide ; la règle qui s'y accroche vit dans `option-row.scss`.
   */
  it('marque la ligne sans action propre, et n’émet plus au clic', () => {
    const { element, host, refresh, row } = render();
    expect(element.querySelector('.is-passive')).toBeNull();

    host.passive.set(true);
    refresh();

    expect(element.querySelector('app-option-row')?.classList).toContain('is-passive');
    row()?.click();
    refresh();
    expect(host.activations()).toBe(0);
  });

  it('projette le contrôle, qui reste le seul élément focalisable de la ligne', () => {
    const { element } = render();

    // La ligne n'est pas un bouton et ne porte pas de `tabindex` : elle n'ajoute pas d'arrêt
    // de tabulation. C'est ce qui distingue « cliquable à la souris » de « focalisable ».
    expect(element.querySelector('.row')?.tagName).toBe('DIV');
    expect(element.querySelector('.row')?.hasAttribute('tabindex')).toBe(false);
    expect(element.querySelectorAll('button')).toHaveLength(1);
    expect(element.querySelector('button')?.className).toBe('control');
  });

  /**
   * ⚠️ **Le drill-in SANS indication est le cas qui a cassé**, et le seul qui puisse casser :
   * le bouton n'y contient qu'une icône décorative. AXE l'a attrapé sur l'écran Options, parce
   * que ce spec-ci ne testait alors que le cas avec indication. Les deux sont couverts depuis.
   */
  it('n’a aucune violation d’accessibilité, dans les trois configurations', async () => {
    const { element, host, refresh } = render();
    host.sublabel.set('Joue un son bref');
    refresh();
    await expectNoAxeViolations(element);

    host.drillIn.set(true);
    host.withControl.set(false);
    refresh();
    await expectNoAxeViolations(element);

    host.hint.set('14 termes');
    refresh();
    await expectNoAxeViolations(element);
  });

  it('nomme le bouton du drill-in par le libellé de la ligne, avec ou sans indication', () => {
    const { host, more, refresh } = render();
    host.drillIn.set(true);
    host.withControl.set(false);
    refresh();
    expect(more()?.getAttribute('aria-label')).toBe('Sons de démarrage');

    host.hint.set('14 termes');
    refresh();
    expect(more()?.getAttribute('aria-label')).toBe('Sons de démarrage');
  });
});
