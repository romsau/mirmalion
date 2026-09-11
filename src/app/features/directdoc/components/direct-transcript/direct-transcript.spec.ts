import { describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DirectTranscript } from './direct-transcript';
import type { LiveLine } from '../../../../core/services/live/live';
import type { PendingSpeech } from '../../../../core/store/direct/direct.store';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const NOTHING_PENDING: PendingSpeech = { system: null, microphone: null };

interface Options {
  readonly lines?: readonly LiveLine[];
  readonly pending?: PendingSpeech;
  readonly translations?: Record<number, string>;
  readonly sourceLanguage?: string | null;
  readonly targetLanguage?: string | null;
  readonly showOriginal?: boolean;
}

async function render(overrides: Options = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(DirectTranscript);
  fixture.componentRef.setInput('lines', overrides.lines ?? []);
  fixture.componentRef.setInput('pending', overrides.pending ?? NOTHING_PENDING);
  fixture.componentRef.setInput('translations', overrides.translations ?? {});
  fixture.componentRef.setInput('sourceLanguage', overrides.sourceLanguage ?? null);
  fixture.componentRef.setInput('targetLanguage', overrides.targetLanguage ?? null);
  fixture.componentRef.setInput('showOriginal', overrides.showOriginal ?? false);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

/** Les colonnes rendues, dans l'ordre — traduction d'abord, original ensuite. */
function columnsOf(fixture: ComponentFixture<DirectTranscript>): HTMLElement[] {
  return [...rootOf(fixture).querySelectorAll<HTMLElement>('.tr-col')];
}

function paragraphsOf(column: HTMLElement): string[] {
  return [...column.querySelectorAll('.tpar')].map(
    (paragraph) => paragraph.textContent?.trim() ?? '',
  );
}

function rootOf(fixture: ComponentFixture<DirectTranscript>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Les paragraphes affichés — acquis puis en cours. */
function linesOf(fixture: ComponentFixture<DirectTranscript>): string[] {
  return [...rootOf(fixture).querySelectorAll('.tpar')].map(
    (paragraph) => paragraph.textContent?.trim() ?? '',
  );
}

/** ⚠️ **L'hôte EST le conteneur qui défile** — il n'y a pas de div à l'intérieur. */
function viewportOf(fixture: ComponentFixture<DirectTranscript>): HTMLElement {
  return rootOf(fixture);
}

/**
 * Une suite de segments acquis, prête à passer en entrée.
 *
 * ⚠️ **Seul le FLUX distingue les segments** : le direct ne porte plus de numéro de locuteur.
 * Le troisième champ, facultatif, dit que le segment suit un **silence** — l'écran y ouvre alors
 * un nouveau paragraphe.
 */
function settled(
  ...entries: ([LiveLine['stream'], string] | [LiveLine['stream'], string, 'pause'])[]
): LiveLine[] {
  return entries.map(([stream, text, pause], index) => ({
    id: index,
    stream,
    text,
    paragraph: pause === 'pause',
  }));
}

describe('DirectTranscript', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **AUCUNE ÉTIQUETTE DE LOCUTEUR — LE DIRECT NE MONTRE QUE LE TEXTE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(porteur, 2026-08-06 : « on veut juste le texte de l'ensemble du son »)*. La maquette
   * dessine des pastilles ici ; elles sont retirées sur décision, et ce test garde la décision.
   * Trois étiquettes ont existé — « Locuteur N », puis « Moi » et « Participant » — et les
   * deux dernières étaient justes : elles sont tombées faute d'usage, pas faute de fiabilité.
   */
  it('shows the text of both streams without labelling anyone', async () => {
    const fixture = await render({
      lines: settled(['system', 'Bon, on commence ?'], ['microphone', 'De mon côté…']),
    });

    expect(linesOf(fixture)).toEqual(['Bon, on commence ? De mon côté…']);
    expect(rootOf(fixture).querySelectorAll('.spk')).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE TEXTE RESPIRE AUX SILENCES DE LA SESSION, ET NULLE PART AILLEURS.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(porteur, 2026-08-06)*. Un retour à la ligne par segment n'avait plus de sens sans pastille
   * de locuteur — le moteur découpe au gré de ses respirations. Mais tout coller ferait d'une
   * session de plusieurs heures « un monolithe humainement illisible ». Ce qui reste et qui a du
   * sens, c'est la pause : quand personne ne parlait, le texte s'arrête aussi.
   */
  it('opens a new paragraph where the live fell silent', async () => {
    const fixture = await render({
      lines: settled(
        ['system', 'Bon, on commence ?'],
        ['microphone', 'Oui.'],
        ['system', 'Passons au budget.', 'pause'],
      ),
    });

    expect(linesOf(fixture)).toEqual(['Bon, on commence ? Oui.', 'Passons au budget.']);
  });

  /**
   * ⚠️⚠️ **LE SILENCE SEUL NE SUFFIT PAS.** Une discussion animée n'a aucune pause de deux
   * secondes et demie : sans second garde-fou, elle rendrait le bloc unique qu'on cherche
   * précisément à éviter. La coupure sur la longueur est arbitraire, et c'est assumé — elle
   * n'arrive **qu'à défaut** de la bonne.
   */
  it('cuts a paragraph that grows too long even without a pause', async () => {
    const talkative: LiveLine[] = Array.from({ length: 40 }, (_, index) => ({
      id: index,
      stream: 'system' as const,
      text: `phrase numéro ${index} sans la moindre pause`,
      paragraph: false,
    }));
    const fixture = await render({ lines: talkative });

    expect(linesOf(fixture).length).toBeGreaterThan(1);
  });

  /**
   * ⚠️⚠️ **DEUX LIGNES VIVANTES, LÀ OÙ LA MAQUETTE N'EN MONTRE QU'UNE.** Elle fige un instant
   * où une seule personne parle ; en session, l'utilisateur et un interlocuteur se chevauchent
   * constamment. N'en afficher qu'une ferait s'écraser mutuellement les deux flux.
   */
  it('shows one live line per stream, both at the end', async () => {
    const fixture = await render({
      lines: settled(['system', 'Point roadmap.']),
      pending: { system: 'Il reste les tests', microphone: 'Je prends les bugs' },
    });

    expect(linesOf(fixture)).toEqual([
      'Point roadmap.',
      'Il reste les tests',
      'Je prends les bugs',
    ]);
    expect(rootOf(fixture).querySelectorAll('.tpar-live')).toHaveLength(2);
  });

  /** Une hypothèse porte le curseur clignotant ; un segment acquis, non. */
  it('marks only the hypotheses as live', async () => {
    const fixture = await render({
      lines: settled(['system', 'Acquis.']),
      pending: { system: 'En cours', microphone: null },
    });

    const shown = rootOf(fixture).querySelectorAll('.tpar');
    expect(shown[0].classList.contains('tpar-live')).toBe(false);
    expect(shown[1].classList.contains('tpar-live')).toBe(true);
  });

  /**
   * ⚠️⚠️ **LE PLAFOND EST D'AFFICHAGE, PAS DE MÉMOIRE.** Le store garde tout — c'est de lui que
   * P4-06 fera le document. Ici on borne le DOM : des milliers de lignes montées feraient ramer
   * un écran dont le seul travail est de défiler.
   */
  it('mounts only the tail of a long live, keeping the newest', async () => {
    const many: LiveLine[] = Array.from({ length: 500 }, (_, index) => ({
      id: index,
      stream: 'system' as const,
      text: `ligne ${index}`,
      // ⚠️ Chacun suit un silence : sans cela ils se joindraient en un seul paragraphe et le
      // plafond d'affichage ne se mesurerait plus.
      paragraph: true,
    }));
    const fixture = await render({ lines: many });

    const rendered = linesOf(fixture);
    expect(rendered.length).toBeLessThan(500);
    expect(rendered.at(-1)).toContain('ligne 499');
    expect(rendered.at(0)).not.toContain('ligne 0');
  });

  /**
   * ⚠️ **La maquette ne dessine pas cet état, et il est pourtant nécessaire** : elle fige un
   * instant de session déjà avancée. Sans lui, l'écran reste vide les premières secondes — le
   * moment exact où l'utilisateur se demande si quelque chose s'est passé.
   */
  it('invites the first words when nothing has been said yet', async () => {
    const fixture = await render();
    expect(rootOf(fixture).querySelector('.lt-empty')).not.toBeNull();

    const speaking = await render({ pending: { system: 'Bonjour', microphone: null } });
    expect(rootOf(speaking).querySelector('.lt-empty')).toBeNull();
  });

  /**
   * ⚠️⚠️ **LE DÉFILEMENT NE DOIT PAS SE BATTRE AVEC L'UTILISATEUR.** Quelqu'un qui remonte pour
   * relire une phrase serait ramené en bas à chaque mot prononcé — l'écran lui arracherait sa
   * lecture des mains.
   */
  it('follows the bottom, and lets go once the reader scrolls up', async () => {
    const fixture = await render({ lines: settled(['system', 'Un.']) });
    const viewport = viewportOf(fixture);

    // jsdom ne met rien en page : on lui donne des dimensions pour que la distance au bas
    // signifie quelque chose. Sans cela, tout vaut zéro et le test ne mesure rien.
    Object.defineProperty(viewport, 'scrollHeight', { value: 1_000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true });

    // Au bas : on suit.
    viewport.scrollTop = 800;
    viewport.dispatchEvent(new Event('scroll'));
    fixture.componentRef.setInput('lines', settled(['system', 'Un.'], ['system', 'Deux.']));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(1_000);

    // Remonté loin : on lâche, et une nouvelle ligne ne ramène plus personne en bas.
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
    fixture.componentRef.setInput(
      'lines',
      settled(['system', 'Un.'], ['system', 'Deux.'], ['system', 'Trois.']),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(viewport.scrollTop).toBe(100);
  });

  /**
   * ⚠️ **`aria-live="polite"`, jamais `assertive`.** Un transcript qui interrompt la synthèse
   * vocale à chaque phrase rendrait la session inécoutable pour qui la suit au casque.
   */
  it('announces new lines politely, and only the additions', async () => {
    const viewport = viewportOf(await render());
    expect(viewport.getAttribute('role')).toBe('log');
    expect(viewport.getAttribute('aria-live')).toBe('polite');
    expect(viewport.getAttribute('aria-relevant')).toBe('additions');
  });

  it('has no accessibility violations', async () => {
    await expectNoAxeViolations(rootOf(await render()));
    await expectNoAxeViolations(
      rootOf(
        await render({
          lines: settled(['system', 'On commence ?'], ['microphone', 'Oui.']),
          pending: { system: 'Alors', microphone: 'Je note' },
        }),
      ),
    );
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **LA TRADUCTION EN DIRECT** *(P4-20)*.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe('DirectTranscript, translated', () => {
  const SPOKEN = settled(
    ['system', 'Bon, on commence ?'],
    ['microphone', 'Oui.'],
    ['system', 'Parfait.', 'pause'],
  );

  /**
   * ⚠️⚠️ **SANS LANGUE DE SUIVI, UNE SEULE COLONNE ET AUCUN EN-TÊTE.** Ce qui s'affiche **est**
   * déjà l'original : le nommer serait répondre à une question que personne n'a posée.
   */
  it('stays a single unlabelled column when nothing is translated', async () => {
    const fixture = await render({ lines: SPOKEN });

    expect(columnsOf(fixture)).toHaveLength(1);
    expect(rootOf(fixture).querySelector('.tr-col-head')).toBeNull();
    expect(rootOf(fixture).querySelector('.tr-cols')?.classList).toContain('is-single');
  });

  /**
   * ⚠️⚠️ **LA TRADUCTION À GAUCHE, L'ORIGINAL À DROITE** *(décision 5)* : c'est la traduction
   * qu'on suit en direct, et le regard part de la gauche. L'original est la référence qu'on
   * consulte, pas le texte qu'on lit.
   */
  it('puts the translation on the left and the original on the right', async () => {
    const fixture = await render({
      lines: SPOKEN,
      translations: { 0: 'So, shall we start?', 1: 'Yes.', 2: 'Great.' },
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      showOriginal: true,
    });
    const [translated, original] = columnsOf(fixture);

    expect(paragraphsOf(translated)).toEqual(['So, shall we start? Yes.', 'Great.']);
    expect(paragraphsOf(original)).toEqual(['Bon, on commence ? Oui.', 'Parfait.']);
  });

  /**
   * ⚠️⚠️ **LES EN-TÊTES NOMMENT LA LANGUE, PAS UN RÔLE** : au milieu d'une session on cherche
   * « où est l'anglais ». ⚠️ **Dans la langue de l'INTERFACE**, jamais en écriture native.
   */
  it('names the language of each column, with its role in second', async () => {
    const fixture = await render({
      lines: SPOKEN,
      sourceLanguage: 'fr',
      targetLanguage: 'it',
      showOriginal: true,
    });
    const heads = [...rootOf(fixture).querySelectorAll('.tr-col-head')].map((head) =>
      head.textContent?.trim().replace(/\s+/g, ' '),
    );

    expect(heads).toEqual(['Italien traduction', 'Français original']);
    expect(heads.join(' ')).not.toContain('日本語');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **COLONNE FERMÉE, L'ORIGINAL N'EXISTE PAS — IL N'EST PAS MASQUÉ** *(décision 5)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Masqué en CSS, il resterait dans l'arbre d'accessibilité et un lecteur d'écran annoncerait
   * **deux fois** chaque réplique. C'est un `@if`, et rien d'autre.
   */
  it('does not render the original at all while the switch is off', async () => {
    const fixture = await render({
      lines: SPOKEN,
      translations: { 0: 'So, shall we start?' },
      sourceLanguage: 'fr',
      targetLanguage: 'en',
    });

    expect(columnsOf(fixture)).toHaveLength(1);
    expect(rootOf(fixture).textContent).not.toContain('Bon, on commence');
  });

  /**
   * ⚠️⚠️ **RIEN NE BLOQUE L'AFFICHAGE EN ATTENDANT UNE TRADUCTION.** Un segment non traduit
   * n'ajoute rien et n'insère surtout pas d'espace en trop : la colonne de gauche se remplit à
   * mesure, sans trou visible, et le transcript continue d'avancer. Un transcript qui
   * s'arrêterait se lirait comme une panne.
   */
  it('shows what it has when a segment is not translated yet', async () => {
    const fixture = await render({
      lines: SPOKEN,
      translations: { 1: 'Yes.' },
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      showOriginal: true,
    });
    const [translated, original] = columnsOf(fixture);

    expect(paragraphsOf(translated)).toEqual(['Yes.', '']);
    expect(paragraphsOf(original)).toEqual(['Bon, on commence ? Oui.', 'Parfait.']);
  });

  /**
   * ⚠️⚠️ **L'HYPOTHÈSE N'EST JAMAIS TRADUITE** *(décision 5)*, et elle reste donc dans la langue
   * parlée jusque dans la colonne de traduction. Traduire du texte qui va être révisé rendrait
   * une traduction qui se réécrit toute seule — et l'atténué dit déjà que ce n'est pas définitif.
   */
  it('never translates a hypothesis, and keeps it in the spoken language', async () => {
    const fixture = await render({
      lines: SPOKEN,
      pending: { system: 'et pour la traduction', microphone: null },
      translations: { 0: 'So, shall we start?', 1: 'Yes.', 2: 'Great.' },
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      showOriginal: true,
    });
    const [translated] = columnsOf(fixture);

    expect(translated.querySelector('.tpar-live')?.textContent?.trim()).toBe(
      'et pour la traduction',
    );
    // L'hypothèse ne vit que dans la colonne de gauche : la dupliquer à droite l'afficherait deux
    // fois, dans la même langue.
    expect(paragraphsOf(columnsOf(fixture)[1])).not.toContain('et pour la traduction');
  });

  it('has no accessibility violations while translating', async () => {
    const fixture = await render({
      lines: SPOKEN,
      translations: { 0: 'So, shall we start?' },
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      showOriginal: true,
    });
    await expectNoAxeViolations(rootOf(fixture));
  });
});
