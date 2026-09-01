import type { Metadata } from 'next';
import OperationsControlTower from '@/components/OperationsControlTower';

export const metadata: Metadata = {
  title: 'Operations Control Tower',
  description: 'Exception-first load execution, carrier communication, tracking, and settlement for the Payload brokerage desk.',
  robots: { index: false, follow: false },
};

export default function OperationsPage() {
  return <OperationsControlTower />;
}
