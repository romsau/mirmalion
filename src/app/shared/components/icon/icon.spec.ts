import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Icon } from './icon';
import { ICONS, ICON_NAMES, type IconName } from './icons';
import { expectNoAxeViolations } from '../../../../testing/axe';

async function render(inputs: {
  name: IconName;
  label?: string;
  strokeWidth?: number;
  spin?: boolean;
}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Icon);
  fixture.componentRef.setInput('name', inputs.name);
  if (inputs.label !== undefined) {
    fixture.componentRef.setInput('label', inputs.label);
  }
  if (inputs.strokeWidth !== undefined) {
    fixture.componentRef.setInput('strokeWidth', inputs.strokeWidth);
  }
  if (inputs.spin !== undefined) {
    fixture.componentRef.setInput('spin', inputs.spin);
  }
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const svg = element.querySelector('svg');
  if (svg === null) {
    throw new Error('aucun <svg> rendu');
  }
  return { fixture, element, svg };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('Icon', () => {
  it('reproduces the maquette contract: 24×24, no fill, currentColor, round ends', async () => {
    const { svg } = await render({ name: 'trash' });

    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('draws every shape of the requested icon, and only those', async () => {
    const { svg } = await render({ name: 'refresh' });

    const drawn = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d'));
    expect(drawn).toEqual(ICONS['refresh'].shapes.map((shape) => shape.d));
  });

  it('carries the canonical stroke width of the icon, which is not the same for all', async () => {
    expect((await render({ name: 'chevron-left' })).svg.getAttribute('stroke-width')).toBe('2.2');
    expect((await render({ name: 'check' })).svg.getAttribute('stroke-width')).toBe('2.6');
    expect((await render({ name: 'cube' })).svg.getAttribute('stroke-width')).toBe('1.8');
  });

  it('lets a caller override the stroke width', async () => {
    const { svg } = await render({ name: 'chevron-left', strokeWidth: 3 });
    expect(svg.getAttribute('stroke-width')).toBe('3');
  });

  it('hides a decorative icon from assistive technology', async () => {
    const { svg } = await render({ name: 'trash' });

    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBeNull();
  });

  it('announces a meaningful icon, and stops hiding it', async () => {
    const { svg } = await render({ name: 'trash', label: 'Supprimer' });

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Supprimer');
    // Les deux s'excluent : annoncée ET masquée, l'icône ne serait jamais lue.
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });

  it('paints the filled shapes, and only them', async () => {
    const { svg } = await render({ name: 'status-success' });

    const [disc, glyph] = [...svg.querySelectorAll('path')];
    expect(disc?.getAttribute('fill')).toBe('var(--success)');
    expect(disc?.getAttribute('stroke')).toBe('none');
    // Le glyphe prend l'encre assortie à l'aplat, pas le blanc par défaut.
    expect(glyph?.getAttribute('stroke')).toBe('var(--success-on)');
    expect(glyph?.getAttribute('fill')).toBeNull();
  });

  it('has no accessibility violation, decorative or meaningful', async () => {
    await expectNoAxeViolations((await render({ name: 'copy' })).element);
    await expectNoAxeViolations((await render({ name: 'copy', label: 'Copier' })).element);
  });
});

describe('le registre', () => {
  it('renders every registered icon — none is malformed', async () => {
    expect(ICON_NAMES.length).toBeGreaterThan(0);

    for (const name of ICON_NAMES) {
      const { svg } = await render({ name });
      expect(svg.querySelectorAll('path')).toHaveLength(ICONS[name].shapes.length);
    }
  });

  it('holds no duplicate icon — that consolidation is the point of the registry', () => {
    // La signature inclut les couleurs : `status-warning` et `status-error` ont le même tracé
    // — un disque et un point d'exclamation — et ne se distinguent que par leur teinte. Ce
    // n'est pas un doublon, c'est justement là que la couleur porte le sens.
    const signature = (name: IconName) =>
      ICONS[name].shapes.map((shape) => [shape.d, shape.fill, shape.stroke].join('~')).join('|');
    const seen = new Map<string, IconName>();
    const duplicates: string[] = [];

    for (const name of ICON_NAMES) {
      const key = signature(name);
      const previous = seen.get(key);
      if (previous === undefined) {
        seen.set(key, name);
      } else {
        duplicates.push(`${previous} = ${name}`);
      }
    }

    expect(duplicates).toEqual([]);
  });

  it('holds only well-formed paths, each with a plausible stroke width', () => {
    // Un `d` qui ne commence pas par un déplacement est un chemin invalide : le navigateur
    // n'affiche rien, sans rien signaler. C'est le mode de panne d'une conversion ratée
    // (`<circle>` ou `<rect>` mal transcrit), et il est silencieux à l'écran comme au test.
    for (const name of ICON_NAMES) {
      const { shapes, strokeWidth } = ICONS[name];
      expect(shapes.length, `${name} : icône sans tracé`).toBeGreaterThan(0);
      for (const { d } of shapes) {
        expect(d[0], `${name} : chemin ne commençant pas par un déplacement`).toMatch(/[Mm]/);
      }
      expect(strokeWidth, `${name} : épaisseur invraisemblable`).toBeGreaterThanOrEqual(1);
      expect(strokeWidth, `${name} : épaisseur invraisemblable`).toBeLessThanOrEqual(4);
    }
  });

  it('spins from inside the SVG, never from the host', async () => {
    // ⚠️ **C'est le correctif d'un défaut visible.** Une rotation posée sur l'élément hôte
    // tourne une image déjà rastérisée : sur un écran en mise à l'échelle non entière, le
    // centre de rotation se déplace d'une image à l'autre et le glyphe monte et descend
    // (mesuré le 2026-07-30). Portée par le groupe SVG, elle s'applique en vectoriel.
    const { element } = await render({ name: 'spinner', spin: true });

    expect(element.querySelector('svg > g')?.classList.contains('spin')).toBe(true);
    expect(element.classList.contains('spin'), "l'hôte ne doit jamais tourner").toBe(false);
  });

  it('does not spin unless it is asked to', async () => {
    const { element } = await render({ name: 'spinner' });
    expect(element.querySelector('svg > g')?.classList.contains('spin')).toBe(false);
  });
});
