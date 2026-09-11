import { describe, expect, it } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FileDropZone } from './file-drop-zone';
import { expectNoAxeViolations } from '../../../../../../../testing/axe';

async function render(dragging = false): Promise<ComponentFixture<FileDropZone>> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(FileDropZone);
  fixture.componentRef.setInput('dragging', dragging);
  await fixture.whenStable();
  return fixture;
}

function rootOf(fixture: ComponentFixture<FileDropZone>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function titleOf(fixture: ComponentFixture<FileDropZone>): HTMLParagraphElement {
  const title = rootOf(fixture).querySelector<HTMLParagraphElement>('.dz-title');
  if (title === null) {
    throw new Error('La zone de dépôt doit toujours porter un titre.');
  }
  return title;
}

function browseButton(fixture: ComponentFixture<FileDropZone>): HTMLButtonElement | null {
  return rootOf(fixture).querySelector<HTMLButtonElement>('app-button button');
}

describe('FileDropZone', () => {
  it('invite à glisser un média, et propose une seconde voie', async () => {
    const fixture = await render();

    expect(titleOf(fixture).textContent?.trim()).toBe('Glissez un fichier audio ou vidéo');
    expect(browseButton(fixture)?.textContent?.trim()).toBe("Parcourir l'ordinateur");
  });

  it('bascule son titre et retire le bouton pendant un glisser', async () => {
    // ⚠️ C'est **tout** le retour visuel confié à ce composant : le fond teinté appartient à
    // l'écran. L'icône, elle, reste — la maquette ne la masque pas.
    const fixture = await render(true);

    expect(titleOf(fixture).textContent?.trim()).toBe('Déposez le fichier');
    expect(browseButton(fixture)).toBeNull();
    expect(rootOf(fixture).querySelector('app-icon')).not.toBeNull();
  });

  it('garde le même nœud de titre d’un état à l’autre', async () => {
    // Un texte qui change, et non un paragraphe qui disparaît pour laisser place à un autre :
    // c'est ce qu'entend un lecteur d'écran.
    const fixture = await render();
    const before = titleOf(fixture);

    fixture.componentRef.setInput('dragging', true);
    await fixture.whenStable();

    expect(titleOf(fixture)).toBe(before);
    expect(before.classList.contains('is-drop')).toBe(true);
  });

  it('demande le sélecteur une seule fois quand le bouton est activé', async () => {
    // ⚠️ Le clic du bouton **remonte** jusqu'à l'hôte, qui l'écoute pour toute la zone. Deux
    // écouteurs émettraient deux fois pour un seul geste.
    const fixture = await render();
    let asked = 0;
    fixture.componentInstance.browseRequested.subscribe(() => (asked += 1));

    browseButton(fixture)?.click();
    await fixture.whenStable();

    expect(asked).toBe(1);
  });

  it('demande le sélecteur quand on clique n’importe où dans la zone', async () => {
    // La maquette pose `cursor: pointer` sur toute la zone : elle doit tenir sa promesse.
    const fixture = await render();
    let asked = 0;
    fixture.componentInstance.browseRequested.subscribe(() => (asked += 1));

    rootOf(fixture).click();
    await fixture.whenStable();

    expect(asked).toBe(1);
  });

  it('n’a aucune violation d’accessibilité, dans les deux états', async () => {
    await expectNoAxeViolations((await render()).nativeElement);
    await expectNoAxeViolations((await render(true)).nativeElement);
  });
});
