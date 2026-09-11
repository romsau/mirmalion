import { afterEach, describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DirectConfig } from './direct-config';
import type { Language } from '../../../../core/models/settings';
import type { AudioSource } from '../../../../core/services/bridge/live/live.bridge';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const SOURCES: readonly AudioSource[] = [
  { id: 'system', name: 'Tout le système', isSystem: true },
  { id: '4212', name: 'Microsoft Teams', isSystem: false },
];

const SPOKEN: readonly Language[] = ['fr', 'en', 'it'];

/** Les cibles activées. **Volontairement peu nombreuses** : la liste n'est pas celle des parlées. */
const TRANSLATION: readonly Language[] = ['en', 'it'];

async function render(
  overrides: {
    sources?: readonly AudioSource[];
    spokenLanguages?: readonly Language[];
    translationLanguages?: readonly Language[];
    translationTarget?: string;
    language?: Language;
    sourceId?: string | null;
    includeMicrophone?: boolean;
    canStart?: boolean;
    recording?: boolean;
    busy?: boolean;
    elapsedSeconds?: number;
  } = {},
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(DirectConfig);
  fixture.componentRef.setInput('sources', overrides.sources ?? SOURCES);
  fixture.componentRef.setInput('spokenLanguages', overrides.spokenLanguages ?? SPOKEN);
  fixture.componentRef.setInput(
    'translationLanguages',
    overrides.translationLanguages ?? TRANSLATION,
  );
  fixture.componentRef.setInput('translationTarget', overrides.translationTarget ?? 'none');
  fixture.componentRef.setInput('sourceId', overrides.sourceId ?? null);
  fixture.componentRef.setInput('includeMicrophone', overrides.includeMicrophone ?? true);
  fixture.componentRef.setInput('language', overrides.language ?? 'fr');
  fixture.componentRef.setInput('canStart', overrides.canStart ?? false);
  fixture.componentRef.setInput('recording', overrides.recording ?? false);
  fixture.componentRef.setInput('busy', overrides.busy ?? false);
  fixture.componentRef.setInput('elapsedSeconds', overrides.elapsedSeconds ?? 0);
  await fixture.whenStable();
  return fixture;
}

