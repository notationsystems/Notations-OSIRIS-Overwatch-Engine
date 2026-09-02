import { EyeOff } from 'lucide-react';
import type { ScenarioUnobservedState } from '@/lib/economy/scenarioDelta';

interface Props {
  state: ScenarioUnobservedState;
}

/**
 * The visual counterpart to an unobserved state. It is deliberately not a
 * ScenarioEntityDelta card: no baseline or synthetic numeric value is shown.
 */
export default function ScenarioUnobservedStateCard({ state }: Props) {
  return (
    <article
      className="rounded-xl border border-violet-400/25 bg-violet-500/[0.07] p-3 shadow-[inset_0_1px_0_rgba(196,181,253,0.08)]"
      aria-label={`${state.presentation.label}: ${state.scope.entityName} ${state.metric.name}`}
    >
      <div className="flex items-start gap-2.5">
        <EyeOff size={15} className="mt-0.5 shrink-0 text-violet-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[8px] font-semibold uppercase tracking-[0.16em] text-violet-300">
              {state.presentation.label}
            </p>
            <span className="rounded border border-violet-300/20 px-1.5 py-0.5 font-mono text-[7px] uppercase text-violet-200/70">
              Evidence required
            </span>
          </div>
          <p className="mt-1 text-[10px] font-medium text-violet-50">{state.scope.entityName}</p>
          <p className="mt-0.5 font-mono text-[8px] text-violet-200/55">
            {state.metric.name} · {state.presentation.valueText}
          </p>
          <p className="mt-2 text-[9px] leading-4 text-violet-100/70">{state.observability.reason}</p>
          <div className="mt-2 border-l border-violet-300/35 pl-2">
            <p className="font-mono text-[7px] uppercase tracking-wide text-violet-300/70">Acquisition remedy</p>
            <p className="mt-0.5 text-[9px] leading-4 text-violet-100/75">{state.acquisition.remedy}</p>
          </div>
        </div>
      </div>
    </article>
  );
}
