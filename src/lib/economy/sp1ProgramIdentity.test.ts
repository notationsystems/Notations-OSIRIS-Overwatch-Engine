import { describe, expect, it } from 'vitest';
import {
  parseSp1ProgramIdentity,
  payloadSp1ProgramIdentity,
  proofBatchLifecycleSummary,
} from './sp1ProgramIdentity';

describe('SP1 program identity', () => {
  it('loads the exact committed ceremony identity', () => {
    const identity = payloadSp1ProgramIdentity();
    expect(identity).toMatchObject({
      schemaVersion: 1,
      program: 'payload_event_batch_v1',
      sp1Version: '6.5.0',
      verificationKey: '0x008b44279df6f73c35aedf6de5145496d7b6364124ed46620bf4d4d222c54368',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.ceremony)).toBe(true);
  });

  it('refuses non-canonical or malformed identity records', () => {
    const identity = payloadSp1ProgramIdentity();
    expect(() => parseSp1ProgramIdentity({ ...identity, verificationKey: '0x1234' })).toThrow(/SP1_PROGRAM_IDENTITY_INVALID/);
    expect(() => parseSp1ProgramIdentity({ ...identity, unexpected: true })).toThrow(/fields are not canonical/);
    expect(() => parseSp1ProgramIdentity({ ...identity, ceremony: { ...identity.ceremony, sourceCommit: 'main' } })).toThrow(/SP1_PROGRAM_IDENTITY_INVALID/);
  });

  it('summarizes proof coverage without treating pending work as proved', () => {
    expect(proofBatchLifecycleSummary([
      { status: 'proved', eventCount: 12 },
      { status: 'pending', eventCount: 5 },
      { status: 'proving', eventCount: 3 },
      { status: 'failed', eventCount: 2 },
    ])).toEqual({
      total: 4,
      pending: 1,
      proving: 1,
      proved: 1,
      failed: 1,
      committedEvents: 22,
      provedEvents: 12,
    });
  });
});
