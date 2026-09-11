import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Dictionary } from './dictionary';
import { DictationBridge } from '../bridge/dictation/dictation.bridge';

function service(bridge: Partial<Record<string, unknown>> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DictationBridge,
        useValue: {
          listDictionaryTerms: vi.fn().mockResolvedValue([]),
          addDictionaryTerm: vi.fn().mockResolvedValue(null),
          deleteDictionaryTerm: vi.fn().mockResolvedValue(undefined),
          addDictionaryVariant: vi.fn().mockResolvedValue(null),
          deleteDictionaryVariant: vi.fn().mockResolvedValue(undefined),
          ...bridge,
        },
      },
    ],
  });
  return { dictionary: TestBed.inject(Dictionary), bridge: TestBed.inject(DictationBridge) };
}

describe('Dictionary', () => {
  it('rend les termes du pont', async () => {
    const entry = { id: 1, term: 'GitLab', variants: [] };
    const { dictionary } = service({ listDictionaryTerms: vi.fn().mockResolvedValue([entry]) });
    await expect(dictionary.list()).resolves.toEqual([entry]);
  });

  // ⚠️ Hors contexte Tauri le pont rend `null`, et une liste absente n'est pas la même chose
  // qu'une liste vide pour un `@for`. La conversion se fait ici, une fois.
  it('ramène l’absence de pont à une liste vide', async () => {
    const { dictionary } = service({ listDictionaryTerms: vi.fn().mockResolvedValue(null) });
    await expect(dictionary.list()).resolves.toEqual([]);
  });

  it('crée un terme et rend la ligne', async () => {
    const created = { id: 2, term: 'Kubernetes', variants: [] };
    const { dictionary } = service({ addDictionaryTerm: vi.fn().mockResolvedValue(created) });
    await expect(dictionary.addTerm('Kubernetes')).resolves.toEqual(created);
  });

  it('supprime un terme', async () => {
    const { dictionary, bridge } = service();
    await dictionary.removeTerm(3);
    expect(bridge.deleteDictionaryTerm).toHaveBeenCalledWith(3);
  });

  it('ajoute une graphie sous un terme', async () => {
    const variant = { id: 9, value: 'git lab' };
    const { dictionary, bridge } = service({
      addDictionaryVariant: vi.fn().mockResolvedValue(variant),
    });
    await expect(dictionary.addVariant(1, 'git lab')).resolves.toEqual(variant);
    expect(bridge.addDictionaryVariant).toHaveBeenCalledWith(1, 'git lab');
  });

  it('retire une graphie par son identifiant', async () => {
    const { dictionary, bridge } = service();
    await dictionary.removeVariant(9);
    expect(bridge.deleteDictionaryVariant).toHaveBeenCalledWith(9);
  });
});
