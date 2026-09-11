import { describe, expect, it } from 'vitest';
import {
  LIVE_ID_PREFIX,
  DOCUMENT_ID_PREFIX,
  exportDate,
  windowDocumentId,
} from './document-window';

describe('windowDocumentId', () => {
  /**
   * ⚠️ **Le point de cette fonction.** Le segment n'est pas l'identifiant : l'étiquette de la
   * fenêtre vaut `filedoc-3`, et `applyWindowRoute` la coupe au premier tiret parce qu'Angular
   * n'apparie ses paramètres que sur un segment entier. C'est ici que les deux moitiés se
   * recollent, pour les deux familles de fenêtres.
   */
  it('recolle le préfixe que la route a perdu', () => {
    expect(windowDocumentId(DOCUMENT_ID_PREFIX, '3')).toBe('filedoc-3');
    expect(windowDocumentId(LIVE_ID_PREFIX, '3')).toBe('directdoc-3');
  });

  it('rend le préfixe seul quand la route n’a porté aucun segment', () => {
    // Une route sans paramètre donne `''` : l'identifiant obtenu ne désigne aucun document, et
    // c'est le backend qui le dira — l'écran n'a pas à deviner.
    expect(windowDocumentId(DOCUMENT_ID_PREFIX, '')).toBe('filedoc-');
  });
});

describe('exportDate', () => {
  /**
   * ⚠️ **Le point de cette fonction.** `Intl` sans locale rend celle de l'environnement — donc
   * celle de macOS, jamais celle du bundle chargé. Un Mac en anglais écrirait « Aug 16, 2026 »
   * dans le nom proposé par une interface allemande.
   */
  it('écrit la date dans la langue qu’on lui passe, jamais dans celle du système', () => {
    const today = new Date();

    expect(exportDate('de')).toBe(
      new Intl.DateTimeFormat('de', { dateStyle: 'medium' }).format(today),
    );
    expect(exportDate('fr')).not.toBe(exportDate('en'));
  });
});
