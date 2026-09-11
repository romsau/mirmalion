import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DictionaryStore } from './dictionary.store';
import { Dictionary } from '../../services/dictionary/dictionary';
import type { DictionaryTerm } from '../../models/dictionary-term';

const GITLAB: DictionaryTerm = {
  id: 1,
  term: 'GitLab',
  variants: [
    { id: 10, value: 'git lab' },
    { id: 11, value: 'guitte lab' },
  ],
};
const MIRMALION: DictionaryTerm = {
  id: 2,
  term: 'Mirmalion',
  variants: [{ id: 20, value: 'mir maléon' }],
};

function store(terms: readonly DictionaryTerm[] = [GITLAB, MIRMALION]) {
  TestBed.resetTestingModule();
  const service = {
    list: vi.fn().mockResolvedValue(terms),
    addTerm: vi.fn().mockResolvedValue(null),
    removeTerm: vi.fn().mockResolvedValue(undefined),
    addVariant: vi.fn().mockResolvedValue(null),
    removeVariant: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({ providers: [{ provide: Dictionary, useValue: service }] });
  return { store: TestBed.inject(DictionaryStore), service };
}

/**
 * ⚠️⚠️ **CE STORE ÉTAIT LE SEUL DES DIX À NE RIEN ATTRAPER** *(P6-05, 2026-08-09)*. Ses six
 * méthodes laissaient filer leur rejet et ses appelants les lançaient en `void` : une base
 * indisponible faisait qu'un terme n'apparaissait pas — ou ne disparaissait pas — **sans un
 * mot**. C'est le seul écran où l'utilisateur modifie des données persistées à la main.
 */
describe('DictionaryStore — quand la base refuse', () => {
  const refuse = () => Promise.reject(new Error('base indisponible'));

  it('retient l’échec d’une lecture au lieu de le laisser filer', async () => {
    const { store: s, service } = store();
    service.list.mockImplementation(refuse);

    await s.load();

    expect(s.error()?.message).toBeTruthy();
    // ⚠️ **`loaded` passe quand même à vrai** : l'écran doit montrer son état vide plutôt que
    // de rester sur un chargement qui ne finira jamais.
    expect(s.loaded()).toBe(true);
  });

  it('rend « failed » sur un ajout refusé, sans toucher à la liste', async () => {
    const { store: s, service } = store();
    await s.load();
    service.addTerm.mockImplementation(refuse);

    expect(await s.addTerm('Docker')).toBe('failed');
    expect(s.error()).not.toBeNull();
    expect(s.count()).toBe(2);
  });

  it('rend « failed » sur une graphie refusée', async () => {
    const { store: s, service } = store();
    await s.load();
    service.addVariant.mockImplementation(refuse);

    expect(await s.addVariant(1, 'guite lab')).toBe('failed');
    expect(s.error()).not.toBeNull();
  });

  it('retient l’échec d’une suppression de terme', async () => {
    const { store: s, service } = store();
    await s.load();
    service.removeTerm.mockImplementation(refuse);

    await s.removeTerm(1);

    expect(s.error()).not.toBeNull();
    expect(s.count()).toBe(2);
  });

  it('retient l’échec d’une suppression de graphie', async () => {
    const { store: s, service } = store();
    await s.load();
    service.removeVariant.mockImplementation(refuse);

    await s.removeVariant(10);

    expect(s.error()).not.toBeNull();
  });

  // L'écran l'annonce puis l'efface : sans cela, la snackbar reviendrait à chaque rendu.
  it('oublie l’échec quand l’écran l’a dit', async () => {
    const { store: s, service } = store();
    service.list.mockImplementation(refuse);
    await s.load();

    s.clearError();

    expect(s.error()).toBeNull();
  });
});

describe('DictionaryStore', () => {
  // ⚠️ `terms.length === 0` confondrait « pas encore lu » et « rien dedans », et l'écran
  // n'affiche pas la même chose dans les deux cas.
  it('distingue « pas encore lu » de « rien dedans »', async () => {
    const { store: s } = store([]);
    expect(s.loaded()).toBe(false);
    await s.load();
    expect(s.loaded()).toBe(true);
    expect(s.count()).toBe(0);
  });

  it('charge les termes et les compte', async () => {
    const { store: s } = store();
    await s.load();
    expect(s.count()).toBe(2);
    expect(s.visible()).toHaveLength(2);
  });

  describe('la recherche', () => {
    it('laisse tout passer quand elle est vide', async () => {
      const { store: s } = store();
      await s.load();
      s.setQuery('   ');
      expect(s.visible()).toHaveLength(2);
    });

    it('filtre sur le terme, casse et accents ignorés', async () => {
      const { store: s } = store();
      await s.load();
      s.setQuery('GITLAB');
      expect(s.visible().map((entry) => entry.term)).toEqual(['GitLab']);
    });

    // ⚠️ C'est ce qui la rend utile : on cherche un terme parce qu'une dictée l'a écorché,
    // donc on tape la graphie fautive — pas le terme correct, qu'on n'a peut-être jamais vu.
    it('filtre AUSSI sur les graphies', async () => {
      const { store: s } = store();
      await s.load();
      s.setQuery('mir maleon');
      expect(s.visible().map((entry) => entry.term)).toEqual(['Mirmalion']);
    });

    it('ne rend rien quand rien ne correspond', async () => {
      const { store: s } = store();
      await s.load();
      s.setQuery('introuvable');
      expect(s.visible()).toEqual([]);
    });
  });

  describe('ajouter un terme', () => {
    it('refuse une saisie vide sans appeler le backend', async () => {
      const { store: s, service } = store();
      await s.load();
      await expect(s.addTerm('   ')).resolves.toBe('empty');
      expect(service.addTerm).not.toHaveBeenCalled();
    });

    // ⚠️ Le doublon est refusé ICI pour que le message soit dans la langue de l'interface :
    // une erreur remontée de Rust ne serait pas localisée.
    it('refuse un doublon, casse et accents ignorés, sans appeler le backend', async () => {
      const { store: s, service } = store();
      await s.load();
      await expect(s.addTerm('gîtlab')).resolves.toBe('duplicate');
      expect(service.addTerm).not.toHaveBeenCalled();
    });

    it('crée le terme détouré de ses blancs, puis relit', async () => {
      const { store: s, service } = store();
      await s.load();
      await expect(s.addTerm('  Anthropic ')).resolves.toBe('added');
      expect(service.addTerm).toHaveBeenCalledWith('Anthropic');
      expect(service.list).toHaveBeenCalledTimes(2);
    });
  });

  describe('ajouter une graphie', () => {
    it('refuse une saisie vide', async () => {
      const { store: s, service } = store();
      await s.load();
      await expect(s.addVariant(1, ' ')).resolves.toBe('empty');
      expect(service.addVariant).not.toHaveBeenCalled();
    });

    it('refuse une graphie déjà listée SOUS CE TERME', async () => {
      const { store: s, service } = store();
      await s.load();
      await expect(s.addVariant(1, 'Git Lab')).resolves.toBe('duplicate');
      expect(service.addVariant).not.toHaveBeenCalled();
    });

    // ⚠️ La contrainte de base est `UNIQUE (term_id, variant)` : deux termes différents
    // peuvent légitimement partager une graphie.
    it('accepte sous un AUTRE terme une graphie déjà prise ailleurs', async () => {
      const { store: s, service } = store();
      await s.load();
      await expect(s.addVariant(2, 'git lab')).resolves.toBe('added');
      expect(service.addVariant).toHaveBeenCalledWith(2, 'git lab');
    });

    it('accepte une graphie sous un terme inconnu du store', async () => {
      // Repli : la liste vient d'être relue ailleurs. Le backend tranchera.
      const { store: s, service } = store();
      await s.load();
      await expect(s.addVariant(99, 'inédit')).resolves.toBe('added');
      expect(service.addVariant).toHaveBeenCalledWith(99, 'inédit');
    });
  });

  it('supprime un terme puis relit', async () => {
    const { store: s, service } = store();
    await s.load();
    await s.removeTerm(1);
    expect(service.removeTerm).toHaveBeenCalledWith(1);
    expect(service.list).toHaveBeenCalledTimes(2);
  });

  it('supprime une graphie puis relit', async () => {
    const { store: s, service } = store();
    await s.load();
    await s.removeVariant(10);
    expect(service.removeVariant).toHaveBeenCalledWith(10);
    expect(service.list).toHaveBeenCalledTimes(2);
  });
});
