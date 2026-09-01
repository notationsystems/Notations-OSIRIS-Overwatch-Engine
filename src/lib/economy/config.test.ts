import { describe, it, expect } from 'vitest';
import { assertRequiredConfig, checkRequiredConfig } from './config';

describe('deployment configuration seams (S-3)', () => {
  it('default state requires nothing — no built source needs a credential today', () => {
    expect(checkRequiredConfig({}).ok).toBe(true);
  });

  it('enabling EDGAR without the identity refuses loudly with BOTH keys named', () => {
    // The discriminating state: the flag on, the identity absent — the
    // configuration-layer fresh-but-wrong failure this gate exists for.
    const source = { PAYLOAD_EDGAR_ENABLED: '1' };
    const check = checkRequiredConfig(source);
    expect(check.ok).toBe(false);
    expect(check.missing.map(m => m.key).sort()).toEqual(['PAYLOAD_SEC_UA_CONTACT', 'PAYLOAD_SEC_UA_ORG']);
    expect(() => assertRequiredConfig(source)).toThrow(/PAYLOAD_SEC_UA_ORG/);
    expect(() => assertRequiredConfig(source)).toThrow(/PAYLOAD_SEC_UA_CONTACT/);
    // Partial identity is still a refusal — one key alone must not pass.
    expect(checkRequiredConfig({ PAYLOAD_EDGAR_ENABLED: '1', PAYLOAD_SEC_UA_ORG: 'ExampleCo' }).ok).toBe(false);
  });

  it('the complete identity passes', () => {
    expect(checkRequiredConfig({
      PAYLOAD_EDGAR_ENABLED: '1',
      PAYLOAD_SEC_UA_ORG: 'ExampleCo',
      PAYLOAD_SEC_UA_CONTACT: 'data@example.com',
    }).ok).toBe(true);
  });

  describe('the SEA_DOG_ landing strip', () => {
    it('a deployment still on the old spelling keeps working', () => {
      // The whole point of the strip: an operator who read no release note
      // gets a working deployment, not a silent refusal at boot.
      expect(checkRequiredConfig({
        SEA_DOG_EDGAR_ENABLED: '1',
        SEA_DOG_SEC_UA_ORG: 'ExampleCo',
        SEA_DOG_SEC_UA_CONTACT: 'data@example.com',
      }).ok).toBe(true);
    });

    it('reports the CURRENT key name even when the old spelling enabled the flag', () => {
      // A refusal that hands back the deprecated name would tell the
      // operator to set the wrong thing — a remedy pointing at the exit
      // being closed.
      const check = checkRequiredConfig({ SEA_DOG_EDGAR_ENABLED: '1' });
      expect(check.ok).toBe(false);
      expect(check.missing.map(m => m.key).sort()).toEqual(['PAYLOAD_SEC_UA_CONTACT', 'PAYLOAD_SEC_UA_ORG']);
      expect(check.missing.every(m => !m.key.includes('SEA_DOG'))).toBe(true);
    });

    it('the current spelling wins when both are set, so a migration is testable', () => {
      // Preferring the old one silently would make "did my rename take?"
      // unanswerable from behaviour.
      expect(checkRequiredConfig({
        PAYLOAD_EDGAR_ENABLED: '1',
        SEA_DOG_EDGAR_ENABLED: '',
        PAYLOAD_SEC_UA_ORG: 'NewCo',
        SEA_DOG_SEC_UA_ORG: 'OldCo',
        PAYLOAD_SEC_UA_CONTACT: 'data@example.com',
      }).ok).toBe(true);
    });

    it('a half-migrated deployment is not a refusal', () => {
      // New flag, old identity: both are read, so it holds.
      expect(checkRequiredConfig({
        PAYLOAD_EDGAR_ENABLED: '1',
        SEA_DOG_SEC_UA_ORG: 'ExampleCo',
        SEA_DOG_SEC_UA_CONTACT: 'data@example.com',
      }).ok).toBe(true);
    });
  });
});
