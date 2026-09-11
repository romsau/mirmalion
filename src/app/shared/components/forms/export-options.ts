/**
 * Le menu « Exporter », partagé par les deux fenêtres-documents.
 *
 * C'est le même menu dans les deux : recopié, il aurait divergé à la première correction — et
 * dans une seule des deux fenêtres, ce qui ne se voit qu'en les ouvrant côte à côte.
 */

import type { ExportFormat } from '../../../core/services/bridge/media/media.bridge';
import type { FormOption } from './form-option';

/**
 * Ce que le menu « Exporter » peut demander.
 *
 * @remarks
 * ⚠️ `''` est le libellé de tête du menu, jamais un choix : il fait partie du type parce que
 * c'est la valeur que le contrôle porte entre deux actions — le menu est une commande.
 */
export type ExportChoice = '' | 'copy' | ExportFormat;

/**
 * Le libellé du menu — son libellé de tête et son nom accessible, en une seule chaîne : le mot
 * affiché entre deux actions est ce que le contrôle fait.
 *
 * @remarks
 * ⚠️ Partagé par les deux fenêtres-documents, comme le menu lui-même.
 */
export const EXPORT_LABEL = $localize`:@@common.export:Exporter`;

/**
 * Les formats du menu, dans l'ordre de la maquette — le presse-papiers d'abord, puis les huit
 * fichiers par ordre alphabétique de leur libellé français.
 *
 * @remarks
 * ⚠️ L'ordre n'est pas retrié à la langue, contrairement aux langues : ce sont des sigles presque
 * identiques partout, et les retrier ferait bouger un menu qu'on apprend par la position.
 */
export const EXPORT_OPTIONS: readonly FormOption<ExportChoice>[] = [
  { value: 'copy', label: $localize`:@@export.clipboard:Copier (presse-papier)` },
  { value: 'csv', label: $localize`:@@export.csv:CSV (.csv)` },
  { value: 'json', label: $localize`:@@export.json:JSON (.json)` },
  { value: 'markdown', label: $localize`:@@export.markdown:Markdown (.md)` },
  { value: 'pdf', label: $localize`:@@export.pdf:PDF (.pdf)` },
  { value: 'srt', label: $localize`:@@export.srt:Sous-titres (.srt)` },
  { value: 'vtt', label: $localize`:@@export.vtt:Sous-titres (.vtt)` },
  { value: 'plainText', label: $localize`:@@export.text:Texte (.txt)` },
  { value: 'docx', label: $localize`:@@export.word:Word (.docx)` },
];

/**
 * Le menu, amputé des sous-titres quand il n'y a pas un mot à horodater.
 *
 * @param withTimecodes - Le contenu exporté porte-t-il des repères de temps ?
 *
 * @remarks
 * ⚠️ Un `.srt` dont tous les repères vaudraient `00:00:00` est accepté par le lecteur et ne montre
 * rien — pire qu'une absence, l'utilisateur croyant avoir exporté. Les autres formats restent :
 * un document vide donne un fichier vide, ce qui est au moins honnête.
 */
export function exportOptionsFor(withTimecodes: boolean): readonly FormOption<ExportChoice>[] {
  return withTimecodes
    ? EXPORT_OPTIONS
    : EXPORT_OPTIONS.filter((option) => option.value !== 'srt' && option.value !== 'vtt');
}
