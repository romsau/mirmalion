import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Translation } from './translation';
import { LanguagesBridge } from '../bridge/languages/languages.bridge';

function harness() {
  const prepareTranslation = vi.fn().mockResolvedValue(undefined);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: LanguagesBridge, useValue: { prepareTranslation } }],
  });
  return { prepareTranslation, service: TestBed.inject(Translation) };
}

describe('Translation', () => {
  it('passe une LANGUE CIBLE et les langues parlées, jamais une paire', async () => {
    // ⚠️ **Le test qui garde la frontière.** Le choix de la paire ordonnée appartient au
    // backend : l'interface ne parle jamais de paires, et la lui faire choisir ici
    // l'obligerait à manipuler exactement ce qu'on a décidé de lui cacher. Une version
    // antérieure lisait la disponibilité et calculait la paire en TypeScript — elle envoyait
    // `{ target, source }` là où Rust attendait `{ target, spoken }`, si bien que l'appel
    // aurait échoué en vrai sans qu'aucun test ne le voie.
    const { service, prepareTranslation } = harness();
    await service.offerDownload('it', ['fr', 'en']);
    expect(prepareTranslation).toHaveBeenCalledWith('it', ['fr', 'en']);
  });

  it('ne lit AUCUN état avant de demander', async () => {
    // Rien n'est mis en cache et rien n'est consulté ici : le backend décide s'il manque
    // quelque chose, et le pipeline de dictée relit la machine à chaque emploi.
    const { service } = harness();
    const tauri = TestBed.inject(LanguagesBridge) as unknown as Record<string, unknown>;
    await service.offerDownload('it', ['fr']);
    expect(Object.keys(tauri)).toEqual(['prepareTranslation']);
  });

  it('ne promet rien : une demande partie n’est pas un téléchargement', async () => {
    // L'utilisateur peut refermer la feuille d'Apple par *Done* sans rien prendre, et une
    // installation acceptée se poursuit en arrière-plan. Le type ne dit donc rien de plus.
    const { service } = harness();
    await expect(service.offerDownload('it', ['fr'])).resolves.toBeUndefined();
  });

  it('demande une fois par geste, sans mémoriser le précédent', async () => {
    const { service, prepareTranslation } = harness();
    await service.offerDownload('it', ['fr']);
    await service.offerDownload('it', ['fr']);
    expect(prepareTranslation).toHaveBeenCalledTimes(2);
  });
});
