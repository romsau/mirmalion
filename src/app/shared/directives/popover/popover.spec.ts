import { afterEach, describe, expect, it } from 'vitest';
import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Popover } from './popover';

@Component({
  imports: [Popover],
  template: `
    <button type="button" [appPopover]="panel" [placement]="placement" [autoFocus]="autoFocus">
      Ouvrir
    </button>
    <ng-template #panel>
      <div class="contenu">
        @if (unreachableFirst) {
          <button type="button" class="eteint" disabled>Indisponible</button>
          <span class="hors-tab" tabindex="-1">Hors tabulation</span>
        }
        <button type="button">Dedans</button>
      </div>
    </ng-template>
  `,
})
class Host {
  readonly popover = viewChild.required(Popover);
  placement: 'below' | 'above' = 'below';
  autoFocus = false;
  /** Le panneau ouvre-t-il sur des lignes que le clavier ne peut pas atteindre ? */
  unreachableFirst = false;
}

function render(placement: 'below' | 'above' = 'below', autoFocus = false, unreachable = false) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.placement = placement;
  fixture.componentInstance.autoFocus = autoFocus;
  fixture.componentInstance.unreachableFirst = unreachable;
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const trigger = element.querySelector('button');
  if (trigger === null) {
    throw new Error('aucun déclencheur');
  }
  return {
    fixture,
    trigger,
    panel: () => document.querySelector('.contenu'),
    backdrop: () => document.querySelector<HTMLElement>('.cdk-overlay-backdrop'),
  };
}

function press(key: string) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

afterEach(() => {
  TestBed.resetTestingModule();
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('Popover', () => {
  /**
   * ⚠️ **Ce test prouve que le sens d'ouverture est PRIS EN COMPTE, pas qu'il place bien.**
   * jsdom ne fait aucune mise en page : aucun élément n'y a de géométrie, donc rien ici ne peut
   * dire où le panneau atterrit — seul l'œil le peut, et c'est écrit dans l'en-tête de la
   * directive. Ce qu'on vérifie est que la branche existe, qu'elle s'exécute, et qu'un panneau
   * demandé vers le haut **s'ouvre quand même** : une position mal formée aurait fait lever le
   * CDK à l'attachement, et le menu ne serait jamais apparu.
   */
  it('opens upwards when the host asks for it, without changing anything else', () => {
    const { trigger, panel, fixture } = render('above');

    trigger.click();
    fixture.detectChanges();
    expect(panel()).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.click();
    fixture.detectChanges();
    expect(panel()).toBeNull();
  });

  it('opens and closes on the trigger, and says so on the trigger itself', () => {
    const { fixture, trigger, panel } = render();

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();

    trigger.click();
    fixture.detectChanges();
    expect(panel()).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.click();
    fixture.detectChanges();
    expect(panel()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and gives the focus back to the trigger', () => {
    const { fixture, trigger, panel } = render();
    trigger.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('.contenu button')?.focus();

    press('Escape');
    fixture.detectChanges();

    expect(panel()).toBeNull();
    expect(document.activeElement, 'sans cela le focus se perd dans le <body>').toBe(trigger);
  });

  it('closes on a click outside', () => {
    const { fixture, trigger, panel, backdrop } = render();
    trigger.click();
    fixture.detectChanges();

    backdrop()?.click();
    fixture.detectChanges();

    expect(panel()).toBeNull();
  });

  it('survives a page scroll', () => {
    // ⚠️ Régression : en butée de liste, le défilement se propageait à la page (*scroll
    // chaining*), la page émettait un `scroll`, et le panneau se fermait sous le doigt de
    // l'utilisateur. Il ne se ferme que sur choix ou clic dehors (signalé le 2026-07-30).
    const { fixture, trigger, panel } = render();
    trigger.click();
    fixture.detectChanges();

    document.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(panel()).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens only once, however many times it is asked', () => {
    const { fixture, trigger } = render();

    fixture.componentInstance.popover().open();
    fixture.componentInstance.popover().open();
    fixture.detectChanges();

    expect(document.querySelectorAll('.contenu')).toHaveLength(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes quietly when it was never open', () => {
    const { fixture } = render();

    expect(() => {
      fixture.componentInstance.popover().close();
    }).not.toThrow();
  });

  it('takes nothing with it when destroyed while open', () => {
    const { fixture, trigger } = render();
    trigger.click();
    fixture.detectChanges();

    fixture.destroy();

    expect(document.querySelector('.contenu')).toBeNull();
  });

  /**
   * ⚠️ **`autoFocus` est FAUX par défaut, et il faut que ça se voie.** Déplacer le focus dans un
   * panneau qui vient de s'ouvrir est juste pour un menu où l'on va choisir, et faux pour un
   * panneau qu'on survole : le clavier se retrouverait ailleurs sans que rien ne l'ait demandé.
   */
  it('leaves the focus alone unless it is asked to move it', () => {
    const { fixture, trigger } = render();
    trigger.click();
    fixture.detectChanges();

    expect(document.activeElement).not.toBe(document.querySelector('.contenu button'));
  });

  it('focuses the first focusable element of the panel when asked', () => {
    const { fixture, trigger } = render('below', true);
    trigger.click();
    fixture.detectChanges();

    expect(document.activeElement).toBe(document.querySelector('.contenu button'));
  });

  /**
   * ⚠️ **Une ligne désactivée ou hors tabulation n'est pas un candidat.** `focus()` sur elle est
   * un non-évènement : le focus resterait sur le déclencheur, et le panneau s'ouvrirait sans que
   * le clavier y entre. Le cas est courant — une langue non installée ouvre un menu dont la
   * première ligne est éteinte.
   */
  it('skips the rows the keyboard cannot reach when it moves the focus', () => {
    const { fixture, trigger } = render('below', true, true);
    trigger.click();
    fixture.detectChanges();

    expect(document.activeElement).not.toBe(document.querySelector('.contenu .eteint'));
    expect(document.activeElement).not.toBe(document.querySelector('.contenu .hors-tab'));
    expect(document.activeElement).toBe(document.querySelector('.contenu button:not([disabled])'));
  });
});
