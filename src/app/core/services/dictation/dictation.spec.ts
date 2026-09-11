import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Dictation } from './dictation';
import type { DictationRecord, InputDevice } from '../bridge/dictation/dictation.bridge';
import { DictationBridge } from '../bridge/dictation/dictation.bridge';
import { ShortcutBridge } from '../bridge/shortcut/shortcut.bridge';

const DEVICES: readonly InputDevice[] = [
  { id: '42', name: 'Micro du MacBook Pro', isDefault: true },
  { id: '77', name: 'Blue Yeti', isDefault: false },
];

const RECORDS: readonly DictationRecord[] = [
  {
    id: 7,
    language: 'fr',
    rawText: 'bonjour tout le monde',
    cleanedText: 'Bonjour tout le monde.',
    rephrasedText: null,
    translatedText: null,
    translatedLanguage: null,
  },
];

function harness(overrides: Record<string, unknown> = {}) {
  const tauri = {
    listInputDevices: vi.fn().mockResolvedValue(DEVICES),
    setShortcutMode: vi.fn().mockResolvedValue(undefined),
    getRephrasingPrompt: vi.fn().mockResolvedValue('Ton professionnel.'),
    setRephrasingPrompt: vi.fn().mockResolvedValue(undefined),
    listDictations: vi.fn().mockResolvedValue(RECORDS),
    deleteDictation: vi.fn().mockResolvedValue(undefined),
    clearDictations: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DictationBridge, useValue: tauri },
      { provide: ShortcutBridge, useValue: tauri },
    ],
  });
  return { tauri, service: TestBed.inject(Dictation) };
}

describe('Dictation', () => {
  it('lists the machine inputs', async () => {
    const { service } = harness();
    await expect(service.inputDevices()).resolves.toEqual(DEVICES);
  });

  it('gives an empty list rather than null outside Tauri', async () => {
    // Le sélecteur doit pouvoir se construire sans avoir à distinguer « aucun micro » de
    // « pas de backend » : les deux se rendent pareil.
    const { service } = harness({ listInputDevices: vi.fn().mockResolvedValue(null) });
    await expect(service.inputDevices()).resolves.toEqual([]);
  });

  it('pushes the mode to the running shortcut', async () => {
    // ⚠️ Écrire `dictationMode` dans les réglages ne suffit pas : le backend ne relit ce
    // fichier qu'au démarrage. Sans cet appel, l'utilisateur bascule et rien ne change.
    const { service, tauri } = harness();
    await service.applyMode('toggle');
    expect(tauri.setShortcutMode).toHaveBeenCalledExactlyOnceWith('toggle');
  });

  it('reads the custom rephrasing prompt from the encrypted database', async () => {
    // ⚠️ Pas des réglages : c'est du texte libre de l'utilisateur.
    const { service } = harness();
    await expect(service.rephrasingPrompt()).resolves.toBe('Ton professionnel.');
  });

  it('gives an empty string rather than null when no prompt was ever written', async () => {
    // L'appelant remplit un champ de saisie, qui ne connaît que la chaîne vide.
    const { service } = harness({ getRephrasingPrompt: vi.fn().mockResolvedValue(null) });
    await expect(service.rephrasingPrompt()).resolves.toBe('');
  });

  it('saves the custom rephrasing prompt', async () => {
    const { service, tauri } = harness();
    await service.saveRephrasingPrompt('Sans virgule.');
    expect(tauri.setRephrasingPrompt).toHaveBeenCalledExactlyOnceWith('Sans virgule.');
  });

  it('reads the archived dictations', async () => {
    const { service } = harness();
    await expect(service.dictations()).resolves.toEqual(RECORDS);
  });

  it('gives an empty history rather than null outside Tauri', async () => {
    // ⚠️ Le `null` du pont s'absorbe ici, au bord : le magasin qui appelle porte de l'état, et
    // lui faire distinguer « historique vide » de « pas de backend » lui donnerait une branche
    // que rien ne peut atteindre dans l'application livrée.
    const { service } = harness({ listDictations: vi.fn().mockResolvedValue(null) });
    await expect(service.dictations()).resolves.toEqual([]);
  });

  it('deletes one dictation', async () => {
    const { service, tauri } = harness();
    await service.deleteDictation(7);
    expect(tauri.deleteDictation).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('clears the whole history', async () => {
    const { service, tauri } = harness();
    await service.clearDictations();
    expect(tauri.clearDictations).toHaveBeenCalledOnce();
  });
});
