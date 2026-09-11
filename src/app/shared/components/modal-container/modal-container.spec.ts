import { afterEach, describe, expect, it } from 'vitest';
import { Component, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalContainer } from './modal-container';
import { expectNoAxeViolations } from '../../../../testing/axe';

@Component({ template: '<p>contenu monté</p><button type="button">Agir</button>' })
class Mounted {}

async function render(
  inputs: {
    heading?: string;
    columns?: 1 | 2 | 3;
    width?: number | null;
    dismissible?: boolean;
    fill?: boolean;
  } = {},
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(ModalContainer);
  fixture.componentRef.setInput('heading', inputs.heading ?? 'Participants');
  if (inputs.columns !== undefined) {
    fixture.componentRef.setInput('columns', inputs.columns);
  }
  if (inputs.width !== undefined) {
    fixture.componentRef.setInput('width', inputs.width);
  }
  if (inputs.dismissible !== undefined) {
    fixture.componentRef.setInput('dismissible', inputs.dismissible);
  }
  if (inputs.fill !== undefined) {
    fixture.componentRef.setInput('fill', inputs.fill);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, element: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('ModalContainer', () => {
  it('declares itself a modal dialog, named by its heading', async () => {
    const { element } = await render({ heading: 'Participants' });
    const dialog = element.querySelector('[role="dialog"]');

    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // Le nom accessible vient du titre : sans lui, un lecteur d'écran n'annonce que « dialogue ».
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    expect(element.querySelector(`#${labelledBy}`)?.textContent).toBe('Participants');
  });

  it('mounts an arbitrary component inside its body', async () => {
    const { fixture, element } = await render();

    fixture.componentInstance.mount(Mounted, TestBed.inject(Injector));
    fixture.detectChanges();

    expect(element.querySelector('.pmodal-body')?.textContent).toContain('contenu monté');
  });

  it('freezes its width on the column count it was opened with', async () => {
    expect((await render({})).element.querySelector('.pmodal')?.className).toContain('columns-1');
    expect((await render({ columns: 3 })).element.querySelector('.pmodal')?.className).toContain(
      'columns-3',
    );
  });

  /**
   * ⚠️ Opt-in, et les deux moitiés ensemble : la hauteur pleine sur la boîte, la colonne sur son
   * corps. Une modale qui ne la demande pas ne doit pas bouger d'un pixel.
   */
  it('fills the height only when asked for it', async () => {
    const filled = await render({ fill: true });
    expect(filled.element.querySelector('.pmodal')?.className).toContain('is-fill');

    const plain = await render({});
    expect(plain.element.querySelector('.pmodal')?.className).not.toContain('is-fill');
  });

  it('takes a width of its own over the column palier, and none by default', async () => {
    // La modale d'installation de langue en demande une (380 px) : celle d'une colonne, 460 px,
    // ne tient pas dans la fenêtre repliée, qui n'en fait que 450 (constaté le 2026-07-30).
    const chosen = await render({ width: 380 });
    expect(chosen.element.querySelector<HTMLElement>('.pmodal')?.style.width).toBe('380px');

    const palier = await render({});
    expect(palier.element.querySelector<HTMLElement>('.pmodal')?.style.width).toBe('');
  });

  it('offers a close button only when it is dismissible', async () => {
    const withButton = await render({ dismissible: true });
    expect(withButton.element.querySelector('.pmodal-head app-button')).not.toBeNull();

    const without = await render({ dismissible: false });
    expect(without.element.querySelector('.pmodal-head app-button')).toBeNull();
  });

  it('emits when the close button is used', async () => {
    const { fixture, element } = await render({ dismissible: true });
    let dismissals = 0;
    fixture.componentInstance.dismissed.subscribe(() => {
      dismissals += 1;
    });

    element.querySelector<HTMLButtonElement>('.pmodal-head button')?.click();
    expect(dismissals).toBe(1);
  });

  it('has no accessibility violation', async () => {
    const { element } = await render();
    await expectNoAxeViolations(element);
  });
});
