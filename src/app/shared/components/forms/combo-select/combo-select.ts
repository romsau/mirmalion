import {
  Component,
  type ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from '../../icon/icon';
import { Popover } from '../../../directives/popover/popover';
import type { FormOption } from '../form-option';

/**
 * L'écart entre le menu et son sous-menu, en pixels.
 *
 * @remarks
 * ⚠️ Il répète le `6px` de `.cselect-sub` : la mesure qui choisit le côté doit compter l'écart
 * que la feuille dessinera, sinon elle bascule trop tôt ou trop tard.
 */
const SUB_GAP = 6;

/**
 * Une ligne de premier niveau du menu : une option, ou une branche de la cascade.
 *
 * @remarks
 * ⚠️ Une branche n'est pas une valeur : elle ne se coche pas, ne devient jamais le libellé du
 * déclencheur, et refermer le menu dessus ne change rien au champ.
 */
export type ComboRow<Value extends string = string> =
  | { readonly kind: 'option'; readonly option: FormOption<Value> }
  | {
      readonly kind: 'branch';
      readonly group: string;
      readonly options: readonly FormOption<Value>[];
      /** Montrée, grisée, non déroulante, et sautée par les flèches. */
      readonly locked: boolean;
    };

/**
 * Une branche montrée mais fermée à clé, et **le rang qu'elle occupe**.
 *
 * @remarks
 * ⚠️ Le rang vient de l'appelant, et c'est tout l'intérêt : la rubrique vide doit se poser
 * exactement là où elle se posera une fois pleine. Sans lui, elle sauterait de place en se
 * remplissant — un menu qui bouge sous l'utilisateur sans qu'il l'ait demandé.
 */
export interface LockedGroup {
  /** Son nom, celui que la branche pleine portera. */
  readonly group: string;
  /** Son rang parmi les lignes de premier niveau. Au-delà de la dernière, elle se pose en fin. */
  readonly index: number;
}

/**
 * Le select à liste stylée, pour quand la liste déroulée native ne suffit plus.
 *
 * Sans {@link ComboSelect.headLabel}, le déclencheur porte l'option choisie ; avec, il porte ce
 * libellé et le menu devient une commande. Dès qu'une option porte un {@link FormOption.group},
 * le menu se range en cascade, et son rôle ARIA change avec sa forme.
 *
 * @remarks
 * ⚠️ `Select` reste le premier choix : celui-ci n'existe que parce que la liste native ne se
 * style pas, et tout le motif ARIA 1.2 du combobox a dû y être réécrit à la main —
 * `aria-activedescendant`, les flèches, Home et Fin. C'est là que se logent les violations.
 */
@Component({
  selector: 'app-combo-select',
  imports: [Icon, Popover],
  templateUrl: './combo-select.html',
  styleUrl: './combo-select.scss',
})
export class ComboSelect<Value extends string = string> {
  /** Les options proposées, dans l'ordre du menu. */
  readonly options = input.required<readonly FormOption<Value>[]>();

  /**
   * La valeur affichée.
   *
   * @remarks
   * ⚠️ Une entrée et non un modèle, même contrat que `Select` : c'est l'hôte qui repose la
   * valeur choisie, ou qui la refuse. Un modèle interne l'écrirait avant tout jugement, et y
   * revenir ne changerait plus l'expression liée — le menu garderait un choix non accepté.
   */
  readonly value = input.required<Value>();

  /** Le nom accessible du contrôle. */
  readonly ariaLabel = input.required<string>();

  /** Le contrôle ne répond plus. */
  readonly disabled = input(false);

  /**
   * De quel côté la liste s'ouvre — voir {@link Popover.placement}.
   *
   * @remarks
   * ⚠️ Un passe-plat, et rien de plus : savoir s'il reste de la place sous un champ demande de
   * connaître la fenêtre qui l'entoure, et ce n'est pas à un contrôle générique de le savoir.
   */
  readonly placement = input<'below' | 'above'>('below');

  /**
   * Le choix de l'utilisateur.
   *
   * @remarks
   * ⚠️ Nommé `valueChange` à dessein : c'est ce qui laisse `[(value)]` s'écrire chez l'appelant,
   * sans modèle interne ici.
   */
  readonly valueChange = output<Value>();

  /**
   * Ce que le déclencheur affiche, estompé, quand aucune option ne correspond à la valeur.
   *
   * @remarks
   * ⚠️ À ne pas confondre avec {@link ComboSelect.headLabel}, qui l'emporte sur lui : celui-ci
   * dit « rien à montrer », l'autre dit ce que le contrôle est, en encre pleine.
   */
  readonly placeholder = input('—');

  /**
   * Le libellé de tête : ce que le déclencheur affiche à la place de l'option choisie, en encre
   * pleine. Il fait du menu une commande — « Exporter » —, ou résume un état que les lignes ne
   * disent pas mot pour mot — « Locuteurs : masqués ».
   *
   * @remarks
   * ⚠️ Il n'entre jamais dans la liste et n'est donc pas choisissable : c'est ce qui garde un
   * menu de commande sur son libellé après chaque action, sans rien demander à l'hôte.
   */
  readonly headLabel = input('');

  /**
   * Ce qu'un lecteur d'écran annonce sur une option {@link FormOption.unavailable} — par
   * exemple « à télécharger ». Vide par défaut.
   *
   * @remarks
   * ⚠️ À la charge de l'appelant, parce que c'est du domaine : une coche verte et une icône ne
   * se lisent pas, et sans ce libellé les deux états sont indiscernables pour qui n'a que la
   * voix.
   */
  readonly unavailableLabel = input('');

  /**
   * Une dernière ligne qui agit au lieu de valoir — « Voir les options de langues ». Vide par
   * défaut.
   *
   * @remarks
   * - ⚠️ Elle n'entre pas dans `options` : sa valeur n'existe pas dans le type du champ, et l'y
   *   faire passer obligerait chaque appelant à inventer une sentinelle puis à s'en garder.
   * - ⚠️ La choisir n'écrit rien : le menu se ferme, {@link ComboSelect.action} part, et le
   *   champ garde la valeur qu'il affichait.
   */
  readonly actionLabel = input('');

  /** Émis quand la ligne d'action est choisie, au clavier comme à la souris. */
  readonly action = output<void>();

  /**
   * Des branches montrées mais fermées à clé : grisées, non déroulantes, sautées par les flèches.
   *
   * @remarks
   * - ⚠️ Montrées et non retirées : une rubrique vide qui disparaît n'apprend pas qu'elle existe.
   * - ⚠️ Chacune se pose à son {@link LockedGroup.index}, jamais en fin de liste : une rubrique
   *   qui change de place en se remplissant fait bouger le menu sous l'utilisateur.
   * - ⚠️ Un nom déjà porté par une branche née des options ne la verrouille pas — la rubrique
   *   qui range quelque chose s'ouvre.
   */
  readonly lockedGroups = input<readonly LockedGroup[]>([]);

  /**
   * Les lignes de premier niveau : des options à plat, et des branches.
   *
   * @remarks
   * ⚠️ L'ordre vient des options et n'est pas trié : la première option d'un groupe fixe la
   * place de sa branche, et c'est l'appelant qui décide de l'ordre de lecture.
   */
  protected readonly rows = computed<readonly ComboRow<Value>[]>(() => {
    const rows: ComboRow<Value>[] = [];
    const branches = new Map<string, FormOption<Value>[]>();
    for (const option of this.options()) {
      const group = option.group;
      if (group === undefined) {
        rows.push({ kind: 'option', option });
        continue;
      }
      let items = branches.get(group);
      if (items === undefined) {
        items = [];
        branches.set(group, items);
        rows.push({ kind: 'branch', group, options: items, locked: false });
      }
      items.push(option);
    }
    for (const { group, index } of this.lockedGroups()) {
      if (!branches.has(group)) {
        // ⚠️ Retenu tout de suite : deux verrous de même nom poseraient deux lignes de clé `track`
        // identique, et le rendu s'effondrerait sur un doublon.
        branches.set(group, []);
        const at = Math.max(0, Math.min(index, rows.length));
        rows.splice(at, 0, { kind: 'branch', group, options: [], locked: true });
      }
    }
    return rows;
  });

  /**
   * Le menu est-il une cascade ?
   *
   * @remarks
   * ⚠️ C'est ce qui décide du rôle ARIA du panneau : un `listbox` ne prévoit pas de sous-menus,
   * ses seuls enfants légaux étant `option` et `group`. Une cascade est un `menu` — prétendre le
   * contraire ferait annoncer une structure qui n'existe pas.
   */
  protected readonly cascading = computed(() => this.rows().some((row) => row.kind === 'branch'));

  /**
   * La branche ouverte, `null` quand aucune ne l'est.
   *
   * @remarks
   * ⚠️ Le sous-menu est un frère du menu dans le gabarit, jamais son enfant : le menu porte
   * `overflow-y: auto` et le découperait. Il s'aligne sur le haut du menu, pas sur sa branche.
   */
  protected readonly openGroup = signal<string | null>(null);

  /**
   * Le sous-menu s'ouvre-t-il à GAUCHE du menu ? Recalculé à chaque ouverture de branche.
   *
   * @remarks
   * ⚠️ La droite reste le défaut, et la gauche n'est qu'un repli : un menu qui changerait de
   * côté sans nécessité ferait chercher son sous-menu à chaque fois.
   */
  protected readonly subOnLeft = signal(false);

  /**
   * Le déclencheur, pour mesurer la place qu'il laisse à sa droite.
   *
   * @remarks
   * ⚠️ Lui et non le menu, qui vit dans l'overlay et n'est donc pas atteignable par une
   * requête de vue : `Popover` impose au panneau la largeur et le bord gauche du déclencheur,
   * si bien que les deux occupent exactement la même bande horizontale.
   */
  private readonly triggerRef = viewChild.required<ElementRef<HTMLElement>>('trigger');

  /**
   * La ligne active dans le sous-menu ouvert, ou `-1` quand c'est la branche elle-même.
   *
   * @remarks
   * ⚠️ Deux index et non un : les flèches ne parcourent pas les mêmes lignes selon qu'on est
   * dans le menu ou dans une branche ouverte, et un index unique ferait sortir du sous-menu en
   * descendant — ce qu'aucune cascade ne fait.
   */
  protected readonly subIndex = signal(-1);

  /** Les options de la branche ouverte. Vide quand aucune ne l'est. */
  protected readonly subOptions = computed<readonly FormOption<Value>[]>(() => {
    const group = this.openGroup();
    const row = this.rows().find((entry) => entry.kind === 'branch' && entry.group === group);
    return row?.kind === 'branch' ? row.options : [];
  });

  /**
   * Le menu bascule en mode « disponibilité » dès qu'une option se déclare indisponible.
   *
   * Déduit plutôt que déclaré : une entrée de plus se serait désynchronisée des options le jour
   * où l'appelant en change. Sans aucune option indisponible, la coche garde son sens ordinaire,
   * celui de la sélection.
   */
  protected readonly showsAvailability = computed(() =>
    this.options().some((option) => option.unavailable === true),
  );

  /** L'option désignée au clavier. Le focus, lui, ne quitte jamais le déclencheur. */
  protected readonly activeIndex = signal(0);

  /**
   * Y a-t-il une ligne d'action ? Son index est celui qui suit la dernière option.
   *
   * @remarks
   * ⚠️ Les flèches doivent l'atteindre : une commande que seule la souris peut déclencher est
   * une commande absente pour qui n'a que le clavier.
   */
  protected readonly hasAction = computed(() => this.actionLabel().length > 0);

  /** Le nombre de lignes parcourables, ligne d'action comprise. */
  private readonly rowCount = computed(() => this.rows().length + (this.hasAction() ? 1 : 0));

  /** L'option qui porte la valeur courante, `undefined` si aucune ne la porte. */
  protected readonly selected = computed(() =>
    this.options().find((option) => option.value === this.value()),
  );

  /** Ce que porte le déclencheur : le libellé de tête, l'option choisie, ou le placeholder. */
  protected readonly triggerLabel = computed(
    () => this.headLabel() || (this.selected()?.label ?? this.placeholder()),
  );

  /** Le placeholder — et lui seul — s'estompe. Voir {@link ComboSelect.headLabel}. */
  protected readonly showsPlaceholder = computed(
    () => this.headLabel() === '' && this.selected() === undefined,
  );

  /**
   * À l'ouverture, l'option active est celle qui est sélectionnée : les flèches partent de là,
   * et non du début de la liste.
   */
  protected onOpened(): void {
    this.closeSub();
    const chosen = this.rows().findIndex(
      (row) => row.kind === 'option' && row.option.value === this.value(),
    );
    // ⚠️ À défaut d'option choisie, la PREMIÈRE ligne atteignable, jamais la ligne 0 en aveugle :
    // ouvrir sur une ligne verrouillée la ferait annoncer comme désignée alors qu'elle ne répond
    // pas. Le repli sur 0 ne sert qu'au menu entièrement verrouillé, où il n'y a rien d'autre.
    this.activeIndex.set(chosen >= 0 ? chosen : Math.max(0, this.step(-1, 1)));
  }

  /** L'identifiant DOM d'une ligne du menu, celui que `aria-activedescendant` cite. */
  protected optionId(index: number): string {
    return `combo-option-${String(index)}`;
  }

  /** L'identifiant DOM d'une ligne du sous-menu. */
  protected subOptionId(index: number): string {
    return `combo-sub-${String(index)}`;
  }

  /** Ce que `aria-activedescendant` désigne : une ligne du sous-menu, ou une ligne du menu. */
  protected readonly activeId = computed(() =>
    this.subIndex() >= 0 ? this.subOptionId(this.subIndex()) : this.optionId(this.activeIndex()),
  );

  /**
   * Ouvre une branche.
   *
   * @remarks
   * ⚠️ Ouvrir n'est pas choisir : `subIndex` reste à `-1`, la branche est désignée et aucune de
   * ses options ne l'est encore.
   * ⚠️ Rend `false` sur une branche verrouillée — c'est ce qui rend le clic et le survol inertes
   * sans que le gabarit ait à s'en garder. Une branche qui range quelque chose s'ouvre, même si
   * son nom figure dans {@link ComboSelect.lockedGroups}.
   */
  protected openBranch(group: string): boolean {
    const row = this.rows().find((entry) => entry.kind === 'branch' && entry.group === group);
    if (row?.kind === 'branch' && row.locked) {
      return false;
    }
    if (this.openGroup() !== group) {
      this.subOnLeft.set(!this.fitsOnRight());
      this.openGroup.set(group);
      this.subIndex.set(-1);
    }
    return true;
  }

  /**
   * Le survol d'une branche : elle s'ouvre et devient la ligne désignée.
   *
   * @remarks
   * ⚠️ Verrouillée, elle referme le sous-menu voisin **sans** prendre la désignation : laisser le
   * sous-menu de la branche précédente ouvert sous une ligne grisée le montrerait rattaché à
   * elle, et `aria-activedescendant` annoncerait comme désignée une ligne `aria-disabled`.
   */
  protected hoverBranch(row: Extract<ComboRow<Value>, { kind: 'branch' }>, index: number): void {
    if (row.locked) {
      this.closeSub();
      return;
    }
    this.activeIndex.set(index);
    this.openBranch(row.group);
  }

  /**
   * Reste-t-il, à droite du déclencheur, de quoi poser le sous-menu en entier ?
   *
   * @remarks
   * ⚠️ Le sous-menu a la largeur du menu, donc celle du déclencheur : c'est ce qui permet de
   * répondre avant de l'avoir rendu, et donc de le poser du bon côté du premier coup plutôt que
   * de le voir sauter après coup.
   */
  private fitsOnRight(): boolean {
    const box = this.triggerRef().nativeElement.getBoundingClientRect();
    return box.right + SUB_GAP + box.width <= document.documentElement.clientWidth;
  }

  /** Referme le sous-menu ouvert, s'il y en a un. */
  protected closeSub(): void {
    this.openGroup.set(null);
    this.subIndex.set(-1);
  }

  /**
   * Retient une option : referme le menu, puis signale le choix.
   *
   * @remarks
   * ⚠️ La fermeture précède l'émission : l'hôte peut ouvrir une modale ou une snackbar en
   * réponse, et un panneau encore attaché lui passerait devant — son voile avalerait le premier
   * clic.
   */
  protected select(option: FormOption<Value>, popover: Popover): void {
    this.closeSub();
    popover.close();
    this.valueChange.emit(option.value);
  }

  /**
   * Déclenche la ligne d'action : referme, émet, et ne touche pas à la valeur.
   *
   * @remarks
   * ⚠️ Écrire la valeur ici laisserait « Voir les options de langues » dans le déclencheur à la
   * place d'une langue — un champ qui affiche le nom d'une commande.
   */
  protected runAction(popover: Popover): void {
    popover.close();
    this.action.emit();
  }

  /**
   * Ce que valide Entrée : une option, ou la ligne d'action si c'est elle qui est désignée.
   *
   * Le clavier et la souris passent par les mêmes deux gestes ; les séparer laisserait l'un des
   * deux chemins diverger sans que rien ne le signale.
   */
  private choose(index: number, popover: Popover): void {
    // Dans une branche ouverte, Entrée valide la ligne du sous-menu, pas celle du menu.
    const inSub = this.subOptions()[this.subIndex()] as FormOption<Value> | undefined;
    if (inSub !== undefined) {
      this.select(inSub, popover);
      return;
    }
    const row = this.rows()[index] as ComboRow<Value> | undefined;
    if (row === undefined) {
      this.runAction(popover);
      return;
    }
    if (row.kind === 'branch') {
      if (this.openBranch(row.group)) {
        this.subIndex.set(0);
      }
      return;
    }
    this.select(row.option, popover);
  }

  /**
   * La ligne suivante dans le sens `delta`, les branches verrouillées passées.
   *
   * @remarks
   * ⚠️ Le compteur de tours est ce qui évite la boucle infinie d'un menu entièrement verrouillé :
   * il n'y a alors rien à désigner, et l'index ne bouge plus.
   */
  private step(from: number, delta: number): number {
    const total = this.rowCount();
    let index = from;
    for (let turn = 0; turn < total; turn++) {
      index = (index + delta + total) % total;
      const row = this.rows()[index] as ComboRow<Value> | undefined;
      if (row?.kind !== 'branch' || !row.locked) {
        return index;
      }
    }
    return from;
  }

  /**
   * Le clavier du déclencheur : flèches, Home, Fin, Entrée et Espace.
   *
   * Les flèches ouvrent le panneau quand il est fermé, comme sur un `<select>` natif.
   */
  protected onKeydown(event: KeyboardEvent, popover: Popover): void {
    const total = this.rowCount();
    if (total === 0) {
      return;
    }

    if (!popover.isOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault();
        popover.open();
      }
      return;
    }

    // ⚠️ Une branche ouverte capte les flèches : haut et bas y parcourent ses options, gauche
    // en ressort. Sans cela, descendre depuis un sous-menu sauterait dans le menu derrière.
    const sub = this.subOptions().length;
    if (this.subIndex() >= 0 && sub > 0) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          this.subIndex.update((index) => (index + 1) % sub);
          return;
        case 'ArrowUp':
          event.preventDefault();
          this.subIndex.update((index) => (index - 1 + sub) % sub);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          this.closeSub();
          return;
        case 'Enter':
        case ' ':
          event.preventDefault();
          this.choose(this.activeIndex(), popover);
          return;
        default:
          break;
      }
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.closeSub();
        this.activeIndex.update((index) => this.step(index, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.closeSub();
        this.activeIndex.update((index) => this.step(index, -1));
        break;
      case 'ArrowRight': {
        // ⚠️ Ouvrir une branche au clavier, et entrer dedans : ouvrir sans désigner de ligne
        // obligerait à une flèche de plus pour un geste qui n'en demande qu'une.
        const row = this.rows()[this.activeIndex()] as ComboRow<Value> | undefined;
        if (row?.kind === 'branch') {
          event.preventDefault();
          if (this.openBranch(row.group)) {
            this.subIndex.set(0);
          }
        }
        break;
      }
      case 'Home':
        event.preventDefault();
        this.closeSub();
        this.activeIndex.set(this.step(-1, 1));
        break;
      case 'End':
        event.preventDefault();
        this.closeSub();
        this.activeIndex.set(this.step(0, -1));
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        // L'index actif est toujours dans les bornes : la liste vide est écartée plus haut, et
        // les flèches le ramènent modulo le nombre de lignes. Au-delà de la dernière option,
        // c'est la ligne d'action — `choose` s'en charge.
        this.choose(this.activeIndex(), popover);
        break;
      }
      default:
        break;
    }
  }
}
