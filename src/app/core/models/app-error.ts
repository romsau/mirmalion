/**
 * L'erreur du pont, miroir de l'enum `AppError` du backend (`src-tauri/src/error.rs`).
 *
 * @remarks
 * ⚠️ Le contrat sérialisé `{ kind, message }` est stable et les deux fichiers évoluent
 * ensemble : on ajoute des discriminants, on n'en renomme jamais.
 */

/** Les discriminants d'erreur, identiques à `AppError::kind()` côté Rust. */
export type AppErrorKind =
  | 'io'
  | 'database'
  | 'keychain'
  | 'native'
  | 'permission'
  | 'invalidArgument'
  | 'cancelled'
  | 'conflict';

/** Toute erreur remontée par une commande Tauri. */
export interface AppError {
  readonly kind: AppErrorKind;
  readonly message: string;
}

/** Les discriminants énumérés à l'exécution, pour reconnaître une erreur du pont. */
const APP_ERROR_KINDS: readonly AppErrorKind[] = [
  'io',
  'database',
  'keychain',
  'native',
  'permission',
  'invalidArgument',
  'cancelled',
  'conflict',
];

/** Vrai si la valeur respecte exactement le contrat `{ kind, message }` du backend. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AppError>;
  return (
    typeof candidate.message === 'string' &&
    APP_ERROR_KINDS.includes(candidate.kind as AppErrorKind)
  );
}

/**
 * Normalise n'importe quel rejet en {@link AppError}.
 *
 * @param value - Ce avec quoi une promesse a rejeté.
 * @returns La valeur telle quelle si elle est déjà conforme, sinon une erreur `native` : un
 * rejet de la couche IPC elle-même — commande inconnue, permission ACL refusée, sérialisation
 * en échec — vient bien du côté natif, pas de la commande.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }
  return {
    kind: 'native',
    message: value instanceof Error ? value.message : String(value),
  };
}
