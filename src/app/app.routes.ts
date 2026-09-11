/**
 * Les routes de l'application, et la route de départ de chaque fenêtre.
 *
 * Le segment d'URL est l'identifiant d'écran, aux mêmes valeurs que le type `ScreenId` : la
 * coquille lit l'URL plutôt qu'une table de correspondance, qui serait une deuxième vérité à
 * tenir. Tout arrive par `loadComponent`, coquille comprise — une fenêtre secondaire n'en a pas
 * besoin et ne doit pas la charger pour rien.
 *
 * @remarks
 * ⚠️ La coquille est un composant de route parente : une fenêtre sans header global se déclare
 * en route sœur de `''`, hors des `children`, et ne la traverse jamais. Aucune condition à
 * maintenir dans un gabarit, aucune liste à allonger.
 */

import { Routes } from '@angular/router';

/**
 * L'étiquette de la fenêtre principale, en miroir de `MAIN_WINDOW` dans
 * `src-tauri/src/lifecycle.rs`. C'est la seule qui n'ait pas de route à elle.
 */
const MAIN_WINDOW = 'main';

/**
 * Où la fenêtre principale range la route qu'elle veut retrouver après un changement de langue.
 *
 * @remarks
 * ⚠️ `sessionStorage`, et non `localStorage` : il est propre à une fenêtre et disparaît avec
 * elle. Une clé partagée ferait ouvrir la fenêtre principale sur la route d'une autre.
 */
const ROUTE_ACROSS_LOCALES = 'mirmalion.route';

/**
 * Retient la route courante le temps d'un changement de langue d'interface.
 * {@link applyWindowRoute} en est l'autre moitié : c'est lui qui la consomme.
 *
 * @param url - La route à retrouver après le rechargement.
 *
 * @remarks
 * ⚠️ Sans cela, changer de langue renvoie à l'écran d'accueil : un autre bundle est chargé,
 * donc une autre URL, et la route en cours n'y survit pas — on quitterait les Options à
 * l'instant où l'on vient d'y régler quelque chose.
 */
export function rememberRouteAcrossLocaleChange(url: string): void {
  sessionStorage.setItem(ROUTE_ACROSS_LOCALES, url);
}

/**
 * Le même chemin, mais sous le `<base href>` du bundle chargé. `document.baseURI` porte la
 * réponse quel que soit le schéma — `tauri://` en production, `http://` en développement.
 *
 * @remarks
 * ⚠️ Chaque langue vit dans son dossier et le routeur retire ce préfixe avant de comparer : le
 * bundle allemand est servi depuis `/de/`, où `/filedoc/3` ne désigne aucune route connue. Le
 * français étant à la racine, où les deux écritures coïncident, un chemin absolu écrit à la main
 * ne se voit pas tant qu'aucun autre bundle n'a été chargé.
 */
function underBaseHref(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).pathname;
}

/**
 * Pose l'URL de départ d'après la fenêtre dans laquelle on démarre : l'étiquette de la fenêtre
 * est la route. Sans contexte Tauri, il n'y a pas de fenêtre nommée et rien n'est touché.
 *
 * @remarks
 * ⚠️ À appeler avant le bootstrap d'Angular : Rust ouvre toutes les fenêtres sur le même
 * `index.html`, et naviguer ensuite laisserait le routeur résoudre `/` d'abord — la fenêtre
 * d'onboarding, large de 470 px, montrerait un éclair de l'écran Dictée prévu pour 900 px.
 */
export async function applyWindowRoute(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) {
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const label = getCurrentWindow().label;
  if (label === MAIN_WINDOW) {
    // ⚠️ Consommée dans tous les cas, même inutilisée : une route laissée en place
    // ressusciterait au prochain rechargement de la fenêtre, longtemps après le geste qui
    // l'avait posée — l'utilisateur retomberait sur les Options sans l'avoir demandé.
    const remembered = sessionStorage.getItem(ROUTE_ACROSS_LOCALES);
    sessionStorage.removeItem(ROUTE_ACROSS_LOCALES);
    if (remembered) {
      history.replaceState(null, '', underBaseHref(remembered));
    }
    return;
  }
  // ⚠️ Une fenêtre ouverte en plusieurs exemplaires porte son identifiant dans son étiquette —
  // `filedoc-0`, `filedoc-1`… On coupe au premier tiret pour rendre `/filedoc/0`, parce
  // qu'Angular n'apparie ses paramètres que sur un segment entier : `filedoc-:id` ne s'écrit pas.
  //
  // ⚠️ C'est aussi ce qui fait qu'une fenêtre secondaire n'a rien à retenir d'un changement de
  // langue : sa route se redéduit de son étiquette, à chaque démarrage.
  const separator = label.indexOf('-');
  const path =
    separator === -1 ? label : `${label.slice(0, separator)}/${label.slice(separator + 1)}`;
  history.replaceState(null, '', underBaseHref(path));
}

