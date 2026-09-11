import { describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ComboSelect } from '../../../../shared/components/forms/combo-select/combo-select';
import { DirectDocument } from './direct-document';
import { expectNoAxeViolations } from '../../../../../testing/axe';
import {
  REPORT_PROMPT_GROUP_INDEX,
  reportPromptGroupLabel,
  reportTypeOptions,
} from '../../../../core/services/live/live';
import type {
  ReportPrompt,
  ReportSection,
} from '../../../../core/services/bridge/live/live.bridge';

const CLIENT: ReportPrompt = { id: 7, title: 'Client', prompt: 'Décisions, tâches, risques.' };

const LINES = [{ text: 'Bon, on commence par le point roadmap ?' }, { text: 'Oui, je partage.' }];

const REPORT: readonly ReportSection[] = [
  { heading: 'Résumé', lines: ['Point hebdomadaire produit.'], bullets: false },
  { heading: 'Décisions', lines: ['La démo est maintenue vendredi.'], bullets: true },
];

interface Overrides extends Record<string, unknown> {
  /** Les prompts nommés dont l'hôte compose le menu. */
  readonly prompts?: readonly ReportPrompt[];
}

async function render({ prompts = [], ...overrides }: Overrides = {}) {
  TestBed.resetTestingModule();
  const fixture: ComponentFixture<DirectDocument> = TestBed.createComponent(DirectDocument);
  fixture.componentRef.setInput('title', 'Session produit hebdo');
  fixture.componentRef.setInput('meta', '20 juil. 2026 · Microsoft Teams');
  fixture.componentRef.setInput('sections', []);
  fixture.componentRef.setInput('lines', LINES);
  fixture.componentRef.setInput('kind', 'team');
  fixture.componentRef.setInput('kinds', reportTypeOptions(prompts));
  fixture.componentRef.setInput('transcriptTarget', 'none');
  fixture.componentRef.setInput('reportTarget', 'none');
  for (const [name, value] of Object.entries(overrides)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

/** Le `ComboSelect` des types de compte rendu — celui qui porte la classe `cr-kind`. */
function kindMenu(fixture: ComponentFixture<DirectDocument>): ComboSelect<string> {
  return fixture.debugElement
    .queryAll(By.directive(ComboSelect))
    .find((found) => (found.nativeElement as HTMLElement).classList.contains('cr-kind'))!
    .componentInstance as ComboSelect<string>;
}

/** Le déclencheur du menu des types — c'est lui qui porte le titre du prompt choisi. */
function kindTrigger(fixture: ComponentFixture<DirectDocument>): HTMLElement {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    '.cr-kind .cselect-trigger',
  )!;
}

/** Le `ComboSelect` d'export — celui qui porte la classe `export`. */
function exportMenu(fixture: ComponentFixture<DirectDocument>): ComboSelect<string> {
  return fixture.debugElement
    .queryAll(By.directive(ComboSelect))
    .find((found) => (found.nativeElement as HTMLElement).classList.contains('export'))!
    .componentInstance as ComboSelect<string>;
}

/** Le `ComboSelect` de traduction — celui qui porte la classe `cr-translate`. */
function translateMenu(fixture: ComponentFixture<DirectDocument>): ComboSelect<string> {
  return fixture.debugElement
    .queryAll(By.directive(ComboSelect))
    .find((found) => (found.nativeElement as HTMLElement).classList.contains('cr-translate'))!
    .componentInstance as ComboSelect<string>;
}

function text(fixture: ComponentFixture<DirectDocument>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('DirectDocument', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA FENÊTRE S'OUVRE SUR LE TRANSCRIPT, PARCE QU'IL N'Y A RIEN D'AUTRE À MONTRER.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * L'arrêt d'une session ne génère rien *(décision 8)*. Ouvrir sur un panneau de compte rendu
   * vide laisserait croire que le modèle a échoué.
   */
  it('opens on the transcript when there is no report', async () => {
    const fixture = await render();
    expect(text(fixture)).toContain('point roadmap');
    expect((fixture.nativeElement as HTMLElement).querySelector('.tr-toggle')).toBeNull();
  });

  it('opens on the report when there is one', async () => {
    const fixture = await render({ sections: REPORT });
    expect(text(fixture)).toContain('Point hebdomadaire produit.');
    expect(text(fixture)).not.toContain('point roadmap');
  });

  /**
   * ⚠️⚠️ **ELLE BASCULE D'ELLE-MÊME QUAND LE COMPTE RENDU ARRIVE.** Celui qui vient de le
   * demander n'a pas à le réclamer une seconde fois — mais entre deux, il reste maître de ce
   * qu'il regarde, ce qu'un simple `computed` lui aurait retiré.
   */
  it('switches to the report the moment it exists, then leaves the choice alone', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('sections', REPORT);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Point hebdomadaire produit.');

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tr-toggle')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('point roadmap');

    // Et elle revient : la bascule va dans les deux sens, sinon on serait coincé sur le verbatim.
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tr-toggle')?.click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Point hebdomadaire produit.');
  });

  it('renders a bulleted section as a list and a plain one as paragraphs', async () => {
    const fixture = await render({ sections: REPORT });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.cr-list li')).toHaveLength(1);
    expect(root.querySelectorAll('.cr-p')).toHaveLength(1);
  });

  /**
   * ⚠️ **Une session sans un mot n'est pas une panne** : on peut lancer un enregistrement et
   * n'entendre que du silence. L'écran le dit plutôt que de laisser du blanc.
   */
  it('says a silent session produced nothing, rather than showing blank', async () => {
    const fixture = await render({ lines: [] });
    expect((fixture.nativeElement as HTMLElement).querySelector('.doc-empty')).not.toBeNull();
  });

  /**
   * ⚠️⚠️ **LA BARRE D'ACTIONS RESTE VISIBLE SUR LE TRANSCRIPT** *(décision 8)*. L'ancienne règle
   * « transcript = aucune action » valait quand le transcript n'était qu'une vue de vérification ;
   * depuis que la fenêtre s'ouvre **sur** lui, la même vue aurait porté ses contrôles ou non selon
   * d'où l'on venait — le même document, deux comportements.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **UN SEUL SÉLECTEUR « EXPORTER », ET IL PORTE SUR LA VUE OÙ L'ON EST** *(P4-12)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * La fiche demandait un choix de contenu — transcript, compte rendu, ou les deux en `.zip`. La
   * barre est **partagée** par les deux vues, et le porteur y a posé la règle « chaque contrôle
   * veut dire ce qu'il dit pour la vue où l'on est » : un troisième choix redemanderait ce que
   * l'écran affiche déjà.
   */
  it('exports the view it is showing, without ever asking which', async () => {
    const fixture = await render({ sections: REPORT });
    const exported = vi.fn();
    fixture.componentInstance.exported.subscribe(exported);

    exportMenu(fixture).valueChange.emit('markdown');
    expect(exported).toHaveBeenCalledExactlyOnceWith({ choice: 'markdown', content: 'report' });

    // La bascule vers le transcript change ce que le **même** menu exporte.
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tr-toggle')?.click();
    fixture.detectChanges();
    exportMenu(fixture).valueChange.emit('copy');

    expect(exported).toHaveBeenLastCalledWith({ choice: 'copy', content: 'transcript' });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LA TRADUCTION PORTE SUR LA VUE OÙ L'ON EST, EXACTEMENT COMME L'EXPORT** *(P4-24)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * C'est la règle que le porteur a posée sur cette barre le 2026-08-06 : *chaque contrôle veut
   * dire ce qu'il dit pour la vue où l'on est*.
   */
  it('translates the view it is showing, and says which one in its accessible name', async () => {
    const fixture = await render({ sections: REPORT });
    const translated = vi.fn();
    fixture.componentInstance.translate.subscribe(translated);

    expect(translateMenu(fixture).ariaLabel()).toBe('Traduire le compte rendu vers');
    translateMenu(fixture).valueChange.emit('en');
    expect(translated).toHaveBeenCalledExactlyOnceWith({ target: 'en', content: 'report' });

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tr-toggle')?.click();
    fixture.detectChanges();

    expect(translateMenu(fixture).ariaLabel()).toBe('Traduire le transcript vers');
    translateMenu(fixture).valueChange.emit('it');
    expect(translated).toHaveBeenLastCalledWith({ target: 'it', content: 'transcript' });
  });

  /**
   * ⚠️⚠️ **CHAQUE VUE GARDE SA LANGUE, ET BASCULER NE TRADUIT RIEN.** Une langue unique aurait
   * obligé à traduire l'autre vue en douce à chaque aller-retour — jusqu'à plusieurs minutes de
   * voile. Le menu se contente de dire la langue de ce qu'on lit.
   */
  it('shows the language of the view it is on, not a single one for the document', async () => {
    const fixture = await render({
      sections: REPORT,
      reportTarget: 'en',
      transcriptTarget: 'none',
    });
    expect(translateMenu(fixture).value()).toBe('en');

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tr-toggle')?.click();
    fixture.detectChanges();
    expect(translateMenu(fixture).value()).toBe('none');
  });

  /**
   * ⚠️⚠️ **RECHOISIR LA MÊME LANGUE NE RELANCE RIEN — L'INVERSE DU SÉLECTEUR DE TYPE.**
   * `ComboSelect` émet sur **toute sélection**, ce qui permet de régénérer un compte rendu sur le
   * type déjà choisi ; retraduire dans la langue déjà affichée ne changerait rien au texte, en
   * coûtant plusieurs minutes de voile.
   */
  it('does not relaunch a translation into the language already shown', async () => {
    const fixture = await render({ transcriptTarget: 'de' });
    const translated = vi.fn();
    fixture.componentInstance.translate.subscribe(translated);

    translateMenu(fixture).valueChange.emit('de');
    expect(translated).not.toHaveBeenCalled();

    translateMenu(fixture).valueChange.emit('none');
    expect(translated).toHaveBeenCalledExactlyOnceWith({ target: 'none', content: 'transcript' });
  });

  /**
   * ⚠️⚠️ **LES SOUS-TITRES DISPARAISSENT DEVANT UN COMPTE RENDU.** Il n'a aucun timing : un
   * `.srt` dont tous les repères vaudraient `00:00:00` serait un fichier que le lecteur accepte
   * et qui ne montre rien — pire qu'une absence, parce que l'utilisateur croit avoir exporté.
   */
  it('drops the two subtitle formats when a report is shown, and brings them back on the transcript', async () => {
    const fixture = await render({ sections: REPORT });
    const values = () =>
      exportMenu(fixture)
        .options()
        .map((option) => option.value);

    expect(values()).not.toContain('srt');
    expect(values()).not.toContain('vtt');
    expect(values()).toContain('markdown');

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.tr-toggle')?.click();
    fixture.detectChanges();

    expect(values()).toContain('srt');
    expect(values()).toContain('vtt');
  });

  /**
   * ⚠️ **La garde sur la valeur de repos tient la promesse du TYPE**, pas celle du composant : le
   * libellé de tête n'entre jamais dans la liste, donc aucun geste ne peut la produire. Elle
   * existe parce que `''` fait partie d'`ExportChoice`, et un `''` pris pour un format écrirait
   * un fichier sans extension.
   */
  it('ignores the resting value, which no gesture can produce', async () => {
    const fixture = await render();
    const exported = vi.fn();
    fixture.componentInstance.exported.subscribe(exported);

    exportMenu(fixture).valueChange.emit('');

    expect(exported).not.toHaveBeenCalled();
  });

  /** ⚠️ **Une commande, pas un champ** : le déclencheur retombe sur « Exporter » après coup. */
  it('keeps the export trigger on its own name', async () => {
    const fixture = await render();
    expect(exportMenu(fixture).value()).toBe('');
    expect(exportMenu(fixture).headLabel()).toBe('Exporter');
  });

  it('keeps its actions on the transcript view', async () => {
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.done-subbar')).not.toBeNull();
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **IL N'Y A PLUS DE BOUTON « GÉNÉRER » — CHOISIR *EST* LE GESTE** *(décision 8)*.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ **Retour en arrière assumé** : les prompts sont nommés et se gèrent dans les Options. Un
   * prompt retouché ici ne saurait pas s'il doit s'enregistrer.
   */
  it('offers neither a prompt field nor a custom generate button', async () => {
    const element = (await render({ kind: 'custom' })).nativeElement as HTMLElement;

    expect(element.querySelector('app-prompt-field')).toBeNull();
    expect(element.querySelector('.regen-action')).toBeNull();
  });

  /** ⚠️ Le déclencheur porte le TITRE du prompt : son identifiant n'apprendrait rien. */
  it('carries the title of the chosen prompt on the menu trigger', async () => {
    const fixture = await render({ kind: String(CLIENT.id), prompts: [CLIENT] });

    expect(kindTrigger(fixture).textContent?.trim()).toBe('Client');
  });

  /**
   * ⚠️⚠️ **LE PASSE-PLAT NE FILTRE RIEN, ET C'EST LE MAILLON QU'ON CASSERAIT SANS S'EN APERCEVOIR.**
   * Le menu émet sur toute sélection, la coquille relance sur toute émission — mais un filtre posé
   * ici, entre les deux, tuerait la relance en silence. Aucune égalité, donc, sur ce hop.
   */
  it('passes every selection up, the repeated one included', async () => {
    const fixture = await render({ prompts: [CLIENT] });
    const chosen = vi.fn();
    fixture.componentInstance.kindChange.subscribe(chosen);

    kindMenu(fixture).valueChange.emit(String(CLIENT.id));
    kindMenu(fixture).valueChange.emit(String(CLIENT.id));

    expect(chosen).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠️ **Le menu du type se désactive comme les deux autres** : la barre est un tout, et un seul
   * contrôle resté vivant sous le voile laisserait croire qu'il peut encore quelque chose.
   */
  it('locks the report menu while a job is in flight, like the other two', async () => {
    const fixture = await render({ busy: true });

    expect(kindMenu(fixture).disabled()).toBe(true);
    expect(translateMenu(fixture).disabled()).toBe(true);
    expect(exportMenu(fixture).disabled()).toBe(true);
  });

  /**
   * ⚠️ **Le menu vient de l'hôte, il ne se recompose pas ici** : lui seul connaît les prompts
   * nommés, et deux listes bâties de part et d'autre s'oublieraient l'une l'autre.
   */
  it('shows the menu its host composed, prompts included', async () => {
    const fixture = await render({ prompts: [CLIENT] });

    expect(kindMenu(fixture).options()).toEqual(reportTypeOptions([CLIENT]));
  });

  /**
   * ⚠️ **La rubrique se montre grisée à la place qu'elle gardera une fois pleine** : retirée
   * faute de prompt, elle n'apprendrait pas qu'elle existe ; posée en fin de liste, elle
   * bougerait sous l'utilisateur en se remplissant.
   */
  it('keeps the prompt group in the menu, at its place, even with no prompt', async () => {
    const fixture = await render();

    expect(kindMenu(fixture).lockedGroups()).toEqual([
      { group: reportPromptGroupLabel(), index: REPORT_PROMPT_GROUP_INDEX },
    ]);
  });

  it('draws its toggle with the application button', async () => {
    const fixture = await render({ sections: REPORT });

    expect((fixture.nativeElement as HTMLElement).querySelector('.tr-toggle')?.tagName).toBe(
      'APP-BUTTON',
    );
  });

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

  it('has no accessibility violations on the transcript', async () => {
    const fixture = await render();
    await expectNoAxeViolations(fixture.nativeElement);
  });

  it('has no accessibility violations on the report', async () => {
    const fixture = await render({ sections: REPORT, kind: String(CLIENT.id), prompts: [CLIENT] });
    await expectNoAxeViolations(fixture.nativeElement);
  });
});
