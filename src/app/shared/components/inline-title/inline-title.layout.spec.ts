import { describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { InlineTitle } from './inline-title';

/**
 * ÉPREUVE DE MISE EN PAGE — dans un VRAI navigateur. Voir `history-panel.layout.spec.ts`.
 *
 * Le défaut gardé : le crayon n'apparaissait qu'au survol de la rangée, si bien que rien ne disait
 * qu'un titre de document se renomme. jsdom ne calcule aucune opacité effective et ne connaît pas
 * `:hover` — cette épreuve est la seule qui puisse le voir.
 */
@Component({
  imports: [InlineTitle],
  template: `
    <app-inline-title
      [value]="value()"
      [fallback]="value()"
      renameLabel="Renommer"
      fieldLabel="Titre du document"
    />
  `,
})
class Host {
  readonly value = signal('Session produit hebdo');
}

describe('InlineTitle — mise en page réelle', () => {
  /**
   * ⚠️ **L'invariant est l'opacité EFFECTIVE, sans le moindre survol** : c'est exactement ce que
   * voit quelqu'un qui arrive sur la fenêtre. Une assertion sur la règle CSS, elle, resterait
   * vraie le jour où une seconde règle la couvrirait.
   */
  it('montre son crayon sans qu’on survole quoi que ce soit', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    await fixture.whenStable();
    fixture.detectChanges();

    const pencil = root.querySelector<HTMLButtonElement>('.title-rename');
    expect(pencil).not.toBeNull();

    const style = getComputedStyle(pencil!);
    expect(Number(style.opacity)).toBe(1);
    expect(style.visibility).toBe('visible');
    expect(pencil!.getBoundingClientRect().width).toBeGreaterThan(0);

    root.remove();
  });
});
