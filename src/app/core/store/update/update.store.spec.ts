import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UpdateStore } from './update.store';
import { Update, type AvailableUpdate } from '../../services/update/update';

/** Une mise à jour trouvée, dont on observe les trois gestes. */
function available(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    version: '0.9.1',
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function store(service: Partial<Update>): InstanceType<typeof UpdateStore> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: Update,
        useValue: { check: vi.fn().mockResolvedValue(null), relaunch: vi.fn(), ...service },
      },
    ],
  });
  return TestBed.inject(UpdateStore);
}

/** Un magasin déjà porteur d'une proposition — le point de départ de la plupart des cas. */
async function offered(
  update: AvailableUpdate,
  service: Partial<Update> = {},
): Promise<InstanceType<typeof UpdateStore>> {
  const created = store({ check: vi.fn().mockResolvedValue(update), ...service });
  await created.check();
  return created;
}

describe('UpdateStore', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ⚠️ Le temps est simulé pour TOUTES ces épreuves : elles décrivent des heures, et les attendre
  // vraiment rendrait la suite inutilisable. `setSystemTime` suffit — le magasin lit l'horloge,
  // il ne pose aucun minuteur : c'est la coquille qui bat la mesure.
  describe('le rythme des contrôles', () => {
    it('ne redemande rien avant six heures', async () => {
      vi.useFakeTimers();
      const check = vi.fn().mockResolvedValue(null);
      const created = store({ check });

      await created.check();
      vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
      await created.check();

      expect(check).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('redemande une fois les six heures passées', async () => {
      vi.useFakeTimers();
      const check = vi.fn().mockResolvedValue(null);
      const created = store({ check });

      await created.check();
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1);
      await created.check();

      expect(check).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe('une version repoussée', () => {
    /** Repousse `0.9.1`, puis rend la main au temps qu'on veut. */
    async function postponed(next: AvailableUpdate) {
      vi.useFakeTimers();
      const first = available();
      const check = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next);
      const created = store({ check });

      await created.check();
      await created.dismiss();
      return created;
    }

    // ⚠️ La ressource du backend est rendue même quand on se tait : la garder ouverte à chaque
    // contrôle silencieux la ferait fuir toutes les six heures.
    it('reste muette pendant vingt-quatre heures, en rendant la ressource', async () => {
      const same = available();
      const created = await postponed(same);

      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await created.check();

      expect(created.phase()).toBe('idle');
      expect(same.dispose).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('se repropose une fois les vingt-quatre heures écoulées', async () => {
      const same = available();
      const created = await postponed(same);

      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      await created.check();

      expect(created.phase()).toBe('available');
      vi.useRealTimers();
    });

    // ⚠️ Une ressource qui refuse de se fermer ne doit pas faire échouer le contrôle : personne
    // n'a rien demandé, rien ne s'affiche, et l'échec n'a rien à réparer côté utilisateur.
    it('se tait quand même si la ressource refuse de se fermer', async () => {
      const same = available({ dispose: vi.fn().mockRejectedValue(new Error('non')) });
      const created = await postponed(same);

      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await created.check();

      expect(created.phase()).toBe('idle');
      vi.useRealTimers();
    });

    // ⚠️ C'est le refus D'UNE version, pas des mises à jour : une version plus récente n'a jamais
    // été refusée, et la taire ferait manquer le correctif qui suit celui qu'on a repoussé.
    it('ne tait pas une version plus récente', async () => {
      const newer = available({ version: '0.9.2' });
      const created = await postponed(newer);

      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await created.check();

      expect(created.phase()).toBe('available');
      expect(created.version()).toBe('0.9.2');
      vi.useRealTimers();
    });
  });

  describe('check', () => {
    it('shows nothing when the application is up to date', async () => {
      const created = store({});
      await created.check();

      expect(created.phase()).toBe('idle');
      expect(created.banner()).toBeNull();
    });

    it('offers the version it was given', async () => {
      const created = await offered(available());

      expect(created.phase()).toBe('available');
      expect(created.version()).toBe('0.9.1');
      expect(created.banner()).toBe('available');
    });

    it('says nothing at all when the check itself fails', async () => {
      // ⚠️⚠️ **RÈGLE DE PRODUIT, PAS PARESSE.** Sur une application dont l'argument est de
      // marcher sans réseau, annoncer « impossible de vérifier les mises à jour » à chaque
      // lancement hors ligne reprocherait à l'utilisateur ce que le produit lui promet.
      const created = store({ check: vi.fn().mockRejectedValue(new Error('hors ligne')) });
      await created.check();

      expect(created.phase()).toBe('idle');
      expect(created.error()).toBeNull();
    });

    it('does not check twice while a proposal is on screen', async () => {
      const check = vi.fn().mockResolvedValue(available());
      const created = store({ check });
      await created.check();
      await created.check();

      expect(check).toHaveBeenCalledOnce();
    });
  });

  describe('install', () => {
    it('does nothing when there is nothing to install', async () => {
      const created = store({});
      await created.install();

      expect(created.phase()).toBe('idle');
    });

    it('downloads without installing, and stops at « ready »', async () => {
      // C'est tout l'intérêt des deux gestes séparés : l'application n'est PAS encore remplacée.
      const update = available({
        download: vi.fn(async (onProgress: (ratio: number) => void) => {
          onProgress(0.5);
        }),
      });
      const created = await offered(update);
      await created.install();

      expect(created.phase()).toBe('ready');
      expect(created.percent()).toBe(0.5);
      expect(update.install).not.toHaveBeenCalled();
    });

    it('refuses to restart a download already under way', async () => {
      const update = available();
      const created = await offered(update);
      await created.install();
      await created.install();

      expect(update.download).toHaveBeenCalledOnce();
    });

    it('reports a failed download, and forgets the update', async () => {
      const update = available({ download: vi.fn().mockRejectedValue(new Error('coupure')) });
      const created = await offered(update);
      await created.install();

      expect(created.error()).toBe('coupure');
      expect(created.phase()).toBe('idle');
      expect(update.dispose).toHaveBeenCalledOnce();
    });
  });

  describe('cancelling mid-download', () => {
    it('never reaches « ready », and stops moving the bar', async () => {
      // ⚠️ Les octets, eux, continuent d'arriver : le plugin n'offre aucune interruption. Ce qui
      // est garanti, et qui est le sens du bouton, c'est que RIEN NE S'INSTALLE.
      const pending: { finish?: () => void } = {};
      const seen: number[] = [];
      const update = available({
        download: vi.fn(
          (onProgress: (ratio: number) => void) =>
            new Promise<void>((resolve) => {
              onProgress(0.2);
              pending.finish = () => {
                onProgress(1);
                resolve();
              };
            }),
        ),
      });
      const created = await offered(update);

      const running = created.install();
      expect(created.phase()).toBe('downloading');
      seen.push(created.percent());

      await created.dismiss();
      pending.finish?.();
      await running;

      expect(seen).toEqual([0.2]);
      expect(created.percent()).toBe(0);
      expect(created.phase()).toBe('idle');
      expect(update.install).not.toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('does nothing before the download has finished', async () => {
      const update = available();
      const created = await offered(update);
      await created.restart();

      expect(update.install).not.toHaveBeenCalled();
    });

    it('replaces the bundle, then relaunches — in that order', async () => {
      const order: string[] = [];
      const update = available({
        install: vi.fn(async () => {
          order.push('install');
        }),
      });
      const relaunch = vi.fn(async () => {
        order.push('relaunch');
      });
      const created = await offered(update, { relaunch });
      await created.install();
      await created.restart();

      expect(order).toEqual(['install', 'relaunch']);
    });

    it('reports a failed installation, and forgets the update', async () => {
      const update = available({ install: vi.fn().mockRejectedValue(new Error('disque plein')) });
      const created = await offered(update);
      await created.install();
      await created.restart();

      expect(created.error()).toBe('disque plein');
      expect(created.phase()).toBe('idle');
    });
  });

  describe('dismiss', () => {
    it('gives the backend resource back', async () => {
      const update = available();
      const created = await offered(update);
      await created.dismiss();

      expect(update.dispose).toHaveBeenCalledOnce();
      expect(created.banner()).toBeNull();
    });

    it('has nothing to give back when nothing was offered', async () => {
      const created = store({});
      await expect(created.dismiss()).resolves.toBeUndefined();
    });

    it('survives a resource that refuses to close', async () => {
      // Rien à réparer côté utilisateur, et il n'a rien demandé : on ne le dérange pas.
      const update = available({ dispose: vi.fn().mockRejectedValue(new Error('déjà fermée')) });
      const created = await offered(update);

      await expect(created.dismiss()).resolves.toBeUndefined();
      expect(created.error()).toBeNull();
    });
  });

  it('forgets an error once it has been shown', async () => {
    const update = available({ download: vi.fn().mockRejectedValue(new Error('coupure')) });
    const created = await offered(update);
    await created.install();
    created.clearError();

    expect(created.error()).toBeNull();
  });
});
