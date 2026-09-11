import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DictionaryRow } from './dictionary-row';
import type { DictionaryTerm } from '../../../../../../core/models/dictionary-term';
import { expectNoAxeViolations } from '../../../../../../../testing/axe';

const ENTRY: DictionaryTerm = {
  id: 1,
  term: 'GitLab',
  variants: [
    { id: 10, value: 'git lab' },
    { id: 11, value: 'guitte lab' },
  ],
};

async function render(options: { duplicate?: boolean } = {}) {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [DictionaryRow] }).compileComponents();
  const fixture = TestBed.createComponent(DictionaryRow);
  fixture.componentRef.setInput('entry', ENTRY);
  fixture.componentRef.setInput('duplicate', options.duplicate ?? false);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  const element = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return {
    fixture,
    element,
    refresh,
    more: () => element.querySelector<HTMLButtonElement>('.dico-more'),
    field: () => element.querySelector<HTMLInputElement>('.dico-input'),
  };
}

/** Le harnais des tests : jsdom ne pose pas le focus tout seul. */
function type(field: HTMLInputElement, value: string, key: string): void {
  field.value = value;
  field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('DictionaryRow', () => {
  it('affiche le terme et ses graphies', async () => {
    const { element } = await render();
    expect(element.querySelector('.dico-term')?.textContent?.trim()).toBe('GitLab');
    expect(element.querySelectorAll('.dico-tag')).toHaveLength(2);
  });

  /**
   * ⚠️⚠️ **CE QUI RÉPOND AU REPROCHE DU 2026-08-02** : la sous-ligne dit ce que sont les
   * étiquettes. Sans elle, la rangée montrait deux colonnes muettes et rien ne distinguait le
   * terme correct des orthographes fautives — « on ne comprend pas dans quel champ on saisit ».
   * Le libellé doit précéder les étiquettes : c'est ce qui le rend lisible comme une légende.
   */
  it('dit ce que sont les graphies, avant de les montrer', async () => {
    const { element } = await render();
    const said = element.querySelector('.dico-said');
    expect(said?.textContent?.trim()).toBe('La dictée écrit');

    const field = element.querySelector('.dico-field');
    expect(field?.firstElementChild).toBe(said);
  });

  // ⚠️ Sans le terme, un lecteur d'écran annonce « Supprimer » quinze fois de suite sur une
  // liste de quinze lignes.
  it('nomme sa cible dans chaque libellé accessible', async () => {
    const { element } = await render();
    expect(element.querySelector('.h-act.del')?.getAttribute('aria-label')).toBe(
      'Supprimer GitLab',
    );
    expect(element.querySelector('.dico-tag button')?.getAttribute('aria-label')).toBe(
      'Retirer git lab de GitLab',
    );
    expect(element.querySelector('.dico-more')?.getAttribute('aria-label')).toBe(
      'Ajouter ce que la dictée écrit pour GitLab',
    );
  });

  it('retire une graphie par son identifiant', async () => {
    const { fixture, element } = await render();
    const removed: number[] = [];
    fixture.componentInstance.removeVariant.subscribe((id) => removed.push(id));
    element.querySelectorAll<HTMLButtonElement>('.dico-tag button')[1].click();
    expect(removed).toEqual([11]);
  });

  it('supprime le terme sans rien demander', async () => {
    const { fixture, element } = await render();
    let asked = 0;
    fixture.componentInstance.removeTerm.subscribe(() => (asked += 1));
    element.querySelector<HTMLButtonElement>('.h-act.del')?.click();
    expect(asked).toBe(1);
  });

  describe('le champ « + une autre »', () => {
    // ⚠️ Il remplace le bouton à SON emplacement : la saisie apparaît là où l'étiquette
    // apparaîtra.
    it('remplace le bouton et prend le focus', async () => {
      const { more, field, refresh } = await render();
      more()?.click();
      await refresh();
      expect(more()).toBeNull();
      expect(field()).not.toBeNull();
      expect(document.activeElement).toBe(field());
    });

    // ⚠️ Délibéré : on corrige rarement une seule graphie à la fois.
    it('reste OUVERT après Entrée, et se vide', async () => {
      const { fixture, more, field, refresh } = await render();
      const added: string[] = [];
      fixture.componentInstance.addVariant.subscribe((value) => added.push(value));

      more()?.click();
      await refresh();
      const input = field();
      if (input === null) {
        throw new Error('champ absent');
      }
      type(input, '  guite labe  ', 'Enter');
      await refresh();

      expect(added).toEqual(['guite labe']);
      expect(field()).not.toBeNull();
      expect(field()?.value).toBe('');
    });

    it('se referme sur Entrée à vide, sans rien émettre', async () => {
      const { fixture, more, field, refresh } = await render();
      const added: string[] = [];
      fixture.componentInstance.addVariant.subscribe((value) => added.push(value));

      more()?.click();
      await refresh();
      const input = field();
      if (input === null) {
        throw new Error('champ absent');
      }
      type(input, '   ', 'Enter');
      await refresh();

      expect(added).toEqual([]);
      expect(field()).toBeNull();
    });

    // ⚠️ Sans cela le focus retomberait sur `<body>`, au milieu de la liste.
    it('rend le focus au bouton sur Échap', async () => {
      const { more, field, refresh } = await render();
      more()?.click();
      await refresh();
      const input = field();
      if (input === null) {
        throw new Error('champ absent');
      }
      type(input, 'abandon', 'Escape');
      await refresh();
      await new Promise((resolve) => queueMicrotask(() => resolve(null)));

      expect(field()).toBeNull();
      expect(document.activeElement).toBe(more());
    });

    // ⚠️ Ici on ne reprend RIEN : l'utilisateur est déjà parti ailleurs.
    it('se referme sur perte de focus sans reprendre le focus', async () => {
      const { more, field, refresh } = await render();
      more()?.click();
      await refresh();
      field()?.dispatchEvent(new Event('blur'));
      await refresh();
      expect(field()).toBeNull();
      expect(document.activeElement).not.toBe(more());
    });
  });

  describe('le refus de doublon', () => {
    it('s’annonce et décrit le champ', async () => {
      const { element, field, more, refresh } = await render({ duplicate: true });
      more()?.click();
      await refresh();
      const alert = element.querySelector('.dico-dup');
      expect(alert?.getAttribute('role')).toBe('alert');
      expect(field()?.getAttribute('aria-invalid')).toBe('true');
      expect(field()?.getAttribute('aria-describedby')).toBe(alert?.id);
    });

    it('ne décrit rien quand il n’y a pas de refus', async () => {
      const { element, field, more, refresh } = await render();
      more()?.click();
      await refresh();
      expect(element.querySelector('.dico-dup')).toBeNull();
      expect(field()?.getAttribute('aria-invalid')).toBeNull();
      expect(field()?.getAttribute('aria-describedby')).toBeNull();
    });
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const { element, more, refresh } = await render({ duplicate: true });
    more()?.click();
    await refresh();
    await expectNoAxeViolations(element);
  });
});
