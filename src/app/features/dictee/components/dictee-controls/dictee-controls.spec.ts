import { afterEach, describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DicteeControls } from './dictee-controls';
import type { Language, RephrasingMode } from '../../../../core/models/settings';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const ALL: readonly Language[] = ['fr', 'en', 'es', 'de', 'it', 'pt'];

async function render(
  overrides: {
    spokenLanguages?: readonly Language[];
    translationLanguages?: readonly Language[];
    language?: Language;
    rephrasingMode?: RephrasingMode;
    translationTarget?: string;
    cleanupEnabled?: boolean;
    rephrasingEnabled?: boolean;
  } = {},
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(DicteeControls);
  fixture.componentRef.setInput('spokenLanguages', overrides.spokenLanguages ?? ALL);
  fixture.componentRef.setInput('translationLanguages', overrides.translationLanguages ?? ALL);
  fixture.componentRef.setInput('mode', 'hold');
  fixture.componentRef.setInput('language', overrides.language ?? 'fr');
  fixture.componentRef.setInput('translationTarget', overrides.translationTarget ?? 'none');
  fixture.componentRef.setInput('cleanupEnabled', overrides.cleanupEnabled ?? true);
  // ⚠️ Allumée par défaut DANS LE BANC, éteinte dans le produit : sans elle, la moitié des
  // épreuves ci-dessous n'aurait aucun champ de reformulation à interroger.
  fixture.componentRef.setInput('rephrasingEnabled', overrides.rephrasingEnabled ?? true);
  fixture.componentRef.setInput('rephrasingMode', overrides.rephrasingMode ?? 'standard');
  fixture.componentRef.setInput('customPrompt', '');
  await fixture.whenStable();
  return fixture;
}

