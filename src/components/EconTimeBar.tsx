'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Play, Pause, Radio } from 'lucide-react';

/**
 * OSIRIS — Temporal playback scrubber for the physical-economy layers.
 *
 * Scrubs an evaluation date (month granularity) across the engine's event
 * horizon; the map refetches its projection at that date so disruption flags,
 * propagation and concentration are all evaluated as-of the scrub position.
 * "LIVE" clears the override and returns to present-day state.
 */

interface TimelineEvent {
  id: string;
  title: string;
  type: string;
  severity: string;
  start: string;
  end: string | null;
  entityName: string | null;
  disruptive: boolean;
}

interface EconTimeBarProps {
  asOf: string | null;
  onChange: (asOf: string | null) => void;
}

/** Exported for tests (vitest matches .test.ts only, so helpers are tested
 *  from EconTimeBar.test.ts like the sibling panels do). */
export function monthRange(min: string, max: string): string[] {
  const months: string[] = [];
  let [y, m] = min.split('-').map(Number);
  const [ey, em] = max.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

/** Evaluate at month-end so events starting mid-month register that month. */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(lastDay).padStart(2, '0')}`;
}

const SEV_COLOR: Record<string, string> = { high: '#FF3D3D', medium: '#FF9500', low: '#FFD700' };

export default function EconTimeBar({ asOf, onChange }: EconTimeBarProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [range, setRange] = useState<{ min: string; max: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  // Read by the playback interval without restarting it on every scrub.
  const asOfRef = useRef(asOf);
  useEffect(() => { asOfRef.current = asOf; }, [asOf]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/economy?commodity=copper&view=timeline', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) { setRange(d.range); setEvents(d.events); } })
      .catch(() => { /* timeline unavailable — bar stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  const months = useMemo(() => (range ? monthRange(range.min, range.max) : []), [range]);
  const currentIndex = useMemo(() => {
    if (!asOf) return months.length - 1;
    const ym = asOf.slice(0, 7);
    const i = months.indexOf(ym);
    return i >= 0 ? i : months.length - 1;
  }, [asOf, months]);
  const currentMonth = months[currentIndex] ?? null;

  const activeEvents = useMemo(() => {
    if (!currentMonth) return [];
    const evalDate = monthEnd(currentMonth);
    return events.filter(ev => ev.start <= evalDate && (!ev.end || ev.end >= evalDate.slice(0, 10)));
  }, [events, currentMonth]);

  // Playback: advance one month per tick; return to LIVE at the end.
  useEffect(() => {
    if (!playing || months.length < 2) return;
    const iv = setInterval(() => {
      const i = months.indexOf((asOfRef.current ?? '').slice(0, 7));
      const next = (i < 0 ? 0 : i) + 1;
      if (next >= months.length - 1) { setPlaying(false); onChange(null); return; }
      onChange(monthEnd(months[next]));
    }, 800);
    return () => clearInterval(iv);
  }, [playing, months, onChange]);

  if (!range || months.length < 2) return null;
  const live = asOf === null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      className="glass-panel pointer-events-auto border border-[#D4AF37]/25 px-3 py-2"
      style={{ background: 'rgba(212, 175, 55, 0.04)', width: 520, maxWidth: '90vw' }}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (playing) { setPlaying(false); return; }
            // Start from the beginning when pressing play from LIVE.
            if (live) onChange(monthEnd(months[0]));
            setPlaying(true);
          }}
          className="hover:bg-white/10 rounded p-1"
          title={playing ? 'Pause playback' : 'Play event timeline'}
          aria-label={playing ? 'Pause playback' : 'Play event timeline'}
        >
          {playing ? <Pause className="w-3.5 h-3.5 text-[var(--gold-primary)]" /> : <Play className="w-3.5 h-3.5 text-[var(--gold-primary)]" />}
        </button>

        <div className="relative flex-1 h-6 flex items-center">
          {/* Event markers along the track */}
          {events.map(ev => {
            const i = months.indexOf(ev.start.slice(0, 7));
            if (i < 0) return null;
            return (
              <span
                key={ev.id}
                title={`${ev.start} — ${ev.title}`}
                className="absolute w-[3px] rounded-full pointer-events-none"
                style={{
                  left: `${(i / (months.length - 1)) * 100}%`,
                  height: ev.severity === 'high' ? 14 : 9,
                  background: SEV_COLOR[ev.severity] ?? '#FF9500',
                  opacity: 0.9,
                }}
              />
            );
          })}
          <input
            type="range"
            min={0}
            max={months.length - 1}
            value={currentIndex}
            onChange={e => {
              setPlaying(false);
              const i = Number(e.target.value);
              onChange(i >= months.length - 1 ? null : monthEnd(months[i]));
            }}
            className="w-full econ-timebar-range"
            aria-label="Evaluation month"
          />
        </div>

        <button
          onClick={() => { setPlaying(false); onChange(null); }}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider ${live ? 'text-[#00E676] border border-[#00E676]/50' : 'text-[var(--text-muted)] border border-white/15 hover:bg-white/10'}`}
          title="Return to present-day state"
        >
          <Radio className="w-3 h-3" /> LIVE
        </button>
      </div>

      <div className="flex items-baseline justify-between mt-1 gap-2">
        <span className="text-[10px] font-mono font-bold tabular-nums" style={{ color: live ? '#00E676' : '#D4AF37' }}>
          {live ? 'PRESENT STATE' : currentMonth}
        </span>
        <span className="text-[9px] font-mono text-[var(--text-muted)] truncate">
          {activeEvents.length === 0
            ? 'no active events'
            : activeEvents.map(ev => ev.title).join(' · ')}
        </span>
      </div>
    </motion.div>
  );
}
