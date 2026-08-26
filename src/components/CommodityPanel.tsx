'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Mountain, X, ChevronLeft, ChevronDown, ChevronRight, Crosshair, AlertTriangle, Activity, Database } from 'lucide-react';

/**
 * OSIRIS — Physical Economy research panel (phase 1: copper).
 *
 * A projection of the canonical economy state served by /api/economy — the
 * panel holds no truth of its own. Overview mode shows concentration,
 * candidate bottlenecks, anomaly signals and events; selecting an entity
 * (here or on the map) opens the inspector with observations, provenance,
 * flows and upstream/downstream traversal.
 */

interface CommodityPanelProps {
  selectedId: string | null;
  onSelectEntity: (id: string | null) => void;
  onClose: () => void;
  onFlyTo?: (lat: number, lng: number, zoom?: number) => void;
}

interface Share { entityId: string; name: string; value: number; share: number }
interface ConcentrationBlock {
  operation: { name: string };
  inputs: { observationIds?: string[]; capacityIds?: string[] };
  result: { hhi: number; band: string; total: number; unit: string; shares: Share[] };
}
interface Bottleneck {
  entityId: string; name: string; kind: string; score: number;
  components: { throughputShare: number; utilization: number | null; redundancy: number; dependencyLoad: number };
  explanation: string[];
}
interface Anomaly { entityId: string; metric: string; kind: string; period: string; magnitude: number; explanation: string; observationIds: string[] }
interface EconEvent { id: string; entityId?: string; type: string; title: string; start: string; end?: string; severity: string; description?: string }

interface Analytics {
  commodityName: string;
  providers: string[];
  concentration: Record<string, ConcentrationBlock>;
  bottlenecks: { result: Bottleneck[] };
  anomalies: { result: Anomaly[] };
  events: EconEvent[];
  sources: Array<{ sourceId: string; sourceName: string; sourceUrl?: string }>;
}

interface Prov { sourceId: string; sourceName: string; sourceUrl?: string; retrievedAt: string; sourceRef?: string; note?: string }
interface Obs { id: string; metric: string; value: number; unit: string; period: { start: string; end: string }; valueKind: string; confidence: string; provenance: Prov }
interface Cap { id: string; stage: string; value: number; unit: string; valueKind: string; confidence: string; provenance: Prov }
interface FlowRec { id: string; fromEntityId: string; toEntityId: string; fromName: string; toName: string; form: string; quantity: number; unit: string; mode: string; confidence: string; provenance: Prov }
interface Step { id: string; name: string; kind: string; stage: string | null; country: string | null; depth: number; viaKind: string }

interface EntityDetail {
  entity: { id: string; name: string; kind: string; stage?: string; country?: string; operator?: string; lat?: number; lng?: number; geoPrecision?: string; notes?: string };
  observations: Obs[];
  capacities: Cap[];
  flowsIn: FlowRec[];
  flowsOut: FlowRec[];
  events: EconEvent[];
  upstream: Step[];
  downstream: Step[];
}

const CONCENTRATION_LABELS: Record<string, string> = {
  mineProductionByCountry: 'MINE PRODUCTION / COUNTRY',
  mineProductionByMine: 'MINE PRODUCTION / MINE',
  refinedProductionByCountry: 'REFINED PRODUCTION / COUNTRY',
  consumptionByRegion: 'CONSUMPTION / REGION',
  smeltingCapacityByCountry: 'SMELTING CAPACITY / COUNTRY',
  refiningCapacityByCountry: 'REFINING CAPACITY / COUNTRY',
};

const BAND_COLOR: Record<string, string> = { high: '#FF3D3D', moderate: '#FF9500', unconcentrated: '#00E676' };
const CONF_COLOR: Record<string, string> = { high: '#00E676', medium: '#FF9500', low: '#FF3D3D' };

const kindLabel = (kind: string, stage?: string | null) =>
  (stage && stage !== kind ? `${kind} · ${stage}` : kind).toUpperCase();

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <span className="inline-block w-16 h-1.5 rounded bg-white/10 overflow-hidden align-middle">
      <span className="block h-full rounded" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
    </span>
  );
}

