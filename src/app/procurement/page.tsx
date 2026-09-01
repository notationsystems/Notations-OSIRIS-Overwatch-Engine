import type { Metadata } from 'next';
import ProcurementDesk from '@/components/ProcurementDesk';

export const metadata: Metadata = {
  title: 'PayloadOS Procurement & Positions',
  description: 'Evidence-led supplier qualification, purchasing, physical positions, logistics, receipt, and landed-cost settlement.',
  robots: { index: false, follow: false },
};

export default function ProcurementPage() { return <ProcurementDesk />; }
