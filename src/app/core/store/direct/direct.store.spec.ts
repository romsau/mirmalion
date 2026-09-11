import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DirectStore } from './direct.store';
import { Live } from '../../services/live/live';
import type { AudioSource, LiveStream } from '../../services/bridge/live/live.bridge';

/** Un évènement de transcript, écrit court — ces tests en enchaînent beaucoup. */
function event(kind: 'partial' | 'final' | 'failed', stream: LiveStream, text: string) {
  return { kind, stream, text } as const;
}

/**
 * L'effacement d'une hypothèse — **et il ne porte aucun texte**, c'est tout son sens.
 *
 * ⚠️ Écrit à part et non comme un `event('dropped', …)` vide : un texte vide serait ignoré par le
 * garde des morceaux vides, et le test ne prouverait rien.
 */
function dropped(stream: LiveStream) {
  return { kind: 'dropped', stream } as const;
}

const SOURCES: readonly AudioSource[] = [
  { id: 'system', name: 'Tout le système', isSystem: true },
  { id: '4212', name: 'Microsoft Teams', isSystem: false },
];

/** Ce que `live.start` rend : le document de la session, dont la fenêtre vient de s'ouvrir. */
const BEGUN = {
  id: 'directdoc-0',
  title: null,
  sourceName: 'Microsoft Teams',
  startedAtMs: 1_754_300_000_000,
  endedAtMs: null,
  transcript: { language: '', paragraphs: [] },
  report: [],
};

/** Ce que le backend répond quand rien ne tourne. */
const AT_REST = {
  phase: 'idle',
  documentId: null,
  startedAtMs: null,
  sourceName: null,
  withMicrophone: false,
};

function harness(overrides: Record<string, unknown> = {}) {
  const live = {
    audioSources: vi.fn().mockResolvedValue(SOURCES),
    start: vi.fn().mockResolvedValue(BEGUN),
    stop: vi.fn().mockResolvedValue(undefined),
    session: vi.fn().mockResolvedValue(AT_REST),
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: Live, useValue: live }],
  });
  return { live, store: TestBed.inject(DirectStore) };
}

describe('DirectStore', () => {
  it('starts empty rather than optimistic', () => {
    // `loaded` distingue « pas encore lu » de « rien à proposer », que la liste seule
    // confondrait.
    const { store } = harness();
    expect(store.sources()).toEqual([]);
    expect(store.loaded()).toBe(false);
    expect(store.sourceId()).toBeNull();
    expect(store.startedAtMs()).toBeNull();
    expect(store.error()).toBeNull();
  });

  it('reads the captureable sources', async () => {
    const { store } = harness();
    await store.load();
    expect(store.sources()).toEqual(SOURCES);
    expect(store.loaded()).toBe(true);
  });

  /**
   * ⚠️ **Un backend muet laisse l'écran lisible.** La liste reste vide, le bouton reste inactif,
   * et l'erreur remonte pour une snackbar — elle ne remonte pas en exception.
   */
  it('never rejects, and keeps the failure for the snackbar', async () => {
    const { store } = harness({ audioSources: vi.fn().mockRejectedValue(new Error('pont muet')) });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.loaded()).toBe(true);
    expect(store.error()?.message).toContain('pont muet');
  });

  it('forgets the failure once it has been said', async () => {
    const { store } = harness({ audioSources: vi.fn().mockRejectedValue(new Error('pont muet')) });
    await store.load();
    store.clearError();
    expect(store.error()).toBeNull();
  });

  /**
   * ⚠️⚠️ **LA SOURCE NE SE MÉMORISE PAS D'UNE OUVERTURE À L'AUTRE**, mais elle survit à une
   * RELECTURE tant qu'elle émet : sans cela, rafraîchir la liste effacerait un choix que
   * l'utilisateur venait de faire.
   */
  it('keeps a chosen source across a reload while it still emits', async () => {
    const { store } = harness();
    await store.load();
    store.select('4212');
    await store.load();
    expect(store.sourceId()).toBe('4212');
  });

  /**
   * ⚠️ **Une application fermée en cours de route perd le choix**, et c'est ce qu'il faut :
   * garder un identifiant disparu laisserait « Démarrer » actif sur une source que l'écran ne
   * montre plus, et le démarrage échouerait côté natif.
   */
  it('drops a chosen source that stopped emitting', async () => {
    const audioSources = vi.fn().mockResolvedValueOnce(SOURCES).mockResolvedValueOnce([SOURCES[0]]);
    const { store } = harness({ audioSources });
    await store.load();
    store.select('4212');
    await store.load();
    expect(store.sourceId()).toBeNull();
  });

  it('cannot start until a source is chosen', async () => {
    const { store } = harness();
    await store.load();
    expect(store.canStart()).toBe(false);
    store.select('system');
    expect(store.canStart()).toBe(true);
  });

  /**
   * ⚠️ **La source doit exister dans la liste COURANTE, pas seulement être non nulle.** Le cas
   * arrive quand une application est choisie puis fermée avant le démarrage.
   */
  it('refuses to start on a source that is not in the current list', async () => {
    const { store } = harness();
    await store.load();
    store.select('inconnue');
    expect(store.canStart()).toBe(false);
  });

  it('lets a source be unchosen', async () => {
    const { store } = harness();
    await store.load();
    store.select('system');
    store.select(null);
    expect(store.sourceId()).toBeNull();
    expect(store.canStart()).toBe(false);
  });
});

