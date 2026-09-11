import { Component, input } from '@angular/core';

/**
 * Une ligne du transcript, telle que ce composant a besoin de la connaître.
 *
 * @remarks
 * ⚠️ Ce n'est pas le contrat du backend : la transcription qui remonte du pont porte des mots
 * horodatés et des bornes de paragraphe, dont rien ne se dessine. C'est au composant intelligent
 * de réduire ce qu'il reçoit au seul texte.
 */
export interface TranscriptLine {
  readonly text: string;
}

/**
 * Le transcript d'un média ou d'une session : du texte, en paragraphes justifiés.
 *
 * ```html
 * <app-transcript-view [lines]="lines()" />
 * ```
 *
 * Partagé par la fenêtre-fichier et la fenêtre-session, qui affichent le même transcript.
 */
@Component({
  selector: 'app-transcript-view',
  templateUrl: './transcript-view.html',
  styleUrl: './transcript-view.scss',
})
export class TranscriptView {
  /** Les paragraphes à afficher, dans l'ordre. */
  readonly lines = input.required<readonly TranscriptLine[]>();
}
