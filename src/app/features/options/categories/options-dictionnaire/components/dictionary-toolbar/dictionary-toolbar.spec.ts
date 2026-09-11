import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DictionaryToolbar } from './dictionary-toolbar';
import { expectNoAxeViolations } from '../../../../../../../testing/axe';

async function render(query = '') {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [DictionaryToolbar] }).compileComponents();
  const fixture = TestBed.createComponent(DictionaryToolbar);
  fixture.componentRef.setInput('query', query);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, element: fixture.nativeElement as HTMLElement };
}

describe('DictionaryToolbar', () => {
  // ⚠️ Contrairement à celui de l'historique, qu'une loupe déplie : on ouvre le dictionnaire
  // pour modifier une entrée précise, et la chercher est le premier geste.
  it('montre son champ de recherche sans rien déplier', async () => {
    const { element } = await render();
    expect(element.querySelector('input[type="search"]')).not.toBeNull();
    expect(element.querySelector('.search-toggle')).toBeNull();
  });

  it('reflète le filtre que le parent lui donne', async () => {
    const { element } = await render('git');
    expect(element.querySelector<HTMLInputElement>('input')?.value).toBe('git');
  });

  it('remonte chaque frappe', async () => {
    const { fixture, element } = await render();
    const emitted: string[] = [];
    fixture.componentInstance.search.subscribe((value) => emitted.push(value));

    const field = element.querySelector<HTMLInputElement>('input');
    if (field === null) {
      throw new Error('champ de recherche absent');
    }
    field.value = 'kube';
    field.dispatchEvent(new Event('input'));

    expect(emitted).toEqual(['kube']);
  });

  it('met l’action à gauche et la recherche à droite', async () => {
    // ⚠️ C'est l'action qui ouvre la barre : on vient ici pour ajouter, pas pour chercher dans
    // dix termes. Une recherche pleine largeur promet qu'on y écrit des phrases.
    const { element } = await render();
    const order = [...element.querySelectorAll('app-button, .opt-search')];
    expect(order.map((node) => node.tagName.toLowerCase())).toEqual(['app-button', 'div']);
  });

  it('nomme ce que le bouton ajoute', async () => {
    const { element } = await render();
    expect(element.querySelector('app-button')?.textContent).toContain('un nouveau mot');
  });

  it('demande un nouveau mot', async () => {
    const { fixture, element } = await render();
    let asked = 0;
    fixture.componentInstance.add.subscribe(() => (asked += 1));
    element.querySelector<HTMLButtonElement>('app-button button')?.click();
    expect(asked).toBe(1);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render()).element);
  });
});
