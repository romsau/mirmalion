import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Direct } from './direct';
import { DirectConfig } from './components/direct-config/direct-config';
import { DirectStore } from '../../core/store/direct/direct.store';
import { LiveHistoryStore } from '../../core/store/live-history/live-history.store';
import { PanelStore } from '../../core/store/panel/panel.store';
import { SettingsStore } from '../../core/store/settings/settings.store';
import { Live } from '../../core/services/live/live';
import { RecordingSound } from '../../core/services/overlay/recording-sound';
import { Snackbar } from '../../core/services/snackbar/snackbar';
import { Translation } from '../../core/services/translation/translation';
import { DEFAULT_SETTINGS, type AppSettings } from '../../core/models/settings';
import type { AppError } from '../../core/models/app-error';
import type { AudioSource } from '../../core/services/bridge/live/live.bridge';
import { expectNoAxeViolations } from '../../../testing/axe';

const SOURCES: readonly AudioSource[] = [
  { id: 'system', name: 'Tout le système', isSystem: true },
  { id: '4212', name: 'Microsoft Teams', isSystem: false },
];

/**
 * Le rappel d'arrêt que l'écran a passé au service, retenu par le harnais.
 *
 * ⚠️ **C'est le seul moyen d'éprouver que l'écran suit un arrêt venu D'AILLEURS** — de la
 * fenêtre-session, ou de sa fermeture. Sans le rappel, on ne saurait pas dire s'il est branché.
 */
let stoppedHandler: (() => void) | null = null;

/** Le rappel de **consolidation**, retenu de la même façon — c'est lui qui relit l'historique. */
let finalisedHandler: (() => void) | null = null;

/**
 * Le harnais monte l'écran sur des doublures : ni pont, ni overlay CDK. Ce qui est éprouvé ici
 * est **l'orchestration** — ce qui part dans les réglages, ce qui reste dans le store, et où
 * mène la ligne qui sort vers les options de langues.
 */
function harness(
  overrides: {
    settings?: Partial<AppSettings>;
    collapsed?: boolean;
    sourceId?: string | null;
    recording?: boolean;
    startSucceeds?: boolean;
    subscribeFails?: boolean;
    historyEmpty?: boolean;
  } = {},
) {
  const error = signal<AppError | null>(null);
  const settingsValue = signal<AppSettings>({ ...DEFAULT_SETTINGS, ...overrides.settings });
  stoppedHandler = null;
  finalisedHandler = null;
  const sourceId = signal<string | null>(overrides.sourceId ?? null);

  const recording = signal(overrides.recording ?? false);
  const startedAtMs = signal<number | null>(overrides.recording === true ? Date.now() : null);
  const store = {
    sources: signal(SOURCES),
    loaded: signal(true),
    sourceId,
    canStart: signal(false),
    recording,
    busy: signal(false),
    recordingSource: signal('Microsoft Teams'),
    recordingWithMicrophone: signal(true),
    startedAtMs,
    error,
    load: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    select: vi.fn((value: string | null) => sourceId.set(value)),
    start: vi.fn(async () => {
      const started = overrides.startSucceeds ?? true;
      recording.set(started);
      startedAtMs.set(started ? Date.now() : null);
      return started;
    }),
    stop: vi.fn(async () => {
      recording.set(false);
      startedAtMs.set(null);
    }),
    stopped: vi.fn(() => {
      recording.set(false);
      startedAtMs.set(null);
    }),
    clearError: vi.fn(() => error.set(null)),
  };

  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    settingsValue.update((current) => ({ ...current, ...patch }));
  });

  const unlistenStopped = vi.fn();
  const onStopped = vi.fn(async (handler: () => void) => {
    if (overrides.subscribeFails === true) {
      throw new Error('le pont ne répond pas');
    }
    stoppedHandler = handler;
    return unlistenStopped;
  });
  const unlistenFinalised = vi.fn();
  const onFinalised = vi.fn(async (handler: () => void) => {
    if (overrides.subscribeFails === true) {
      throw new Error('le pont ne répond pas');
    }
    finalisedHandler = handler;
    return unlistenFinalised;
  });
  const live = {
    onStopped,
    onFinalised,
  };

  const historyEmpty = signal(overrides.historyEmpty ?? true);
  // La doublure porte tout ce que le PANNEAU lit, et pas seulement ce que l'écran lit : déplié,
  // il est monté pour de bon, et un membre manquant échoue au rendu et non à l'assertion.
  const history = {
    empty: historyEmpty,
    entries: signal([]),
    filtered: signal([]),
    search: signal(''),
    error: signal(null),
    load: vi.fn().mockResolvedValue(undefined),
    setSearch: vi.fn(),
    open: vi.fn(),
    copy: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    clearError: vi.fn(),
  };

  const sound = { play: vi.fn() };
  const collapsed = signal(overrides.collapsed ?? false);
  const panel = { collapsed, toggle: vi.fn(() => collapsed.update((value) => !value)) };
  const router = { navigateByUrl: vi.fn().mockResolvedValue(true) };
  const snackbar = { error: vi.fn() };
  const translation = { offerDownload: vi.fn().mockResolvedValue(undefined) };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DirectStore, useValue: store },
      { provide: LiveHistoryStore, useValue: history },
      { provide: PanelStore, useValue: panel },
      { provide: SettingsStore, useValue: { settings: settingsValue, update } },
      { provide: Live, useValue: live },
      { provide: RecordingSound, useValue: sound },
      { provide: Snackbar, useValue: snackbar },
      { provide: Router, useValue: router },
      { provide: Translation, useValue: translation },
    ],
  });

  return {
    store,
    live,
    sound,
    history,
    onStopped,
    unlistenStopped,
    unlistenFinalised,
    update,
    panel,
    router,
    snackbar,
    translation,
    error,
    startedAtMs,
  };
}

