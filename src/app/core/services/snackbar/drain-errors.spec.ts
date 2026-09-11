import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { drainErrors } from './drain-errors';
import { Snackbar } from './snackbar';
import type { AppError } from '../../models/app-error';

/** Un magasin réduit au contrat que l'aide lit : une erreur, et de quoi l'oublier. */
function store() {
  const error = signal<AppError | null>(null);
  return {
    error: error.asReadonly(),
    clearError: vi.fn(() => error.set(null)),
    fail: (message: string) => error.set({ kind: 'database', message }),
  };
}

function harness() {
  const snackbar = { error: vi.fn(), info: vi.fn(), success: vi.fn(), clear: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: Snackbar, useValue: snackbar }] });
  return { snackbar, injector: TestBed.inject(Injector) };
}

describe('drainErrors', () => {
  it('ne dit rien tant qu’aucun échec n’est survenu', () => {
    const { snackbar, injector } = harness();
    const subject = store();

    runInInjectionContext(injector, () => drainErrors(subject));
    TestBed.tick();

    expect(snackbar.error).not.toHaveBeenCalled();
  });

  it('dit l’échec avec son propre message', () => {
    const { snackbar, injector } = harness();
    const subject = store();

    runInInjectionContext(injector, () => drainErrors(subject));
    subject.fail('base fermée');
    TestBed.tick();

    expect(snackbar.error).toHaveBeenCalledExactlyOnceWith('base fermée');
  });

  /**
   * ⚠️ **Le point de cette aide.** Sans la remise à zéro, la snackbar reviendrait à chaque cycle
   * de détection, longtemps après le geste qui l'a causée.
   */
  it('oublie l’échec une fois dit', () => {
    const { snackbar, injector } = harness();
    const subject = store();

    runInInjectionContext(injector, () => drainErrors(subject));
    subject.fail('disque plein');
    TestBed.tick();
    TestBed.tick();

    expect(subject.clearError).toHaveBeenCalledOnce();
    expect(snackbar.error).toHaveBeenCalledOnce();
  });

  it('dit deux échecs successifs, et non un seul', () => {
    // ⚠️ Deux échecs donnent deux objets distincts : c'est la remise à zéro entre les deux qui
    // permet au second de se voir, là où un drapeau resté vrai n'aurait rien annoncé.
    const { snackbar, injector } = harness();
    const subject = store();

    runInInjectionContext(injector, () => drainErrors(subject));
    subject.fail('premier');
    TestBed.tick();
    subject.fail('second');
    TestBed.tick();

    expect(snackbar.error).toHaveBeenCalledTimes(2);
    expect(snackbar.error).toHaveBeenLastCalledWith('second');
  });
});
