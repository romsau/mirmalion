import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OptionsMoteurs } from './options-moteurs';
import { expectNoAxeViolations } from '../../../../../testing/axe';

/**
 * La catégorie est **vide** jusqu'à la phase 5. Ce spec garde sa présence et son
 * accessibilité, pour que le premier réglage ajouté trouve un harnais déjà en place.
 */
describe('OptionsMoteurs', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('se monte', async () => {
    const fixture = TestBed.createComponent(OptionsMoteurs);
    await fixture.whenStable();

    expect(fixture.componentInstance).toBeTruthy();
  });

  it('n’a aucune violation d’accessibilité', async () => {
    const fixture = TestBed.createComponent(OptionsMoteurs);
    await fixture.whenStable();

    await expectNoAxeViolations(fixture.nativeElement);
  });
});
