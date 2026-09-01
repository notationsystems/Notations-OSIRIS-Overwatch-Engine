import type { Metadata } from 'next';
import CommercialDesk from '@/components/CommercialDesk';

export const metadata: Metadata = {
  title: 'PayloadOS Commercial Book',
  description: 'Inventory lots, customer commitments, allocations, sales contracts, fulfillment, and margin exposure.',
  robots: { index: false, follow: false },
};

export default function CommercialPage() { return <CommercialDesk />; }
