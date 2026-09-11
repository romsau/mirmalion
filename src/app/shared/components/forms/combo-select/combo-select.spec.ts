import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ComboSelect } from './combo-select';
import type { FormOption } from '../form-option';
import type { LockedGroup } from './combo-select';
import { expectNoAxeViolations } from '../../../../../testing/axe';

const LANGUAGES: readonly FormOption[] = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'Anglais' },
  { value: 'it', label: 'Italien' },
];

function render(
  value = 'fr',
  options: readonly FormOption[] = LANGUAGES,
  lockedGroups: readonly LockedGroup[] = [],
) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(ComboSelect);
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('ariaLabel', 'Langue parlée');
  fixture.componentRef.setInput('lockedGroups', lockedGroups);
  fixture.detectChanges();
  // ⚠️ Le composant ne retient rien : ce qu'il « choisit » ne se lit que dans ce qu'il émet.
  const chosen: string[] = [];
  fixture.componentInstance.valueChange.subscribe((next) => chosen.push(next));
  const element = fixture.nativeElement as HTMLElement;
  const trigger = element.querySelector('[role="combobox"]');
  if (trigger === null) {
    throw new Error('aucun déclencheur');
  }
  const open = () => {
    (trigger as HTMLButtonElement).click();
    fixture.detectChanges();
  };
  const key = (name: string) => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    fixture.detectChanges();
  };
  return {
    fixture,
    element,
    trigger,
    open,
    key,
    chosen,
    options: () => [...document.querySelectorAll<HTMLElement>('[role="option"]')],
    listbox: () => document.querySelector('[role="listbox"]'),
    menu: () => document.querySelector('[role="menu"]'),
    branches: () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')],
    leaves: () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')],
    sub: () => document.querySelector('.cselect-sub'),
    activeId: () => trigger.getAttribute('aria-activedescendant'),
    // Les lignes de PREMIER NIVEAU, dans l'ordre : c'est là que se lit la place d'une rubrique.
    firstLevel: () =>
      [...document.querySelectorAll<HTMLElement>('#combo-listbox > div')].map((node) =>
        node.querySelector('.lbl')?.textContent?.trim(),
      ),
    labels: (nodes: readonly HTMLElement[]) =>
      nodes.map((node) => node.querySelector('.lbl')?.textContent?.trim()),
    // ⚠️ Le panneau est monté hors du composant : un clic dedans ne provoque aucun rendu tant
    // qu'on ne le demande pas. Sans ces deux aides, chaque test cascade répéterait la ligne.
    tap: (node: HTMLElement | null | undefined) => {
      node?.click();
      fixture.detectChanges();
    },
    hover: (node: HTMLElement | null | undefined) => {
      node?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      fixture.detectChanges();
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  document.querySelector('.cdk-overlay-container')?.remove();
});

