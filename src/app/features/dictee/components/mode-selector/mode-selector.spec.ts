import { describe, expect, it } from 'vitest';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ModeSelector } from './mode-selector';
import type { DictationMode } from '../../../../core/models/settings';
import { expectNoAxeViolations } from '../../../../../testing/axe';

async function render(mode: DictationMode = 'hold') {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(ModeSelector);
  fixture.componentRef.setInput('mode', mode);
  await fixture.whenStable();
  return fixture;
}

function rootOf(fixture: ComponentFixture<ModeSelector>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function buttons(fixture: ComponentFixture<ModeSelector>): HTMLButtonElement[] {
  return [...rootOf(fixture).querySelectorAll<HTMLButtonElement>('.mode-btn')];
}

function hintOf(fixture: ComponentFixture<ModeSelector>): string {
  return rootOf(fixture).querySelector('.hint-txt')?.textContent?.trim() ?? '';
}

/** Un hôte minimal : la projection ne se teste pas autrement. */
@Component({
  selector: 'app-mode-selector-host',
  imports: [ModeSelector],
  template: `<app-mode-selector [mode]="'hold'"
    ><p class="second">Traduit en Anglais</p></app-mode-selector
  >`,
})
class Host {}

describe('ModeSelector', () => {
  it('offers the second shortcut a place under its own hint', async () => {
    // ⚠️ Le second indice n'appartient pas à ce composant — il parle de traduction, que le
    // sélecteur de mode ignore. Il offre la place, l'hôte décide ce qui s'y met.
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const column = (fixture.nativeElement as HTMLElement).querySelector('.hints');

    expect(column).not.toBeNull();
    expect([...(column?.children ?? [])].map((child) => child.className)).toEqual([
      'hint',
      'second',
    ]);
  });

  it('keeps its own hint alone when the host projects nothing', async () => {
    // Un anglophone sans cible réglée : la colonne n'a qu'un indice, et c'est un cas nominal.
    const column = rootOf(await render()).querySelector('.hints');
    expect(column?.children).toHaveLength(1);
  });

  it('offers exactly the two modes settled, in the order of the maquette', async () => {
    const fixture = await render();
    expect(buttons(fixture).map((button) => button.textContent?.trim())).toEqual([
      'Maintenir',
      'Mains libres',
    ]);
  });

  it('marks the chosen mode as pressed, and the other as not', async () => {
    const held = await render('hold');
    expect(buttons(held).map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ]);

    const toggled = await render('toggle');
    expect(buttons(toggled).map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
    ]);
  });

  it('lets the hint follow the mode', async () => {
    // C'est la seule chose qui explique la différence entre les deux modes : sans elle,
    // « Mains libres » ne dit pas qu'il faut retaper pour arrêter.
    expect(hintOf(await render('hold'))).toBe('Maintenez pour dicter.');
    expect(hintOf(await render('toggle'))).toBe('Tapez pour démarrer, tapez pour arrêter.');
  });

  it('emits the mode the user picked', async () => {
    const fixture = await render('hold');
    const seen: DictationMode[] = [];
    fixture.componentInstance.mode.subscribe((mode) => seen.push(mode));

    buttons(fixture)[1].click();
    await fixture.whenStable();
    buttons(fixture)[0].click();
    await fixture.whenStable();

    expect(seen).toEqual(['toggle', 'hold']);
  });

  it('shows the shortcut without ever offering to change it', async () => {
    // ⚠️ ⌃⌥ est FIXE. Un contrôle ici laisserait croire le contraire.
    const root = rootOf(await render());
    const keys = [...root.querySelectorAll('kbd')];

    expect(keys).toHaveLength(2);
    expect(keys.map((key) => key.textContent?.trim().replace(/\s+/g, ' '))).toEqual([
      '⌃ control',
      '⌥ option',
    ]);
    expect(root.querySelector('kbd input, kbd button')).toBeNull();
  });

  it('does not let a screen reader say each key twice', async () => {
    // « ⌃ » et « control » désignent la même touche : le symbole est décoratif.
    const root = rootOf(await render());
    for (const symbol of root.querySelectorAll('.sym')) {
      expect(symbol.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('has no AXE violation, in either mode', async () => {
    await expectNoAxeViolations((await render('hold')).nativeElement);
    await expectNoAxeViolations((await render('toggle')).nativeElement);
  });
});
