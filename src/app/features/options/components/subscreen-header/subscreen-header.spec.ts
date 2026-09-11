import { afterEach, describe, expect, it } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SubscreenHeader } from './subscreen-header';
import { expectNoAxeViolations } from '../../../../../testing/axe';

@Component({
  imports: [SubscreenHeader],
  template: `<app-subscreen-header
    [title]="title()"
    [backLabel]="backLabel()"
    (back)="returns.set(returns() + 1)"
  />`,
})
class Host {
  readonly title = signal('Dictionnaire personnel');
  readonly backLabel = signal('Retour à Dictée');
  readonly returns = signal(0);
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
    button: () => element.querySelector<HTMLButtonElement>('.back'),
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('SubscreenHeader', () => {
  it('écrit le titre, mais annonce la destination', () => {
    const { button } = render();

    // Sans cette distinction, un lecteur d'écran annoncerait « bouton Dictionnaire
    // personnel » : où l'on est, pas où l'on va.
    expect(button()?.textContent).toContain('Dictionnaire personnel');
    expect(button()?.getAttribute('aria-label')).toBe('Retour à Dictée');
  });

  it('ne fait qu’une cible du chevron et du titre', () => {
    const { element, host, button, refresh } = render();

    expect(element.querySelectorAll('button')).toHaveLength(1);
    button()?.click();
    refresh();

    expect(host.returns()).toBe(1);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const { element } = render();
    await expectNoAxeViolations(element);
  });
});
