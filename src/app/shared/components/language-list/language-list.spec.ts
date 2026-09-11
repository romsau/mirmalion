import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LanguageList, type LanguagePurpose } from './language-list';
import { expectNoAxeViolations } from '../../../../testing/axe';
import type { Language } from '../../../core/models/settings';

function render(
  inputs: {
    purpose?: LanguagePurpose;
    selected?: readonly Language[];
    installed?: readonly Language[] | null;
    locked?: Language | null;
    lockedReason?: string;
  } = {},
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(LanguageList);
  fixture.componentRef.setInput('purpose', inputs.purpose ?? 'dictation');
  fixture.componentRef.setInput('selected', inputs.selected ?? ['fr']);
  fixture.componentRef.setInput('installed', inputs.installed ?? null);
  fixture.componentRef.setInput('locked', inputs.locked ?? null);
  fixture.componentRef.setInput('lockedReason', inputs.lockedReason ?? '');
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  const asked: Language[] = [];
  fixture.componentInstance.toggled.subscribe((language) => asked.push(language));

  const rows = [...element.querySelectorAll<HTMLElement>('.lang-row')];
  // ⚠️ Le nom se lit dans `.lang-name`, jamais dans la rangée entière : une rangée marquée
  // « à télécharger » porte deux textes, et comparer le tout ne trouverait plus la langue.
  const nameOf = (row: HTMLElement): string =>
    row.querySelector('.lang-name')?.textContent?.trim() ?? '';
  const rowFor = (name: string): HTMLElement => {
    const row = rows.find((candidate) => nameOf(candidate) === name);
    if (row === undefined) {
      throw new Error(`aucune rangée « ${name} »`);
    }
    return row;
  };
  const switchIn = (row: HTMLElement): HTMLButtonElement => {
    const control = row.querySelector('button');
    if (control === null) {
      throw new Error('aucun interrupteur dans cette rangée');
    }
    return control;
  };
  const markIn = (row: HTMLElement): HTMLElement | null =>
    row.querySelector<HTMLElement>('.lang-missing');

  return { fixture, element, rows, nameOf, rowFor, switchIn, markIn, asked };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('LanguageList', () => {
  it('rend les six langues, rangées par leur nom traduit', () => {
    const { rows, nameOf } = render();
    expect(rows).toHaveLength(6);
    expect(nameOf(rows[0] as HTMLElement)).toBe('Allemand');
    expect(nameOf(rows[1] as HTMLElement)).toBe('Anglais');
  });

  it('n’affiche AUCUNE icône, ni rien sous la liste, ni marque sur une langue non choisie', () => {
    // Une langue qu'on n'a pas choisie n'a rien à annoncer : allumer son interrupteur EST le
    // téléchargement. Seule exception, plus bas, une langue choisie dont les ressources ont
    // disparu — l'interrupteur reflète le choix, pas le moteur, et il ment alors tout seul.
    const { element, rowFor, markIn } = render({ selected: ['fr'], installed: ['fr'] });
    expect(element.querySelectorAll('svg')).toHaveLength(0);
    expect(element.querySelector('.lang-legend')).toBeNull();
    expect(element.querySelector('.lang-note')).toBeNull();
    expect(markIn(rowFor('Italien'))).toBeNull();
  });

  describe('la marque « à télécharger »', () => {
    it('marque une langue CHOISIE dont les ressources ne sont plus là', () => {
      const { rowFor, markIn } = render({ selected: ['fr', 'it'], installed: ['fr'] });
      const mark = markIn(rowFor('Italien'));
      expect(mark?.textContent?.trim()).toBe('à télécharger');
      // Le nom accessible de l'interrupteur le dit déjà : la marque ne le répète pas.
      expect(mark?.getAttribute('aria-hidden')).toBe('true');
      expect(markIn(rowFor('Français'))).toBeNull();
    });

    it('ne marque rien quand on ne lui donne pas la liste des installées', () => {
      // `null` n'est pas une liste vide : il n'y a alors rien à savoir de l'installation.
      const { element } = render({ selected: ['fr', 'it'], installed: null });
      expect(element.querySelectorAll('.lang-missing')).toHaveLength(0);
    });

    it('laisse le nom accessible mot pour mot tel qu’il était', () => {
      const { rowFor, switchIn } = render({ selected: ['fr', 'it'], installed: ['fr'] });
      expect(switchIn(rowFor('Italien')).getAttribute('aria-label')).toBe(
        'Dicter en Italien — à télécharger',
      );
      expect(switchIn(rowFor('Français')).getAttribute('aria-label')).toBe('Dicter en Français');
    });
  });

  it('montre l’état de chaque interrupteur', () => {
    const { rowFor, switchIn } = render({ selected: ['fr', 'it'] });
    expect(switchIn(rowFor('Français')).getAttribute('aria-checked')).toBe('true');
    expect(switchIn(rowFor('Italien')).getAttribute('aria-checked')).toBe('true');
    expect(switchIn(rowFor('Allemand')).getAttribute('aria-checked')).toBe('false');
  });

  describe('le nom accessible', () => {
    it('dit ce que la langue sert à faire', () => {
      const { rowFor, switchIn } = render({ purpose: 'dictation' });
      expect(switchIn(rowFor('Allemand')).getAttribute('aria-label')).toBe('Dicter en Allemand');

      const traduction = render({ purpose: 'translation' });
      expect(traduction.switchIn(traduction.rowFor('Allemand')).getAttribute('aria-label')).toBe(
        'Traduire en Allemand',
      );
    });

    it('porte l’état « à télécharger », puisque plus rien à l’écran ne le dit', () => {
      const { rowFor, switchIn } = render({ installed: ['fr'] });
      expect(switchIn(rowFor('Italien')).getAttribute('aria-label')).toBe(
        'Dicter en Italien — à télécharger',
      );
      expect(switchIn(rowFor('Français')).getAttribute('aria-label')).toBe('Dicter en Français');
    });

    it('ne dit RIEN de l’installation quand on ne lui donne pas la liste', () => {
      // `null` n'est pas une liste vide : la traduction s'installe par paires ordonnées, et
      // prétendre un état par langue mentirait sur la granularité.
      const { rowFor, switchIn } = render({ purpose: 'translation', installed: null });
      expect(switchIn(rowFor('Italien')).getAttribute('aria-label')).toBe('Traduire en Italien');
    });

    it('reprend la raison d’un interrupteur figé, mot pour mot', () => {
      // Un contrôle inerte doit dire pourquoi, y compris à qui ne survole rien.
      const { rowFor, switchIn } = render({
        selected: ['fr'],
        locked: 'fr',
        lockedReason: 'Au moins une langue parlée est nécessaire.',
      });
      expect(switchIn(rowFor('Français')).getAttribute('aria-label')).toBe(
        'Dicter en Français — Au moins une langue parlée est nécessaire.',
      );
    });
  });

  describe('le geste', () => {
    it('demande la bascule depuis l’interrupteur', () => {
      const { fixture, rowFor, switchIn, asked } = render();
      switchIn(rowFor('Italien')).click();
      fixture.detectChanges();
      expect(asked).toEqual(['it']);
    });

    it('demande la bascule depuis TOUTE la carte', () => {
      const { fixture, rowFor, asked } = render();
      rowFor('Italien').click();
      fixture.detectChanges();
      expect(asked).toEqual(['it']);
    });

    it('ne la demande qu’UNE fois quand on clique l’interrupteur lui-même', () => {
      // Sans `stopPropagation`, le clic remonterait à la carte : allumée puis éteinte dans le
      // même geste.
      const { fixture, rowFor, switchIn, asked } = render();
      switchIn(rowFor('Italien')).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();
      expect(asked).toEqual(['it']);
    });

    it('n’allume rien de lui-même — c’est l’hôte qui accorde', () => {
      // Une langue absente ne s'allume qu'à la fin de son téléchargement.
      const { fixture, rowFor, switchIn } = render({ selected: ['fr'] });
      const control = switchIn(rowFor('Italien'));
      control.click();
      fixture.detectChanges();
      expect(control.getAttribute('aria-checked')).toBe('false');
    });

    it('ne demande rien sur une ligne figée, carte comprise', () => {
      const { fixture, rowFor, switchIn, asked } = render({
        selected: ['fr'],
        locked: 'fr',
        lockedReason: 'Au moins une langue parlée est nécessaire.',
      });
      const row = rowFor('Français');
      expect(switchIn(row).disabled).toBe(true);
      row.click();
      switchIn(row).click();
      fixture.detectChanges();
      expect(asked).toEqual([]);
    });
  });

  it('porte la raison dans l’infobulle, en plus du nom accessible', () => {
    const { rowFor } = render({
      selected: ['fr'],
      locked: 'fr',
      lockedReason: 'Au moins une langue parlée est nécessaire.',
    });
    expect(rowFor('Français').getAttribute('data-hint')).toBe(
      'Au moins une langue parlée est nécessaire.',
    );
    expect(rowFor('Allemand').getAttribute('data-hint')).toBeNull();
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations(render({ selected: ['fr', 'it'], installed: ['fr'] }).element);
    await expectNoAxeViolations(
      render({ purpose: 'translation', selected: [], locked: 'fr', lockedReason: 'Figée.' })
        .element,
    );
  });
});
