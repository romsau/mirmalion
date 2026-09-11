import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { liveClock } from './live-clock';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

/** Monte un chrono dans un contexte d'injection, comme le ferait un constructeur de composant. */
function mount(startedAtMs: () => number | null) {
  TestBed.resetTestingModule();
  const injector = TestBed.inject(Injector);
  return runInInjectionContext(injector, () => liveClock(startedAtMs));
}

describe('liveClock', () => {
  it('part à zéro tant qu’il n’a pas démarré', () => {
    const clock = mount(() => null);

    expect(clock.elapsedSeconds()).toBe(0);
  });

  /**
   * ⚠️ **Le premier relevé est immédiat.** Sans lui, l'écran afficherait `00:00:00` pendant une
   * seconde après un retour en pleine session — le chrono ne compte pas, il relit.
   */
  it('relève la durée dès le démarrage, sans attendre le premier intervalle', () => {
    vi.setSystemTime(new Date(10_000));
    const clock = mount(() => 4_000);

    clock.start();

    expect(clock.elapsedSeconds()).toBe(6);
  });

  it('relit la durée à chaque seconde', () => {
    vi.setSystemTime(new Date(10_000));
    const clock = mount(() => 10_000);
    clock.start();

    vi.advanceTimersByTime(3_000);

    expect(clock.elapsedSeconds()).toBe(3);
  });

  /**
   * ⚠️ **Idempotent.** L'effet qui l'appelle peut se rejouer, et deux intervalles pour un même
   * écran feraient deux relectures par seconde.
   */
  it('ne pose qu’un intervalle, même démarré deux fois', () => {
    vi.setSystemTime(new Date(0));
    const clock = mount(() => 0);
    const spy = vi.spyOn(globalThis, 'clearInterval');

    clock.start();
    clock.start();

    expect(spy).toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(clock.elapsedSeconds()).toBe(1);
  });

  it('se coupe et se laisse recouper sans effet', () => {
    vi.setSystemTime(new Date(0));
    const clock = mount(() => 0);
    clock.start();

    clock.stop();
    vi.advanceTimersByTime(5_000);

    expect(clock.elapsedSeconds()).toBe(0);
    expect(() => clock.stop()).not.toThrow();
  });

  /**
   * ⚠️ La durée se recalcule depuis l'instant de départ, elle ne s'incrémente pas : un intervalle
   * en retard ne décale donc rien.
   */
  it('suit l’instant de départ, même quand il change en cours de route', () => {
    vi.setSystemTime(new Date(20_000));
    const started = signal<number | null>(20_000);
    const clock = mount(() => started());
    clock.start();
    expect(clock.elapsedSeconds()).toBe(0);

    started.set(5_000);
    vi.advanceTimersByTime(1_000);

    expect(clock.elapsedSeconds()).toBe(16);
  });
});
