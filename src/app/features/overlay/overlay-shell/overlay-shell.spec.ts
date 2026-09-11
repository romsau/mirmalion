import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OverlayShell } from './overlay-shell';
import { OVERLAY_EVENT } from '../../../core/services/bridge/overlay/overlay.bridge';
import type { OverlayPayload } from '../../../core/services/bridge/overlay/overlay.bridge';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { Invoke } from '../../../core/services/bridge/invoke/invoke';
import { OverlayBridge } from '../../../core/services/bridge/overlay/overlay.bridge';

/**
 * La doublure du pont : elle retient l'abonné pour que les tests puissent lui pousser des
 * évènements, comme le backend le ferait.
 */
function harness(initial: OverlayPayload | null = null) {
  let emit: ((payload: OverlayPayload) => void) | null = null;
  const unlisten = vi.fn();
  return {
    emit: (payload: OverlayPayload) => emit?.(payload),
    unlisten,
    tauri: {
      listen: vi.fn(async (event: string, handler: (payload: OverlayPayload) => void) => {
        expect(event).toBe(OVERLAY_EVENT);
        emit = handler;
        return unlisten;
      }),
      getOverlayState: vi.fn().mockResolvedValue(initial),
      hideOverlay: vi.fn().mockResolvedValue(undefined),
      resizeOverlay: vi.fn().mockResolvedValue(undefined),
    },
  };
}

type Doubles = ReturnType<typeof harness>;

/**
 * Monte la coquille, puis passe aux minuteries feintes.
 *
 * ⚠️ **L'ordre n'est pas négociable.** `whenStable()` d'Angular s'appuie sur de vraies
 * minuteries : les feindre avant le rendu fait attendre indéfiniment. Une fois montée, la
 * coquille n'a plus besoin que de `detectChanges()`, qui est synchrone.
 */
async function render(
  doubles: Doubles = harness(),
): Promise<{ fixture: ComponentFixture<OverlayShell>; doubles: Doubles }> {
  vi.useRealTimers();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: OverlayBridge, useExisting: Invoke },
      { provide: Invoke, useValue: doubles.tauri },
    ],
  });
  const fixture = TestBed.createComponent(OverlayShell);
  await fixture.whenStable();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  return { fixture, doubles };
}

/**
 * Laisse Angular finir son rendu **et ses effets d'après-rendu**, minuteries feintes comprises.
 *
 * ⚠️ **`detectChanges()` ne suffit pas** : il rafraîchit le gabarit mais ne déclenche pas
 * `afterRenderEffect`, donc pas la mesure de la pilule. Et `whenStable()` seul reste en
 * attente, parce qu'il programme lui-même une minuterie — feinte, donc jamais échue tant
 * qu'on ne l'avance pas.
 */
async function settle(fixture: ComponentFixture<OverlayShell>): Promise<void> {
  // `tick()` de l'application, et non `detectChanges()` de la fixture : les effets
  // d'après-rendu appartiennent à l'application, pas au composant.
  TestBed.inject(ApplicationRef).tick();
  const stable = fixture.whenStable();
  await vi.advanceTimersByTimeAsync(1);
  await stable;
}

function rootOf(fixture: ComponentFixture<OverlayShell>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function pillOf(fixture: ComponentFixture<OverlayShell>): Element | null {
  return rootOf(fixture).querySelector('app-overlay-pill');
}

function labelOf(fixture: ComponentFixture<OverlayShell>): string {
  return rootOf(fixture).querySelector('.ro-label')?.textContent?.trim() ?? '';
}

function timerOf(fixture: ComponentFixture<OverlayShell>): string | null {
  return rootOf(fixture).querySelector('.ro-timer')?.textContent?.trim() ?? null;
}

/**
 * Les largeurs mesurées le 2026-07-30 en Montserrat Bold 19 px, état par état.
 *
 * ⚠️ Le pire cas était « Indisponible » (214 px) ; depuis que cet état a disparu, c'est
 * « Préparation ». La mesure se faisant à l'exécution, la pilule l'a suivi toute seule.
 */
const WIDTHS: Readonly<Record<string, number>> = {
  listening: 158,
  preparing: 207,
  translating: 197,
  done: 182,
  error: 151,
};

/** Ce que le chrono ajoute à la pilule qui le porte. */
const CHRONO_WIDTH = 70;

/**
 * Donne une largeur à chaque pilule, faute de mise en page dans jsdom.
 *
 * La largeur se lit sur `data-state`, et le chrono s'y ajoute quand la pilule en porte un —
 * c'est ce qui permet de distinguer la mesure de la dictée de celle de la session.
 */
function measureBy(widths: Readonly<Record<string, number>>): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = widths[this.getAttribute('data-state') ?? ''] ?? 0;
    const chrono = this.querySelector('.ro-timer') === null ? 0 : CHRONO_WIDTH;
    return { width: width + chrono, height: width === 0 ? 0 : 53 } as DOMRect;
  });
}

