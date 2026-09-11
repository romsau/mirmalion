import { Component, ElementRef, afterRenderEffect, computed, inject, input } from '@angular/core';
import { LANGUAGE_NAMES } from '../../../../core/models/language';
import type { Language } from '../../../../core/models/settings';
import type { LiveLine } from '../../../../core/services/live/live';
import type { PendingSpeech } from '../../../../core/store/direct/direct.store';
import type { LiveStream } from '../../../../core/services/bridge/live/live.bridge';

/**
 * Combien de lignes acquises restent à l'écran.
 *
 * @remarks
 * ⚠️ Un plafond d'affichage, pas de mémoire : le magasin garde tout. Deux heures de session
 * produisent des milliers de lignes, et les garder montées ferait ramer un écran qui ne fait que
 * défiler.
 */
const VISIBLE_LINES = 200;

/**
 * À quelle distance du bas on considère que l'utilisateur « suit ».
 *
 * @remarks
 * ⚠️ Le défilement automatique ne doit pas se battre avec l'utilisateur : qui remonte pour relire
 * une phrase serait ramené en bas à chaque mot prononcé. Au-delà de cette marge, on le laisse où
 * il est.
 */
const FOLLOW_THRESHOLD_PX = 80;

/**
 * La longueur au-delà de laquelle un paragraphe se coupe, faute de silence. Environ deux minutes
 * de parole, soit un paragraphe de livre.
 *
 * @remarks
 * ⚠️ Le silence seul ne suffit pas : une discussion animée n'a aucune pause de deux secondes et
 * demie, et rendrait un bloc unique — illisible sur une session de plusieurs heures.
 */
const PARAGRAPH_CHARS = 800;

/** Un paragraphe du transcript acquis, et sa traduction quand il y en a une. */
interface Paragraph {
  readonly id: string;
  text: string;
  /**
   * Le même paragraphe dans la langue de suivi. Vide tant que rien n'est traduit.
   *
   * @remarks
   * ⚠️ Il se compose aux mêmes frontières que l'original, segment par segment : c'est ce qui
   * garde les deux colonnes en regard. Un regroupement propre à la traduction les ferait dériver
   * dès qu'un segment manque, et l'utilisateur lirait le paragraphe d'à côté.
   */
  translated: string;
}

/** Une ligne telle que le gabarit la consomme — acquise ou en cours. */
interface RenderedLine {
  readonly id: string;
  readonly stream: LiveStream;
  readonly text: string;
  /** Une hypothèse, que le curseur clignotant signale. */
  readonly live: boolean;
}

/**
 * Le transcript d'une session pendant qu'elle a lieu : du texte, sans étiquette de locuteur.
 *
 * @example
 * ```html
 * <app-direct-transcript
 *   [lines]="…" [pending]="…" [translations]="…"
 *   [sourceLanguage]="…" [targetLanguage]="…" [showOriginal]="…"
 * />
 * ```
 *
 * @remarks
 * - ⚠️ Sans étiquette, l'écho du micro apparaît deux fois à l'identique, sans rien pour
 *   l'expliquer : le filtre `live::echo_text` l'écarte, et il en devient plus nécessaire.
 * - ⚠️ Une ligne acquise ne change jamais ; une hypothèse, elle, peut disparaître — c'est ainsi
 *   que l'écho s'efface quand le segment acquis le confirme.
 * - ⚠️ Deux hypothèses vivantes : les flux se chevauchent, une seule les écraserait.
 */
@Component({
  selector: 'app-direct-transcript',
  imports: [],
  templateUrl: './direct-transcript.html',
  styleUrl: './direct-transcript.scss',
  // ⚠️ L'hôte est le conteneur qui défile, et il n'y a pas de div dedans : un `viewChild` sur un
  // conteneur intérieur laisse des chemins d'absence inatteignables, que le seuil de couverture à
  // 100 % refuse. L'élément hôte, lui, existe toujours.
  host: {
    class: 'live-transcript',
    // ⚠️ `polite`, jamais `assertive` : un transcript qui interrompt la synthèse vocale à chaque
    // phrase rendrait la session inécoutable pour qui la suit au casque.
    role: 'log',
    'aria-live': 'polite',
    // ⚠️ Sans cela, une hypothèse révisée dix fois par seconde serait réannoncée en entier à
    // chaque révision.
    'aria-relevant': 'additions',
    '[attr.aria-label]': 'label',
    '(scroll)': 'onScroll()',
  },
})
export class DirectTranscript {
  /** Les segments acquis, dans leur ordre d'arrivée. */
  readonly lines = input.required<readonly LiveLine[]>();
  /** Ce qui est en train d'être dit, par flux. */
  readonly pending = input.required<PendingSpeech>();
  /**
   * La traduction de chaque segment acquis, par identifiant.
   *
   * ⚠️ **Une ligne absente n'est pas une panne** : elle n'est pas encore traduite, ou sa paire
   * manque. Le paragraphe rend alors ce qu'il a.
   */
  readonly translations = input<Readonly<Record<number, string>>>({});
  /** La langue parlée — l'en-tête de la colonne d'original. */
  readonly sourceLanguage = input<Language | null>(null);
  /** La langue de suivi, `null` quand la session n'en a pas demandé. */
  readonly targetLanguage = input<Language | null>(null);
  /**
   * La colonne d'original est-elle ouverte ?
   *
   * @remarks
   * ⚠️ Fermée, elle n'existe pas — c'est `@if` dans le gabarit, jamais un masquage CSS : masquée,
   * elle resterait dans l'arbre d'accessibilité et un lecteur d'écran annoncerait deux fois
   * chaque réplique.
   */
  readonly showOriginal = input(false);

