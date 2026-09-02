import type { Metadata } from 'next';
import DocsClient from './DocsClient';
import { ENDPOINT_COUNT } from './apiCatalog';

export const metadata: Metadata = {
  title: 'Documentation & API Reference',
  description: `Official PayloadOS documentation — physical-economy corpus, visual queries, self-hosting, and the complete API reference for all ${ENDPOINT_COUNT} public and authenticated endpoints.`,
  alternates: { canonical: '/docs' },
  openGraph: {
    title: 'Payload — Documentation & API Reference',
    description: `Physical-economy corpus, self-hosting guide, and the complete API reference for all ${ENDPOINT_COUNT} PayloadOS endpoints.`,
    url: '/docs',
    type: 'article',
  },
};

export default function DocsPage() {
  return <DocsClient />;
}
