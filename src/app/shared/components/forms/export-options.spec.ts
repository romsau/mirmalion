import { describe, expect, it } from 'vitest';
import { EXPORT_OPTIONS, exportOptionsFor } from './export-options';

describe('exportOptionsFor', () => {
  it('propose tout ce que le menu porte quand les mots sont horodatés', () => {
    expect(exportOptionsFor(true)).toEqual(EXPORT_OPTIONS);
  });

  /**
   * ⚠️ **Le point de cette fonction.** Un `.srt` dont tous les repères vaudraient `00:00:00` est
   * accepté par le lecteur et ne montre rien — pire qu'une absence, l'utilisateur croyant avoir
   * exporté. Les autres formats restent : un document vide donne un fichier vide, ce qui est au
   * moins honnête.
   */
  it('retire les deux formats de sous-titres quand il n’y a rien à horodater', () => {
    const values = exportOptionsFor(false).map((option) => option.value);

    expect(values).not.toContain('srt');
    expect(values).not.toContain('vtt');
    expect(values).toHaveLength(EXPORT_OPTIONS.length - 2);
  });

  it('garde le presse-papiers et l’ordre du menu dans les deux cas', () => {
    // ⚠️ L'ordre n'est pas retrié à la langue : ce sont des sigles presque identiques partout, et
    // les retrier ferait bouger un menu qu'on apprend par la position.
    expect(exportOptionsFor(false).map((option) => option.value)).toEqual([
      'copy',
      'csv',
      'json',
      'markdown',
      'pdf',
      'plainText',
      'docx',
    ]);
  });

  it('ne propose jamais le libellé de tête comme un choix', () => {
    // ⚠️ `''` fait partie d'`ExportChoice` parce que c'est la valeur portée entre deux actions,
    // jamais parce qu'on pourrait la choisir.
    expect(EXPORT_OPTIONS.map((option) => option.value)).not.toContain('');
  });
});
