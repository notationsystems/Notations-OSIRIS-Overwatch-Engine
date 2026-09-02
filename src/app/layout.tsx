import type { Metadata, Viewport } from "next";
import ErrorBoundary from '@/components/ErrorBoundary';
import "./globals.css";

const SITE_URL = "https://payload-terminal.app";
const SITE_NAME = "Payload Terminal";
const SITE_TITLE = "PayloadOS — Physical-Economy Information Operating System";
const SITE_DESCRIPTION = "A provenance-preserving physical-economy corpus and visual query system for facilities, materials, organizations and networks. Every answer carries evidence and knowledge time; an unanswerable question returns a typed refusal with a remedy rather than an invented result.";

export const viewport: Viewport = {
  themeColor: "#D4AF37",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  colorScheme: "dark",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: "%s | Payload Terminal",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    // What this instrument is for
    "physical economy data", "industrial intelligence", "facility intelligence",
    "materials intelligence", "supplier discovery", "physical economy knowledge graph",
    "freight operating system", "supply chain operating system", "physical commerce",
    "load management", "lane analytics", "carrier vetting", "freight brokerage software",
    "landed cost", "truck-legal routing", "transit time variance", "appointment slippage",
    "bill of lading reconciliation", "double brokering detection",

    // The discipline
    "data provenance", "knownAt", "as-known-then replay", "typed refusals",
    "measurement basis", "coverage annotation", "append-only ledger",
    "commodity intelligence", "GraphRAG", "evidence API", "supply chain concentration", "HHI concentration",

    // Brand
    "payload", "payload terminal",
  ],
  authors: [{ name: "Notation Systems", url: SITE_URL }],
  creator: "Notation Systems",
  publisher: "Notation Systems",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/android-chrome-192x192.png", type: "image/png", sizes: "192x192" },
      { url: "/android-chrome-512x512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180" },
    ],
    shortcut: "/favicon.ico",
    other: [
      {
        rel: "apple-touch-icon-precomposed",
        url: "/apple-touch-icon.png",
      },
    ],
  },
  manifest: "/site.webmanifest",
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    url: SITE_URL,
    images: [
      {
        url: `${SITE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: "PayloadOS physical-economy information operating system",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: "Query the physical economy through evidence-linked facilities, materials, organizations, networks and historical state.",
    images: [`${SITE_URL}/og-image.png`],
  },
  category: "technology",
  classification: "Logistics & Supply Chain",
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "apple-mobile-web-app-title": "Payload",
    "mobile-web-app-capable": "yes",
    "msapplication-TileColor": "#06060C",
    "msapplication-config": "none",
  },
};

// JSON-LD Structured Data
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_TITLE,
  alternateName: ["Payload", "PayloadOS", "Payload Earth", "Payload Terminal"],
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  browserRequirements: "Requires a modern web browser",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
  featureList: [
    "Immutable physical-economy corpus for organizations, facilities, materials, processes, networks and markets",
    "Evidence-linked facility discovery rendered as a visual query on Payload Earth",
    "Strict separation between the reusable global corpus and customer-private corpus scopes",
    "Temporal record revisions and as-known-then retrieval over a global linear sequence",
    "Computational APIs that return evidence-bearing answers or typed refusals",
    "Append-only freight book with supersession, never in-place edits",
    "Lane residuals by carrier, lane and season, with a minimum-trials floor",
    "Three-state carrier vetting — cleared, blocked, and undetermined",
    "Exception queue where the tender and the bill of lading disagree",
    "Landed cost that refuses rather than defaulting a missing component",
    "Truck-legal mileage, with legality derived from the profile supplied",
    "Facility resolution that surfaces suspected duplicates and never merges them",
    "Provenance on every claim: source, method, and knownAt",
    "As-known-then playback — what did we know when we priced it",
    "Typed refusals carrying remedies, as a work queue",
    "Coverage annotation travelling with every index",
    "Commodity concentration, flow centrality and candidate bottlenecks",
    "Divergence records where two sources disagree about one quantity",
    "Counterparty sanctions screening for organisations, vessels and aircraft",
  ],
  screenshot: `${SITE_URL}/og-image.png`,
  author: {
    "@type": "Organization",
    name: "Notation Systems",
    url: SITE_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="canonical" href={SITE_URL} />
        
        {/* JSON-LD Structured Data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />

      </head>
      <body className="antialiased">
        <ErrorBoundary name="Payload Terminal">
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}
