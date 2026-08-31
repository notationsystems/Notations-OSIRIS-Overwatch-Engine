import { buildDemoQueue } from '@/lib/economy/worldQueueDemo';

export const metadata = {
  title: 'Operations Queue | Payload Terminal',
  description:
    'The morning view: what is priced, what is blocked on a missing field, and what was refused with a clause.',
};

/**
 * Payload — the operations queue (ledger phase 82).
 *
 * THE SCREEN'S ONE JOB is that BLOCKED and REFUSED do not look alike. They were
 * carefully separated in the data; rendering them as two similar columns of
 * grey rows would put the distinction back exactly where it was.
 *
 *   BLOCKED is amber, states a FIELD, and its action is "add it".
 *   REFUSED is red, states a CLAUSE, and its action is a decision.
 *
 * The banner is not decoration either. This queue rests on the simulated world,
 * so `admissible` is false and every number below is a shape rather than a
 * price. A morning view that looked authoritative while resting on a fixture
 * would be the most expensive defect this project could ship, because its
 * output is what someone quotes.
 */

const GENERATED_AT = '2026-08-31T00:00:00.000Z';

function money(n: number): string {
  return `$${n.toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;
}

export default function QueuePage() {
  const queue = buildDemoQueue({ generatedAt: GENERATED_AT, pendingCount: 14 });
  const { census } = queue;

  return (
    <main className="min-h-screen bg-[#0b0f19] text-[#e2e8f0] p-6 md:p-10 font-mono">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-[#D4AF37]">OPERATIONS QUEUE</h1>
        <p className="text-xs text-[#94a3b8] mt-1">
          as of {queue.asOf} · {census.pending} pending
          {' · '}
          <span className={census.conserved ? 'text-[#00E676]' : 'text-[#FF3D3D]'}>
            {census.conserved
              ? 'every load accounted for'
              : 'CONSERVATION FAILED — a load is missing from these lists'}
          </span>
        </p>
      </header>

      {!queue.admissible && (
        <div className="mb-8 border border-[#D4AF37]/40 bg-[#D4AF37]/5 px-4 py-3 text-xs leading-relaxed">
          <div className="font-bold text-[#D4AF37] mb-1">NOT ADMISSIBLE — SIMULATED BOOK</div>
          <p className="text-[#cbd5e1]">
            Every figure on this screen is computed from the representative freight world
            ({queue.attestation.evidenceClass} evidence). These are shapes, not prices, and
            nothing here may be quoted to a customer or cited as a measurement.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ── PRICED ─────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-[#00E676] mb-1">
            PRICED <span className="text-[#94a3b8] font-normal">({census.priced})</span>
          </h2>
          <p className="text-[10px] text-[#64748b] mb-3">A number, with its confidence and band.</p>
          <ul className="space-y-2">
            {queue.priced.map(({ load, quote }) => (
              <li key={load.loadId} className="border border-[#00E676]/25 bg-[#00E676]/[0.03] p-3">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="text-xs font-bold">{load.laneId} · {load.equipment}</span>
                  <span className="text-sm font-bold text-[#00E676]">
                    {money(quote.components.quote)}
                  </span>
                </div>
                <div className="text-[10px] text-[#94a3b8] mt-1">
                  {load.loadId} · {load.reference}
                </div>
                <div className="text-[10px] mt-1">
                  <span
                    className={
                      quote.confidence === 'confident' ? 'text-[#00E676]' : 'text-[#D4AF37]'
                    }
                  >
                    {quote.confidence.toUpperCase()}
                  </span>
                  <span className="text-[#64748b]">
                    {' '}· band {money(quote.band.low)}–{money(quote.band.high)} · n=
                    {quote.stat.nUsed}
                  </span>
                </div>
              </li>
            ))}
            {queue.priced.length === 0 && (
              <li className="text-[11px] text-[#64748b] border border-dashed border-[#334155] p-3">
                No load in this book priced. With {census.refused} refused and {census.blocked}{' '}
                blocked, that is an answer about the book, not an empty screen.
              </li>
            )}
          </ul>
        </section>

        {/* ── BLOCKED ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-[#D4AF37] mb-1">
            BLOCKED <span className="text-[#94a3b8] font-normal">({census.blocked})</span>
          </h2>
          <p className="text-[10px] text-[#64748b] mb-3">
            Never quoted — a required field is missing. Go to the LOAD.
          </p>
          <ul className="space-y-2">
            {queue.blocked.map(({ load, missing, remedy }) => (
              <li key={load.loadId} className="border border-[#D4AF37]/40 bg-[#D4AF37]/[0.05] p-3">
                <div className="text-xs font-bold">{load.loadId}</div>
                <div className="text-[11px] text-[#D4AF37] mt-1">
                  missing: {missing.join(', ')}
                </div>
                <div className="text-[10px] text-[#94a3b8] mt-1">{remedy}</div>
              </li>
            ))}
            {queue.blocked.length === 0 && (
              <li className="border border-dashed border-[#D4AF37]/30 p-3 text-[11px] text-[#94a3b8] leading-relaxed">
                <span className="font-bold text-[#D4AF37]">EMPTY — AND WHY.</span>{' '}
                {queue.blockedWarrant}
              </li>
            )}
          </ul>
        </section>

        {/* ── REFUSED ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-[#FF3D3D] mb-1">
            REFUSED <span className="text-[#94a3b8] font-normal">({census.refused})</span>
          </h2>
          <p className="text-[10px] text-[#64748b] mb-3">
            Quoted and declined, with a clause. This is a DECISION.
          </p>
          <ul className="space-y-2">
            {queue.refused.map(({ load, quote }) => (
              <li key={load.loadId} className="border border-[#FF3D3D]/30 bg-[#FF3D3D]/[0.04] p-3">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="text-xs font-bold">{load.laneId} · {load.equipment}</span>
                  <span className="text-[10px] text-[#FF3D3D] font-bold">
                    {quote.reason.replace(/_/g, ' ').toUpperCase()}
                  </span>
                </div>
                <div className="text-[10px] text-[#94a3b8] mt-1">{load.loadId}</div>
                <div className="text-[10px] text-[#cbd5e1] mt-2 leading-relaxed">
                  {quote.remedy}
                </div>
                <div className="text-[10px] text-[#64748b] mt-1 leading-relaxed">
                  Fallback: {quote.fallback}
                </div>
              </li>
            ))}
            {queue.refused.length === 0 && (
              <li className="text-[11px] text-[#64748b] border border-dashed border-[#334155] p-3">
                Nothing refused: every load with a complete booking priced from the record.
              </li>
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}