async function render(overrides: Parameters<typeof harness>[0] = {}) {
  const tools = harness(overrides);
  const fixture = TestBed.createComponent(Direct);
  await fixture.whenStable();
  return { ...tools, fixture };
}

/**
 * Monte l'écran **sur des timers factices**, ce que [`render`] ne peut pas faire.
 *
 * ⚠️⚠️ **`await fixture.whenStable()` NE REND JAMAIS LA MAIN SOUS TIMERS FACTICES** — la leçon a
 * déjà été payée : les promesses en attente ne se résolvent que si quelque chose fait avancer
 * l'horloge, et `whenStable` attend justement ces promesses. On avance donc l'horloge
 * nous-mêmes, ce qui débloque la stabilisation et fait tourner les intervalles du même geste.
 *
 * C'est le seul moyen d'éprouver un écran monté **pendant** une session — c'est-à-dire un
 * retour depuis les Options, ou une fenêtre rouverte, le cas exact que le minuteur ne survivait
 * pas.
 */
async function renderTicking(overrides: Parameters<typeof harness>[0] = {}) {
  const tools = harness(overrides);
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Direct);
  fixture.detectChanges();
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();
  return { ...tools, fixture };
}

function config(fixture: ComponentFixture<Direct>): DirectConfig {
  return fixture.debugElement.query(By.directive(DirectConfig)).componentInstance;
}