function rootOf(fixture: ComponentFixture<DirectConfig>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * Ouvre l'un des trois menus : 0 source, 1 langue parlée, 2 traduction.
 *
 * ⚠️ **Le micro n'en est plus un** *(porteur, 2026-08-06)* : l'appareil se règle dans
 * Options ▸ Général, et ce qui reste ici est un interrupteur — « ma voix est-elle
 * enregistrée ? ».
 *
 * ⚠️ **Le type de compte rendu non plus** *(même jour)* : il a quitté cet écran pour la
 * fenêtre-session et Options ▸ Direct.
 */
async function openMenu(fixture: ComponentFixture<DirectConfig>, index: number) {
  (rootOf(fixture).querySelectorAll('[role="combobox"]')[index] as HTMLElement).click();
  await fixture.whenStable();
  return [...document.querySelectorAll('[role="option"]')];
}

function labelsOf(options: readonly Element[]): (string | undefined)[] {
  return options.map((option) => option.querySelector('.lbl')?.textContent?.trim());
}

function startButton(fixture: ComponentFixture<DirectConfig>): HTMLButtonElement {
  return rootOf(fixture).querySelector('.rec-start') as HTMLButtonElement;
}

afterEach(() => {
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('DirectConfig', () => {
  /**
   * ⚠️⚠️ **« INCLURE MON MICRO » N'EST PAS UNE RUBRIQUE, C'EST LE LIBELLÉ D'UN INTERRUPTEUR**
   * *(porteur, 2026-08-06)*. Il appartient au groupe **« Source audio »** — on complète la
   * source captée par sa propre voix —, et il ne porte donc **pas** le style des intitulés de
   * section.
   *
   * ⚠️ **Deux assertions, et les deux comptent** : la première interdit qu'il reparaisse parmi
   * les `.label`, ce qui ferait croire à un champ de plus ; la seconde exige qu'il reste
   * **dans le premier groupe**. Sans elle, le sortir en bas de colonne passerait inaperçu.
   *
   * ⚠️ **« Traduction » est le troisième et dernier** *(P4-20)* : ce qu'on capte, dans quelle
   * langue on le dit, dans quelle langue on veut le suivre. Le type de compte rendu, lui, a
   * quitté cet écran — il ne se décide plus **avant** le direct.
   */
  it('lays the fields out in the order of the maquette', async () => {
    const root = rootOf(await render());
    const labels = [...root.querySelectorAll('.label')].map((label) => label.textContent?.trim());
    expect(labels).toEqual(['Source audio*', 'Langue parlée', 'Traduction']);

    const sourceGroup = root.querySelectorAll('.group')[0];
    expect(sourceGroup.querySelector('.switch-field .sf-label')?.textContent?.trim()).toBe(
      'Inclure mon micro',
    );
  });

  /**
   * ⚠️ **Un seul astérisque, et sur la source.** La convention le réserve aux champs sans valeur
   * par défaut ; les autres en ont un. Plusieurs astérisques feraient croire à autant de
   * décisions obligatoires quand il n'y en a qu'une.
   */
  it('marks only the audio source as requiring a choice', async () => {
    const root = rootOf(await render());
    const required = [...root.querySelectorAll('.req')];
    expect(required).toHaveLength(1);
    expect(required[0].closest('.label')?.textContent).toContain('Source audio');
    // Invisible pour les lecteurs d'écran : c'est le placeholder qui porte l'obligation.
    expect(required[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the placeholder while no source is chosen, and says it is mandatory', async () => {
    const trigger = rootOf(await render()).querySelector('[role="combobox"]') as HTMLElement;
    expect(trigger.textContent).toContain('Choisir une source (obligatoire)');
  });

  it('shows the chosen source once one is picked', async () => {
    const trigger = rootOf(await render({ sourceId: '4212' })).querySelector(
      '[role="combobox"]',
    ) as HTMLElement;
    expect(trigger.textContent).toContain('Microsoft Teams');
  });

  it('emits the source the user picks', async () => {
    const fixture = await render();
    const picked: (string | null)[] = [];
    fixture.componentInstance.sourceId.subscribe((value) => picked.push(value));

    ((await openMenu(fixture, 0))[1] as HTMLElement).click();
    await fixture.whenStable();

    expect(picked).toEqual(['4212']);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **CE QUI SE DÉCIDE ICI EST « EST-CE QUE JE PARLE », PAS « QUEL MICRO ».**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(porteur, 2026-08-06)*. L'appareil est un réglage — Options ▸ Général, partagé avec la
   * dictée. Ce qui change d'une session à l'autre est de savoir si l'on y intervient : une
   * conférence qu'on écoute, une réunion où l'on parle.
   *
   * ⚠️ **Et il reste à l'écran plutôt que dans les Options**, pour qu'on le voie au démarrage :
   * enfoui dans un réglage, on capterait son bureau pendant deux heures sans s'en apercevoir.
   */
  it('offers a switch for the voice, and reports what is toggled', async () => {
    const fixture = await render({ includeMicrophone: true });
    const toggled: boolean[] = [];
    fixture.componentInstance.includeMicrophone.subscribe((value) => toggled.push(value));

    const toggle = rootOf(fixture).querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    toggle?.click();
    await fixture.whenStable();
    expect(toggled).toEqual([false]);
  });

  it('shows the voice as left out when the setting says so', async () => {
    const fixture = await render({ includeMicrophone: false });
    const toggle = rootOf(fixture).querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('sorts the enabled languages by their translated name', async () => {
    // ⚠️ **La dernière ligne est la COMMANDE, pas une langue** — « Voir les options de
    // langues », détachée par un filet. Elle ne participe donc pas au tri.
    const rows = labelsOf(await openMenu(await render(), 1));
    expect(rows.at(-1)).toBe('Voir les options de langues');

    const languages = rows.slice(0, -1);
    expect(languages).toHaveLength(SPOKEN.length);
    // ⚠️ L'ordre suit la langue d'INTERFACE : on vérifie qu'il est trié, pas une liste figée.
    expect([...languages]).toEqual([...languages].sort((a, b) => (a ?? '').localeCompare(b ?? '')));
  });

  /**
   * ⚠️ **La langue parlée ici est celle de la session**, pas celle de la dictée : traduire vers
   * ce qu'on parle n'est pas une traduction, et le pont rendrait le texte inchangé.
   */
  it('never offers the language of the session as a translation target', async () => {
    const options = await openMenu(
      await render({ language: 'it', translationLanguages: ['en', 'it'] }),
      2,
    );

    expect(labelsOf(options)).toEqual([
      'Pas de traduction',
      'Anglais',
      'Voir les options de langues',
    ]);
  });

  it('leads to the language options without changing the field', async () => {
    const fixture = await render();
    let asked = 0;
    fixture.componentInstance.languageOptionsRequested.subscribe(() => (asked += 1));
    const changes: Language[] = [];
    fixture.componentInstance.language.subscribe((value) => changes.push(value));

    const options = await openMenu(fixture, 1);
    (options.at(-1) as HTMLElement).click();
    await fixture.whenStable();

    expect(asked).toBe(1);
    expect(changes).toEqual([]);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE TYPE DE COMPTE RENDU A QUITTÉ CET ÉCRAN, ET SA ZONE DE PROMPT AVEC LUI.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * *(porteur, 2026-08-06.)* Le compte rendu se fabrique **après** le direct : il n'y a aucune
   * raison de le décider avant. Le choix vit à deux endroits, et deux seulement — la
   * fenêtre-session, et Options ▸ Direct qui dit lequel est *proposé*. ⚠️ **Ne pas le remettre
   * ici** en voyant que la fenêtre en a un.
   */
  it('no longer asks for a report type, nor for its prompt', async () => {
    const root = rootOf(await render());

    expect(root.textContent).not.toContain('compte rendu');
    expect(root.querySelector('.prompt-input')).toBeNull();
  });

  /**
   * ⚠️ **Désactivé, pas masqué** : un bouton qui disparaît ne dit pas ce qui manque. Et l'état
   * passe par `disabled`, donc il est annoncé — le grisé seul ne l'est pas.
   */
  it('keeps the start button disabled until the form allows it', async () => {
    expect(startButton(await render({ canStart: false })).disabled).toBe(true);
    expect(startButton(await render({ canStart: true })).disabled).toBe(false);
  });

  it('emits the start request when it is allowed', async () => {
    const fixture = await render({ canStart: true });
    let started = 0;
    fixture.componentInstance.start.subscribe(() => (started += 1));
    startButton(fixture).click();
    expect(started).toBe(1);
  });

  it('renders an empty source list without breaking', async () => {
    const fixture = await render({ sources: [] });
    expect(labelsOf(await openMenu(fixture, 0))).toEqual([]);
    expect(startButton(fixture).disabled).toBe(true);
  });

  it('has no accessibility violations', async () => {
    await expectNoAxeViolations(rootOf(await render({ canStart: true })));
    await expectNoAxeViolations(rootOf(await render({ recording: true, elapsedSeconds: 724 })));
  });
});