function Section({ id, title, icon, children, count, open, onToggle }: {
  id: string; title: string; icon?: React.ReactNode; children: React.ReactNode; count?: number;
  open: boolean; onToggle: (id: string) => void;
}) {
  return (
    <div className="border-b border-white/5 pb-2 mb-2">
      <button onClick={() => onToggle(id)} className="flex items-center gap-1.5 w-full text-left mb-1">
        {open ? <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />}
        {icon}
        <span className="text-[10px] font-mono tracking-widest text-[var(--text-muted)] font-bold">{title}</span>
        {count !== undefined && <span className="text-[9px] font-mono text-[var(--text-muted)] opacity-70">({count})</span>}
      </button>
      {open && children}
    </div>
  );
}

function ProvLine({ p, valueKind, confidence }: { p: Prov; valueKind?: string; confidence?: string }) {
  return (
    <div className="text-[9px] font-mono text-[var(--text-muted)] leading-tight mt-0.5">
      <span className="text-[#00BCD4]">{p.sourceName}</span>
      {p.sourceRef ? <span> · {p.sourceRef}</span> : null}
      {valueKind ? <span> · <span className="text-[#FF9500]">{valueKind.toUpperCase()}</span></span> : null}
      {confidence ? <span> · conf <span style={{ color: CONF_COLOR[confidence] ?? '#aaa' }}>{confidence.toUpperCase()}</span></span> : null}
      {p.note ? <div className="text-[8px] text-[var(--text-muted)] opacity-80">{p.note}</div> : null}
    </div>
  );
}

