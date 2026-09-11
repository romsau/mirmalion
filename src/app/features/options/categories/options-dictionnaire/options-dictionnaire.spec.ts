import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OptionsDictionnaire } from './options-dictionnaire';
import { Dictionary } from '../../../../core/services/dictionary/dictionary';
import { Modal } from '../../../../core/services/modal/modal';
import { Snackbar } from '../../../../core/services/snackbar/snackbar';
import type { DictionaryWordFormResult } from './components/dictionary-word-form/dictionary-word-form';
import type { DictionaryTerm } from '../../../../core/models/dictionary-term';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const GITLAB: DictionaryTerm = {
  id: 1,
  term: 'GitLab',
  variants: [{ id: 10, value: 'git lab' }],
};
const MIRMALION: DictionaryTerm = { id: 2, term: 'Mirmalion', variants: [] };

/**
 * Monte l'écran sur un service simulé. `list` est **rejouée** après chaque écriture, comme le
 * fait le vrai store : c'est ce qui rend la ligne créée visible au test suivant.
 */
async function render(initial: readonly DictionaryTerm[] = [GITLAB, MIRMALION]) {
  TestBed.resetTestingModule();
  let terms = [...initial];
  const service = {
    list: vi.fn().mockImplementation(() => Promise.resolve(terms)),
    addTerm: vi.fn().mockImplementation((term: string) => {
      const created = { id: terms.length + 90, term, variants: [] };
      terms = [...terms, created];
      return Promise.resolve(created);
    }),
    removeTerm: vi.fn().mockImplementation((id: number) => {
      terms = terms.filter((entry) => entry.id !== id);
      return Promise.resolve();
    }),
    addVariant: vi.fn().mockResolvedValue(null),
    removeVariant: vi.fn().mockResolvedValue(undefined),
  };

  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

  // ⚠️ La doublure rend une poignée dont `closed` se résout tout de suite : sans elle, chaque
  // ouverture laisserait une promesse en vol et les épreuves se termineraient avant l'écriture.
  let answer: DictionaryWordFormResult | undefined;
  const modal = { open: vi.fn(() => ({ closed: Promise.resolve(answer) })) };

  await TestBed.configureTestingModule({
    imports: [OptionsDictionnaire],
    providers: [
      { provide: Dictionary, useValue: service },
      { provide: Modal, useValue: modal },
      { provide: Snackbar, useValue: snackbar },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(OptionsDictionnaire);
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;

  const refresh = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  return {
    fixture,
    element,
    service,
    snackbar,
    modal,
    refresh,
    /** Ce que la modale rendra à la prochaine ouverture. */
    answers: (result: DictionaryWordFormResult | undefined) => {
      answer = result;
    },
    rows: () => element.querySelectorAll('app-dictionary-row'),
    add: () => element.querySelector<HTMLButtonElement>('app-dictionary-toolbar app-button button'),
    search: () => element.querySelector<HTMLInputElement>('input[type="search"]'),
  };
}

function type(field: HTMLInputElement, value: string, key: string): void {
  field.value = value;
  field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

afterEach(() => TestBed.resetTestingModule());

describe('OptionsDictionnaire', () => {
  it('répond aux trois questions d’arrivée', async () => {
    const { element } = await render();
    const description = element.querySelector('.fam-desc');
    expect(description?.textContent).toContain('se corrigent une fois pour toutes');
    expect(description?.textContent).toContain('vocabulaire de métier');
    // Le gras porte ce qu'il faut retenir : la phrase se saute sans lui.
    expect(description?.querySelectorAll('strong')).toHaveLength(1);
  });

  it('liste les termes chargés', async () => {
    const { rows } = await render();
    expect(rows()).toHaveLength(2);
  });

  // ⚠️ Deux vides qui ne disent PAS la même chose : l'un invite à créer, l'autre à effacer
  // la recherche. Les confondre enverrait créer un terme à qui en a déjà quinze.
  describe('les deux vides', () => {
    it('invite à commencer quand rien n’a jamais été saisi', async () => {
      const { element } = await render([]);
      expect(element.querySelector('.dico-empty')?.textContent).toContain(
        'Votre dictionnaire est vide',
      );
    });

    it('dit que la RECHERCHE ne trouve rien quand la liste, elle, n’est pas vide', async () => {
      const { element, search, refresh } = await render();
      const field = search();
      if (field === null) {
        throw new Error('champ de recherche absent');
      }
      field.value = 'introuvable';
      field.dispatchEvent(new Event('input'));
      await refresh();

      const empty = element.querySelector('.dico-empty');
      expect(empty?.textContent).toContain('Aucun mot trouvé');
      expect(empty?.getAttribute('role')).toBe('status');
    });
  });

  describe('« Ajouter »', () => {
    it('ouvre une modale plutôt qu’une ligne, et demande les deux champs d’un coup', async () => {
      // ⚠️ Un mot sans son écriture fautive ne corrige rien : l'ajout se faisait en deux temps,
      // et le second geste n'était pas demandé, seulement possible.
      const { add, modal, element, refresh } = await render();
      add()?.click();
      await refresh();

      expect(modal.open).toHaveBeenCalledOnce();
      expect(element.querySelector('.dico-row.is-draft')).toBeNull();
    });

    it('enregistre le mot ET sa première écriture fautive', async () => {
      const { add, answers, refresh, service } = await render();
      answers({ term: 'WhatsApp', said: "what's up" });
      add()?.click();
      await refresh();

      expect(service.addTerm).toHaveBeenCalledWith('WhatsApp');
      expect(service.addVariant).toHaveBeenCalledWith(expect.any(Number), "what's up");
    });

    it('n’écrit rien quand la modale est annulée', async () => {
      const { add, answers, refresh, service } = await render();
      answers(undefined);
      add()?.click();
      await refresh();

      expect(service.addTerm).not.toHaveBeenCalled();
    });

    // ⚠️ **Un doublon ne jette pas la saisie** : l'écriture fautive est valide, et la modale
    // est déjà refermée — la perdre serait le vrai défaut.
    it('range l’écriture sous le mot déjà connu, sans le dupliquer', async () => {
      const { add, answers, refresh, service, snackbar } = await render();
      answers({ term: 'gitlab', said: 'guitte lab' });
      add()?.click();
      await refresh();

      expect(service.addTerm, 'le mot existant ne se recrée pas').not.toHaveBeenCalled();
      expect(service.addVariant).toHaveBeenCalledWith(1, 'guitte lab');
      // Un rangement, pas un échec.
      expect(snackbar.info).toHaveBeenCalledOnce();
      expect(snackbar.error).not.toHaveBeenCalled();
    });

    it('ne casse rien quand l’écriture était déjà listée sous ce mot', async () => {
      const { add, answers, refresh, service, snackbar } = await render();
      answers({ term: 'GitLab', said: 'Git Lab' });
      add()?.click();
      await refresh();

      expect(service.addTerm).not.toHaveBeenCalled();
      expect(service.addVariant, 'rien à écrire deux fois').not.toHaveBeenCalled();
      expect(snackbar.info).toHaveBeenCalledOnce();
      expect(snackbar.error).not.toHaveBeenCalled();
    });

    // ⚠️ La snackbar est UNIQUE : un rangement annoncé par-dessus l'échec que le magasin vient
    // de dire l'effacerait, et affirmerait l'inverse de ce qui s'est passé.
    it('n’annonce aucun rangement quand l’écriture échoue sous un mot connu', async () => {
      const { add, answers, refresh, service, snackbar } = await render();
      service.addVariant.mockRejectedValue(new Error('base indisponible'));
      answers({ term: 'gitlab', said: 'guitte lab' });
      add()?.click();
      await refresh();

      expect(snackbar.error).toHaveBeenCalledOnce();
      expect(snackbar.info).not.toHaveBeenCalled();
    });

    // ⚠️ Repli : la liste relue ne contient pas le mot qu'on vient de créer — une autre fenêtre
    // a pu le supprimer entre-temps. On n'écrit alors aucune graphie, plutôt que de la poser
    // sous une ligne au hasard.
    it('n’écrit aucune graphie quand le mot créé a disparu de la liste relue', async () => {
      const { add, answers, refresh, service } = await render();
      service.addTerm.mockResolvedValueOnce({ id: 90, term: 'Anthropic', variants: [] });
      answers({ term: 'Anthropic', said: 'entropique' });
      add()?.click();
      await refresh();

      expect(service.addTerm).toHaveBeenCalledWith('Anthropic');
      expect(service.addVariant).not.toHaveBeenCalled();
    });
  });

  describe('les gestes remontés par une ligne', () => {
    it('ajoute une graphie', async () => {
      const { element, service, refresh } = await render();
      element.querySelector<HTMLButtonElement>('app-dictionary-row .dico-more')?.click();
      await refresh();
      const input = element.querySelector<HTMLInputElement>('app-dictionary-row .dico-input');
      if (input === null) {
        throw new Error('champ absent');
      }
      type(input, 'guitte lab', 'Enter');
      await refresh();
      expect(service.addVariant).toHaveBeenCalledWith(1, 'guitte lab');
    });

    // ⚠️ La saisie reste dans le champ, qui reste ouvert : on corrige, on ne retape pas.
    it('signale à la LIGNE que sa graphie est un doublon', async () => {
      const { element, refresh } = await render();
      element.querySelector<HTMLButtonElement>('app-dictionary-row .dico-more')?.click();
      await refresh();
      const input = element.querySelector<HTMLInputElement>('app-dictionary-row .dico-input');
      if (input === null) {
        throw new Error('champ absent');
      }
      type(input, 'Git Lab', 'Enter');
      await refresh();

      expect(element.querySelector('app-dictionary-row .dico-dup')?.getAttribute('role')).toBe(
        'alert',
      );
    });

    it('retire une graphie', async () => {
      const { element, service, refresh } = await render();
      element.querySelector<HTMLButtonElement>('app-dictionary-row .dico-tag button')?.click();
      await refresh();
      expect(service.removeVariant).toHaveBeenCalledWith(10);
    });

    // ⚠️ Immédiate, sans confirmation : la fenêtre d'options est étroite, et une ligne se
    // retape en trois secondes — l'inverse d'un historique de centaines de dictées.
    it('supprime un terme SANS confirmation', async () => {
      const { element, service, refresh, rows } = await render();
      element.querySelector<HTMLButtonElement>('app-dictionary-row .h-act.del')?.click();
      await refresh();
      expect(service.removeTerm).toHaveBeenCalledWith(1);
      expect(document.querySelector('app-confirm-dialog')).toBeNull();
      expect(rows()).toHaveLength(1);
    });
  });

  /**
   * ⚠️ **Ni titre, ni bouton retour** : c'est une famille du rail depuis le 2026-08-03, et le
   * panneau des Options ne porte jamais le nom de sa catégorie. Le rail le dit, et lui seul.
   */
  it('n’est plus un sous-écran : aucun titre-bouton retour', async () => {
    const { element } = await render();
    expect(element.querySelector('app-subscreen-header')).toBeNull();
    expect(element.querySelector('.back')).toBeNull();
  });

  it('n’a aucune violation d’accessibilité', async () => {
    await expectNoAxeViolations((await render()).element);
  });

  /**
   * ⚠️⚠️ **CET ÉCRAN NE DISAIT RIEN QUAND LA BASE REFUSAIT** *(P6-05, 2026-08-09)*. Son store
   * était le seul des dix à ne rien attraper, et ses appelants lançaient en `void` : un terme
   * n'apparaissait pas, ou ne disparaissait pas, et c'était tout. C'est pourtant le seul écran
   * où l'utilisateur modifie des données persistées à la main.
   */
  describe('quand la base refuse', () => {
    it('dit l’échec d’un ajout, et n’enchaîne pas sur la graphie', async () => {
      const { add, answers, refresh, service, snackbar } = await render();
      service.addTerm.mockRejectedValue(new Error('base indisponible'));
      answers({ term: 'Docker', said: 'doqueur' });

      add()?.click();
      await refresh();

      expect(snackbar.error).toHaveBeenCalledOnce();
      expect(
        service.addVariant,
        'rien ne s’écrit sous un mot qui n’existe pas',
      ).not.toHaveBeenCalled();
    });

    // ⚠️ Le drapeau de doublon ne doit pas rester allumé sur un échec qui n'en est pas un.
    it('dit l’échec d’une graphie, sans la prendre pour un doublon', async () => {
      const { rows, refresh, service, snackbar } = await render();
      service.addVariant.mockRejectedValue(new Error('base indisponible'));

      const row = rows()[0] as HTMLElement;
      row.querySelector<HTMLButtonElement>('.dico-more')?.click();
      await refresh();
      const field = row.querySelector<HTMLInputElement>('.dico-input');
      expect(field, 'le champ de graphie doit être ouvert').not.toBeNull();
      type(field as HTMLInputElement, 'git labe', 'Enter');
      await refresh();

      expect(snackbar.error).toHaveBeenCalledOnce();
    });

    it('dit l’échec d’une lecture', async () => {
      const { snackbar } = await render();
      expect(snackbar.error).not.toHaveBeenCalled();

      TestBed.resetTestingModule();
      const broken = await renderBroken();
      expect(broken.snackbar.error).toHaveBeenCalledOnce();
    });
  });
});

/** Le même écran, mais la base ne répond à rien. */
async function renderBroken() {
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn() };
  const refuse = () => Promise.reject(new Error('base indisponible'));
  await TestBed.configureTestingModule({
    imports: [OptionsDictionnaire],
    providers: [
      {
        provide: Dictionary,
        useValue: {
          list: vi.fn().mockImplementation(refuse),
          addTerm: vi.fn().mockImplementation(refuse),
          removeTerm: vi.fn().mockImplementation(refuse),
          addVariant: vi.fn().mockImplementation(refuse),
          removeVariant: vi.fn().mockImplementation(refuse),
        },
      },
      { provide: Snackbar, useValue: snackbar },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(OptionsDictionnaire);
  await fixture.whenStable();
  fixture.detectChanges();
  return { snackbar };
}
