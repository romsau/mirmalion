import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InlineTitle } from './inline-title';
import { expectNoAxeViolations } from '../../../../testing/axe';

const VALUE = 'interview-podcast-ep12';
const FALLBACK = 'interview.mp4';

async function render(value = VALUE) {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [InlineTitle] }).compileComponents();
  const fixture = TestBed.createComponent(InlineTitle);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('fallback', FALLBACK);
  fixture.componentRef.setInput('renameLabel', 'Renommer la transcription');
  fixture.componentRef.setInput('fieldLabel', 'Titre de la transcription');
  await fixture.whenStable();

  const element = fixture.nativeElement as HTMLElement;
  const renamed: string[] = [];
  fixture.componentInstance.renamed.subscribe((next) => renamed.push(next));

  const refresh = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  return {
    fixture,
    element,
    renamed,
    refresh,
    heading: () => element.querySelector<HTMLHeadingElement>('.title'),
    pencil: () => element.querySelector<HTMLButtonElement>('.title-rename'),
    field: () => element.querySelector<HTMLInputElement>('.title-input'),
    /** Ouvre l'édition et rend le champ, une fois qu'il est réellement là. */
    open: async () => {
      element.querySelector<HTMLButtonElement>('.title-rename')?.click();
      await refresh();
      const field = element.querySelector<HTMLInputElement>('.title-input');
      if (field === null) {
        throw new Error('Le champ d’édition aurait dû s’ouvrir.');
      }
      return field;
    },
  };
}

/** jsdom ne synthétise aucune frappe : on pose la valeur puis on envoie la touche. */
function type(field: HTMLInputElement, value: string, key: string): void {
  field.value = value;
  field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('InlineTitle', () => {
  it('affiche le titre et son crayon', async () => {
    const { heading, pencil, field } = await render();

    expect(heading()?.textContent?.trim()).toBe(VALUE);
    expect(pencil()?.getAttribute('aria-label')).toBe('Renommer la transcription');
    expect(field()).toBeNull();
  });

  describe('ouvrir l’édition', () => {
    // ⚠️ Le champ REMPLACE la rangée : sinon le crayon resterait cliquable pendant l'édition et
    // ouvrirait un second champ.
    it('remplace le titre par un champ pré-rempli, focalisé et sélectionné', async () => {
      const { open, heading, pencil } = await render();
      const field = await open();

      expect(field.value).toBe(VALUE);
      expect(field.getAttribute('aria-label')).toBe('Titre de la transcription');
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe(VALUE.length);
      expect(heading()).toBeNull();
      expect(pencil()).toBeNull();
    });

    // Le clic sur le titre est un raccourci à la souris, en plus du crayon, jamais à sa place.
    it('s’ouvre aussi par un clic sur le titre', async () => {
      const { heading, field, refresh } = await render();

      heading()?.click();
      await refresh();

      expect(field()).not.toBeNull();
    });
  });

  describe('valider', () => {
    it('émet le nouveau nom sur Entrée, et rend le focus au crayon', async () => {
      const { open, renamed, refresh, pencil, field } = await render();
      const input = await open();

      type(input, '  Table ronde paiements  ', 'Enter');
      await refresh();

      expect(renamed).toEqual(['Table ronde paiements']);
      expect(field()).toBeNull();
      expect(document.activeElement).toBe(pencil());
    });

    // ⚠️ Ici on ne reprend RIEN : l'utilisateur est déjà parti ailleurs, lui arracher le focus
    // serait pire que de ne rien faire.
    it('valide aussi sur perte de focus, sans reprendre le focus', async () => {
      const { open, renamed, refresh, pencil, field } = await render();
      const input = await open();

      input.value = 'Autre titre';
      input.dispatchEvent(new Event('blur'));
      await refresh();

      expect(renamed).toEqual(['Autre titre']);
      expect(field()).toBeNull();
      expect(document.activeElement).not.toBe(pencil());
    });

    // Valider sans avoir touché à rien ne doit déclencher ni écriture ni marqueur « modifié ».
    it('n’émet rien quand le nom n’a pas changé', async () => {
      const { open, renamed, refresh, heading } = await render();
      const input = await open();

      type(input, VALUE, 'Enter');
      await refresh();

      expect(renamed).toEqual([]);
      expect(heading()?.textContent?.trim()).toBe(VALUE);
    });
  });

  describe('les deux sorties de secours', () => {
    it('annule sur Échap, sans rien émettre, et rend le focus au crayon', async () => {
      const { open, renamed, refresh, pencil, heading } = await render();
      const input = await open();

      type(input, 'saisie abandonnée', 'Escape');
      await refresh();

      expect(renamed).toEqual([]);
      expect(heading()?.textContent?.trim()).toBe(VALUE);
      expect(document.activeElement).toBe(pencil());
    });

    // ⚠️ Un document sans nom ne se retrouve plus dans une pile de fenêtres : le champ vidé
    // retombe sur la valeur de secours, jamais sur du vide.
    it('retombe sur la valeur de secours quand le champ est vidé', async () => {
      const { open, renamed, refresh } = await render();
      const input = await open();

      type(input, '   ', 'Enter');
      await refresh();

      expect(renamed).toEqual([FALLBACK]);
    });

    it('n’émet rien si le repli est déjà le titre affiché', async () => {
      const { open, renamed, refresh } = await render(FALLBACK);
      const input = await open();

      type(input, '', 'Enter');
      await refresh();

      expect(renamed).toEqual([]);
    });
  });

  // ⚠️⚠️ **LE CAS DU DOCUMENT PAS ENCORE CHARGÉ, ET IL EST RÉEL** *(P6-07, 2026-08-10)*. Les
  // deux fenêtres-documents passent `document()?.title ?? ''` : entre l'ouverture de la fenêtre
  // et le retour du backend, la valeur est **vide**, et un `<h1>` vide était rendu. Un lecteur
  // d'écran annonçait « titre de niveau 1 » suivi de rien — la pire première phrase possible.
  // ⚠️ **Le crayon part avec le titre** : on ne renomme pas un document qui n'est pas chargé.
  // ⚠️ Relevé dans un vrai navigateur, sur la règle `empty-heading` — jsdom ne pouvait rien
  // dire, aucun spec ne fournissant jusque-là un titre vide.
  it('ne rend aucun titre tant que le document n’en a pas', async () => {
    const { heading, pencil, element } = await render('');

    expect(heading()).toBeNull();
    expect(pencil()).toBeNull();
    expect(element.querySelector('h1')).toBeNull();
  });

  it('n’a aucune violation d’accessibilité, ouvert comme fermé', async () => {
    const closed = await render();
    await expectNoAxeViolations(closed.element);

    const open = await render();
    await open.open();
    await expectNoAxeViolations(open.element);
  });
});
