import { DestroyRef, Injector, Service, inject } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  SnackbarItem,
  type SnackbarTone,
} from '../../../shared/components/snackbar-item/snackbar-item';

/**
 * Affiche les notifications transitoires, erreurs comprises.
 *
 * Une seule à la fois — une nouvelle remplace la précédente — et toute navigation la retire :
 * une erreur est contextuelle à l'écran qui l'a produite.
 *
 * @remarks
 * ⚠️ Il n'y a ni page d'erreur ni message ad hoc dans cette application : toute erreur remonte
 * ici.
 */
@Service()
export class Snackbar {
  private readonly overlay = inject(Overlay);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);

  private dismiss: (() => void) | null = null;

  constructor() {
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.clear();
      }
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
    });
  }

  /** Une erreur. C'est l'usage principal, et le seul qui soit obligatoire. */
  error(message: string): void {
    this.show(message, 'error');
  }

  /** Une information neutre. */
  info(message: string): void {
    this.show(message, 'info');
  }

  /** La confirmation qu'un geste a abouti. */
  success(message: string): void {
    this.show(message, 'success');
  }

  /** Retire la notification affichée, s'il y en a une. */
  clear(): void {
    this.dismiss?.();
  }

  /** Monte la notification dans l'overlay, après avoir retiré celle qui s'y trouvait. */
  private show(message: string, tone: SnackbarTone): void {
    this.clear();

    const overlayRef = this.overlay.create({
      hasBackdrop: false,
      panelClass: 'snackbar-panel',
      positionStrategy: this.overlay.position().global().centerHorizontally().bottom('16px'),
    });

    const componentRef = overlayRef.attach(new ComponentPortal(SnackbarItem, null, this.injector));
    componentRef.setInput('message', message);
    componentRef.setInput('tone', tone);

    this.dismiss = () => {
      overlayRef.dispose();
      this.dismiss = null;
    };
    componentRef.instance.dismissed.subscribe(() => {
      this.dismiss?.();
    });
    componentRef.changeDetectorRef.detectChanges();
  }
}
