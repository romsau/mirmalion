import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranscriptView, type TranscriptLine } from './transcript-view';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const TRANSCRIPT: readonly TranscriptLine[] = [
  { text: 'Par où faut-il commencer ?' },
  { text: 'La première chose, c’est la conformité.' },
  { text: 'Et côté déploiement ?' },
];

async function render(lines: readonly TranscriptLine[]) {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [TranscriptView] }).compileComponents();
  const fixture = TestBed.createComponent(TranscriptView);
  fixture.componentRef.setInput('lines', lines);
  await fixture.whenStable();

  const element = fixture.nativeElement as HTMLElement;
  return {
    element,
    paragraphs: () => [...element.querySelectorAll('.cr-p')].map((node) => node.textContent),
  };
}

describe('TranscriptView', () => {
  it('coule un paragraphe par ligne', async () => {
    const { element, paragraphs } = await render(TRANSCRIPT);

    expect(element.querySelector('.tr-raw')).not.toBeNull();
    expect(paragraphs()).toEqual([
      'Par où faut-il commencer ?',
      'La première chose, c’est la conformité.',
      'Et côté déploiement ?',
    ]);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **AUCUNE ÉTIQUETTE DE LOCUTEUR, ET C'EST CE TEST QUI L'EMPÊCHE DE REVENIR.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(Porteur, 2026-08-06.)* Ce composant a eu **deux rendus** : une liste de tours de parole
   * (`.tr-list`, `.tline`, `.spk`) et du texte brut. Le premier est parti avec les locuteurs, et
   * avec lui le libellé « Locuteur *n* », les six teintes de pastille et l'entrée
   * `speakersHidden`. Un test d'absence est le seul moyen d'empêcher qu'ils reviennent par un
   * chemin qu'on n'a pas prévu.
   */
  it('ne dessine aucune pastille, ni aucun rendu par locuteur', async () => {
    const { element } = await render(TRANSCRIPT);

    expect(element.querySelector('.spk')).toBeNull();
    expect(element.querySelector('.tline')).toBeNull();
    expect(element.querySelector('.tr-list')).toBeNull();
    expect(element.textContent).not.toContain('Locuteur');
  });

  it('ne dessine rien quand il n’y a aucune ligne', async () => {
    const { element, paragraphs } = await render([]);

    expect(element.querySelector('.tr-raw')).not.toBeNull();
    expect(paragraphs()).toEqual([]);
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render(TRANSCRIPT)).element);
  });
});
