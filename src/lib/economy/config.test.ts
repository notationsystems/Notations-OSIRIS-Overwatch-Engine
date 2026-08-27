import { describe, it, expect } from 'vitest';
import { assertRequiredConfig, checkRequiredConfig } from './config';

describe('deployment configuration seams (S-3)', () => {
  it('default state requires nothing — no built source needs a credential today', () => {
    expect(checkRequiredConfig({}).ok).toBe(true);
  });

  it('enabling EDGAR without the identity refuses loudly with BOTH keys named', () => {
    // The discriminating state: the flag on, the identity absent — the
    // configuration-layer fresh-but-wrong failure this gate exists for.
    const env = { SEA_DOG_EDGAR_ENABLED: '1' };
    const check = checkRequiredConfig(env);
    expect(check.ok).toBe(false);
    expect(check.missing.map(m => m.key).sort()).toEqual(['SEA_DOG_SEC_UA_CONTACT', 'SEA_DOG_SEC_UA_ORG']);
    expect(() => assertRequiredConfig(env)).toThrow(/SEA_DOG_SEC_UA_ORG/);
    expect(() => assertRequiredConfig(env)).toThrow(/SEA_DOG_SEC_UA_CONTACT/);
    // Partial identity is still a refusal — one key alone must not pass.
    expect(checkRequiredConfig({ SEA_DOG_EDGAR_ENABLED: '1', SEA_DOG_SEC_UA_ORG: 'ExampleCo' }).ok).toBe(false);
  });

  it('the complete identity passes', () => {
    expect(checkRequiredConfig({
      SEA_DOG_EDGAR_ENABLED: '1',
      SEA_DOG_SEC_UA_ORG: 'ExampleCo',
      SEA_DOG_SEC_UA_CONTACT: 'data@example.com',
    }).ok).toBe(true);
  });
});
