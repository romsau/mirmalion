import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PanelStore } from './panel.store';

function store() {
  TestBed.resetTestingModule();
  return TestBed.inject(PanelStore);
}

describe('PanelStore', () => {
  it('starts collapsed', () => {
    // La fenêtre s'ouvre dans sa largeur réduite, celle qui convient à une dictée.
    expect(store().collapsed()).toBe(true);
  });

  it('toggles both ways', () => {
    const panel = store();
    panel.toggle();
    expect(panel.collapsed()).toBe(false);
    panel.toggle();
    expect(panel.collapsed()).toBe(true);
  });

  it('does not remember its state across sessions', () => {
    // ⚠️ Rien n'est persisté : un store neuf repart replié, quoi qu'ait fait le précédent.
    const panel = store();
    panel.toggle();
    expect(panel.collapsed()).toBe(false);

    expect(store().collapsed()).toBe(true);
  });
});
