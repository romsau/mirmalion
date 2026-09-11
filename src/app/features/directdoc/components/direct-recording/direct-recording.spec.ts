import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DirectRecording } from './direct-recording';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import type { LiveLine } from '../../../../core/services/live/live';

const LINES: readonly LiveLine[] = [
  { id: 0, stream: 'system', text: 'Bon, on commence par le point roadmap ?', paragraph: false },
  { id: 1, stream: 'microphone', text: 'Oui, je partage mon écran.', paragraph: false },
];

async function render(overrides: Partial<Record<string, unknown>> = {}) {
  TestBed.resetTestingModule();
  const fixture: ComponentFixture<DirectRecording> = TestBed.createComponent(DirectRecording);
  fixture.componentRef.setInput('title', 'Session du 06/08/2026 à 14:30');
  fixture.componentRef.setInput('meta', 'Microsoft Teams · avec mon micro');
  fixture.componentRef.setInput('elapsedSeconds', 724);
  fixture.componentRef.setInput('level', 0.4);
  fixture.componentRef.setInput('lines', LINES);
  fixture.componentRef.setInput('pending', { system: null, microphone: null });
  for (const [name, value] of Object.entries(overrides)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

describe('DirectRecording', () => {
  /**
   * ⚠️ **Tête, barre, filet, contenu — la même charpente que le panneau document**, aux mêmes
   * endroits. La fenêtre ne doit pas se réorganiser sous les yeux de l'utilisateur au moment de
   * l'arrêt.
   */
  it('lays out the head, the recording line and the transcript', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.done-head')).not.toBeNull();
    expect(root.querySelector('.done-subbar')).not.toBeNull();
    expect(root.querySelector('app-direct-live')).not.toBeNull();
    expect(root.querySelector('app-direct-transcript')).not.toBeNull();
  });

  it('shows the title and the meta it is given', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Session du 06/08/2026 à 14:30');
    expect(root.querySelector('.done-meta')?.textContent).toContain('avec mon micro');
  });

  /**
   * ⚠️⚠️ **RIEN D'AUTRE À DROITE DU TITRE.** Il n'y a plus de participants dans le produit, et la
   * bascule vers l'original n'existe que si une traduction a été demandée au démarrage (P4-20).
   */
  it('puts no toggle beside the title', async () => {
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.tr-toggle')).toBeNull();
  });

  /**
   * ⚠️ **`role="status"` sur la méta, jamais sur le chrono** : elle ne change pas, elle peut donc
   * être annoncée sans devenir un bavardage. La durée, elle, est en `aria-hidden`.
   */
  it('announces what is being captured without announcing the passing seconds', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.done-meta')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('.rec-timer')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('passes the stop up rather than acting on it', async () => {
    const fixture = await render();
    const stopped = vi.fn();
    fixture.componentInstance.stop.subscribe(stopped);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.rec-stop')?.click();

    expect(stopped).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ **On renomme sa session PENDANT qu'elle enregistre** — c'est même le moment où l'on sait
   * de quoi elle parle. Le panneau ne fait que faire remonter : c'est la coquille qui écrit.
   */
  it('passes a rename up rather than writing it', async () => {
    const fixture = await render();
    const renamed = vi.fn();
    fixture.componentInstance.renamed.subscribe(renamed);
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector<HTMLButtonElement>('.title-rename')?.click();
    fixture.detectChanges();

    const field = root.querySelector<HTMLInputElement>('.title-input');
    expect(field).not.toBeNull();
    if (field === null) {
      return;
    }
    field.value = 'Point client';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(renamed).toHaveBeenCalledExactlyOnceWith('Point client');
  });

  it('refuses a second stop while one is in flight', async () => {
    const fixture = await render({ stopping: true });
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.rec-stop',
    );
    expect(button?.disabled).toBe(true);
  });

  it('has no accessibility violations', async () => {
    const fixture = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **L'INTERRUPTEUR « AFFICHER L'ORIGINAL »** *(P4-20)*.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe('DirectRecording, translated', () => {
  function switchOf(fixture: ComponentFixture<DirectRecording>): HTMLButtonElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[role="switch"]');
  }

  /**
   * ⚠️⚠️ **IL N'EXISTE PAS SANS LANGUE DE TRADUCTION, ET IL N'EST PAS GRISÉ : ABSENT.** Sans
   * elle, il n'aurait pas de seconde colonne à montrer — et ce qui s'affiche **est** déjà
   * l'original.
   */
  it('offers no switch when the session is not translated', async () => {
    const fixture = await render();
    expect(switchOf(fixture)).toBeNull();
  });

  /**
   * ⚠️ **Un interrupteur, pas un bouton** : ce qui se règle est un **état de la vue** — allumé,
   * la colonne est là ; éteint, elle n'y est pas. Un bouton aurait dû changer de libellé à chaque
   * clic pour dire la même chose.
   */
  it('opens and closes the original column, and stays a view state', async () => {
    const fixture = await render({ sourceLanguage: 'fr', targetLanguage: 'en' });
    const root = fixture.nativeElement as HTMLElement;

    expect(switchOf(fixture)?.getAttribute('aria-checked')).toBe('false');
    expect(root.querySelectorAll('.tr-col')).toHaveLength(1);

    switchOf(fixture)?.click();
    fixture.detectChanges();

    expect(switchOf(fixture)?.getAttribute('aria-checked')).toBe('true');
    expect(root.querySelectorAll('.tr-col')).toHaveLength(2);
  });

  /**
   * ⚠️ **Au bout de la LIGNE D'ENREGISTREMENT, pas dans la ligne de titre** *(porteur,
   * 2026-08-06)* : tout ce qui pilote la session en cours vit sur cette ligne-là.
   */
  it('lives at the end of the recording line, never in the title row', async () => {
    const fixture = await render({ sourceLanguage: 'fr', targetLanguage: 'en' });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.dd-recbar .switch-field')).not.toBeNull();
    expect(root.querySelector('.done-head [role="switch"]')).toBeNull();
  });

  /** La traduction descend jusqu'au transcript, sans que ce panneau la retouche. */
  it('passes the translations straight down to the transcript', async () => {
    const fixture = await render({
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      translations: { 0: 'So, shall we start with the roadmap?', 1: 'Yes, sharing my screen.' },
    });

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('shall we start');
  });

  it('has no accessibility violations while translating', async () => {
    const fixture = await render({ sourceLanguage: 'fr', targetLanguage: 'en' });
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