  /** Le conteneur qui défile : c'est l'élément hôte lui-même. Voir le décorateur. */
  private readonly viewport = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly label = $localize`:@@direct.transcript.label:Transcription en direct`;

  /** L'utilisateur suit-il le bas du transcript ? Voir `FOLLOW_THRESHOLD_PX`. */
  private following = true;

  /**
   * Le texte acquis, d'un seul tenant : les segments du moteur joints en paragraphes.
   *
   * @remarks
   * ⚠️ Un flux de texte, jamais une ligne par segment : sans étiquette de locuteur, les retours à
   * la ligne du moteur sont arbitraires — ils suivent ses respirations et alternent entre deux
   * flux qui ne se coordonnent pas. Le résultat se lit comme un texte cassé.
   */
  protected readonly settled = computed<readonly Paragraph[]>(() => {
    const paragraphs: Paragraph[] = [];
    for (const line of this.lines().slice(-VISIBLE_LINES)) {
      const current = paragraphs.at(-1);
      // ⚠️ Deux raisons de couper, et elles ne se remplacent pas : le silence dit où la session a
      // marqué une pause, la longueur garantit une coupure même quand personne ne s'arrête de
      // parler. Voir `PARAGRAPH_CHARS`.
      const translated = this.translations()[line.id] ?? '';
      if (current === undefined || line.paragraph || current.text.length >= PARAGRAPH_CHARS) {
        paragraphs.push({ id: `par-${line.id}`, text: line.text, translated });
        continue;
      }
      current.text = `${current.text} ${line.text}`;
      // ⚠️ Un segment non traduit n'ajoute rien, et n'insère surtout pas d'espace en trop : la
      // colonne de gauche se remplit à mesure, sans trou visible.
      current.translated =
        translated.length === 0
          ? current.translated
          : `${current.translated} ${translated}`.trimStart();
    }
    return paragraphs;
  });

  /**
   * Le transcript est-il présenté en deux colonnes ? Il y faut une langue de suivi — sans elle,
   * rien à mettre en face — et que l'utilisateur ait demandé l'original.
   */
  protected readonly split = computed(() => this.targetLanguage() !== null && this.showOriginal());

  /**
   * Les en-têtes de colonne, ou `null` quand il n'y a qu'une colonne. Ils nomment la langue, le
   * rôle ne venant qu'en second : au milieu d'une session on cherche « où est l'anglais ».
   *
   * @remarks
   * ⚠️ Dans la langue de l'interface, jamais dans celle qu'on nomme : « Allemand », pas
   * « Deutsch ».
   */
  protected readonly headings = computed(() => {
    const target = this.targetLanguage();
    const source = this.sourceLanguage();
    if (!this.split() || target === null || source === null) {
      return null;
    }
    return { translated: LANGUAGE_NAMES[target], original: LANGUAGE_NAMES[source] };
  });

  /**
   * Ce que la colonne de gauche affiche : la traduction quand il y en a une, l'original sinon —
   * c'est la traduction qu'on suit en direct, et le regard part de la gauche.
   *
   * @remarks
   * ⚠️ Sans langue de suivi, la colonne unique porte l'original ; elle ne devient pas vide.
   */
  protected readonly leading = computed<readonly Paragraph[]>(() =>
    this.targetLanguage() === null
      ? this.settled()
      : this.settled().map((paragraph) => ({ ...paragraph, text: paragraph.translated })),
  );

  /**
   * Ce qui est en train d'être dit, et qui n'est pas encore sûr. Une transcription en direct
   * affiche des prédictions qu'elle révise ensuite — l'instabilité de texte propre au streaming.
   *
   * @remarks
   * - ⚠️ Le provisoire doit se voir comme tel, en atténué : le même doublon en texte plein se lit
   *   comme un bug plutôt que comme un système qui se stabilise.
   * - ⚠️ Les hypothèses vont toujours à la fin, quel que soit l'ordre où les flux se sont mis à
   *   parler : c'est le seul placement qui ne fasse pas bouger du texte déjà lu.
   */
  protected readonly live = computed<readonly RenderedLine[]>(() => {
    const pending = this.pending();
    const live: RenderedLine[] = [];
    // ⚠️ La clé d'une hypothèse est son flux, pas un compteur : elle est révisée plusieurs fois
    // par seconde, et une clé qui changerait à chaque révision remonterait l'élément entier du
    // DOM au lieu d'en remplacer le texte — donc rejouerait le fondu d'entrée.
    if (pending.system !== null) {
      live.push({ id: 'live-system', stream: 'system', text: pending.system, live: true });
    }
    if (pending.microphone !== null) {
      live.push({
        id: 'live-microphone',
        stream: 'microphone',
        text: pending.microphone,
        live: true,
      });
    }
    return live;
  });

  /** Ni segment acquis, ni hypothèse : il n'y a rien à montrer. */
  protected readonly isEmpty = computed(
    () => this.settled().length === 0 && this.live().length === 0,
  );

  constructor() {
    // ⚠️ `afterRenderEffect` et non `effect` : la hauteur du conteneur n'est à jour qu'une fois le
    // nouveau texte peint. Mesurée avant, elle ferait défiler vers l'ancienne fin — c'est-à-dire
    // un segment en retard, indéfiniment.
    afterRenderEffect(() => {
      this.settled();
      this.live();
      this.followBottom();
    });
  }

  /** L'utilisateur vient de faire défiler : suit-il encore le bas ? */
  protected onScroll(): void {
    const distance =
      this.viewport.scrollHeight - this.viewport.scrollTop - this.viewport.clientHeight;
    this.following = distance <= FOLLOW_THRESHOLD_PX;
  }

  private followBottom(): void {
    if (!this.following) {
      return;
    }
    this.viewport.scrollTop = this.viewport.scrollHeight;
  }
}