describe('OverlayShell', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows nothing until a recording is under way', async () => {
    const { fixture } = await render();
    expect(pillOf(fixture)).toBeNull();
  });

  it('reads the state it may have missed while its webview was mounting', async () => {
    // ⚠️ La fenêtre met quelques dizaines de millisecondes à monter : un évènement émis
    // pendant ce temps n'a personne pour l'entendre. La lecture initiale comble l'intervalle.
    const { fixture } = await render(harness({ state: 'preparing', chrono: false }));
    expect(labelOf(fixture)).toBe('Préparation');
  });

  it('lets an event already received win over the initial read', async () => {
    // L'évènement est plus récent : l'écraser ferait reculer la pilule d'un cran.
    const doubles = harness({ state: 'listening', chrono: false });
    const { fixture } = await render(doubles);
    doubles.emit({ state: 'translating', chrono: false });
    await settle(fixture);
    expect(labelOf(fixture)).toBe('Traduction');
  });

  it('follows the states the backend pushes', async () => {
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);
    expect(labelOf(fixture)).toBe('Écoute');

    doubles.emit({ state: 'done', chrono: false });
    await settle(fixture);
    expect(labelOf(fixture)).toBe('Terminé !');
  });

  it('counts the seconds itself in live, rather than being told each one', async () => {
    // Recevoir le chrono coûterait un aller-retour IPC par seconde pendant toute la session.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: true });
    await settle(fixture);
    expect(timerOf(fixture)).toBe('0:00');

    await vi.advanceTimersByTimeAsync(3_000);
    await settle(fixture);
    expect(timerOf(fixture)).toBe('0:03');
  });

  it('shows no chrono in dictation', async () => {
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);

    await vi.advanceTimersByTimeAsync(3_000);
    await settle(fixture);
    expect(timerOf(fixture)).toBeNull();
  });

  it('does not restart the chrono when the same state is republished', async () => {
    // ⚠️ Le pipeline peut republier sans changement ; remettre le compteur à zéro au milieu
    // d'une session serait un défaut visible et incompréhensible.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: true });
    await vi.advanceTimersByTimeAsync(5_000);
    doubles.emit({ state: 'listening', chrono: true });
    await settle(fixture);
    expect(timerOf(fixture)).toBe('0:05');
  });

  it('stops the chrono when listening ends', async () => {
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: true });
    await vi.advanceTimersByTimeAsync(2_000);
    doubles.emit({ state: 'preparing', chrono: true });
    await settle(fixture);

    await vi.advanceTimersByTimeAsync(5_000);
    await settle(fixture);
    expect(timerOf(fixture)).toBeNull();
  });

  it('erases the three terminal states on its own', async () => {
    for (const state of ['done', 'error'] as const) {
      const { fixture, doubles } = await render();
      doubles.emit({ state, chrono: false });
      await settle(fixture);
      expect(doubles.tauri.hideOverlay).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(doubles.tauri.hideOverlay).toHaveBeenCalledOnce();
    }
  });

  it('never erases a state the pipeline is still working through', async () => {
    for (const state of ['listening', 'preparing', 'translating'] as const) {
      const { fixture, doubles } = await render();
      doubles.emit({ state, chrono: false });
      await settle(fixture);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(doubles.tauri.hideOverlay).not.toHaveBeenCalled();
    }
  });

  it('cancels a pending erasure when a new state arrives', async () => {
    // Un « Terminé » suivi d'une nouvelle dictée ne doit pas emporter la pilule avec lui.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'done', chrono: false });
    await vi.advanceTimersByTimeAsync(1_000);
    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(doubles.tauri.hideOverlay).not.toHaveBeenCalled();
  });

  it('asks the backend to fit the window to the pill', async () => {
    // ⚠️ La fenêtre EST la pilule : sa taille, que seul le webview peut mesurer.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);
    expect(doubles.tauri.resizeOverlay).toHaveBeenCalled();
  });

  it('asks for the width of the WIDEST state, never the current one', async () => {
    // ⚠️ **LE POINT DE CETTE MESURE.** « Écoute » fait 158 px et « Indisponible » 214 : suivre
    // l'état ferait grandir puis rétrécir la pilule à chaque étape de la dictée, sous les yeux
    // de quelqu'un qui attend son texte.
    measureBy(WIDTHS);
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);

    expect(doubles.tauri.resizeOverlay).toHaveBeenCalledWith(207, 53);
  });

  it('reserves the chrono in the measurement, but only in live', async () => {
    // Le chrono s'ajoute au libellé et ne rétrécit jamais : sa place se réserve d'emblée,
    // sinon la pilule s'allongerait à la première minute. En dictée il n'existe pas.
    //
    // ⚠️ Il ne s'ajoute qu'à **« Écoute »** — le seul état qui le porte —, ce qui suffit à
    // faire de celui-ci le pire cas d'une session, alors qu'il est le plus étroit en dictée.
    measureBy(WIDTHS);
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: true });
    await settle(fixture);

    expect(doubles.tauri.resizeOverlay).toHaveBeenCalledWith(
      WIDTHS['listening'] + CHRONO_WIDTH,
      53,
    );
  });

  it('removes the measuring template once it has served', async () => {
    // Six pilules animées en permanence coûteraient du CPU pour une mesure qui ne change plus.
    measureBy(WIDTHS);
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'preparing', chrono: false });
    await settle(fixture);

    expect(rootOf(fixture).querySelector('.overlay-measure')).toBeNull();
    expect(rootOf(fixture).querySelectorAll('app-overlay-pill')).toHaveLength(1);
  });

  it('falls back to the displayed pill when nothing can be measured', async () => {
    // jsdom ne fait aucune mise en page : tout vaut zéro. La fenêtre doit rester taillée sur
    // ce qu'elle affiche plutôt que de se réduire à rien.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);

    expect(doubles.tauri.resizeOverlay).toHaveBeenCalledWith(0, 0);
  });

  it('does not ask again while the size has not moved', async () => {
    // Le rendu se déclenche à chaque seconde du chrono ; redemander la même géométrie ferait
    // clignoter la fenêtre pour rien.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: true });
    await settle(fixture);
    const calls = doubles.tauri.resizeOverlay.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3_000);
    await settle(fixture);
    // jsdom ne fait aucune mise en page : la mesure ne bouge pas, donc rien n'est redemandé.
    expect(doubles.tauri.resizeOverlay.mock.calls.length).toBe(calls);
  });

  it('asks for its size again after an effacement — the pill must come back', async () => {
    // ⚠️⚠️ **LE TEST QUI GARDE LA PILULE VISIBLE.** La fenêtre n'est plus détruite en fin de
    // dictée : la recréer **activait l'application** et volait le focus au champ où
    // l'utilisateur écrivait (bogue amont tauri-apps/tauri#7519). Or le backend ne révèle la
    // pilule qu'au moment où on lui demande sa taille, et cette demande est court-circuitée
    // quand la taille n'a pas bougé. Sans l'oubli de la dernière taille à l'effacement, la
    // deuxième dictée d'affilée ne redemanderait rien — et la pilule ne reparaîtrait
    // **jamais**. En jsdom toutes les mesures valent zéro : deux dictées de suite donnent donc
    // exactement la géométrie que le court-circuit refuserait.
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'done', chrono: false });
    await settle(fixture);
    const calls = doubles.tauri.resizeOverlay.mock.calls.length;

    // L'effacement part de lui-même sur un état terminal.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(doubles.tauri.hideOverlay).toHaveBeenCalled();

    doubles.emit({ state: 'listening', chrono: false });
    await settle(fixture);
    expect(doubles.tauri.resizeOverlay.mock.calls.length).toBeGreaterThan(calls);
  });

  it('unsubscribes when the window closes', async () => {
    const { fixture, doubles } = await render();
    fixture.destroy();
    expect(doubles.unlisten).toHaveBeenCalledOnce();
  });

  it('drops a subscription that arrives after the window is gone', async () => {
    // La fenêtre peut être fermée pendant l'attente de l'abonnement : le laisser sans
    // propriétaire fuirait à chaque enregistrement.
    vi.useRealTimers();
    const doubles = harness();
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const pending = {
      ...doubles.tauri,
      listen: vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            resolveListen = resolve;
          }),
      ),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Invoke, useValue: pending },
        { provide: OverlayBridge, useValue: pending },
      ],
    });
    const fixture = TestBed.createComponent(OverlayShell);
    fixture.destroy();
    resolveListen?.(doubles.unlisten);
    await Promise.resolve();

    expect(doubles.unlisten).toHaveBeenCalledOnce();
    expect(doubles.tauri.getOverlayState).not.toHaveBeenCalled();
  });

  it('has no AXE violation', async () => {
    const { fixture, doubles } = await render();
    doubles.emit({ state: 'listening', chrono: true });
    await settle(fixture);
    // AXE programme ses propres minuteries : il lui faut les vraies.
    vi.useRealTimers();
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