afterEach(() => {
  vi.useRealTimers();
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('Direct', () => {
  it('reads the sources and the running session on arrival', async () => {
    const { store } = await render();
    expect(store.load).toHaveBeenCalledOnce();
    expect(store.sync).toHaveBeenCalledOnce();
  });

  it('shows its title and both columns', async () => {
    const { fixture } = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.screen-title')?.textContent).toContain('Direct');
    expect(root.querySelector('app-direct-config')).not.toBeNull();
    expect(root.querySelector('app-direct-history')).not.toBeNull();
  });

  it('drops the right column when the panel is collapsed', async () => {
    const { fixture } = await render({ collapsed: true });
    expect((fixture.nativeElement as HTMLElement).querySelector('app-direct-history')).toBeNull();
  });

  describe('le bouton de dépli de l’historique', () => {
    const button = (fixture: ComponentFixture<Direct>) =>
      (fixture.nativeElement as HTMLElement).querySelector('.panel-collapse');

    it('reads the history itself — the panel is not mounted when collapsed', async () => {
      // ⚠️ Sans cette lecture, replié, l'écran ne saurait pas s'il a quelque chose à proposer.
      const { history } = await render({ collapsed: true });
      expect(history.load).toHaveBeenCalled();
    });

    /**
     * ⚠️⚠️ **IL DISPARAÎT QUAND IL N'Y A RIEN À OUVRIR** *(porteur, 2026-08-07)*. La règle
     * existait en dictée et attendait ici les données de P4-11 : la masquer plus tôt aurait
     * supprimé le seul moyen de replier la fenêtre.
     */
    it('disappears when there is nothing to open', async () => {
      const { fixture } = await render({ collapsed: true, historyEmpty: true });
      expect(button(fixture)).toBeNull();
    });

    it('is there as soon as the history holds something', async () => {
      const { fixture, panel } = await render({ historyEmpty: false });
      (button(fixture) as HTMLButtonElement).click();
      expect(panel.toggle).toHaveBeenCalledOnce();
    });

    it('stays while the panel is open, however empty the history is', async () => {
      // Sinon on ne pourrait plus le replier : le bouton est sa seule commande.
      const { fixture } = await render({ historyEmpty: true });
      expect(button(fixture)).not.toBeNull();
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ⚠️⚠️ **L'HISTORIQUE SE RELIT À LA CONSOLIDATION, PAS À L'ARRÊT.**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * Une session n'est archivée qu'une fois consolidée : relire sur `stopped` chercherait une
     * ligne qui n'existe pas encore, et le panneau resterait en retard d'une session jusqu'à la
     * prochaine visite de l'écran.
     */
    it('re-reads the history when a session is consolidated, not when it stops', async () => {
      const { history } = await render();
      history.load.mockClear();

      stoppedHandler?.();
      expect(history.load).not.toHaveBeenCalled();

      finalisedHandler?.();
      expect(history.load).toHaveBeenCalledOnce();
    });

    it('unsubscribes from both channels when the screen goes', async () => {
      const { fixture, unlistenStopped, unlistenFinalised } = await render();
      fixture.destroy();

      expect(unlistenStopped).toHaveBeenCalledOnce();
      expect(unlistenFinalised).toHaveBeenCalledOnce();
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **PENDANT UNE SESSION, LE FORMULAIRE RESTE LÀ — INACTIF, MAIS LÀ** *(P4-17)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * L'utilisateur doit pouvoir **relire** ce qu'il a choisi pendant qu'il enregistre : quelle
   * source, quel micro, quelle langue. Un formulaire escamoté l'obligerait à s'en souvenir, ou à
   * arrêter pour vérifier.
   */
  it('keeps the form readable and inert while a session runs', async () => {
    const { fixture } = await render({ recording: true });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('app-direct-config')).not.toBeNull();
    expect(config(fixture).recording()).toBe(true);
    // ⚠️ `disabled` et non un simple grisé : c'est l'attribut qui sort les champs de l'ordre de
    // tabulation et qui est **annoncé**.
    const controls = [...root.querySelectorAll<HTMLButtonElement>('[role="combobox"], .switch')];
    expect(controls).not.toHaveLength(0);
    expect(controls.every((control) => control.disabled)).toBe(true);
  });

  /**
   * ⚠️⚠️ **LE TRANSCRIPT EN DIRECT A QUITTÉ CET ÉCRAN** *(P4-17)*. Il vit dans la fenêtre-session.
   * Le laisser aussi ici en ferait deux affichages du même flux, dont un que personne ne
   * regarde — et deux abonnements, donc chaque ligne écrite deux fois.
   */
  it('never shows the live transcript any more', async () => {
    const { fixture } = await render({ recording: true });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('app-direct-transcript')).toBeNull();
    expect(root.querySelector('app-direct-live')).toBeNull();
  });

  /**
   * ⚠️⚠️ **LA SOURCE NE VA PAS DANS LES RÉGLAGES**, contrairement aux trois autres champs :
   * l'application visée change d'une session à l'autre, et la maquette veut le sélecteur vide à
   * chaque ouverture.
   */
  it('keeps the chosen source in the store and out of the settings', async () => {
    const { fixture, store, update } = await render();
    config(fixture).sourceId.set('4212');
    await fixture.whenStable();

    expect(store.select).toHaveBeenCalledExactlyOnceWith('4212');
    expect(update).not.toHaveBeenCalled();
  });

  it('writes the two remembered fields to the settings', async () => {
    const { fixture, update } = await render();
    const child = config(fixture);

    child.language.set('it');
    child.includeMicrophone.set(false);
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ liveLanguage: 'it' });
    expect(update).toHaveBeenCalledWith({ liveIncludeMicrophone: false });
  });

  /**
   * ⚠️ **Une seule écriture, pas deux**, comme dans la dictée : la cible tombe dans le même patch
   * que la langue, sinon l'écran passe par l'état que son menu ne propose plus.
   */
  it('drops the live translation target when the session language becomes it', async () => {
    const { fixture, update } = await render({
      settings: { translationLanguages: ['it'], liveTranslationTarget: 'it' },
    });

    config(fixture).language.set('it');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ liveLanguage: 'it', liveTranslationTarget: 'none' });
  });

  it('sends the settings values down to the form', async () => {
    const { fixture } = await render({
      settings: { liveLanguage: 'it', liveIncludeMicrophone: false },
    });
    const child = config(fixture);
    expect(child.language()).toBe('it');
    expect(child.includeMicrophone()).toBe(false);
  });

  /**
   * ⚠️ **Vers la liste elle-même, pas vers l'accueil des langues** — l'accueil ne ferait que
   * redemander laquelle des deux listes on voulait.
   */
  it('leads to the spoken languages list, not to the languages home', async () => {
    const { fixture, router } = await render();
    config(fixture).languageOptionsRequested.emit('spoken');
    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/options/langues/parlees');
  });

  /** L'autre menu mène à **sa** liste, pas à celle d'à côté. */
  it('leads to the translation languages list from the translation menu', async () => {
    const { fixture, router } = await render();
    config(fixture).languageOptionsRequested.emit('translation');
    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/options/langues/traduction');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA PAIRE SE VÉRIFIE ICI, AU CLIC, AVANT « DÉMARRER »** *(décision 5)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Apple présente **sa propre** feuille de téléchargement, et elle exige un hôte SwiftUI dans
   * une fenêtre visible : au milieu d'une session, le geste serait impossible à placer.
   *
   * ⚠️ **C'est un clic, et c'est ce qui l'autorise** : la règle du projet interdit tout appel
   * réseau qui ne suive pas un geste explicite.
   */
  it('offers to install the pair as soon as a target is chosen', async () => {
    const { fixture, update, translation } = await render({ settings: { liveLanguage: 'fr' } });
    config(fixture).translationTarget.set('en');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ liveTranslationTarget: 'en' });
    expect(translation.offerDownload).toHaveBeenCalledExactlyOnceWith('en', ['fr']);
  });

  /** ⚠️ **« Pas de traduction » ne télécharge rien** : il n'y a aucune paire à installer. */
  it('downloads nothing when the user asks for no translation', async () => {
    // On part d'une cible réelle : reposer la valeur courante n'émettrait rien du tout.
    const { fixture, update, translation } = await render({
      settings: { liveTranslationTarget: 'it' },
    });
    config(fixture).translationTarget.set('none');
    await fixture.whenStable();

    expect(update).toHaveBeenCalledWith({ liveTranslationTarget: 'none' });
    expect(translation.offerDownload).not.toHaveBeenCalled();
  });

  /** La cible retenue traverse jusqu'au store — et `'none'` y devient l'absence. */
  it('starts with the chosen target, and turns « none » into nothing at all', async () => {
    const { fixture, store } = await render({ settings: { liveTranslationTarget: 'it' } });
    config(fixture).start.emit();
    await fixture.whenStable();
    expect(store.start).toHaveBeenCalledExactlyOnceWith(null, 'en', 'it');
  });

  it('unsubscribes when the screen is destroyed', async () => {
    const { fixture, unlistenStopped } = await render();
    fixture.destroy();
    expect(unlistenStopped).toHaveBeenCalledOnce();
  });

  it('says a store failure once, then forgets it', async () => {
    const { fixture, store, error, snackbar } = await render();
    error.set({ kind: 'native', message: 'le pont est muet' });
    await fixture.whenStable();

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('le pont est muet');
    expect(store.clearError).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️⚠️ **DEUX RÉGLAGES SE REJOIGNENT EN UNE SEULE VALEUR, ET C'EST L'ÉCRAN QUI LES JOINT**
   * *(porteur, 2026-08-06)*. L'appareil vient de `microphoneId` — Options ▸ Général, partagé
   * avec la dictée — et le refus de sa propre voix vient de l'écran. Le backend, lui, ne
   * connaît qu'une valeur : `'none'` ou un identifiant.
   */
  it('starts the capture with the shared device when the microphone is included', async () => {
    const { fixture, store } = await render({
      settings: { microphoneId: 'usb-3', liveIncludeMicrophone: true },
    });
    config(fixture).start.emit();
    await fixture.whenStable();
    expect(store.start).toHaveBeenCalledExactlyOnceWith('usb-3', 'en', null);
  });

  it('starts the capture without any microphone when the voice is left out', async () => {
    const { fixture, store } = await render({
      settings: { microphoneId: 'usb-3', liveIncludeMicrophone: false },
    });
    config(fixture).start.emit();
    await fixture.whenStable();
    expect(store.start).toHaveBeenCalledExactlyOnceWith('none', 'en', null);
  });

  /**
   * ⚠️⚠️ **UN DÉPART QUI ÉCHOUE NE SONNE PAS.** Faire entendre le début d'une session qui n'a
   * pas commencé serait le pire des retours : celui qui affirme le contraire de ce qui s'est
   * passé.
   */
  it('does not chime when the capture refuses to open', async () => {
    const { fixture, sound } = await render({ startSucceeds: false });
    config(fixture).start.emit();
    await fixture.whenStable();

    expect(config(fixture).recording()).toBe(false);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it('chimes at the start and at the stop', async () => {
    const { fixture, sound } = await render();
    config(fixture).start.emit();
    await fixture.whenStable();
    expect(sound.play).toHaveBeenCalledExactlyOnceWith('start');

    config(fixture).stop.emit();
    await fixture.whenStable();
    expect(sound.play).toHaveBeenLastCalledWith('stop');
  });

  /**
   * ⚠️⚠️ **CET ÉCRAN NE LIT PLUS LE RÉGLAGE, ET C'EST LE SERVICE QUI DÉCIDE** *(P6-04,
   * 2026-08-09)*. Il le lisait tant que les sons se réglaient **par domaine** ; ils ont fusionné
   * en un seul `soundsEnabled` le 2026-08-06, si bien que l'écran relisait exactement le booléen
   * que le service relit déjà — deux vérités pour une. Le silence se vérifie donc dans
   * `recording-sound.spec.ts`, et ce test-ci garde la porte contre le retour du `if`.
   */
  it('delegates the decision instead of reading the setting itself', async () => {
    const { fixture, sound } = await render({ settings: { soundsEnabled: false } });
    config(fixture).start.emit();
    await fixture.whenStable();
    expect(sound.play).toHaveBeenCalledExactlyOnceWith('start');
  });

  it('stops the capture and gives the form back', async () => {
    const { fixture, store } = await render({ recording: true });
    config(fixture).stop.emit();
    await fixture.whenStable();

    expect(store.stop).toHaveBeenCalledOnce();
    expect(config(fixture).recording()).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **ARRÊTER DEPUIS LA FENÊTRE-SESSION MET CET ÉCRAN À JOUR** — ligne de DoD de P4-18.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Les deux fenêtres portent un bouton « Arrêter », et fermer la fenêtre-session en est un
   * troisième. Sans cette écoute, le déclencheur resterait figé sur un formulaire inactif et un
   * minuteur qui court, pour une session déjà close.
   */
  it('follows a stop that came from the other window', async () => {
    const { fixture, store } = await render({ recording: true });
    expect(stoppedHandler).not.toBeNull();

    stoppedHandler?.();
    await fixture.whenStable();

    expect(store.stopped).toHaveBeenCalledOnce();
    expect(config(fixture).recording()).toBe(false);
  });

  /**
   * ⚠️ **Un abonnement qui échoue ne prive pas du démarrage** : le formulaire reste utilisable,
   * et l'échec se dit. C'est la fenêtre-session qui porte la capture, pas cet écran.
   */
  it('still lets a session start when the stop channel cannot be subscribed to', async () => {
    const { fixture, snackbar, store } = await render({ subscribeFails: true });

    expect(snackbar.error).toHaveBeenCalledOnce();
    config(fixture).start.emit();
    await fixture.whenStable();
    expect(store.start).toHaveBeenCalledOnce();
  });

  it('advances the discreet timer every second', async () => {
    const { fixture } = await render();
    // ⚠️ Les timers factices se posent **avant** le démarrage : l'intervalle du minuteur naît
    // dedans, sinon il tourne sur la vraie horloge et rien ne l'avance.
    vi.useFakeTimers();
    config(fixture).start.emit();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();

    vi.advanceTimersByTime(3_000);
    fixture.detectChanges();
    expect(config(fixture).elapsedSeconds()).toBe(3);
  });

  /**
   * ⚠️⚠️ **LE MINUTEUR SE DÉDUIT DE L'INSTANT DE DÉPART, IL NE SE COMPTE PAS** *(correctif du
   * 2026-08-04, élargi par P4-18)*. Quitter l'écran pour les Options détruisait le composant, et
   * y revenir affichait `00:00:00` **figé**. Depuis P4-18 s'ajoute le cas de la fenêtre fermée
   * puis rouverte : le magasin repart de zéro et c'est `sync()` qui le remplit. Ce test monte
   * l'écran sur une session **déjà en cours** et exige que le battement reprenne seul.
   */
  it('picks the timer back up when the screen returns mid-session', async () => {
    const { fixture, startedAtMs } = await renderTicking({ recording: true });
    startedAtMs.set(Date.now() - 90_000);
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();

    expect(config(fixture).elapsedSeconds()).toBe(91);

    await vi.advanceTimersByTimeAsync(2_000);
    fixture.detectChanges();
    expect(config(fixture).elapsedSeconds()).toBe(93);
  });

  it('stops the timer when the screen is destroyed', async () => {
    const { fixture } = await renderTicking({ recording: true });
    // ⚠️ **Le formulaire se prend AVANT la destruction** : après, il n'est plus dans l'arbre, et
    // c'est justement lui qui porte la valeur qu'on veut voir figée.
    const mounted = config(fixture);
    const seen = mounted.elapsedSeconds();
    fixture.destroy();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mounted.elapsedSeconds()).toBe(seen);
  });

  it('has no accessibility violations', async () => {
    const { fixture } = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });

  it('has no accessibility violations while a session runs', async () => {
    const { fixture } = await render({ recording: true });
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
