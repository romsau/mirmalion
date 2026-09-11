import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OnboardingPermissions } from './onboarding-permissions';
import type { PermissionKey } from '../permission-row/permission-row';
import type {
  PermissionStatus,
  PermissionsStatus,
} from '../../../../core/services/bridge/permissions/permissions.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';

/** Un état complet, dont on ne renseigne que ce que le test regarde. */
function statusWith(
  overrides: Partial<Record<PermissionKey, PermissionStatus>>,
): PermissionsStatus {
  const permission = (status: PermissionStatus) => ({ status, detail: null });
  return {
    microphone: permission(overrides.microphone ?? 'notDetermined'),
    accessibility: permission(overrides.accessibility ?? 'notDetermined'),
    automation: permission('unknown'),
    audioCapture: permission(overrides.audioCapture ?? 'unknown'),
  };
}

async function render(
  status: PermissionsStatus | null = null,
  pending: PermissionKey | null = null,
): Promise<ComponentFixture<OnboardingPermissions>> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(OnboardingPermissions);
  fixture.componentRef.setInput('status', status);
  fixture.componentRef.setInput('pending', pending);
  await fixture.whenStable();
  return fixture;
}

/** `fixture.nativeElement` est `any` : on le type une fois, ici, plutôt qu'à chaque appel. */
function rootOf(fixture: ComponentFixture<OnboardingPermissions>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function texts(fixture: ComponentFixture<OnboardingPermissions>, selector: string): string[] {
  return Array.from(rootOf(fixture).querySelectorAll(selector)).map(
    (node) => node.textContent?.trim() ?? '',
  );
}

/** Ce que la ligne d'une permission propose, dans un état donné. */
async function actionOf(key: PermissionKey, status: PermissionStatus): Promise<string | undefined> {
  const fixture = await render(statusWith({ [key]: status }));
  const rows = Array.from(rootOf(fixture).querySelectorAll('app-permission-row'));
  const row = rows[['microphone', 'accessibility', 'audioCapture'].indexOf(key)];
  return row?.querySelector('button, .perm-tag')?.textContent?.trim();
}

describe('OnboardingPermissions', () => {
  it('carries the wording that was settled, word for word', async () => {
    const fixture = await render();
    const root = rootOf(fixture);

    expect(root.querySelector('.onb-h')?.textContent?.trim()).toBe('Autorisations');
    // Le sous-titre est **transversal** : il pose le principe, il ne liste pas les
    // permissions — le détail est dans les lignes.
    expect(root.querySelector('.onb-sub')?.textContent?.trim()).toBe(
      "Accordez-les une par une — rien ne s'active sans votre accord.",
    );
    expect(texts(fixture, '.onb-it-title')).toEqual([
      'Microphone',
      'Accessibilité',
      "Enregistrement de l'audio",
    ]);
    expect(texts(fixture, '.onb-it-desc')).toEqual([
      'Capturer votre voix.',
      'Déclencher la dictée avec le raccourci et coller le texte.',
      'Capter le son de vos sessions.',
    ]);
  });

  it('shows three permissions — automation is not one of them', async () => {
    // ⚠️ Elle ne sert qu'au collage, dont la voie n'est pas tranchée. La demander ici
    // ferait accorder une permission dont on ne sait pas encore si elle servira.
    const fixture = await render();
    expect(rootOf(fixture).querySelectorAll('app-permission-row')).toHaveLength(3);
    expect(rootOf(fixture).textContent?.toLowerCase()).not.toContain('automatisation');
  });

  it('never writes « écran » about audio capture', async () => {
    // ⚠️ Catégorie TCC distincte de la capture d'écran. L'écrire enverrait
    // l'utilisateur dans le mauvais volet des Réglages Système — et Mirmalion ne demande
    // jamais l'accès à l'écran, ce qui est un argument produit, pas une contrainte subie.
    const fixture = await render(statusWith({ audioCapture: 'denied' }));
    expect(rootOf(fixture).textContent?.toLowerCase()).not.toContain('écran');
  });

  it('resolves the gesture from the permission AND its state, never the state alone', async () => {
    // ⚠️ Le cœur de l'étape, et le libellé commun ne doit pas le masquer : `denied` laisse un
    // bouton sur l'Accessibilité — qui se rétablit dans les Réglages — et n'en laisse aucun
    // sur le micro, que macOS refuse de redemander. Le même état, deux issues. C'est pour cela
    // qu'on s'est délibérément abstenu d'écrire une fonction de l'état seul.
    expect(await actionOf('microphone', 'notDetermined')).toBe('Autoriser');
    expect(await actionOf('accessibility', 'notDetermined')).toBe('Autoriser');

    expect(await actionOf('microphone', 'granted')).toBe('Autorisé');
    expect(await actionOf('accessibility', 'granted')).toBe('Autorisé');
    expect(await actionOf('audioCapture', 'granted')).toBe('Autorisé');

    // Refusé, macOS ignore toute nouvelle demande : plus rien à cliquer côté micro.
    expect(await actionOf('microphone', 'denied')).toBe('Refusé');
    expect(await actionOf('microphone', 'unknown')).toBe('Refusé');
    expect(await actionOf('audioCapture', 'denied')).toBe('Refusé');

    // L'Accessibilité renvoie aux Réglages **quel que soit** l'état non accordé : c'est le
    // seul geste qui existe pour elle.
    expect(await actionOf('accessibility', 'denied')).toBe('Autoriser');
    expect(await actionOf('accessibility', 'unknown')).toBe('Autoriser');

    // ⚠️ **`unknown` vaut « Autoriser » pour l'enregistrement audio, et pour lui seul.** Il n'y
    // signifie pas « on ne sait pas s'il y a un geste » mais « on ne saura qu'en le faisant » :
    // la création d'un tap déclenche le prompt. Partout ailleurs, `unknown` ne propose rien.
    expect(await actionOf('audioCapture', 'unknown')).toBe('Autoriser');
    expect(await actionOf('audioCapture', 'notDetermined')).toBe('Autoriser');
  });

  it('treats an unread state as « never asked », not as a verdict', async () => {
    // `status` vaut `null` avant le premier scan, et hors contexte Tauri. Le repli doit
    // proposer un geste utile plutôt qu'inventer un refus.
    const fixture = await render(null);
    expect(texts(fixture, 'button')).toEqual([
      'Autoriser',
      'Autoriser',
      'Autoriser',
      'Revérifier',
      'Continuer',
    ]);
  });

  it('says nothing at all until something is actually refused', async () => {
    // ⚠️ Un premier lancement est **entièrement** `notDetermined` : c'est l'état normal, et le
    // commenter alourdirait trois lignes qui doivent se lire d'un coup d'œil. Une version
    // antérieure prévenait ici que la signature de code peut invalider l'Accessibilité —
    // retiré sur décision du porteur : la phrase parlait d'un passé qui n'existe pas encore.
    for (const status of [null, statusWith({}), statusWith({ accessibility: 'granted' })]) {
      const fixture = await render(status);
      expect(rootOf(fixture).querySelectorAll('.onb-it-note')).toHaveLength(0);
    }
  });

  it('names the microphone pane, and never invents the audio one', async () => {
    // ⚠️ Le libellé du volet « Enregistrement audio » n'a jamais été constaté sur une machine
    // (*À MESURER*). L'inventer enverrait l'utilisateur au mauvais endroit.
    const microphone = await render(statusWith({ microphone: 'denied' }));
    expect(texts(microphone, '.onb-it-note')[0]).toContain(
      'Réglages Système ▸ Confidentialité et sécurité ▸ Microphone',
    );

    const audio = await render(statusWith({ audioCapture: 'denied' }));
    const note = texts(audio, '.onb-it-note').at(-1) ?? '';
    expect(note).toContain('Confidentialité et sécurité');
    expect(note).not.toContain('▸ Confidentialité et sécurité ▸');
  });

  it('marks only the pending row as busy', async () => {
    const fixture = await render(statusWith({}), 'microphone');
    const disabled = Array.from(rootOf(fixture).querySelectorAll('button')).filter(
      (button) => button.disabled,
    );

    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.textContent?.trim()).toBe('Autoriser');
  });

  it('forwards the key of the row that was pressed', async () => {
    const fixture = await render();
    const acted = vi.fn();
    fixture.componentInstance.act.subscribe(acted);

    rootOf(fixture).querySelectorAll('app-permission-row')[1]?.querySelector('button')?.click();
    expect(acted).toHaveBeenCalledWith('accessibility');
  });

  it('offers Revérifier and Continuer, in that order', async () => {
    const fixture = await render();
    const footer = texts(fixture, '.onb-footer button');
    expect(footer).toEqual(['Revérifier', 'Continuer']);
  });

  it('emits recheck and finish', async () => {
    const fixture = await render();
    const rechecked = vi.fn();
    const finished = vi.fn();
    fixture.componentInstance.recheck.subscribe(rechecked);
    fixture.componentInstance.finish.subscribe(finished);

    const footer = rootOf(fixture).querySelectorAll<HTMLButtonElement>('.onb-footer button');
    footer[0]?.click();
    footer[1]?.click();

    expect(rechecked).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
  });

  it('never disables Continuer, whatever is missing', async () => {
    // ⚠️ Règle « non bloquant » de l'onboarding. La tentation de le griser reviendra ; elle
    // est explicitement refusée. Ce sont les fonctions qui se désactivent, pas le parcours.
    for (const status of [
      null,
      statusWith({}),
      statusWith({ microphone: 'denied', accessibility: 'denied', audioCapture: 'denied' }),
    ]) {
      const fixture = await render(status);
      const footer = rootOf(fixture).querySelectorAll<HTMLButtonElement>('.onb-footer button');
      expect(footer[1]?.disabled).toBe(false);
    }
  });

  it('announces state changes to a screen reader', async () => {
    // L'Accessibilité et l'audio s'accordent hors de l'application : « Revérifier » est le
    // seul moment où l'écran l'apprend. Sans région live, rien ne serait annoncé.
    const fixture = await render();
    expect(rootOf(fixture).querySelector('.onb-list')?.getAttribute('aria-live')).toBe('polite');
  });

  it('has no accessibility violations', async () => {
    const fixture = await render(statusWith({ microphone: 'granted', accessibility: 'denied' }));
    await expectNoAxeViolations(rootOf(fixture));
  });
});