/** Les routes des trois écrans, sous la coquille, et celles des fenêtres qui vivent à part. */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./layout/window-shell/window-shell').then((m) => m.WindowShell),
    children: [
      {
        path: 'dictee',
        loadComponent: () => import('./features/dictee/dictee').then((m) => m.Dictee),
      },
      {
        path: 'direct',
        loadComponent: () => import('./features/direct/direct').then((m) => m.Direct),
      },
      {
        path: 'options',
        loadComponent: () => import('./features/options/options').then((m) => m.Options),
        children: [
          {
            path: 'general',
            loadComponent: () =>
              import('./features/options/categories/options-general/options-general').then(
                (m) => m.OptionsGeneral,
              ),
          },
          {
            path: 'direct',
            loadComponent: () =>
              import('./features/options/categories/options-direct/options-direct').then(
                (m) => m.OptionsDirect,
              ),
          },
          {
            path: 'fichiers',
            loadComponent: () =>
              import('./features/options/categories/options-fichiers/options-fichiers').then(
                (m) => m.OptionsFichiers,
              ),
          },
          {
            path: 'langues',
            loadComponent: () =>
              import('./features/options/categories/options-langues/options-langues').then(
                (m) => m.OptionsLangues,
              ),
          },
          // Le dictionnaire est une famille et non un sous-écran de Dictée : il est global — son
          // modèle n'a pas de champ de langue — et corrige la dictée comme les fichiers.
          {
            path: 'dictionnaire',
            loadComponent: () =>
              import('./features/options/categories/options-dictionnaire/options-dictionnaire').then(
                (m) => m.OptionsDictionnaire,
              ),
          },
          {
            path: 'moteurs',
            loadComponent: () =>
              import('./features/options/categories/options-moteurs/options-moteurs').then(
                (m) => m.OptionsMoteurs,
              ),
          },
          {
            path: 'historique',
            loadComponent: () =>
              import('./features/options/categories/options-historique/options-historique').then(
                (m) => m.OptionsHistorique,
              ),
          },
          // ⚠️ Les deux listes de langues sont des sous-écrans, déclarés sœurs des catégories et
          // non enfants de « langues » : le motif voulu est un push à la « Réglages Système », où
          // le sous-écran remplace la catégorie. En enfant, il aurait fallu un second
          // `<router-outlet>` et masquer le contenu de la catégorie. Le rail, lui, reste sur
          // « Langues » — il ne lit que le premier segment après `/options`.
          {
            path: 'langues/parlees',
            loadComponent: () =>
              import('./features/options/categories/options-langues-parlees/options-langues-parlees').then(
                (m) => m.OptionsLanguesParlees,
              ),
          },
          {
            path: 'langues/traduction',
            loadComponent: () =>
              import('./features/options/categories/options-langues-traduction/options-langues-traduction').then(
                (m) => m.OptionsLanguesTraduction,
              ),
          },
          { path: '', pathMatch: 'full', redirectTo: 'general' },
        ],
      },
      // ⚠️ La dictée est l'accueil, et `pathMatch: 'full'` est indispensable : sans lui, le
      // chemin vide correspondrait au préfixe de toutes les URL et la redirection tournerait en
      // boucle.
      { path: '', pathMatch: 'full', redirectTo: 'dictee' },
    ],
  },
  // ⚠️ Route sœur de `''`, et c'est ce qui la met hors de la coquille : l'onboarding est une
  // fenêtre à part — portrait, sans header, sans navigation. En enfant, il aurait hérité du
  // header et de la géométrie paysage, qu'il aurait fallu masquer par des conditions.
  {
    path: 'onboarding',
    loadComponent: () =>
      import('./features/onboarding/onboarding-shell/onboarding-shell').then(
        (m) => m.OnboardingShell,
      ),
  },
  // Les fenêtres-documents, session et fichier. Même motif que l'onboarding : sœurs de `''`,
  // donc hors de la coquille.
  //
  // ⚠️ Le paramètre est le numéro du document, pas son identifiant : l'étiquette de la fenêtre
  // vaut `filedoc-3`, et `applyWindowRoute` la coupe au premier tiret. Le composant recolle les
  // deux moitiés (`documentIdOf`), et c'est le seul endroit qui le fasse.
  {
    path: 'directdoc/:id',
    loadComponent: () => import('./features/directdoc/directdoc').then((m) => m.Directdoc),
  },
  {
    path: 'filedoc/:id',
    loadComponent: () => import('./features/filedoc/filedoc').then((m) => m.Filedoc),
  },
  // La pilule flottante : une fenêtre à part, qui ne prend jamais le focus et que les clics
  // traversent.
  {
    path: 'overlay',
    loadComponent: () =>
      import('./features/overlay/overlay-shell/overlay-shell').then((m) => m.OverlayShell),
  },
  // Une URL inconnue ramène à l'accueil plutôt que d'afficher une fenêtre vide. Il n'y a pas
  // d'écran « page introuvable » : dans une application de bureau, une URL hors liste est un
  // défaut de programmation, pas une situation que l'utilisateur puisse provoquer.
  { path: '**', redirectTo: '' },
];
