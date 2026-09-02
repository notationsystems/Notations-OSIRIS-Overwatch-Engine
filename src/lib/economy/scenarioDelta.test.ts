import { describe, expect, it } from 'vitest';
import type { EventImpact } from './propagation';
import { scenarioUnobservedStates, type ScenarioUnobservedReasonCode } from './scenarioDelta';

function impact(explanation: string, overrides: Partial<EventImpact> = {}): EventImpact {
  return {
    eventId: 'evt:scenario:test:0',
    eventTitle: 'Test interruption',
    eventType: 'outage',
    severity: 'high',
    active: true,
    entityId: 'ent:mine:test',
    entityName: 'Test Mine',
    disruptedKtPerYear: null,
    affected: [],
    alternatives: [],
    dependents: [],
    flowIds: ['flow:test'],
    capacityIds: [],
    dependencyIds: ['dep:test'],
    explanation: [explanation],
    ...overrides,
  };
}

describe('scenario unobserved states', () => {
  it.each<[string, ScenarioUnobservedReasonCode, string]>([
    ['The selected graph predates this evaluation date.', 'flow_topology_unobserved', 'flowTopology'],
    ['FACILITY-LEVEL PROPAGATION REFUSED AT COUNTRY GRANULARITY: ALLOCATION MODEL required.', 'facility_allocation_unobserved', 'countryFacilityAllocation'],
    ['Tonnage is REFUSED because gross-weight needs a corridor grade.', 'material_basis_unobserved', 'corridorGradeOrStageConversion'],
    ['VINTAGE COVERAGE REFUSAL: no reporter-declared corridors.', 'reporter_vintage_unobserved', 'reporterYearFlowCoverage'],
    ['REGULATORY EVENT WITHOUT A SCOPE: propagation refused.', 'regulatory_scope_unobserved', 'regulatoryScope'],
  ])('classifies %s', (explanation, reasonCode, missingField) => {
    const [state] = scenarioUnobservedStates([impact(explanation)]);
    expect(state.observability).toMatchObject({ reasonCode, missingFields: [missingField] });
    expect(state.metric.value).toBeNull();
    expect(state.lineage.observedRecordIds).toEqual(['flow:test', 'dep:test']);
    expect(state.acquisition.remedy.length).toBeGreaterThan(20);
  });

  it('does not turn observed or inactive impacts into unobserved state', () => {
    expect(scenarioUnobservedStates([
      impact('Observed.', { disruptedKtPerYear: 0 }),
      impact('Unknown.', { active: false }),
    ])).toEqual([]);
  });
});