function rootOf(fixture: ComponentFixture<DicteeControls>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** La phrase de l'indice du second raccourci, ou `null` quand il n'est pas affiché. */
function hintOf(fixture: ComponentFixture<DicteeControls>): string | null {
  return rootOf(fixture).querySelector('.is-secondary .hint-txt')?.textContent?.trim() ?? null;
}

/**
 * Ouvre l'un des menus stylés et rend ses lignes.
 *
 * `index` — 0 pour « Langue parlée », 1 pour « Traduction », 2 pour « Reformulation ».
 *
 * ⚠️ **Les trois sont des select custom, et plus aucun `<select>` natif ne subsiste ici.** Les
 * deux premiers le sont depuis le 2026-07-31, parce que le natif ne sait pas rendre la ligne
 * d'action et son filet. Le troisième l'est devenu le 2026-08-03, et pour une autre raison :
 * rien ne l'exigeait, c'est la **cohérence** qui l'exigeait — deux rendus de liste dans une même
 * colonne se voient au premier coup d'œil.
 */
async function openMenu(fixture: ComponentFixture<DicteeControls>, index = 0) {
  (rootOf(fixture).querySelectorAll('[role="combobox"]')[index] as HTMLElement).click();
  await fixture.whenStable();
  return [...document.querySelectorAll('[role="option"]')];
}

/** Les libellés d'un menu stylé ouvert. */
function labelsOf(options: readonly Element[]): (string | undefined)[] {
  return options.map((option) => option.querySelector('.lbl')?.textContent ?? undefined);
}

afterEach(() => {
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('DicteeControls', () => {
  it('lays the groups out in the order of the maquette', async () => {
    const labels = [...rootOf(await render()).querySelectorAll('.label')].map((label) =>
      label.textContent?.trim(),
    );
    // ⚠️ Plus de « Micro » : il est passé dans Options ▸ Dictée.
    expect(labels).toEqual(['Mode de dictée', 'Langue parlée', 'Traduction', 'Reformulation']);
  });

  it('sorts the languages alphabetically, by their translated name', async () => {
    // ⚠️ L'ordre suit la langue d'INTERFACE : aucune constante ne peut le figer.
    const names = labelsOf(await openMenu(await render()));

    expect(names).toEqual([
      'Allemand',
      'Anglais',
      'Espagnol',
      'Français',
      'Italien',
      'Portugais',
      // La ligne d'action ferme la liste, toujours en dernier.
      'Voir les options de langues',
    ]);
  });

  /**
   * ⚠️ **Le cœur du remaniement du 2026-07-30** : le menu ne montre plus QUE ce qui est
   * activé. Une langue désactivée n'est ni proposée, ni marquée, ni installable d'ici.
   */
  it('offers only the enabled languages, and nothing about what is installed', async () => {
    const options = await openMenu(await render({ spokenLanguages: ['fr', 'it'] }));

    expect(labelsOf(options)).toEqual(['Français', 'Italien', 'Voir les options de langues']);
    expect(options.some((option) => option.classList.contains('is-unavailable'))).toBe(false);
  });

  it('keeps « no translation » first, then only the enabled targets', async () => {
    const options = await openMenu(await render({ translationLanguages: ['en', 'de'] }), 1);

    expect(labelsOf(options)).toEqual([
      'Pas de traduction',
      'Allemand',
      'Anglais',
      'Voir les options de langues',
    ]);
  });

  /**
   * ⚠️ **Traduire vers ce qu'on parle n'est pas une traduction** : la cible suit la langue
   * parlée, elle n'est donc pas figée dans la liste des cibles activées.
   */
  it('never offers the spoken language as a translation target', async () => {
    const options = await openMenu(
      await render({ language: 'fr', translationLanguages: ['fr', 'en'] }),
      1,
    );

    expect(labelsOf(options)).toEqual([
      'Pas de traduction',
      'Anglais',
      'Voir les options de langues',
    ]);
  });

  /** La cible retirée revient dès qu'on parle une autre langue. */
  it('offers a target again once it is no longer the spoken language', async () => {
    const options = await openMenu(
      await render({ language: 'en', translationLanguages: ['fr', 'en'] }),
      1,
    );

    expect(labelsOf(options)).toEqual([
      'Pas de traduction',
      'Français',
      'Voir les options de langues',
    ]);
  });

  /** Aucune cible activée : « Pas de traduction » reste offert. */
  it('still offers « no translation » when no target is enabled', async () => {
    const options = await openMenu(await render({ translationLanguages: [] }), 1);
    expect(labelsOf(options)).toEqual(['Pas de traduction', 'Voir les options de langues']);
  });

  /**
   * L'indice du second raccourci — le seul endroit où ⌃⌥⌘ s'apprend.
   *
   * ⚠️ Il nomme la langue **réellement écrite**, et c'est tout son intérêt : figer « anglais »
   * mentirait dès qu'une autre cible est choisie.
   */
  it('names the language the second shortcut will actually write', async () => {
    const withoutTarget = await render({ language: 'fr' });
    expect(hintOf(withoutTarget)).toBe('Traduit en Anglais');

    const withTarget = await render({ language: 'fr', translationTarget: 'es' });
    expect(hintOf(withTarget)).toBe('Traduit en Espagnol');
  });

  /**
   * ⚠️ **Rien à traduire, rien à annoncer.** Un anglophone sans cible réglée : ⌃⌥⌘ ne ferait
   * rien de plus que ⌃⌥, et promettre une différence qui n'existe pas est pire que se taire.
   */
  it('says nothing when the second shortcut would change nothing', async () => {
    const fixture = await render({ language: 'en' });

    expect(rootOf(fixture).querySelector('.is-compact')).toBeNull();
  });

  /** Les trois touches sont là, et le symbole ne s'annonce pas — c'est le nom qui est lu. */
  it('shows the three keys as symbols, each still named to the ear', async () => {
    // ⚠️ Le symbole EST le texte de la touche ici, contrairement à l'indice du mode : à trois
    // touches épelées, la phrase n'avait plus de largeur. Le nom passe donc par `aria-label`,
    // et un lecteur d'écran entend toujours « control option command ».
    const keys = [...rootOf(await render()).querySelectorAll('.is-secondary .key')];

    expect(keys.map((key) => key.textContent?.trim())).toEqual(['⌃', '⌥', '⌘']);
    expect(keys.map((key) => key.getAttribute('aria-label'))).toEqual([
      'control',
      'option',
      'command',
    ]);
  });

  it('puts the second shortcut beside the first, never under the translation field', async () => {
    // ⚠️ Les deux indices se lisent ensemble : ils annoncent deux gestes, pas deux champs.
    const root = rootOf(await render({ translationTarget: 'es' }));
    const secondary = root.querySelector('.is-secondary');

    expect(secondary?.closest('app-mode-selector')).not.toBeNull();
    expect(secondary?.closest('.field-row')).toBeNull();
  });

  it('asks for the language options from either menu, and says which one', async () => {
    const fixture = await render();
    const requested: string[] = [];
    fixture.componentInstance.languageOptionsRequested.subscribe((list) => requested.push(list));
    const chosen: unknown[] = [];
    fixture.componentInstance.language.subscribe((value) => chosen.push(value));

    for (const menu of [0, 1]) {
      const options = await openMenu(fixture, menu);
      (options[options.length - 1] as HTMLElement).click();
      await fixture.whenStable();
    }

    // ⚠️ L'ordre suit celui des menus : parlée d'abord, traduction ensuite. Sans le
    // discriminant, les deux déposaient l'utilisateur sur la même page d'accueil.
    expect(requested).toEqual(['spoken', 'translation']);
    // ⚠️ La valeur du champ n'a pas bougé : c'est une commande, pas une valeur.
    expect(chosen).toEqual([]);
  });

  it('keeps the rephrasing list in the order that was settled, not alphabetical', async () => {
    // Trier alphabétiquement mettrait « Amical » en tête.
    // ⚠️ Aucune ligne « Pas de reformulation » : c'est l'interrupteur qui la porte, et deux
    // façons de dire non feraient douter de ce que fait chacune.
    expect(labelsOf(await openMenu(await render(), 2))).toEqual([
      'Standard',
      'Professionnel',
      'Concis',
      'Détaillé',
      'Amical',
      'Personnalisé…',
    ]);
  });

  it('lets the rephrasing switch command the existence of the style field', async () => {
    // ⚠️ Le champ n'est pas masqué, il n'existe pas : un champ caché reste tabulable dans
    // certains navigateurs, et il serait annoncé alors qu'il ne s'applique à rien.
    const off = rootOf(await render({ rephrasingEnabled: false }));
    expect([...off.querySelectorAll('.label')].map((label) => label.textContent?.trim())).toEqual([
      'Mode de dictée',
      'Langue parlée',
      'Traduction',
    ]);

    const on = rootOf(await render({ rephrasingEnabled: true }));
    expect([...on.querySelectorAll('.label')].map((label) => label.textContent?.trim())).toContain(
      'Reformulation',
    );
  });

  it('emits both switches without touching the rephrasing style', async () => {
    // ⚠️ Le style survit à l'extinction : éteindre puis rallumer doit retrouver le sien.
    const fixture = await render({ rephrasingMode: 'professional' });
    const cleanup: boolean[] = [];
    const rephrasing: boolean[] = [];
    const styles: RephrasingMode[] = [];
    fixture.componentInstance.cleanupEnabled.subscribe((on) => cleanup.push(on));
    fixture.componentInstance.rephrasingEnabled.subscribe((on) => rephrasing.push(on));
    fixture.componentInstance.rephrasingMode.subscribe((mode) => styles.push(mode));

    const switches = [...rootOf(fixture).querySelectorAll<HTMLElement>('.switch-field .switch')];
    switches[0].click();
    switches[1].click();
    await fixture.whenStable();

    expect(cleanup).toEqual([false]);
    expect(rephrasing).toEqual([false]);
    expect(styles).toEqual([]);
  });

  it('names each switch to a screen reader, which sees no visible label of its own', async () => {
    const switches = [...rootOf(await render()).querySelectorAll('.switch-field .switch')];
    expect(switches.map((control) => control.getAttribute('aria-label'))).toEqual([
      'Nettoyer le texte dicté',
      'Reformuler le texte dicté',
    ]);
  });

  it('reveals the free prompt only for « Personnalisé »', async () => {
    expect(rootOf(await render()).querySelector('.prompt-input')).toBeNull();
    expect(
      rootOf(await render({ rephrasingMode: 'custom' })).querySelector('.prompt-input'),
    ).not.toBeNull();
  });

  it('emits what the user types in the prompt', async () => {
    const fixture = await render({ rephrasingMode: 'custom' });
    const seen: string[] = [];
    fixture.componentInstance.customPrompt.subscribe((value) => seen.push(value));

    const input = rootOf(fixture).querySelector('.prompt-input input') as HTMLInputElement;
    input.value = 'Rends-le plus direct';
    input.dispatchEvent(new Event('input'));

    expect(seen).toEqual(['Rends-le plus direct']);
  });

  it('shows no recording visualisation at all', async () => {
    // Le retour visuel passe UNIQUEMENT par l'overlay. Une seconde forme d'onde dans
    // la fenêtre entrerait en concurrence avec elle.
    expect(rootOf(await render()).querySelector('canvas, .waveform, .level')).toBeNull();
  });

  it('has no AXE violation', async () => {
    await expectNoAxeViolations((await render({ rephrasingMode: 'custom' })).nativeElement);
  });
});
