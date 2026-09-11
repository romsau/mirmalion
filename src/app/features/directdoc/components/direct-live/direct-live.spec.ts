import { describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DirectLive, meterLevel } from './direct-live';
import { expectNoAxeViolations } from '../../../../../testing/axe';

async function render(
  overrides: {
    elapsedSeconds?: number;
    level?: number;
    stopping?: boolean;
  } = {},
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(DirectLive);
  fixture.componentRef.setInput('elapsedSeconds', overrides.elapsedSeconds ?? 0);
  fixture.componentRef.setInput('level', overrides.level ?? 0);
  if (overrides.stopping !== undefined) {
    fixture.componentRef.setInput('stopping', overrides.stopping);
  }
  await fixture.whenStable();
  return fixture;
}

/** La hauteur que le style reçoit, telle qu'elle est écrite sur le conteneur du mètre. */
function meterOf(fixture: ComponentFixture<DirectLive>): number {
  const meter = (fixture.nativeElement as HTMLElement).querySelector('.meter') as HTMLElement;
  return Number(meter.style.getPropertyValue('--meter'));
}

function rootOf(fixture: ComponentFixture<DirectLive>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function timerOf(fixture: ComponentFixture<DirectLive>): string {
  return rootOf(fixture).querySelector('.rec-timer')?.textContent?.trim() ?? '';
}

describe('DirectLive', () => {
  /**
   * ⚠️ **`hh:mm:ss`, et non `m:ss` comme la pilule.** Une session dépasse l'heure ; un chrono
   * qui repartirait à zéro serait un mensonge. C'est la maquette (`00:12:04`).
   */
  it('counts in hours, minutes and seconds', async () => {
    expect(timerOf(await render({ elapsedSeconds: 0 }))).toBe('00:00:00');
    expect(timerOf(await render({ elapsedSeconds: 9 }))).toBe('00:00:09');
    expect(timerOf(await render({ elapsedSeconds: 724 }))).toBe('00:12:04');
  });

  /** ⚠️ Les heures ne sont pas plafonnées : une session de trois heures reste lisible. */
  it('never wraps the hours back to zero', async () => {
    expect(timerOf(await render({ elapsedSeconds: 3 * 3600 }))).toBe('03:00:00');
    expect(timerOf(await render({ elapsedSeconds: 10 * 3600 + 61 }))).toBe('10:01:01');
  });

  /** Un temps négatif n'existe pas : on ne rend pas `-1:-1:-1`, on rend zéro. */
  it('refuses to render a negative duration', async () => {
    expect(timerOf(await render({ elapsedSeconds: -5 }))).toBe('00:00:00');
  });

  /**
   * ⚠️⚠️ **LA SOURCE ET LE MICRO ONT QUITTÉ CE COMPOSANT** *(P4-18)*. Ils étaient dans la
   * pastille tant que ce bandeau vivait sur l'écran déclencheur, qui n'a pas d'en-tête. La
   * fenêtre-session porte une **méta sous son titre**, et la maquette l'y dessine ; les redire
   * ici en ferait deux vérités à tenir dans une même fenêtre.
   */
  it('names nothing it is capturing — the head does that now', async () => {
    const root = rootOf(await render());
    expect(root.querySelector('.rec-source')).toBeNull();
    expect(root.textContent).not.toContain('micro');
  });

  it('emits the stop request', async () => {
    const fixture = await render();
    let stopped = 0;
    fixture.componentInstance.stop.subscribe(() => (stopped += 1));
    (rootOf(fixture).querySelector('.rec-stop') as HTMLButtonElement).click();
    expect(stopped).toBe(1);
  });

  /**
   * ⚠️⚠️ **LE BOUTON N'A PLUS DE MOT, DONC SON NOM ACCESSIBLE EST TOUT CE QU'IL A** *(porteur,
   * 2026-08-12 : « l'icône est très reconnaissable »)*. Le carré d'arrêt suffit à l'œil ; à la
   * voix il ne dit rien. Sans ce test, retirer l'`aria-label` — ou le laisser tomber en
   * renommant l'unité de traduction — donnerait un bouton annoncé « bouton », et rien dans la
   * suite ne le signalerait : `expectNoAxeViolations` attrape bien l'absence de nom, mais un
   * `aria-label` VIDE ou mal traduit passerait.
   */
  it('says what it does, though it shows no word', async () => {
    const fixture = await render();
    const stop = rootOf(fixture).querySelector('.rec-stop');

    expect(stop?.textContent?.trim()).toBe('');
    expect(stop?.getAttribute('aria-label')).toBe('Arrêter');
  });

  /**
   * ⚠️ **Fermer les fichiers prend un instant** : sans cet état, un second clic partirait sur un
   * enregistrement déjà en train de se clore.
   */
  it('refuses a second click while it is closing', async () => {
    const fixture = await render({ stopping: true });
    expect((rootOf(fixture).querySelector('.rec-stop') as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * ⚠️ **Le chrono est masqué aux technologies d'assistance.** Sans cela un lecteur d'écran
   * annoncerait la seconde qui passe, indéfiniment — même piège que la pilule.
   */
  it('hides the ticking clock from screen readers', async () => {
    const root = rootOf(await render());
    expect(root.querySelector('.rec-timer')?.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * ⚠️ **Masqué bien qu'il mesure vraiment.** Un niveau qui change dix fois par seconde n'est
   * pas restituable à la voix ; ce qu'il faut annoncer l'est par la pastille de source.
   */
  it('keeps the meter out of the accessibility tree', async () => {
    const meter = rootOf(await render()).querySelector('.meter');
    expect(meter?.getAttribute('aria-hidden')).toBe('true');
    expect(meter?.querySelectorAll('i')).toHaveLength(5);
  });

  /**
   * ⚠️⚠️ **LA MESURE QUI DIT QUE LE MÈTRE N'EST PLUS UNE ANIMATION.** Avant P4-04, les barres
   * bougeaient à cadence fixe quoi qu'il arrive — un utilisateur l'a vu et l'a signalé. Ce test
   * est ce qui empêche d'y revenir : la hauteur ne dépend **que** de l'entrée.
   */
  it('drives the bars from the measured level, and from nothing else', async () => {
    const silence = meterOf(await render({ level: 0 }));
    const speech = meterOf(await render({ level: 0.05 }));
    const loud = meterOf(await render({ level: 0.5 }));

    expect(silence).toBeLessThan(speech);
    expect(speech).toBeLessThan(loud);
    expect(loud).toBeLessThanOrEqual(1);
  });

  /**
   * ⚠️ **Le silence couche les barres, il ne les efface pas.** Un mètre qui disparaît se lit
   * comme un mètre cassé.
   */
  it('keeps a visible sliver at silence', async () => {
    expect(meterOf(await render({ level: 0 }))).toBeGreaterThan(0);
  });

  it('has no accessibility violations', async () => {
    await expectNoAxeViolations(rootOf(await render()));
    await expectNoAxeViolations(rootOf(await render({ stopping: true, level: 0.3 })));
  });
});

/**
 * L'échelle du mètre, éprouvée seule.
 *
 * ⚠️ **Une échelle linéaire en amplitude aurait l'air en panne** : la parole ordinaire tient
 * entre 0,02 et 0,2 de RMS, soit un cinquième de la course. Ces bornes sont ce qui rend le
 * mètre lisible, et elles se vérifient sans monter de composant.
 */
describe('meterLevel', () => {
  it('spreads ordinary speech across the middle of the scale', () => {
    // RMS 0,02 → −34 dB ; RMS 0,2 → −14 dB. Sur une échelle linéaire, les deux seraient
    // écrasés en bas.
    expect(meterLevel(0.02)).toBeGreaterThan(0.3);
    expect(meterLevel(0.2)).toBeLessThan(0.85);
    expect(meterLevel(0.2)).toBeGreaterThan(meterLevel(0.02));
  });

  it('bottoms out at silence and tops out at full scale', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    // Le plancher est à −60 dB : plus bas, on reste à zéro plutôt que de passer sous l'échelle.
    expect(meterLevel(0.0001)).toBe(0);
  });

  /**
   * ⚠️ **`NaN` et les valeurs impossibles se couchent, elles ne se propagent pas.** Un `NaN`
   * arrivé jusqu'au `transform` ferait **disparaître** les barres — l'inverse de ce qu'un mètre
   * doit faire quand il ne sait pas.
   */
  it('refuses what cannot be a level', () => {
    expect(meterLevel(Number.NaN)).toBe(0);
    expect(meterLevel(-1)).toBe(0);
    expect(meterLevel(4)).toBe(1);
  });
});
