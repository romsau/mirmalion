import { describe, expect, it, vi } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LanguageInstall, type LanguageInstallData } from './language-install';
import { MODAL_DATA, ModalRef } from '../../../core/services/modal/modal-ref';
import { expectNoAxeViolations } from '../../../../testing/axe';

interface Harness {
  readonly fixture: ComponentFixture<LanguageInstall>;
  readonly progress: WritableSignal<number | null>;
  readonly indeterminate: WritableSignal<boolean>;
  readonly accept: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly disposed: ReturnType<typeof vi.fn>;
}

async function render(
  initial: { progress?: number | null; indeterminate?: boolean } = {},
): Promise<Harness> {
  const progress = signal<number | null>(initial.progress ?? null);
  const indeterminate = signal(initial.indeterminate ?? false);
  const accept = vi.fn();
  const cancel = vi.fn();
  const disposed = vi.fn();
  const data: LanguageInstallData = {
    language: 'it' as const,
    progress,
    indeterminate,
    accept,
    cancel,
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MODAL_DATA, useValue: data },
      { provide: ModalRef, useValue: new ModalRef(disposed) },
    ],
  });
  const fixture = TestBed.createComponent(LanguageInstall);
  await fixture.whenStable();
  return { fixture, progress, indeterminate, accept, cancel, disposed };
}

function rootOf(fixture: ComponentFixture<LanguageInstall>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function buttons(fixture: ComponentFixture<LanguageInstall>): HTMLButtonElement[] {
  return [...rootOf(fixture).querySelectorAll<HTMLButtonElement>('button')];
}

describe('LanguageInstall', () => {
  it('asks before anything is downloaded', async () => {
    // ⚠️ Choisir une langue dans un menu n'est pas demander plusieurs centaines de mégaoctets.
    // Cette question EST le clic exigé par la règle globale n° 4.
    const { fixture } = await render();
    const root = rootOf(fixture);

    expect(root.querySelector('.li-title')?.textContent).toContain('italienne');
    expect(root.querySelector('app-progress-bar')).toBeNull();
    expect(buttons(fixture).map((button) => button.textContent?.trim())).toEqual([
      'Annuler',
      'Installer',
    ]);
  });

  it('puts the least engaging action first — it is the one the focus lands on', async () => {
    // Ouvrir sur « Installer » lancerait le téléchargement d'une simple frappe d'Entrée.
    const { fixture } = await render();
    expect(buttons(fixture)[0].textContent?.trim()).toBe('Annuler');
  });

  it('starts the download only on an explicit yes', async () => {
    const { fixture, accept } = await render();
    buttons(fixture)[1].click();
    expect(accept).toHaveBeenCalledOnce();
  });

  it('closes without engaging anything on a no', async () => {
    const { fixture, accept, disposed } = await render();
    buttons(fixture)[0].click();

    expect(disposed).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });

  it('switches to the progress block once the download starts', async () => {
    const { fixture, progress } = await render();
    progress.set(47);
    await fixture.whenStable();
    const root = rootOf(fixture);

    expect(root.querySelector('.li-title')).toBeNull();
    expect(root.querySelector('app-progress-bar')).not.toBeNull();
    expect(root.querySelector('.label')?.textContent).toContain('italienne');
  });

  it('tells « not asked yet » from « started at zero »', async () => {
    // ⚠️ `null` et `0` ne veulent pas dire la même chose : les confondre ramènerait la
    // question au premier octet reçu.
    const { fixture, progress } = await render();
    expect(rootOf(fixture).querySelector('app-progress-bar')).toBeNull();

    progress.set(0);
    await fixture.whenStable();
    expect(rootOf(fixture).querySelector('app-progress-bar')).not.toBeNull();
  });

  it('shows an indeterminate bar for a download it found already running', async () => {
    // Une reprise après réouverture de la fenêtre n'a pas de pourcentage connu : afficher 0 %
    // annoncerait une mesure qui n'a jamais été faite.
    const { fixture } = await render({ indeterminate: true });
    const root = rootOf(fixture);

    expect(root.querySelector('app-progress-bar')).not.toBeNull();
    expect(root.querySelector('.bar')?.classList.contains('indeterminate')).toBe(true);
  });

  it('offers its way out immediately, without the usual delay', async () => {
    // ⚠️ Un téléchargement n'est jamais une opération courte, et c'est ici la SEULE sortie :
    // faire attendre 2,5 s avant de l'offrir enfermerait l'utilisateur.
    const { fixture, cancel } = await render({ progress: 12 });
    const button = buttons(fixture).find((item) => item.textContent?.trim() === 'Annuler');

    expect(button).toBeDefined();
    button?.click();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not close itself on cancel — the backend decides when it is over', async () => {
    // L'écran mentirait pendant le temps que met l'arrêt : c'est l'évènement d'annulation qui
    // referme la modale.
    const { fixture, disposed } = await render({ progress: 12 });
    buttons(fixture)[0].click();
    expect(disposed).not.toHaveBeenCalled();
  });

  it('has no AXE violation, at either step', async () => {
    await expectNoAxeViolations((await render()).fixture.nativeElement);
    await expectNoAxeViolations((await render({ progress: 47 })).fixture.nativeElement);
  });
});