describe("DirectStore — le cycle de vie d'un enregistrement", () => {
  async function ready(overrides: Record<string, unknown> = {}) {
    const tools = harness(overrides);
    await tools.store.load();
    tools.store.select('4212');
    return tools;
  }

  it('starts nothing while no source is chosen', async () => {
    const { store, live } = harness();
    await store.load();
    await expect(store.start(null, 'fr', null)).resolves.toBe(false);
    expect(live.start).not.toHaveBeenCalled();
  });

  /** Une source disparue de la liste ne démarre pas non plus : l'identifiant est périmé. */
  it('starts nothing on a source that left the list', async () => {
    const { store, live } = harness();
    await store.load();
    store.select('inconnue');
    await expect(store.start(null, 'fr', null)).resolves.toBe(false);
    expect(live.start).not.toHaveBeenCalled();
  });

  it('records what it is capturing, at the moment it starts', async () => {
    const { store } = await ready();
    await expect(store.start(null, 'fr', null)).resolves.toBe(true);
    expect(store.recording()).toBe(true);
    expect(store.recordingSource()).toBe('Microsoft Teams');
    expect(store.recordingWithMicrophone()).toBe(true);
  });

  /**
   * ⚠️⚠️ **L'INSTANT DE DÉPART EST DANS LE STORE, ET C'EST LUI QUI PORTE LE CHRONO**
   * *(correctif du 2026-08-04)*. Le compteur vivait dans l'écran : quitter la Session pour les
   * Options en pleine capture le détruisait, et le retour affichait `00:00:00` figé. Une durée
   * se recalcule ; un compteur, non.
   *
   * ⚠️⚠️ **ET IL VIENT DU BACKEND, PAS DE L'HORLOGE LOCALE** *(P4-18)*. Deux fenêtres affichent
   * le même minuteur ; si chacune relevait son heure au retour de son propre appel, elles
   * compteraient deux durées différentes pour une seule session.
   */
  it('takes the start instant from the backend, and forgets it on stop', async () => {
    const { store } = await ready();
    await store.start(null, 'fr', null);

    expect(store.startedAtMs()).toBe(BEGUN.startedAtMs);

    await store.stop();
    expect(store.startedAtMs()).toBeNull();
  });

  /**
   * ⚠️ **Le repli sur l'horloge locale ne sert qu'au navigateur**, où il n'y a pas de backend
   * pour dater quoi que ce soit. Sans lui, `npm run start:web` afficherait un minuteur mort.
   */
  it('falls back on the local clock when there is no backend to date the session', async () => {
    const { store } = await ready({ start: vi.fn().mockResolvedValue(null) });
    const before = Date.now();
    await store.start(null, 'fr', null);

    expect(store.startedAtMs()).toBeGreaterThanOrEqual(before);
  });

  /**
   * ⚠️ **La source est RECOPIÉE, pas relue.** Une application fermée en cours de session
   * disparaît de la liste ; le bandeau doit continuer de dire ce qu'on enregistre.
   */
  it('keeps naming the source even after it left the list', async () => {
    const audioSources = vi.fn().mockResolvedValueOnce(SOURCES).mockResolvedValueOnce([SOURCES[0]]);
    const { store } = await ready({ audioSources });
    await store.start(null, 'fr', null);
    await store.load();
    expect(store.recordingSource()).toBe('Microsoft Teams');
  });

  it('remembers that the microphone was excluded', async () => {
    const { store } = await ready();
    await store.start('none', 'fr', null);
    expect(store.recordingWithMicrophone()).toBe(false);
  });

  /**
   * ⚠️⚠️ **L'ÉTAT NE BASCULE QU'AU SUCCÈS.** Un tap qui refuse de s'ouvrir laisse l'écran sur sa
   * configuration : basculer d'abord donnerait un bandeau d'enregistrement sans enregistrement,
   * et un bouton « Arrêter » qui n'arrête rien.
   */
  it('stays on the configuration when the capture refuses to open', async () => {
    const { store } = await ready({
      start: vi.fn().mockRejectedValue(new Error('autorisation manquante')),
    });
    await expect(store.start(null, 'fr', null)).resolves.toBe(false);
    expect(store.recording()).toBe(false);
    expect(store.startedAtMs()).toBeNull();
    expect(store.error()?.message).toContain('autorisation manquante');
  });

  it('cannot start twice', async () => {
    const { store } = await ready();
    await store.start(null, 'fr', null);
    expect(store.canStart()).toBe(false);
  });

  it('comes back to the configuration on stop', async () => {
    const { store, live } = await ready();
    await store.start(null, 'fr', null);
    await store.stop();
    expect(live.stop).toHaveBeenCalledOnce();
    expect(store.recording()).toBe(false);
  });

  /**
   * ⚠️⚠️ **UN ARRÊT EN ÉCHEC NE DOIT PAS EMPRISONNER L'UTILISATEUR.** Rester bloqué sur un
   * enregistrement qu'on ne sait plus clore le priverait de tout recours — le backend rétablit
   * déjà le raccourci avant de tenter la fermeture, pour la même raison.
   */
  it('comes back to the configuration even when the stop fails', async () => {
    const { store } = await ready({ stop: vi.fn().mockRejectedValue(new Error('tap bloqué')) });
    await store.start(null, 'fr', null);
    await store.stop();
    expect(store.recording()).toBe(false);
    expect(store.startedAtMs()).toBeNull();
    expect(store.error()?.message).toContain('tap bloqué');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA RÉHYDRATATION — SANS ELLE, UNE FENÊTRE QUI NAÎT EN COURS DE SESSION NE SAIT RIEN.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Deux fenêtres regardent la même session depuis P4-18, chacune avec sa propre instance
   * d'Angular donc son propre magasin. S'ajoute la fenêtre principale fermée puis rouverte en
   * pleine capture : sans relecture, elle afficherait « Démarrer » sur un enregistrement d'une
   * heure, et un second clic ouvrirait une capture concurrente.
   */
  it('catches up with a session that started in another window', async () => {
    const { store } = harness({
      session: vi.fn().mockResolvedValue({
        phase: 'recording',
        documentId: 'directdoc-2',
        startedAtMs: 1_754_300_000_000,
        sourceName: 'Google Meet',
        withMicrophone: true,
      }),
    });

    await store.sync();

    expect(store.recording()).toBe(true);
    expect(store.startedAtMs()).toBe(1_754_300_000_000);
    expect(store.recordingSource()).toBe('Google Meet');
    expect(store.recordingWithMicrophone()).toBe(true);
  });

  /**
   * ⚠️⚠️ **LA CONSOLIDATION COMPTE COMME UN ENREGISTREMENT QUI N'EST PAS FINI.** Tant qu'elle
   * tourne, le formulaire ne doit pas laisser lancer une seconde session : il n'y a qu'une
   * capture audio, et la seconde échouerait au moment précis où l'utilisateur croit avoir
   * démarré.
   */
  it('treats a consolidation in flight as a session still under way', async () => {
    const { store } = harness({
      session: vi.fn().mockResolvedValue({
        phase: 'finalising',
        documentId: 'directdoc-2',
        startedAtMs: 1_754_300_000_000,
        sourceName: 'Google Meet',
        withMicrophone: false,
      }),
    });

    await store.sync();

    expect(store.recording()).toBe(true);
    expect(store.canStart()).toBe(false);
  });

  /** ⚠️ **Au repos, rien à rattraper** — et surtout pas un nom de source venu de nulle part. */
  it('stays on the configuration when nothing is running', async () => {
    const { store } = harness();
    await store.sync();

    expect(store.recording()).toBe(false);
    expect(store.recordingSource()).toBe('');
    expect(store.startedAtMs()).toBeNull();
  });

  it('never rejects when the backend cannot say where the session is', async () => {
    const { store } = harness({ session: vi.fn().mockRejectedValue(new Error('pont muet')) });
    await expect(store.sync()).resolves.toBeUndefined();
    expect(store.error()?.message).toContain('pont muet');
  });

  /**
   * ⚠️⚠️ **ARRÊTER DEPUIS L'AUTRE FENÊTRE MET CELLE-CI À JOUR** — c'est une ligne de la DoD de
   * P4-18. Les deux fenêtres portent un bouton « Arrêter » ; celle qui n'a pas cliqué resterait
   * sinon figée sur un formulaire inactif et un minuteur qui court, pour une session close.
   */
  it('comes down when the session is stopped somewhere else', async () => {
    const { store } = await ready();
    await store.start(null, 'fr', null);

    store.stopped();

    expect(store.recording()).toBe(false);
    expect(store.busy()).toBe(false);
    expect(store.startedAtMs()).toBeNull();
    expect(store.pending()).toEqual({ system: null, microphone: null });
  });

  /**
   * ⚠️⚠️ **UN SEGMENT S'AJOUTE, UNE HYPOTHÈSE REMPLACE — LES CONFONDRE CASSE LE TEXTE.**
   * Traiter un partiel comme un ajout répéterait le même bout de phrase à chaque révision,
   * plusieurs fois par seconde ; traiter un final comme un remplacement perdrait tout ce qui
   * précède.
   */
  it('appends what is settled and replaces what is only a hypothesis', async () => {
    const { store } = await ready();

    store.applyTranscript(event('partial', 'system', 'Bon on'));
    store.applyTranscript(event('partial', 'system', 'Bon on commence'));
    expect(store.transcript()).toEqual([]);
    expect(store.pending().system).toBe('Bon on commence');

    store.applyTranscript(event('final', 'system', 'Bon, on commence ?'));
    expect(store.transcript()).toEqual([
      { id: 0, stream: 'system', text: 'Bon, on commence ?', paragraph: false },
    ]);
    // ⚠️ **Le final ferme l'hypothèse de son flux** : la laisser afficherait deux fois la même
    // phrase, une acquise et une en cours.
    expect(store.pending().system).toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UNE HYPOTHÈSE D'ÉCHO S'EFFACE, ET RIEN NE LA REMPLACE.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Défaut livré, vu par le porteur le 2026-08-05 : l'écran garde l'hypothèse d'un flux jusqu'à
   * ce qu'un `final` du **même flux** vienne la remplacer. Écarter un segment d'écho en se
   * contentant de ne rien émettre supprimait donc ce qui devait faire le ménage — la phrase des
   * haut-parleurs restait sous « Moi », avec son curseur, à côté de la même phrase portée par le
   * flux système.
   *
   * ⚠️ **Effacer n'ajoute rien au transcript acquis** : ce qui a été validé ne bouge pas.
   */
  it('erases the hypothesis of a stream without adding anything to what is settled', async () => {
    const { store } = await ready();

    store.applyTranscript(event('final', 'system', 'Cette équipe est forte.'));
    store.applyTranscript(event('partial', 'microphone', 'Cette équipe est forte'));
    expect(store.pending().microphone).toBe('Cette équipe est forte');

    store.applyTranscript(dropped('microphone'));

    expect(store.pending().microphone).toBeNull();
    expect(store.transcript()).toEqual([
      { id: 0, stream: 'system', text: 'Cette équipe est forte.', paragraph: false },
    ]);
  });

  /** ⚠️ **Un effacement ne touche qu'un flux** — l'autre continue de parler. */
  it('erases only the stream it names', async () => {
    const { store } = await ready();

    store.applyTranscript(event('partial', 'system', 'De mon côté'));
    store.applyTranscript(event('partial', 'microphone', 'De mon côté'));
    store.applyTranscript(dropped('microphone'));

    expect(store.pending()).toEqual({ system: 'De mon côté', microphone: null });
  });

  /**
   * ⚠️ **Une hypothèse PAR FLUX.** Les deux parlent en même temps — c'est le cas normal d'une
   * session animée —, et une hypothèse unique les ferait s'écraser mutuellement.
   */
  it('keeps the two streams from overwriting each other', async () => {
    const { store } = await ready();

    store.applyTranscript(event('partial', 'system', 'De mon côté'));
    store.applyTranscript(event('partial', 'microphone', 'Je peux prendre'));
    expect(store.pending()).toEqual({
      system: 'De mon côté',
      microphone: 'Je peux prendre',
    });

    store.applyTranscript(event('final', 'microphone', 'Je peux prendre les bugs.'));
    expect(store.pending()).toEqual({ system: 'De mon côté', microphone: null });
    expect(store.transcript()).toHaveLength(1);
  });

  /** Chaque ligne acquise porte une clé neuve : deux clés égales feraient s'effondrer le rendu. */
  it('gives every settled line its own key', async () => {
    const { store } = await ready();
    store.applyTranscript(event('final', 'system', 'Oui.'));
    store.applyTranscript(event('final', 'microphone', 'Oui.'));
    store.applyTranscript(event('final', 'system', 'Oui.'));

    const ids = store.transcript().map((line) => line.id);
    expect(new Set(ids).size).toBe(3);
  });

  /**
   * ⚠️ **Un morceau vide n'entre pas.** Le moteur en produit entre deux énoncés, et chacun
   * effacerait l'hypothèse affichée pour la réafficher au tampon suivant : le transcript
   * clignoterait.
   */
  it('ignores what is only whitespace', async () => {
    const { store } = await ready();
    store.applyTranscript(event('partial', 'system', 'Une phrase'));
    store.applyTranscript(event('partial', 'system', '   '));
    store.applyTranscript(event('final', 'system', ''));

    expect(store.pending().system).toBe('Une phrase');
    expect(store.transcript()).toEqual([]);
  });

  /**
   * ⚠️⚠️ **UN FLUX MUET N'ARRÊTE PAS LA SESSION.** L'audio continue d'être écrit, et c'est lui
   * qui compte — un transcript se refait depuis le fichier, une session non enregistrée est
   * perdue pour toujours. La raison est gardée : c'est ce qui rend le message actionnable.
   */
  it('records a stream that will not be transcribed, and why', async () => {
    const { store } = await ready();
    await store.start(null, 'fr', null);
    store.applyTranscript(event('failed', 'microphone', 'ressources de « fr » absentes'));

    expect(store.recording()).toBe(true);
    expect(store.silentStreams()).toEqual([
      { stream: 'microphone', reason: 'ressources de « fr » absentes' },
    ]);
  });

  /** ⚠️ Un flux ne se signale qu'une fois : répéter en ferait un mur devant l'écran. */
  it('names a silent stream once, however often it complains', async () => {
    const { store } = await ready();
    store.applyTranscript(event('failed', 'system', 'moteur indisponible'));
    store.applyTranscript(event('failed', 'system', 'moteur indisponible'));
    store.applyTranscript(event('failed', 'system', 'toujours indisponible'));

    expect(store.silentStreams()).toHaveLength(1);
  });

  /**
   * ⚠️⚠️ **LE TRANSCRIPT S'EFFACE AU DÉMARRAGE, PAS À L'ARRÊT.** L'effacer à l'arrêt le ferait
   * disparaître sous les yeux de l'utilisateur au moment précis où il vient de finir de parler
   * — et P4-06 en a besoin après la fermeture pour bâtir le document.
   */
  it('carries the transcript past the stop, and clears it at the next start', async () => {
    const { store } = await ready();
    await store.start(null, 'fr', null);
    store.applyTranscript(event('final', 'system', 'Une session.'));
    store.applyTranscript(event('failed', 'microphone', 'micro muet'));
    await store.stop();

    expect(store.transcript()).toHaveLength(1);
    expect(store.silentStreams()).toHaveLength(1);

    await store.start(null, 'fr', null);
    expect(store.transcript()).toEqual([]);
    expect(store.silentStreams()).toEqual([]);
    expect(store.pending()).toEqual({ system: null, microphone: null });
  });

  /**
   * ⚠️ **Une hypothèse orpheline resterait affichée pour toujours**, curseur clignotant sur une
   * session finie : le moteur finalise ce qu'il peut, mais ce qu'il tenait de moins sûr ne
   * revient jamais. Le transcript acquis, lui, ne bouge pas.
   */
  it('drops the dangling hypotheses without touching what is settled', async () => {
    const { store } = await ready();
    store.applyTranscript(event('final', 'system', 'Acquis.'));
    store.applyTranscript(event('partial', 'system', 'jamais fini'));
    store.applyTranscript(event('partial', 'microphone', 'non plus'));

    store.dropPendingSpeech();

    expect(store.pending()).toEqual({ system: null, microphone: null });
    expect(store.transcript()).toHaveLength(1);
  });

  /** La langue traverse jusqu'au pont : c'est elle qui décide de quoi le moteur transcrit. */
  it('passes the live language to the capture', async () => {
    const { store, live } = await ready();
    await store.start('none', 'it', null);
    expect(live.start).toHaveBeenCalledExactlyOnceWith('4212', 'none', 'it', null);
  });

  /** La cible de traduction traverse elle aussi : c'est le backend qui la range avec le document. */
  it('passes the translation target to the capture', async () => {
    const { store, live } = await ready();
    await store.start(null, 'fr', 'en');
    expect(live.start).toHaveBeenCalledExactlyOnceWith('4212', null, 'fr', 'en');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UN SEGMENT ACQUIS NE SE RETRADUIT JAMAIS.** *(décision 5)*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Il ne change plus, donc sa traduction non plus. La réécrire ne pourrait que faire clignoter
   * la colonne sous les yeux de l'utilisateur.
   */
  it('keeps the first translation of a segment and ignores a second', async () => {
    const { store } = await ready();
    store.translated(0, 'Hello.');
    store.translated(0, 'Hi.');
    store.translated(1, 'Good morning.');

    expect(store.translations()).toEqual({ 0: 'Hello.', 1: 'Good morning.' });
  });

  /**
   * ⚠️ **Les traductions partent AVEC le transcript, au démarrage de la session suivante.** Les
   * identifiants de ligne repartent à zéro à chaque session : gardées, celles d'hier
   * s'afficheraient en face des premiers segments d'aujourd'hui.
   */
  it('clears the translations at the next start, like the transcript', async () => {
    const { store } = await ready();
    await store.start(null, 'fr', 'en');
    store.applyTranscript(event('final', 'system', 'Une session.'));
    store.translated(0, 'A session.');
    await store.stop();
    expect(store.translations()).toEqual({ 0: 'A session.' });

    await store.start(null, 'fr', 'en');
    expect(store.translations()).toEqual({});
  });
});
