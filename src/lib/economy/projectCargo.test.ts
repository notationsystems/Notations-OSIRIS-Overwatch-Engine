import { describe, expect, it } from 'vitest';
import { ProjectCargoWorkflow } from './projectCargo';
import { ProjectCargoActions } from './projectCargoActions';
import { decodeOtlpJsonLogs } from './projectCargoOtlp';
import { MemoryProjectCargoStore } from './projectCargoStore';

let sequence = 0;
function command(action: string, submittedAt: string, payload: Record<string, unknown>) {
  sequence += 1;
  return { action, requestId: `request:project:${sequence}`, actorId: 'desk:projects', submittedAt, payload };
}

describe('PayloadOS project cargo execution', () => {
  it('operates constrained cargo from specification through verified delivery and realized margin', async () => {
    const clock = () => '2026-09-20T12:00:00.000Z';
    const workflow = new ProjectCargoWorkflow(new MemoryProjectCargoStore());
    const actions = new ProjectCargoActions(workflow, clock);
    const register = await actions.execute(command('register_project', '2026-09-01T09:00:00.000Z', {
      projectId: 'project:pharma:001', projectReference: 'customer-project:001', customerId: 'customer:life-sciences',
      customerCommitmentId: 'customer-commitment:001', originLocationId: 'facility:origin', destinationLocationId: 'facility:destination', sourceReference: 'project-order:001',
      cargoItems: [{
        cargoItemId: 'cargo:vaccine:001', assetId: 'asset:lot:001', category: 'pharmaceutical_cold_chain', description: 'Qualified biologic shipment', serialOrLotIds: ['lot:001'],
        quantity: 20, quantityUnit: 'unit', declaredValueMinor: 2_000_000, declaredValueCurrency: 'CAD', sourceReference: 'packing-list:001',
        constraints: { temperatureMinimumCel: 2, temperatureMaximumCel: 8, allowedOrientations: ['upright'], handlingRequirements: ['validated cold-chain handling'], securityRequirements: ['sealed custody'], regulatoryRequirements: ['GDP'], requiredDocumentTypes: ['gdp-release'], requiredTelemetrySignals: ['temperature'], continuousCustodyRequired: true },
      }],
    }));
    expect(register).toMatchObject({ kind: 'accepted', project: { phase: 'planning' } });

    const planned = await actions.execute(command('plan_journey', '2026-09-01T10:00:00.000Z', {
      projectId: 'project:pharma:001', journeyId: 'journey:pharma:001', version: 1, sourceReference: 'route-plan:001',
      facilities: [
        { facilityId: 'stop:origin', locationId: 'facility:origin', facilityType: 'origin', capabilities: ['cold storage'] },
        { facilityId: 'stop:airport', locationId: 'facility:airport', facilityType: 'airport', capabilities: ['pharma handling'] },
        { facilityId: 'stop:destination', locationId: 'facility:destination', facilityType: 'destination', capabilities: ['validated receipt'] },
      ],
      permits: [{ permitId: 'permit:gdp:001', permitType: 'GDP movement approval', authority: 'authority:health', requiredForLegIds: ['leg:road:001'] }],
      legs: [
        { legId: 'leg:road:001', sequence: 1, mode: 'road', fromFacilityId: 'stop:origin', toFacilityId: 'stop:airport', plannedStart: '2026-09-02T08:00:00.000Z', plannedEnd: '2026-09-02T10:00:00.000Z', dependsOnLegIds: [], requiredPermitIds: ['permit:gdp:001'], loadOperationId: 'load-operation:001' },
        { legId: 'leg:air:001', sequence: 2, mode: 'air', fromFacilityId: 'stop:airport', toFacilityId: 'stop:destination', plannedStart: '2026-09-02T12:00:00.000Z', plannedEnd: '2026-09-02T16:00:00.000Z', dependsOnLegIds: ['leg:road:001'], requiredPermitIds: [] },
      ],
    }));
    expect(planned).toMatchObject({ kind: 'accepted', project: { phase: 'permits_pending' } });

    const blocked = await actions.execute(command('update_leg', '2026-09-02T07:30:00.000Z', { projectId: 'project:pharma:001', legId: 'leg:road:001', status: 'ready', locationId: 'facility:origin', source: 'operator', sourceReference: 'release:attempt' }));
    expect(blocked).toMatchObject({ kind: 'refusal', code: 'JOURNEY_LEG_UPDATE_REFUSED' });
    await actions.execute(command('update_permit', '2026-09-02T07:40:00.000Z', { projectId: 'project:pharma:001', permitId: 'permit:gdp:001', status: 'approved', validFrom: '2026-09-02T00:00:00.000Z', validThrough: '2026-09-03T00:00:00.000Z', sourceReference: 'permit-record:001' }));
    await actions.execute(command('transfer_custody', '2026-09-02T07:45:00.000Z', { projectId: 'project:pharma:001', cargoItemIds: ['cargo:vaccine:001'], toCustodianId: 'carrier:alpha', locationId: 'facility:origin', sealId: 'seal:001', conditionNote: 'Released sealed and in range', sourceReference: 'custody:origin' }));
    await actions.execute(command('attach_evidence', '2026-09-02T07:50:00.000Z', { projectId: 'project:pharma:001', cargoItemId: 'cargo:vaccine:001', evidenceType: 'document', documentType: 'gdp-release', sha256: 'a'.repeat(64), capturedAt: '2026-09-02T07:30:00.000Z', sourceReference: 'gdp-release:001' }));

    for (const [status, at, location] of [
      ['ready', '2026-09-02T07:55:00.000Z', 'facility:origin'],
      ['in_transit', '2026-09-02T08:00:00.000Z', 'facility:origin'],
      ['arrived', '2026-09-02T10:00:00.000Z', 'facility:airport'],
      ['completed', '2026-09-02T10:05:00.000Z', 'facility:airport'],
    ] as const) await actions.execute(command('update_leg', at, { projectId: 'project:pharma:001', legId: 'leg:road:001', status, locationId: location, source: 'operator', sourceReference: `carrier-event:${status}` }));

    const observed = await actions.execute(command('ingest_telemetry', '2026-09-02T10:10:00.000Z', { projectId: 'project:pharma:001', cargoItemId: 'cargo:vaccine:001', sensorId: 'sensor:reefer:001', signal: 'temperature', numericValue: 12, unit: 'Cel', measuredAt: '2026-09-02T10:09:00.000Z', sourceReference: 'sensor-reading:001' }));
    expect(observed.kind).toBe('accepted');
    if (observed.kind === 'refusal') throw new Error(observed.detail);
    expect(observed.project).toMatchObject({ phase: 'exception', exceptions: [{ breach: { code: 'TEMPERATURE_HIGH', observedValue: 12, limitValue: 8 }, status: 'open' }] });
    const exceptionId = observed.project.exceptions[0].exceptionId;
    const premature = await actions.execute(command('verify_delivery', '2026-09-02T10:11:00.000Z', { projectId: 'project:pharma:001', disposition: 'accepted', locationId: 'facility:destination', evidenceReferences: ['pod:001'], sourceReference: 'pod:001' }));
    expect(premature).toMatchObject({ kind: 'refusal', code: 'PROJECT_VERIFICATION_REFUSED' });
    await actions.execute(command('authorize_remedy', '2026-09-02T10:12:00.000Z', { projectId: 'project:pharma:001', exceptionId, remedyCode: 'quarantine', instruction: 'Move to qualified cold room and inspect stability evidence.', sourceReference: 'exception-approval:001' }));
    await actions.execute(command('complete_remedy', '2026-09-02T11:00:00.000Z', { projectId: 'project:pharma:001', exceptionId, outcome: 'contained', sourceReference: 'exception-outcome:001' }));

    for (const [status, at, location] of [
      ['ready', '2026-09-02T11:30:00.000Z', 'facility:airport'],
      ['in_transit', '2026-09-02T12:00:00.000Z', 'facility:airport'],
      ['arrived', '2026-09-02T16:00:00.000Z', 'facility:destination'],
      ['completed', '2026-09-02T16:05:00.000Z', 'facility:destination'],
    ] as const) await actions.execute(command('update_leg', at, { projectId: 'project:pharma:001', legId: 'leg:air:001', status, locationId: location, source: 'edi', sourceReference: `edi-event:${status}` }));
    await actions.execute(command('transfer_custody', '2026-09-02T16:10:00.000Z', { projectId: 'project:pharma:001', cargoItemIds: ['cargo:vaccine:001'], fromCustodianId: 'carrier:alpha', toCustodianId: 'customer:life-sciences', locationId: 'facility:destination', sealId: 'seal:001', conditionNote: 'Seal intact; shipment quarantined pending release', sourceReference: 'custody:destination' }));
    const falseAcceptance = await actions.execute(command('verify_delivery', '2026-09-02T16:14:00.000Z', { projectId: 'project:pharma:001', disposition: 'accepted', locationId: 'facility:destination', evidenceReferences: ['pod:001'], sourceReference: 'pod:accepted' }));
    expect(falseAcceptance).toMatchObject({ kind: 'refusal', code: 'PROJECT_VERIFICATION_REFUSED' });
    const verified = await actions.execute(command('verify_delivery', '2026-09-02T16:15:00.000Z', { projectId: 'project:pharma:001', disposition: 'quarantined', locationId: 'facility:destination', evidenceReferences: ['pod:001'], sourceReference: 'pod:001' }));
    expect(verified).toMatchObject({ kind: 'accepted', project: { phase: 'economics_pending' } });

    for (const entry of [
      { entryId: 'entry:revenue', category: 'customer_revenue', effect: 'revenue', amountMinor: 1_000_000, sourceSystem: 'commercial' },
      { entryId: 'entry:freight', category: 'freight', effect: 'cost', amountMinor: 400_000, sourceSystem: 'accounting' },
      { entryId: 'entry:insurance', category: 'insurance', effect: 'cost', amountMinor: 50_000, sourceSystem: 'accounting' },
      { entryId: 'entry:recovery', category: 'claim_recovery', effect: 'recovery', amountMinor: 10_000, sourceSystem: 'claims' },
    ]) await actions.execute(command('record_economic_entry', '2026-09-10T10:00:00.000Z', { projectId: 'project:pharma:001', ...entry, currency: 'CAD', incurredAt: '2026-09-09T10:00:00.000Z', externalReference: entry.entryId, sourceReference: `${entry.entryId}:source` }));
    const closed = await actions.execute(command('close_economics', '2026-09-10T12:00:00.000Z', { projectId: 'project:pharma:001', sourceSystemsReconciled: ['commercial', 'accounting', 'claims'], sourceReference: 'reconciliation:001' }));
    expect(closed).toMatchObject({ kind: 'accepted', project: { phase: 'complete', profitability: { kind: 'complete', revenueMinor: 1_000_000, recoveryMinor: 10_000, costMinor: 450_000, grossMarginMinor: 560_000 } } });
  });

  it('maps OTLP JSON log records without occupying the reserved otel namespace', () => {
    const body = {
      resourceLogs: [{ resource: { attributes: [
        { key: 'payload.project.id', value: { stringValue: 'project:pharma:001' } },
        { key: 'payload.cargo.item.id', value: { stringValue: 'cargo:vaccine:001' } },
        { key: 'device.id', value: { stringValue: 'sensor:reefer:001' } },
      ] }, scopeLogs: [{ logRecords: [{
        timeUnixNano: '1788343740000000000', eventName: 'payload.cargo.condition.observed',
        attributes: [
          { key: 'payload.telemetry.signal', value: { stringValue: 'temperature' } },
          { key: 'payload.telemetry.unit', value: { stringValue: 'Cel' } },
          { key: 'payload.telemetry.value', value: { doubleValue: 5.25 } },
        ],
      }] }] }],
    };
    const decoded = decodeOtlpJsonLogs(body, 'collector:toronto:001', '2026-09-02T12:00:00.000Z');
    expect(Array.isArray(decoded)).toBe(true);
    if ('kind' in decoded) throw new Error(decoded.detail);
    expect(decoded[0].request).toMatchObject({ action: 'ingest_telemetry', actorId: 'sensor:collector:toronto:001', payload: { projectId: 'project:pharma:001', cargoItemId: 'cargo:vaccine:001', sensorId: 'sensor:reefer:001', signal: 'temperature', numericValue: 5.25, unit: 'Cel' } });
    expect(JSON.stringify(decoded)).not.toContain('otel.payload');
    expect(decodeOtlpJsonLogs({}, 'collector:toronto:001', '2026-09-02T12:00:00.000Z')).toMatchObject({ kind: 'refusal' });
  });

  it('rejects operator attempts to inject derived event identities', async () => {
    const actions = new ProjectCargoActions(new ProjectCargoWorkflow(new MemoryProjectCargoStore()), () => '2026-09-20T12:00:00.000Z');
    const value = command('register_project', '2026-09-01T09:00:00.000Z', { projectId: 'project:bad', projectReference: 'bad', customerId: 'customer:bad', originLocationId: 'origin', destinationLocationId: 'destination', cargoItems: [], sourceReference: 'bad' });
    expect(await actions.execute({ ...value, commandHash: 'operator-controlled' })).toMatchObject({ kind: 'refusal', code: 'PROJECT_CARGO_COMMAND_INVALID' });
  });
});
