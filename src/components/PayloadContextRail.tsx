'use client';

import { ChevronRight, CircleAlert, Database, FileCheck2, MapPin, Truck } from 'lucide-react';

export interface PayloadContextItem {
  id: string;
  label: string;
  value?: string;
  meta?: string;
  status?: 'neutral' | 'good' | 'warning' | 'critical';
}

interface Props {
  title: string;
  eyebrow?: string;
  items: PayloadContextItem[];
  onSelect?: (item: PayloadContextItem) => void;
  onClose?: () => void;
}

const statusClass = {
  neutral: 'text-white/45',
  good: 'text-[var(--alert-green)]',
  warning: 'text-[var(--alert-orange)]',
  critical: 'text-[var(--alert-red)]',
};

export default function PayloadContextRail({ title, eyebrow = 'CONTEXT', items, onSelect, onClose }: Props) {
  return (
    <aside className="w-[min(88vw,360px)] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080A10]/94 backdrop-blur-2xl shadow-[0_16px_60px_rgba(0,0,0,0.55)]">
      <header className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <div>
          <div className="text-[8px] font-mono tracking-[0.22em] text-[var(--cyan-primary)]">{eyebrow}</div>
          <h2 className="mt-1 text-sm font-semibold tracking-tight text-[var(--text-heading)]">{title}</h2>
        </div>
        {onClose && (
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-[10px] font-mono text-white/30 hover:bg-white/[0.05] hover:text-white/70">ESC</button>
        )}
      </header>

      <div className="styled-scrollbar max-h-[55vh] overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-[10px] font-mono uppercase tracking-[0.16em] text-white/25">No observations</div>
        ) : items.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect?.(item)}
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-white/[0.035]"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-black/20 text-white/35 group-hover:border-[var(--border-active)] group-hover:text-[var(--gold-primary)]">
              {item.id.includes('load') ? <Truck className="h-3.5 w-3.5" /> : item.id.includes('port') ? <MapPin className="h-3.5 w-3.5" /> : item.id.includes('evidence') ? <FileCheck2 className="h-3.5 w-3.5" /> : item.id.includes('exception') ? <CircleAlert className="h-3.5 w-3.5" /> : <Database className="h-3.5 w-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10px] font-mono uppercase tracking-[0.1em] text-white/65">{item.label}</span>
              {item.value && <span className={`mt-0.5 block truncate text-[11px] font-mono tabular-nums ${statusClass[item.status ?? 'neutral']}`}>{item.value}</span>}
              {item.meta && <span className="mt-1 block truncate text-[8px] font-mono uppercase tracking-[0.12em] text-white/20">{item.meta}</span>}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/15 transition group-hover:translate-x-0.5 group-hover:text-[var(--gold-primary)]" />
          </button>
        ))}
      </div>
    </aside>
  );
}
