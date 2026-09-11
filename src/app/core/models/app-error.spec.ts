import { describe, expect, it } from 'vitest';
import { isAppError, toAppError, type AppError, type AppErrorKind } from './app-error';

/** Les 7 discriminants du backend, dans l'ordre de `AppError::kind()`. */
const KINDS: readonly AppErrorKind[] = [
  'io',
  'database',
  'keychain',
  'native',
  'permission',
  'invalidArgument',
  'cancelled',
];

describe('isAppError', () => {
  it('accepts every kind the backend can emit', () => {
    for (const kind of KINDS) {
      expect(isAppError({ kind, message: 'boum' })).toBe(true);
    }
  });

  it('rejects a value that is not an object', () => {
    expect(isAppError('io')).toBe(false);
    expect(isAppError(42)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(isAppError(null)).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isAppError({ kind: 'teapot', message: 'boum' })).toBe(false);
  });

  it('rejects a missing or non-string message', () => {
    expect(isAppError({ kind: 'io' })).toBe(false);
    expect(isAppError({ kind: 'io', message: 42 })).toBe(false);
  });
});

describe('toAppError', () => {
  it('returns a conforming error untouched', () => {
    const error: AppError = { kind: 'keychain', message: 'clé illisible' };
    expect(toAppError(error)).toBe(error);
  });

  it('wraps an Error into the native kind, keeping its message', () => {
    expect(toAppError(new Error('commande inconnue'))).toEqual({
      kind: 'native',
      message: 'commande inconnue',
    });
  });

  it('stringifies anything else into the native kind', () => {
    expect(toAppError('panne sèche')).toEqual({ kind: 'native', message: 'panne sèche' });
    expect(toAppError(undefined)).toEqual({ kind: 'native', message: 'undefined' });
  });
});