describe('ComboSelect', () => {
  it('shows the selected label, and the placeholder when nothing matches', () => {
    expect(render('en').trigger.textContent?.trim()).toBe('Anglais');
    expect(render('zz').trigger.textContent?.trim()).toBe('—');
  });

  it('follows the ARIA combobox pattern', () => {
    const { trigger, open, listbox, options } = render();

    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-activedescendant')).toBeNull();

    open();
    expect(listbox()?.getAttribute('role')).toBe('listbox');
    expect(options()).toHaveLength(3);
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    // L'option active est désignée par identifiant, sans que le focus quitte le déclencheur.
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
  });

  it('opens on the arrows and on Enter, like a native select would', () => {
    for (const opener of ['ArrowDown', 'ArrowUp', 'Enter']) {
      const control = render();
      control.key(opener);
      expect(control.listbox(), `${opener} doit ouvrir`).not.toBeNull();
      document.querySelector('.cdk-overlay-container')?.remove();
    }
  });

  it('stays shut on a key that means nothing', () => {
    const { key, listbox } = render();

    key('a');

    expect(listbox()).toBeNull();
  });

  it('walks the list with the arrows, wrapping at both ends', () => {
    const { trigger, open, key, options } = render('fr');
    open();

    key('ArrowDown');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[1]?.id);

    key('ArrowUp');
    key('ArrowUp');
    expect(trigger.getAttribute('aria-activedescendant'), 'ça revient par la fin').toBe(
      options()[2]?.id,
    );
  });

  it('jumps to both ends with Home and End', () => {
    const { trigger, open, key, options } = render();
    open();

    key('End');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[2]?.id);

    key('Home');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
  });

  it('starts from the selected option, not from the top of the list', () => {
    const { trigger, open, options } = render('it');
    open();

    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[2]?.id);
  });

  it('picks with Enter, with Space, and with the mouse', () => {
    const withEnter = render('fr');
    withEnter.open();
    withEnter.key('ArrowDown');
    withEnter.key('Enter');
    expect(withEnter.chosen).toEqual(['en']);
    expect(withEnter.listbox(), 'choisir referme').toBeNull();

    const withSpace = render('fr');
    withSpace.open();
    withSpace.key('End');
    withSpace.key(' ');
    expect(withSpace.chosen).toEqual(['it']);

    const withMouse = render('fr');
    withMouse.open();
    withMouse.options()[1]?.click();
    withMouse.fixture.detectChanges();
    expect(withMouse.chosen).toEqual(['en']);
  });

  /**
   * ⚠️⚠️ **IL NE RETIENT RIEN, ET C'EST CE QUI REND LE REFUS POSSIBLE.** Un modèle interne
   * écrirait la valeur avant que l'hôte ait pu juger du choix ; y revenir ne changerait alors plus
   * l'expression liée, et le menu annoncerait pour le reste de la session un choix que personne
   * n'a accepté. Cas réel : une paire de traduction absente.
   */
  it('shows what the host gave it, never what was just picked', () => {
    const { trigger, open, options, fixture } = render('fr');
    open();
    options()[1]?.click();
    fixture.detectChanges();

    expect(trigger.textContent?.trim(), 'l’hôte n’a rien reposé').toBe('Français');
  });

  it('ignores keys that mean nothing here', () => {
    const { chosen, open, key } = render('fr');
    open();

    key('a');
    key('Tab');

    expect(chosen).toEqual([]);
  });

  it('does nothing at all when it has no options', () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(ComboSelect);
    fixture.componentRef.setInput('options', []);
    fixture.componentRef.setInput('value', 'fr');
    fixture.componentRef.setInput('ariaLabel', 'Vide');
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('[role="combobox"]') as HTMLElement;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  describe('availability mode', () => {
    const MIXED: readonly FormOption[] = [
      { value: 'fr', label: 'Français' },
      { value: 'en', label: 'Anglais' },
      { value: 'it', label: 'Italien', unavailable: true },
      { value: 'pt', label: 'Portugais', unavailable: true },
    ];

    function renderMixed(options: readonly FormOption[] = MIXED, hint = 'à télécharger') {
      const harness = render('fr', options);
      harness.fixture.componentRef.setInput('unavailableLabel', hint);
      harness.fixture.detectChanges();
      harness.open();
      return harness;
    }

    it('marks what is ready and what still has to be fetched', () => {
      const { options, listbox } = renderMixed();

      expect(listbox()?.classList.contains('shows-availability')).toBe(true);
      const icons = options().map((option) =>
        option.querySelector('.cselect-download') ? 'download' : 'check',
      );
      expect(icons).toEqual(['check', 'check', 'download', 'download']);
    });

    it('keeps the tick on every ready option, not only the selected one', () => {
      // ⚠️ Dans ce mode, la coche dit « prêt à l'emploi » et non « sélectionné » : sur les
      // quatre lignes, deux la portent, dont une qui n'est pas la valeur courante.
      const { options } = renderMixed();
      const ticked = options().filter((option) => option.querySelector('.cselect-check'));

      expect(ticked).toHaveLength(2);
      expect(ticked.map((option) => option.getAttribute('aria-selected'))).toEqual([
        'true',
        'false',
      ]);
    });

    it('says out loud what the icons only show', () => {
      // Une coche verte et une icône ne se lisent pas : sans ce libellé, les deux états sont
      // indiscernables pour qui n'a que la voix.
      const { options } = renderMixed();
      const hints = options().map((option) => option.querySelector('.hidden-hint')?.textContent);

      expect(hints).toEqual([undefined, undefined, 'à télécharger', 'à télécharger']);
    });

    it('stays silent when the caller gives no wording for it', () => {
      // Un composant générique n'invente pas le mot juste — il se tait plutôt que de mentir.
      const { options } = renderMixed(MIXED, '');
      expect(options().some((option) => option.querySelector('.hidden-hint'))).toBe(false);
    });

    it('leaves the tick its ordinary meaning when nothing is unavailable', () => {
      // Sans option indisponible, une coche sur chaque ligne serait incompréhensible.
      const { listbox, options } = renderMixed(LANGUAGES);

      expect(listbox()?.classList.contains('shows-availability')).toBe(false);
      expect(options().every((option) => option.querySelector('.cselect-check'))).toBe(true);
    });

    it('lets an unavailable option be chosen — that is what triggers the fetch', () => {
      // ⚠️ Ce n'est PAS `disabled` : la désactiver enfermerait l'utilisateur, qui verrait une
      // langue sans aucun moyen de l'obtenir.
      const { fixture, options, chosen } = renderMixed();
      options()[2].click();
      fixture.detectChanges();

      expect(chosen).toEqual(['it']);
    });

    it('has no accessibility violation in availability mode', async () => {
      const { listbox } = renderMixed();
      await expectNoAxeViolations(listbox() as Element);
    });
  });

  /**
   * La dernière ligne qui **agit au lieu de valoir**.
   *
   * ⚠️ Elle n'entre pas dans `options` : sa valeur n'existe pas dans le type du champ, et l'y
   * glisser obligerait chaque appelant à inventer une sentinelle puis à s'en garder partout.
   */
  describe('la ligne d’action', () => {
    function renderWithAction(value = 'fr') {
      const harness = render(value);
      harness.fixture.componentRef.setInput('actionLabel', 'Voir les options de langues');
      harness.fixture.detectChanges();
      const emitted: unknown[] = [];
      harness.fixture.componentInstance.action.subscribe(() => emitted.push(true));
      return { ...harness, emitted };
    }

    it('is absent as long as no wording is given', () => {
      const { open, options } = render();
      open();
      expect(options()).toHaveLength(3);
    });

    it('closes the list, after the values', () => {
      const { open, options } = renderWithAction();
      open();

      const rows = options();
      expect(rows).toHaveLength(4);
      expect(rows[3].textContent?.trim()).toBe('Voir les options de langues');
      expect(rows[3].classList.contains('cselect-action')).toBe(true);
    });

    /** ⚠️ C'est toute sa raison d'être : elle navigue, elle ne se choisit pas. */
    it('emits without touching the value', () => {
      const { fixture, open, options, emitted, chosen } = renderWithAction();
      open();
      options()[3].click();
      fixture.detectChanges();

      expect(emitted).toHaveLength(1);
      expect(chosen).toEqual([]);
    });

    it('never claims to be selected', () => {
      const { open, options } = renderWithAction();
      open();
      expect(options()[3].getAttribute('aria-selected')).toBe('false');
    });

    /**
     * ⚠️ **Le clavier doit l'atteindre** : une commande que seule la souris déclenche est une
     * commande absente pour qui n'a que le clavier.
     */
    it('is reachable with the arrows, and validated by Enter', () => {
      const { fixture, open, key, options, emitted, chosen } = renderWithAction();
      open();
      // Depuis « Français » (index 0), trois flèches mènent à la ligne d'action.
      key('ArrowDown');
      key('ArrowDown');
      key('ArrowDown');
      expect(options()[3].classList.contains('is-active')).toBe(true);

      key('Enter');
      fixture.detectChanges();
      expect(emitted).toHaveLength(1);
      expect(chosen).toEqual([]);
    });

    it('wraps back to the first value after it', () => {
      // La ligne d'action est la dernière : la flèche suivante repart en tête.
      const { open, key, options } = renderWithAction();
      open();
      for (let index = 0; index < 4; index += 1) {
        key('ArrowDown');
      }
      expect(options()[0].classList.contains('is-active')).toBe(true);
    });

    it('is where End lands', () => {
      const { open, key, options } = renderWithAction();
      open();
      key('End');
      expect(options()[3].classList.contains('is-active')).toBe(true);
    });

    it('has no accessibility violation', async () => {
      const { open, listbox } = renderWithAction();
      open();
      await expectNoAxeViolations(listbox() as Element);
    });
  });

  /**
   * Le libellé de **tête** — « Exporter », « Locuteurs : masqués ».
   *
   * ⚠️ À ne pas confondre avec le placeholder : celui-ci dit « rien à montrer » et s'estompe,
   * celui-là dit ce que le contrôle *est*, en encre pleine, et l'emporte sur tout.
   */
  describe('le libellé de tête', () => {
    function renderWithHead(value = '', label = 'Exporter') {
      const harness = render(value);
      harness.fixture.componentRef.setInput('headLabel', label);
      harness.fixture.detectChanges();
      return harness;
    }

    it('takes the trigger over, even when an option matches', () => {
      // ⚠️ C'est ce qui garde un menu de COMMANDE sur son libellé après chaque action — la
      // garantie est portée ici, et non laissée à la discipline de l'hôte.
      expect(renderWithHead('fr').trigger.textContent?.trim()).toBe('Exporter');
    });

    it('never enters the list', () => {
      const { open, options } = renderWithHead();
      open();
      expect(options()).toHaveLength(3);
      expect(options().map((option) => option.textContent?.trim())).not.toContain('Exporter');
    });

    it('keeps full ink, where the placeholder dims', () => {
      expect(renderWithHead().trigger.classList.contains('is-placeholder')).toBe(false);
      expect(render('zz').trigger.classList.contains('is-placeholder')).toBe(true);
    });

    it('has no accessibility violation', async () => {
      const { element, open, listbox } = renderWithHead();
      await expectNoAxeViolations(element);
      open();
      await expectNoAxeViolations(listbox() as Element);
    });
  });

  /**
   * Une option **détachée par un filet** — « Masquer les locuteurs » sous les modes d'analyse.
   *
   * ⚠️ Elle reste une valeur : elle se choisit, elle se coche. Le filet dit « ceci relève d'autre
   * chose », pas « ceci n'est pas une valeur » — c'est la ligne d'action qui dit cela.
   */
  describe('une option séparée', () => {
    const GROUPED: readonly FormOption[] = [
      { value: 'fr', label: 'Français' },
      { value: 'en', label: 'Anglais' },
      { value: 'it', label: 'Italien', separated: true },
    ];

    it('wears the rule, and stays a value like the others', () => {
      const { open, options, chosen, fixture } = render('fr', GROUPED);
      open();

      expect(options().map((option) => option.classList.contains('cselect-sep'))).toEqual([
        false,
        false,
        true,
      ]);

      options()[2].click();
      fixture.detectChanges();
      expect(chosen).toEqual(['it']);
    });

    it('has no accessibility violation', async () => {
      const { open, listbox } = render('fr', GROUPED);
      open();
      await expectNoAxeViolations(listbox() as Element);
    });
  });

  /**
   * ⚠️ **Rien à garder de notre côté** : c'est le `<button disabled>` qui rend le contrôle inerte,
   * clic comme clavier — il n'émet plus rien et n'est plus atteignable au focus. Une garde en
   * TypeScript ferait double emploi avec le navigateur, et prétendrait couvrir un chemin
   * qu'aucun geste réel n'emprunte.
   */
  it('opens nothing at all once disabled', () => {
    const { fixture, trigger, open, listbox } = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    open();

    expect(listbox()).toBeNull();
  });

  it('has no accessibility violation, closed or open', async () => {
    const closed = render();
    await expectNoAxeViolations(closed.element);

    closed.open();
    await expectNoAxeViolations(closed.listbox() as Element);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **LA CASCADE** *(décision 6 de la phase 4, P4-21)*.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le porteur a tranché la cascade contre un select à sections, **après avoir vu les deux** : les
 * sections allongent une liste déjà longue, la cascade la tient sur trois lignes.
 */
describe('ComboSelect, cascading', () => {
  const REPORTS: readonly FormOption[] = [
    { value: 'none', label: 'Pas de compte rendu' },
    { value: 'team', label: "Point d'équipe", group: 'Réunions' },
    { value: 'client', label: 'Point client', group: 'Réunions' },
    { value: 'summary', label: 'Résumé', group: 'Contenus' },
    { value: 'media', label: 'Vidéo ou podcast', group: 'Contenus' },
    { value: 'custom', label: 'Personnalisé…' },
  ];

  /**
   * ⚠️⚠️ **DEUX BRANCHES, ET DEUX LIGNES QUI RESTENT À PLAT.** « Pas de compte rendu » est le
   * défaut, qu'on doit atteindre sans ouvrir de branche, et « Personnalisé… » la sortie de
   * secours : les enfouir les rendrait plus difficiles à atteindre que ce qu'ils encadrent.
   *
   * ⚠️ **L'ordre vient des options, il n'est pas trié** : la première option d'un groupe fixe la
   * place de sa branche.
   */
  it('folds the grouped options behind branches, and leaves the rest flat', () => {
    const { open, branches, leaves, labels } = render('none', REPORTS);
    open();

    expect(labels(branches())).toEqual(['Réunions', 'Contenus']);
    expect(labels(leaves())).toEqual(['Pas de compte rendu', 'Personnalisé…']);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **LE RÔLE SUIT LA FORME RÉELLE DU MENU.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Le motif ARIA `listbox` **ne prévoit pas de sous-menus** : ses seuls enfants légaux sont
   * `option` et `group`, et un `group` ne s'ouvre pas. Annoncer une liste là où il y a une
   * cascade décrirait à un lecteur d'écran une structure qui n'existe pas.
   */
  it('becomes a menu, and stops pretending to be a listbox', () => {
    const { open, listbox, menu, trigger } = render('none', REPORTS);
    open();

    expect(menu()).not.toBeNull();
    expect(listbox()).toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  });

  /** ⚠️ **Une liste plate reste une liste** : le mode par défaut ne change pas d'un iota. */
  it('stays a listbox when nothing is grouped', () => {
    const { open, listbox, menu, trigger } = render();
    open();

    expect(listbox()).not.toBeNull();
    expect(menu()).toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
  });

  /**
   * ⚠️ **Une branche n'est pas une valeur** : elle ne se coche pas, ne devient jamais le libellé
   * du déclencheur, et l'ouvrir ne choisit rien. D'où `menuitem`, jamais `menuitemradio`.
   */
  it('opens a branch without choosing anything', () => {
    const { open, branches, sub, chosen, trigger, tap } = render('none', REPORTS);
    open();
    tap(branches()[0]);

    expect(sub()).not.toBeNull();
    expect(branches()[0].getAttribute('aria-expanded')).toBe('true');
    expect(chosen).toEqual([]);
    expect(trigger.textContent?.trim()).toBe('Pas de compte rendu');
  });

  it('shows only the options of the branch it opened', () => {
    const { open, branches, sub, tap } = render('none', REPORTS);
    open();
    tap(branches()[1]);

    const labels = [...(sub()?.querySelectorAll('.lbl') ?? [])].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toEqual(['Résumé', 'Vidéo ou podcast']);
  });

  it('chooses an option from inside a branch', () => {
    const { open, branches, sub, chosen, tap } = render('none', REPORTS);
    open();
    tap(branches()[0]);
    tap(sub()?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[1]);

    expect(chosen).toEqual(['client']);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **IL ÉMET SUR TOUTE SÉLECTION, PAS SUR UN CHANGEMENT DE VALEUR.**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * C'est ce qui permet de **relancer** sur le type déjà choisi en le rechoisissant, et donc de
   * se passer d'un bouton « Générer ». ⚠️ **Un `distinctUntilChanged` bien intentionné casserait
   * la relance sans casser aucun autre test** — le défaut ne se verrait qu'à l'usage.
   */
  it('emits again when the option already selected is chosen a second time', () => {
    const { open, branches, sub, chosen, tap } = render('team', REPORTS);
    open();
    tap(branches()[0]);
    tap(sub()?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[0]);

    expect(chosen).toEqual(['team']);
  });

  /**
   * ⚠️ **Le sous-menu est un FRÈRE du menu, jamais son enfant** : le menu a `overflow-y: auto` et
   * le découperait. C'est le piège que la maquette signale, et il ne se voit qu'à l'écran.
   */
  it('renders the sub-menu outside the scrolling menu', () => {
    const { open, branches, sub, menu, tap } = render('none', REPORTS);
    open();
    tap(branches()[0]);

    expect(menu()?.contains(sub())).toBe(false);
  });

  /**
   * ⚠️⚠️ **UNE BRANCHE OUVERTE CAPTE LES FLÈCHES.** Sans cela, descendre depuis un sous-menu
   * sauterait dans le menu derrière — ce qu'aucune cascade ne fait.
   */
  it('walks into a branch with the right arrow, and back out with the left', () => {
    const { open, key, sub, trigger, chosen } = render('none', REPORTS);
    open();
    key('ArrowDown'); // « Réunions »
    key('ArrowRight');

    expect(sub()).not.toBeNull();
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-sub-0');

    key('ArrowDown');
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-sub-1');
    key('ArrowUp');
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-sub-0');

    key('Enter');
    expect(chosen).toEqual(['team']);
  });

  it('leaves the branch on the left arrow, without choosing', () => {
    const { open, key, sub, chosen, trigger } = render('none', REPORTS);
    open();
    key('ArrowDown');
    key('ArrowRight');
    key('ArrowLeft');

    expect(sub()).toBeNull();
    expect(chosen).toEqual([]);
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-option-1');
  });

  /** Entrée sur une branche l'ouvre **et y entre** : ouvrir sans désigner coûterait un geste. */
  it('opens a branch with Enter and lands on its first option', () => {
    const { open, key, sub, trigger } = render('none', REPORTS);
    open();
    key('ArrowDown');
    key('Enter');

    expect(sub()).not.toBeNull();
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-sub-0');
  });

  /**
   * ⚠️ **Une touche que la cascade ne connaît pas retombe sur le menu.** Sans ce passage, Home et
   * Fin resteraient inertes dès qu'une branche est ouverte — deux sorties de secours perdues au
   * moment précis où l'on est le plus loin dans le menu.
   */
  it('lets an unknown key fall through to the menu while a branch is open', () => {
    const { open, key, sub, trigger } = render('none', REPORTS);
    open();
    key('ArrowDown');
    key('ArrowRight');

    key('End');

    expect(sub()).toBeNull();
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-option-3');
  });

  /** ⚠️ **Sur une ligne à plat, la flèche droite ne fait rien** : il n'y a rien à ouvrir. */
  it('does nothing on the right arrow when the row is not a branch', () => {
    const { open, key, sub, trigger } = render('none', REPORTS);
    open();
    key('ArrowRight');

    expect(sub()).toBeNull();
    expect(trigger.getAttribute('aria-activedescendant')).toBe('combo-option-0');
  });

  /** Quitter une branche par le haut, le bas, Home ou Fin la referme : elle n'est plus visée. */
  it('closes the open branch as soon as the menu regains the arrows', () => {
    for (const away of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const { open, key, sub } = render('none', REPORTS);
      open();
      key('ArrowDown');
      key('ArrowRight');
      key('ArrowLeft');
      key(away);
      expect(sub()).toBeNull();
    }
  });

  /** Rouvrir le menu ne rouvre pas la branche d'avant : on repart du choix courant. */
  it('forgets the open branch when the menu is reopened', () => {
    const { open, key, sub, fixture, trigger } = render('none', REPORTS);
    open();
    key('ArrowDown');
    key('ArrowRight');
    expect(sub()).not.toBeNull();

    (trigger as HTMLButtonElement).click();
    fixture.detectChanges();
    open();

    expect(sub()).toBeNull();
  });

  /** Survoler une ligne à plat referme la branche : deux panneaux ouverts se contrediraient. */
  it('closes the branch when the pointer returns to a flat row', () => {
    const { open, branches, leaves, sub, hover } = render('none', REPORTS);
    open();
    hover(branches()[0]);
    expect(sub()).not.toBeNull();

    hover(leaves()[0]);
    expect(sub()).toBeNull();
  });

  /** Survoler la branche déjà ouverte ne la rejoue pas — sinon le panneau clignoterait. */
  it('does not reopen the branch that is already open', () => {
    const { open, branches, sub, hover } = render('none', REPORTS);
    open();
    hover(branches()[0]);
    const first = sub();
    hover(branches()[0]);

    expect(sub()).toBe(first);
  });

  it('has no accessibility violations, menu open and branch open', async () => {
    const { open, branches, fixture, tap } = render('none', REPORTS);
    open();
    tap(branches()[0]);
    await expectNoAxeViolations(fixture.nativeElement);
    await expectNoAxeViolations(document.body.querySelector('.cdk-overlay-container') as Element);
  });
});

/**
 * ⚠️⚠️ **UNE BRANCHE VIDE RESTE VISIBLE, GRISÉE, ET NE BOUGE PAS.** La rubrique « Personnalisé » du
 * menu de compte rendu n'a rien à dérouler tant qu'aucun prompt n'est écrit ; la faire disparaître
 * n'apprendrait pas qu'elle existe, et la reléguer en fin de menu la ferait sauter de place le jour
 * où elle se remplit.
 */
describe('ComboSelect, une branche verrouillée', () => {
  const REPORTS: readonly FormOption[] = [
    { value: 'none', label: 'Pas de compte rendu' },
    { value: 'team', label: "Point d'équipe", group: 'Réunions' },
    { value: 'client', label: 'Point client', group: 'Réunions' },
    { value: 'summary', label: 'Résumé', group: 'Contenus' },
  ];

  /** Les mêmes options, la rubrique « Personnalisé » pleine — elle naît alors des options. */
  const REPORTS_PLEINE: readonly FormOption[] = [
    REPORTS[0] as FormOption,
    { value: '7', label: 'Bilan', group: 'Personnalisé' },
    ...REPORTS.slice(1),
  ];

  const VIDE: readonly LockedGroup[] = [{ group: 'Personnalisé', index: 1 }];

  it('montre une branche verrouillée, grisée et sans options', () => {
    const { open, branches, labels } = render('fr', LANGUAGES, VIDE);
    open();
    const branch = branches()[0];

    expect(labels(branches())).toEqual(['Personnalisé']);
    expect(branch?.getAttribute('aria-disabled')).toBe('true');
    // ⚠️ Pas d'`aria-expanded` : elle ne s'ouvre pas, et l'annoncer « repliée » promettrait le
    // contraire.
    expect(branch?.getAttribute('aria-expanded')).toBeNull();
  });

  /**
   * ⚠️⚠️ **LE TEST QUI COMPTE** : la rubrique occupe la MÊME place, vide ou pleine. Reléguée en
   * fin de menu tant qu'elle est vide, elle sauterait en deuxième position au premier prompt
   * écrit — le menu bougerait sous l'utilisateur sans qu'il l'ait demandé.
   */
  it('occupe la même place, vide ou pleine', () => {
    const vide = render('none', REPORTS, VIDE);
    vide.open();
    const rangs = vide.firstLevel();

    const pleine = render('none', REPORTS_PLEINE);
    pleine.open();

    expect(rangs).toEqual(['Pas de compte rendu', 'Personnalisé', 'Réunions', 'Contenus']);
    expect(rangs).toEqual(pleine.firstLevel());
    expect(rangs.indexOf('Personnalisé')).toBe(1);
  });

  /** Au-delà de la dernière ligne, le rang se replie sur la fin — jamais hors de la liste. */
  it('se pose en fin de menu quand son rang dépasse la liste', () => {
    const { open, firstLevel } = render('none', REPORTS, [{ group: 'Ailleurs', index: 99 }]);
    open();

    expect(firstLevel()).toEqual(['Pas de compte rendu', 'Réunions', 'Contenus', 'Ailleurs']);
  });

  it('ne l’ouvre ni au clic ni à la flèche droite', () => {
    const { open, branches, sub, tap, hover, key } = render('fr', LANGUAGES, VIDE);
    open();
    tap(branches()[0]);
    expect(sub()).toBeNull();

    hover(branches()[0]);
    key('ArrowRight');
    expect(sub()).toBeNull();
  });

  it('la saute au clavier, dans les deux sens', () => {
    const { open, key, activeId } = render('none', REPORTS, VIDE);
    open();

    // Les lignes : 0 « Pas de compte rendu », 1 verrouillée, 2 « Réunions », 3 « Contenus ».
    key('ArrowDown');
    expect(activeId()).toBe('combo-option-2');
    key('ArrowUp');
    expect(activeId()).toBe('combo-option-0');
  });

  /**
   * ⚠️ Les deux extrémités sont verrouillées, et c'est la seule façon de prouver que Home et Fin
   * les sautent : avec des extrémités libres, un `set(0)` / `set(total - 1)` en aveugle passerait.
   */
  it('sautent aussi les extrémités verrouillées, à Home comme à Fin', () => {
    const { open, key, activeId, firstLevel } = render('none', REPORTS, [
      { group: 'Avant', index: 0 },
      { group: 'Après', index: 99 },
    ]);
    open();

    expect(firstLevel()).toEqual(['Avant', 'Pas de compte rendu', 'Réunions', 'Contenus', 'Après']);
    key('Home');
    expect(activeId()).toBe('combo-option-1');
    key('End');
    expect(activeId()).toBe('combo-option-3');
  });

  /** ⚠️ À l'ouverture aussi : désigner d'emblée une ligne grisée l'annoncerait comme choisissable. */
  it('n’ouvre jamais le menu sur une ligne verrouillée', () => {
    const { open, activeId } = render('inconnue', REPORTS, [{ group: 'Avant', index: 0 }]);
    open();

    expect(activeId()).toBe('combo-option-1');
  });

  /**
   * ⚠️ Le sous-menu voisin ne reste pas ouvert sous une ligne grisée : il paraîtrait rattaché à
   * elle. Et la ligne grisée ne prend pas la désignation.
   */
  it('referme le sous-menu voisin sans se faire désigner', () => {
    const { open, branches, sub, hover, activeId } = render('none', REPORTS, VIDE);
    open();

    hover(branches()[1]);
    expect(sub()).not.toBeNull();

    hover(branches()[0]);
    expect(sub()).toBeNull();
    expect(activeId()).not.toBe('combo-option-1');
  });

  /** Deux verrous de même nom ne posent qu'une ligne : deux clés `track` égales feraient tomber. */
  it('ne pose qu’une ligne pour deux verrous de même nom', () => {
    const { open, firstLevel } = render('none', REPORTS, [
      { group: 'Personnalisé', index: 1 },
      { group: 'Personnalisé', index: 3 },
    ]);
    open();

    expect(firstLevel()).toEqual(['Pas de compte rendu', 'Personnalisé', 'Réunions', 'Contenus']);
  });

  /** Une rubrique déjà née des options n'est ni doublée ni fermée : elle range quelque chose. */
  it('ne verrouille pas une branche que les options ont déjà ouverte', () => {
    const { open, branches, labels, sub, tap } = render('none', REPORTS, [
      { group: 'Réunions', index: 1 },
    ]);
    open();

    expect(labels(branches())).toEqual(['Réunions', 'Contenus']);
    tap(branches()[0]);
    expect(sub()).not.toBeNull();
  });

  /** Rien à désigner : les flèches et Entrée ne font plus rien du tout. */
  it('ne bouge plus quand toutes les lignes sont verrouillées', () => {
    const { open, key, activeId, sub, chosen } = render(
      'fr',
      [],
      [{ group: 'Personnalisé', index: 0 }],
    );
    open();

    key('ArrowDown');
    expect(activeId()).toBe('combo-option-0');
    key('ArrowRight');
    key('Enter');
    expect(sub()).toBeNull();
    expect(chosen).toEqual([]);
  });

  it('has no accessibility violation', async () => {
    const { open, fixture } = render('none', REPORTS, VIDE);
    open();
    await expectNoAxeViolations(fixture.nativeElement);
    await expectNoAxeViolations(document.body.querySelector('.cdk-overlay-container') as Element);
  });
});