export default function CommodityPanel({ selectedId, onSelectEntity, onClose, onFlyTo }: CommodityPanelProps) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState(false);
  const [detailById, setDetailById] = useState<EntityDetail | null>(null);
  const [detailFailedId, setDetailFailedId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ concentration: true, bottlenecks: true });
  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch('/api/economy?commodity=copper&view=analytics', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) setAnalytics(d); })
      .catch(() => { if (!cancelled) setAnalyticsError(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/economy/entity?commodity=copper&id=${encodeURIComponent(selectedId)}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) setDetailById(d); })
      .catch(() => { if (!cancelled) setDetailFailedId(selectedId); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Stale detail is simply not rendered — no state clearing inside effects.
  const detail = selectedId && detailById?.entity.id === selectedId ? detailById : null;
  const detailFailed = selectedId !== null && detailFailedId === selectedId;
  const detailLoading = selectedId !== null && !detail && !detailFailed;

  const toggle = useCallback((key: string) => setOpenSections(s => ({ ...s, [key]: !s[key] })), []);
  const toggleEvidence = useCallback((key: string) => setOpenEvidence(s => ({ ...s, [key]: !s[key] })), []);

  const flyToEntity = useCallback((e: { lat?: number; lng?: number }) => {
    if (e.lat !== undefined && e.lng !== undefined) onFlyTo?.(e.lat, e.lng, 4.5);
  }, [onFlyTo]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.25 }}
      className="glass-panel pointer-events-auto flex flex-col border border-[#D4AF37]/30"
      style={{ background: 'rgba(212, 175, 55, 0.04)', width: 380, maxWidth: '92vw', maxHeight: 'calc(100vh - 140px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-white/10">
        <div className="flex items-center gap-2 min-w-0">
          {selectedId && (
            <button onClick={() => onSelectEntity(null)} title="Back to overview" className="hover:bg-white/10 rounded p-0.5">
              <ChevronLeft className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
            </button>
          )}
          <Mountain className="w-3.5 h-3.5 text-[var(--gold-primary)] shrink-0" />
          <span className="hud-text text-[11px] text-[var(--text-primary)] truncate">
            PHYSICAL ECONOMY — {analytics?.commodityName?.toUpperCase() ?? 'COPPER'}
          </span>
        </div>
        <button onClick={onClose} className="hover:bg-white/10 rounded p-0.5"><X className="w-3.5 h-3.5 text-[var(--text-muted)]" /></button>
      </div>

      <div className="overflow-y-auto styled-scrollbar px-3 py-2 flex-1 min-h-0">
        {/* ── ENTITY INSPECTOR ── */}
        {selectedId ? (
          detailLoading ? (
            <div className="text-[10px] font-mono text-[var(--text-muted)] py-4">LOADING ENTITY STATE…</div>
          ) : !detail ? (
            <div className="text-[10px] font-mono text-[#FF3D3D] py-4">ENTITY UNAVAILABLE — {selectedId}</div>
          ) : (
            <div>
              <div className="mb-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-mono font-bold text-[var(--gold-primary)]">{detail.entity.name}</span>
                  {detail.entity.lat !== undefined && (
                    <button onClick={() => flyToEntity(detail.entity)} title="Fly to" className="hover:bg-white/10 rounded p-0.5">
                      <Crosshair className="w-3 h-3 text-[#00BCD4]" />
                    </button>
                  )}
                </div>
                <div className="text-[9px] font-mono text-[var(--text-muted)] mt-0.5">
                  {kindLabel(detail.entity.kind, detail.entity.stage)}
                  {detail.entity.country ? ` · ${detail.entity.country}` : ''}
                  {detail.entity.operator ? ` · ${detail.entity.operator}` : ''}
                  {detail.entity.geoPrecision ? ` · geo:${detail.entity.geoPrecision}` : ''}
                </div>
                {detail.entity.notes && <div className="text-[9px] font-mono text-[var(--text-muted)] opacity-80 mt-1">{detail.entity.notes}</div>}
              </div>

              {detail.events.length > 0 && (
                <div className="mb-2 space-y-1">
                  {detail.events.map(ev => (
                    <div key={ev.id} className="px-2 py-1.5 rounded border border-[#FF3D3D]/40 bg-[#FF3D3D]/10">
                      <div className="text-[10px] font-mono font-bold text-[#FF3D3D]">{ev.title}</div>
                      <div className="text-[9px] font-mono text-[var(--text-muted)]">{ev.start}{ev.end ? ` → ${ev.end}` : ''} · {ev.type.toUpperCase()} · {ev.severity.toUpperCase()}</div>
                      {ev.description && <div className="text-[9px] font-mono text-[#E8E6E0] mt-0.5 leading-tight">{ev.description}</div>}
                    </div>
                  ))}
                </div>
              )}

              {detail.observations.length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] font-mono tracking-widest text-[var(--text-muted)] font-bold mb-1">OBSERVATIONS</div>
                  <div className="space-y-1.5">
                    {detail.observations.slice(0, 14).map(o => (
                      <div key={o.id} className="px-2 py-1 rounded bg-white/[0.03] border border-white/5">
                        <div className="flex justify-between items-baseline">
                          <span className="text-[10px] font-mono text-[#E8E6E0]">{o.metric.replace(/_/g, ' ')}</span>
                          <span className="text-[11px] font-mono font-bold text-[var(--cyan-primary)] tabular-nums">{o.value.toLocaleString()} <span className="text-[8px] text-[var(--text-muted)]">{o.unit}</span></span>
                        </div>
                        <div className="text-[8px] font-mono text-[var(--text-muted)]">{o.period.start} → {o.period.end}</div>
                        <ProvLine p={o.provenance} valueKind={o.valueKind} confidence={o.confidence} />
                      </div>
                    ))}
                    {detail.observations.length > 14 && (
                      <div className="text-[9px] font-mono text-[var(--text-muted)]">… {detail.observations.length - 14} more observations</div>
                    )}
                  </div>
                </div>
              )}

              {detail.capacities.length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] font-mono tracking-widest text-[var(--text-muted)] font-bold mb-1">CAPACITY</div>
                  {detail.capacities.map(c => (
                    <div key={c.id} className="px-2 py-1 rounded bg-white/[0.03] border border-white/5 mb-1">
                      <div className="flex justify-between items-baseline">
                        <span className="text-[10px] font-mono text-[#E8E6E0]">{c.stage} capacity</span>
                        <span className="text-[11px] font-mono font-bold text-[#FF9500] tabular-nums">{c.value.toLocaleString()} <span className="text-[8px] text-[var(--text-muted)]">{c.unit}</span></span>
                      </div>
                      <ProvLine p={c.provenance} valueKind={c.valueKind} confidence={c.confidence} />
                    </div>
                  ))}
                </div>
              )}

              {(detail.flowsIn.length > 0 || detail.flowsOut.length > 0) && (
                <div className="mb-2">
                  <div className="text-[10px] font-mono tracking-widest text-[var(--text-muted)] font-bold mb-1">MATERIAL FLOWS</div>
                  {detail.flowsIn.map(f => (
                    <button key={f.id} onClick={() => onSelectEntity(f.fromEntityId)} className="w-full text-left px-2 py-1 rounded hover:bg-white/5 border-l-2 border-[#00E676]/60 mb-1">
                      <div className="text-[10px] font-mono text-[#E8E6E0]">← <span className="text-[#00E676]">{f.fromName}</span></div>
                      <div className="text-[9px] font-mono text-[var(--text-muted)]">{f.quantity.toLocaleString()} {f.unit} · {f.form} · {f.mode} · conf <span style={{ color: CONF_COLOR[f.confidence] }}>{f.confidence}</span></div>
                    </button>
                  ))}
                  {detail.flowsOut.map(f => (
                    <button key={f.id} onClick={() => onSelectEntity(f.toEntityId)} className="w-full text-left px-2 py-1 rounded hover:bg-white/5 border-l-2 border-[#00BCD4]/60 mb-1">
                      <div className="text-[10px] font-mono text-[#E8E6E0]">→ <span className="text-[#00BCD4]">{f.toName}</span></div>
                      <div className="text-[9px] font-mono text-[var(--text-muted)]">{f.quantity.toLocaleString()} {f.unit} · {f.form} · {f.mode} · conf <span style={{ color: CONF_COLOR[f.confidence] }}>{f.confidence}</span></div>
                    </button>
                  ))}
                </div>
              )}

              {(['upstream', 'downstream'] as const).map(dir => {
                const steps = detail[dir];
                if (steps.length === 0) return null;
                return (
                  <div className="mb-2" key={dir}>
                    <div className="text-[10px] font-mono tracking-widest text-[var(--text-muted)] font-bold mb-1">{dir.toUpperCase()} DEPENDENCIES</div>
                    <div className="space-y-0.5">
                      {steps.map(s => (
                        <button key={`${dir}-${s.id}`} onClick={() => onSelectEntity(s.id)}
                          className="w-full text-left px-2 py-0.5 rounded hover:bg-white/5 flex items-center gap-1.5"
                          style={{ paddingLeft: 8 + (s.depth - 1) * 12 }}>
                          <span className="text-[9px] font-mono text-[var(--text-muted)] tabular-nums">D{s.depth}</span>
                          <span className="text-[10px] font-mono text-[#E8E6E0] truncate">{s.name}</span>
                          <span className="text-[8px] font-mono text-[var(--text-muted)] ml-auto shrink-0">{s.kind}{s.viaKind === 'dependency' ? ' · dep' : ''}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          /* ── OVERVIEW ── */
          !analytics ? (
            <div className="text-[10px] font-mono text-[var(--text-muted)] py-4">
              {analyticsError ? 'ECONOMY STATE UNAVAILABLE — /api/economy failed.' : 'ASSEMBLING CANONICAL STATE…'}
            </div>
          ) : (
            <div>
              <Section id="concentration" open={!!openSections['concentration']} onToggle={toggle} title="CONCENTRATION (HHI)" icon={<Database className="w-3 h-3 text-[var(--gold-primary)]" />}>
                <div className="space-y-2">
                  {Object.entries(analytics.concentration).map(([key, block]) => (
                    <div key={key} className="px-2 py-1.5 rounded bg-white/[0.03] border border-white/5">
                      <button onClick={() => toggleEvidence(key)} className="w-full text-left">
                        <div className="flex justify-between items-baseline">
                          <span className="text-[9px] font-mono text-[var(--text-muted)] tracking-wider">{CONCENTRATION_LABELS[key] ?? key}</span>
                          <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: BAND_COLOR[block.result.band] }}>
                            {block.result.hhi} <span className="text-[8px] font-normal">{block.result.band.toUpperCase()}</span>
                          </span>
                        </div>
                        {/* Top-3 share strip */}
                        <div className="flex h-1.5 rounded overflow-hidden mt-1 bg-white/10">
                          {block.result.shares.slice(0, 3).map((s, i) => (
                            <span key={s.entityId} style={{ width: `${s.share * 100}%`, background: ['#D4AF37', '#00BCD4', '#7E57C2'][i] }} />
                          ))}
                        </div>
                        <div className="text-[8px] font-mono text-[var(--text-muted)] mt-0.5">
                          {block.result.shares.slice(0, 3).map(s => `${s.name} ${(s.share * 100).toFixed(0)}%`).join(' · ')}
                        </div>
                      </button>
                      {openEvidence[key] && (
                        <div className="mt-1 border-t border-white/5 pt-1">
                          {block.result.shares.slice(0, 8).map(s => (
                            <div key={s.entityId} className="flex justify-between text-[9px] font-mono text-[#E8E6E0]">
                              <span>{s.name}</span>
                              <span className="tabular-nums">{s.value.toLocaleString()} {block.result.unit} · {(s.share * 100).toFixed(1)}%</span>
                            </div>
                          ))}
                          <div className="text-[8px] font-mono text-[var(--text-muted)] mt-0.5">
                            evidence: {(block.inputs.observationIds ?? block.inputs.capacityIds ?? []).length} records · derived by OSIRIS analytics
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>

              <Section id="bottlenecks" open={!!openSections['bottlenecks']} onToggle={toggle} title="CANDIDATE BOTTLENECKS" icon={<AlertTriangle className="w-3 h-3 text-[#FF9500]" />} count={analytics.bottlenecks.result.length}>
                <div className="space-y-1">
                  {analytics.bottlenecks.result.slice(0, 8).map(b => (
                    <div key={b.entityId} className="px-2 py-1 rounded bg-white/[0.03] border border-white/5">
                      <button onClick={() => onSelectEntity(b.entityId)} className="w-full text-left">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-mono text-[#E8E6E0] truncate">{b.name}</span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <ScoreBar value={b.score} color={b.score > 0.6 ? '#FF3D3D' : b.score > 0.45 ? '#FF9500' : '#00BCD4'} />
                            <span className="text-[10px] font-mono font-bold tabular-nums" style={{ color: b.score > 0.6 ? '#FF3D3D' : b.score > 0.45 ? '#FF9500' : '#00BCD4' }}>{b.score.toFixed(2)}</span>
                          </span>
                        </div>
                        <div className="text-[8px] font-mono text-[var(--text-muted)]">{b.kind.toUpperCase()} · {b.explanation[0]}</div>
                      </button>
                    </div>
                  ))}
                  <div className="text-[8px] font-mono text-[var(--text-muted)] opacity-80">
                    Candidate scores — triage signals from flow, capacity and redundancy structure; not validated risk.
                  </div>
                </div>
              </Section>

              <Section id="anomalies" open={!!openSections['anomalies']} onToggle={toggle} title="ANOMALY SIGNALS" icon={<Activity className="w-3 h-3 text-[#FF3D3D]" />} count={analytics.anomalies.result.length}>
                <div className="space-y-1">
                  {analytics.anomalies.result.length === 0 ? (
                    <div className="text-[9px] font-mono text-[#00E676]">No series deviates from its trailing window.</div>
                  ) : analytics.anomalies.result.slice(0, 6).map((a, i) => (
                    <button key={`${a.entityId}-${a.kind}-${a.period}-${i}`} onClick={() => onSelectEntity(a.entityId)} className="w-full text-left px-2 py-1 rounded hover:bg-white/5 border-l-2 border-[#FF3D3D]/60">
                      <div className="text-[9px] font-mono text-[#FF3D3D] font-bold">{a.kind.toUpperCase()} · {a.metric} · {a.period}</div>
                      <div className="text-[9px] font-mono text-[#E8E6E0] leading-tight">{a.explanation}</div>
                    </button>
                  ))}
                </div>
              </Section>

              <Section id="events" open={!!openSections['events']} onToggle={toggle} title="EVENTS" count={analytics.events.length}>
                <div className="space-y-1">
                  {analytics.events.map(ev => (
                    <button key={ev.id} onClick={() => ev.entityId && onSelectEntity(ev.entityId)} className="w-full text-left px-2 py-1 rounded hover:bg-white/5 border-l-2" style={{ borderLeftColor: ev.severity === 'high' ? '#FF3D3D' : '#FF9500' }}>
                      <div className="text-[10px] font-mono text-[#E8E6E0]">{ev.title}</div>
                      <div className="text-[8px] font-mono text-[var(--text-muted)]">{ev.start}{ev.end ? ` → ${ev.end}` : ''} · {ev.type.toUpperCase()}</div>
                    </button>
                  ))}
                </div>
              </Section>

              <Section id="sources" open={!!openSections['sources']} onToggle={toggle} title="SOURCES" count={analytics.sources.length}>
                <div className="space-y-0.5">
                  {analytics.sources.map(s => (
                    <div key={s.sourceId} className="text-[9px] font-mono text-[var(--text-muted)]">
                      {s.sourceUrl ? <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[#00BCD4] hover:underline">{s.sourceName}</a> : s.sourceName}
                    </div>
                  ))}
                  <div className="text-[8px] font-mono text-[var(--text-muted)] opacity-80 mt-1">
                    Quantities are representative magnitudes assembled from public sources — every record carries valueKind, confidence and provenance. Nothing here is a live market feed.
                  </div>
                </div>
              </Section>
            </div>
          )
        )}
      </div>
    </motion.div>
  );
}
