import type { EventImpact } from './propagation';

export interface ScenarioEntityRef {
  id: string;
  name: string;
}

/**
 * Values the counterfactual can state without inventing a baseline. A null
 * disrupted figure is retained here for backwards compatibility, but its
 * explanation lives in the separate ScenarioUnobservedState collection.
 */
export interface ScenarioEntityDelta {
  newlyDisrupted: ScenarioEntityRef[];
  newlyAffectedDownstream: ScenarioEntityRef[];
  disruptedKtPerYear: number | null;
}

export type ScenarioUnobservedReasonCode =
  | 'flow_topology_unobserved'
  | 'facility_allocation_unobserved'
  | 'material_basis_unobserved'
  | 'reporter_vintage_unobserved'
  | 'regulatory_scope_unobserved'
  | 'impact_evidence_unobserved';

export interface ScenarioUnobservedState {
  kind: 'unobserved_state';
  stateId: string;
  scope: {
    scenarioEventId: string;
    entityId: string;
    entityName: string;
  };
  metric: {
    name: 'disruptedKtPerYear';
    unit: 'kt/y';
    value: null;
  };
  observability: {
    status: 'unobserved';
    reasonCode: ScenarioUnobservedReasonCode;
    reason: string;
    missingFields: string[];
  };
  lineage: {
    observedRecordIds: string[];
  };
  acquisition: {
    status: 'evidence_required';
    requiredEvidence: string[];
    remedy: string;
  };
  /** Stable display semantics. Clients may render this without treating the
   * state as an ordinary numeric delta. */
  presentation: {
    component: 'ScenarioUnobservedStateCard';
    accent: 'violet';
    label: 'UNOBSERVED';
    valueText: 'Not observed';
  };
}

interface ReasonSpec {
  code: ScenarioUnobservedReasonCode;
  missingFields: string[];
  requiredEvidence: string[];
  remedy: string;
}

function reasonSpec(explanation: string): ReasonSpec {
  if (/REGULATORY EVENT WITHOUT A SCOPE/i.test(explanation)) {
    return {
      code: 'regulatory_scope_unobserved',
      missingFields: ['regulatoryScope'],
      requiredEvidence: ['jurisdiction', 'regulated stages or commodity scope'],
      remedy: 'Curate the event regulatoryScope from authoritative policy material before estimating reach or tonnage.',
    };
  }
  if (/VINTAGE COVERAGE REFUSAL/i.test(explanation)) {
    return {
      code: 'reporter_vintage_unobserved',
      missingFields: ['reporterYearFlowCoverage'],
      requiredEvidence: ['reporter-declared corridors for the jurisdiction and serving year'],
      remedy: 'Capture and validate the missing jurisdiction reporter-year before calculating disrupted tonnage.',
    };
  }
  if (/FACILITY-LEVEL PROPAGATION REFUSED|ALLOCATION MODEL/i.test(explanation)) {
    return {
      code: 'facility_allocation_unobserved',
      missingFields: ['countryFacilityAllocation'],
      requiredEvidence: ['facility throughput', 'country-to-facility flow allocation'],
      remedy: 'Build an evidence-backed country-to-facility allocation model for the serving topology vintage.',
    };
  }
  if (/predates|outside the .*topology|flow topology/i.test(explanation)) {
    return {
      code: 'flow_topology_unobserved',
      missingFields: ['flowTopology'],
      requiredEvidence: ['a flow topology whose valid period covers the evaluation date'],
      remedy: 'Capture and compile a flow topology covering the evaluation date, then replay the scenario.',
    };
  }
  if (/corridor grade|stage-conversion|gross-weight|unquantified/i.test(explanation)) {
    return {
      code: 'material_basis_unobserved',
      missingFields: ['corridorGradeOrStageConversion'],
      requiredEvidence: ['documented corridor grade or stage-conversion constant'],
      remedy: 'Acquire a documented corridor grade or stage-conversion constant before converting gross weight to material content.',
    };
  }
  return {
    code: 'impact_evidence_unobserved',
    missingFields: ['disruptedKtPerYear'],
    requiredEvidence: ['evidence sufficient to quantify the scenario impact'],
    remedy: 'Acquire and validate the missing impact evidence, then replay the scenario without substituting zero.',
  };
}

function causalExplanation(impact: EventImpact): string {
  return impact.explanation.find(line =>
    /REFUS|unknown|cannot|predates|ALLOCATION MODEL|REGULATORY EVENT WITHOUT A SCOPE/i.test(line),
  ) ?? 'The corpus cannot quantify this active scenario impact from the evidence visible at the requested knowledge state.';
}

/**
 * Turns every active, unquantifiable scenario impact into a durable-shaped
 * epistemic object. It deliberately accepts no baseline values: unknown is a
 * work queue for evidence acquisition, never an invitation to estimate zero.
 */
export function scenarioUnobservedStates(impacts: readonly EventImpact[]): ScenarioUnobservedState[] {
  return impacts
    .filter(impact => impact.active && impact.disruptedKtPerYear === null)
    .map(impact => {
      const reason = causalExplanation(impact);
      const spec = reasonSpec(reason);
      return {
        kind: 'unobserved_state',
        stateId: `unobserved:${impact.eventId}:disruptedKtPerYear`,
        scope: {
          scenarioEventId: impact.eventId,
          entityId: impact.entityId,
          entityName: impact.entityName,
        },
        metric: { name: 'disruptedKtPerYear', unit: 'kt/y', value: null },
        observability: {
          status: 'unobserved',
          reasonCode: spec.code,
          reason,
          missingFields: spec.missingFields,
        },
        lineage: {
          observedRecordIds: [...new Set([
            ...impact.flowIds,
            ...impact.capacityIds,
            ...impact.dependencyIds,
          ])],
        },
        acquisition: {
          status: 'evidence_required',
          requiredEvidence: spec.requiredEvidence,
          remedy: spec.remedy,
        },
        presentation: {
          component: 'ScenarioUnobservedStateCard',
          accent: 'violet',
          label: 'UNOBSERVED',
          valueText: 'Not observed',
        },
      };
    });
}
