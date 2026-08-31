import { describe, it, expect, beforeEach } from 'vitest';
import {
  LEGACY_ENV_NAMES,
  LEGACY_ENV_REMOVED_AFTER,
  readEnvWithLegacy,
  resetLegacyEnvWarnings,
} from './envCompat';

/**
 * The rename has to be real AND it has to land softly. A rename that takes
 * effect immediately turns a configured deployment into an unconfigured one
 * with nothing said: the variable is unset, the feature it gated switches
 * off, and the operator finds out from behaviour rather than from a message.
 *
 * So the old name is read for one release and warns. These tests grade both
 * halves — that the legacy name still works, and that using it is audible.
 */
describe('the OSIRIS → PAYLOAD environment rename', () => {
  beforeEach(() => resetLegacyEnvWarnings());

  it('reads the current name', () => {
    const read = readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', { PAYLOAD_DISABLE_LIVE: '1' });
    expect(read.value).toBe('1');
    expect(read.suppliedBy).toBe('current');
  });

  it('still honours the legacy name so a running deployment does not break', () => {
    const warnings: string[] = [];
    const read = readEnvWithLegacy(
      'PAYLOAD_DISABLE_LIVE', { OSIRIS_DISABLE_LIVE: '1' }, (m) => warnings.push(m));
    expect(read.value).toBe('1');
    expect(read.suppliedBy).toBe('legacy');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OSIRIS_DISABLE_LIVE');
    expect(warnings[0]).toContain('PAYLOAD_DISABLE_LIVE');
    expect(warnings[0]).toContain(LEGACY_ENV_REMOVED_AFTER);
  });

  it('warns once per legacy name, not once per read', () => {
    const warnings: string[] = [];
    const env = { OSIRIS_DISABLE_LIVE: '1' };
    readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', env, (m) => warnings.push(m));
    readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', env, (m) => warnings.push(m));
    readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', env, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  it('prefers the current name when both are set', () => {
    // An operator mid-migration has the NEW one right. Silently preferring
    // the old one would make the migration impossible to verify.
    const read = readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', {
      PAYLOAD_DISABLE_LIVE: 'new',
      OSIRIS_DISABLE_LIVE: 'old',
    });
    expect(read.value).toBe('new');
    expect(read.suppliedBy).toBe('current');
  });

  it('reports unset as unset rather than as a value', () => {
    const read = readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', {});
    expect(read.value).toBeUndefined();
    expect(read.suppliedBy).toBeNull();
  });

  it('treats an empty string as unset on both spellings', () => {
    const read = readEnvWithLegacy('PAYLOAD_DISABLE_LIVE', {
      PAYLOAD_DISABLE_LIVE: '', OSIRIS_DISABLE_LIVE: '',
    });
    expect(read.suppliedBy).toBeNull();
  });

  it('does not invent a legacy spelling for a name that never had one', () => {
    const warnings: string[] = [];
    const read = readEnvWithLegacy('SOME_NEW_KEY', { OSIRIS_SOME_NEW_KEY: 'x' },
      (m) => warnings.push(m));
    expect(read.value).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('names every legacy spelling it still accepts', () => {
    // The deprecation is a state with an end. This list is what has to be
    // empty after LEGACY_ENV_REMOVED_AFTER, and it is the whole of it.
    //
    // This assertion used to require `OSIRIS_` on the legacy side, which
    // encoded an assumption that there had been exactly one rename. There
    // have been two: the fork's original OSIRIS_ names, and the SEA_DOG_
    // names from the day this instrument carried that name. The invariant
    // that actually holds is that every CURRENT name is a PAYLOAD_ one and
    // every legacy name belongs to a brand that has been retired.
    const RETIRED_PREFIXES = ['OSIRIS_', 'SEA_DOG_'];
    for (const [now, was] of Object.entries(LEGACY_ENV_NAMES)) {
      expect(now, `${now} is not a current-brand name`).toMatch(/^PAYLOAD_/);
      expect(RETIRED_PREFIXES.some(p => was.startsWith(p)), `${was} is not a retired-brand name`).toBe(true);
    }
    // No key maps to itself: that would be a deprecation with no migration.
    expect(Object.entries(LEGACY_ENV_NAMES).every(([now, was]) => now !== was)).toBe(true);
    // And no legacy name is ALSO a current name, which would make the
    // fallback read its own successor.
    const current = new Set(Object.keys(LEGACY_ENV_NAMES));
    expect(Object.values(LEGACY_ENV_NAMES).filter(w => current.has(w))).toEqual([]);
  });
});
