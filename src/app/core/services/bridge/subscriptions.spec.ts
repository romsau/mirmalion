import { describe, expect, it, vi } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { subscriptions, type Subscriptions } from './subscriptions';

@Component({ template: '' })
class Host {
  readonly subs: Subscriptions = subscriptions();
}

function harness() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, subs: fixture.componentInstance.subs };
}

/** Un abonnement dont on choisit l'instant où il aboutit. */
function inFlight() {
  let settle: (stop: () => void) => void = () => {};
  const pending = new Promise<() => void>((resolve) => {
    settle = resolve;
  });
  return { pending, settle };
}

describe('subscriptions', () => {
  it('calls every kept unsubscribe when the window dies', async () => {
    const { fixture, subs } = harness();
    const first = vi.fn();
    const second = vi.fn();
    await subs.keep(Promise.resolve(first));
    await subs.keep(Promise.resolve(second));

    fixture.destroy();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **Le point de cette aide.** S'abonner passe par une promesse, et la fenêtre peut mourir
   * pendant. Sans ce rattrapage, l'abonnement aboutirait après la destruction et resterait branché
   * sans propriétaire — un rappel dans une fenêtre qui n'existe plus.
   */
  it('unsubscribes on the spot when the window died while the subscription was in flight', async () => {
    const { fixture, subs } = harness();
    const stop = vi.fn();
    const { pending, settle } = inFlight();
    const kept = subs.keep(pending);

    fixture.destroy();
    settle(stop);
    await kept;

    expect(stop).toHaveBeenCalledOnce();
  });

  it('says whether the window is still there', () => {
    const { fixture, subs } = harness();

    expect(subs.alive()).toBe(true);
    fixture.destroy();
    expect(subs.alive()).toBe(false);
  });
});
