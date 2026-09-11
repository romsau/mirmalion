import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PermissionRow, type PermissionGesture, type PermissionEntry } from './permission-row';
import { expectNoAxeViolations } from '../../../../../testing/axe';

function rowWith(
  gesture: PermissionGesture,
  overrides: Partial<PermissionEntry> = {},
): PermissionEntry {
  return {
    key: 'microphone',
    icon: 'mic',
    title: 'Microphone',
    description: 'Capturer votre voix.',
    gesture,
    note: null,
    busy: false,
    ...overrides,
  };
}

async function render(row: PermissionEntry): Promise<ComponentFixture<PermissionRow>> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(PermissionRow);
  fixture.componentRef.setInput('row', row);
  await fixture.whenStable();
  return fixture;
}

/** `fixture.nativeElement` est `any` : on le type une fois, ici, plutôt qu'à chaque appel. */
function rootOf(fixture: ComponentFixture<PermissionRow>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

describe('PermissionRow', () => {
  it('states what the permission is for, before anything else', async () => {
    // Le priming : quoi + pourquoi, dans notre interface, avant tout appel
    // système. Une ligne qui ne montrerait que son bouton violerait la première des quatre
    // règles.
    const fixture = await render(rowWith('request'));
    const root = rootOf(fixture);

    expect(root.querySelector('.onb-it-title')?.textContent?.trim()).toBe('Microphone');
    expect(root.querySelector('.onb-it-desc')?.textContent?.trim()).toBe('Capturer votre voix.');
  });

  it('shows a badge and no control once granted', async () => {
    const fixture = await render(rowWith('granted'));
    const root = rootOf(fixture);

    expect(root.querySelector('.perm-tag.is-ok')?.textContent?.trim()).toBe('Autorisé');
    expect(root.querySelector('button')).toBeNull();
  });

  it('offers « Autoriser » wherever a prompt can actually be triggered', async () => {
    const fixture = await render(rowWith('request'));
    expect(rootOf(fixture).querySelector('button')?.textContent?.trim()).toBe('Autoriser');
  });

  it('wears the same verb whatever the click will actually open', async () => {
    // ⚠️ L'Accessibilité n'a aucun pop-up — son bouton ouvre les Réglages Système — et porte
    // pourtant le même libellé que les deux autres. Décision du porteur : le verbe annonce
    // une intention, pas une modalité. La règle a été corrigée en conséquence.
    const fixture = await render(
      rowWith('settings', { key: 'accessibility', title: 'Accessibilité' }),
    );
    expect(rootOf(fixture).querySelector('button')?.textContent?.trim()).toBe('Autoriser');
  });

  it('shows a refusal as a fact, with nothing left to click', async () => {
    const fixture = await render(rowWith('blocked'));
    const root = rootOf(fixture);

    expect(root.querySelector('.perm-tag.is-warn')?.textContent?.trim()).toBe('Refusé');
    expect(root.querySelector('button')).toBeNull();
  });

  it('renders the note under the description when there is one', async () => {
    const fixture = await render(rowWith('settings', { note: 'Une explication.' }));
    expect(rootOf(fixture).querySelector('.onb-it-note')?.textContent?.trim()).toBe(
      'Une explication.',
    );
  });

  it('omits the note entirely when the description says it all', async () => {
    const fixture = await render(rowWith('granted'));
    expect(rootOf(fixture).querySelector('.onb-it-note')).toBeNull();
  });

  it('emits its own key when the control is pressed', async () => {
    const fixture = await render(rowWith('settings', { key: 'accessibility' }));
    const acted = vi.fn();
    fixture.componentInstance.act.subscribe(acted);

    rootOf(fixture).querySelector('button')?.click();
    expect(acted).toHaveBeenCalledWith('accessibility');
  });

  it('stops answering while the system prompt is waiting', async () => {
    // La promesse de `requestMicrophone` ne se résout qu'une fois l'utilisateur a répondu,
    // sans délai maximal. Sans ce verrou, chaque clic supplémentaire empilerait une demande.
    const fixture = await render(rowWith('request', { busy: true }));
    const acted = vi.fn();
    fixture.componentInstance.act.subscribe(acted);

    const button = rootOf(fixture).querySelector('button');
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(acted).not.toHaveBeenCalled();
  });

  it('names the control well enough to be understood out of context', async () => {
    // WCAG 2.5.3 : le nom accessible doit **contenir** le libellé visible. Trois lignes, un
    // seul libellé — « Autoriser » tout court ne dit pas de quoi.
    const grant = await render(rowWith('request'));
    expect(rootOf(grant).querySelector('button')?.getAttribute('aria-label')).toBe(
      'Autoriser : Microphone',
    );

    const settings = await render(
      rowWith('settings', { key: 'accessibility', title: 'Accessibilité' }),
    );
    expect(rootOf(settings).querySelector('button')?.getAttribute('aria-label')).toBe(
      'Autoriser : Accessibilité',
    );
  });

  it('keeps its icon decorative — the title already says it', async () => {
    const fixture = await render(rowWith('request'));
    expect(rootOf(fixture).querySelector('.onb-ico svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('has no accessibility violations, whatever the gesture', async () => {
    for (const gesture of ['granted', 'request', 'settings', 'blocked'] as const) {
      const fixture = await render(rowWith(gesture, { note: 'Une explication.' }));
      await expectNoAxeViolations(rootOf(fixture));
    }
  });
});
