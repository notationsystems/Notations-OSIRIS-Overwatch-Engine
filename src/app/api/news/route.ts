import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * Payload — disruption signal from published news.
 *
 * A-1 retired the general-purpose feeds and kept two, this among them, on a
 * stated freight justification: DISRUPTION EVENTS. A closed port, a strike, a
 * corridor under fire are facts a broker prices against.
 *
 * WHAT THIS ROUTE USED TO DO, and why it no longer does (ledger phase 73). It
 * scraped four named Telegram channels through that platform's web-preview
 * endpoint — the one that renders posts to a client which is not a Telegram
 * client — under a desktop-Chrome User-Agent it does not have, with a comment
 * explaining the disguise: "a failsafe fallback ... if Telegram blocks the
 * IP". Two things were wrong with that beyond the disguise itself.
 *
 * The endpoint is described here rather than spelled, because the capability
 * marker that now forbids it is a literal and would match this paragraph. The
 * phase-68 remedy for that collision was a written exemption; the cheaper one,
 * where the prose does not need the token, is to not write the token.
 *
 * First, phase 46 recorded that Telegram post scraping "was advertised and
 * never built ... Nothing to delete." It was built, it was live, and it was
 * this file. The geoparsing the README advertised is `findCoords` below, and
 * the map plots its output.
 *
 * Second, the freight justification never needed it. Published RSS — BBC, Al
 * Jazeera, GDACS — carries disruption events, is what the route already fell
 * back to, and is fetched under this instrument's own name. The Telegram path
 * was the inheritance, not the capability.
 */

const FEEDS = {
  BBC: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  AlJazeera: 'https://www.aljazeera.com/xml/rss/all.xml',
  GDACS: 'https://www.gdacs.org/xml/rss.xml'
};

const RISK_KEYWORDS = ['war','missile','strike','attack','crisis','tension','military','conflict','defense','clash','nuclear','invasion','bomb','drone','weapon','sanctions','ceasefire','escalation', 'killed', 'destroyed', 'operation', 'casualty', 'frontline', 'threat'];

const KEYWORD_COORDS: Record<string, [number, number]> = {
  'ukraine': [49.487, 31.272], 'kyiv': [50.450, 30.523], 'russia': [61.524, 105.318],
  'moscow': [55.755, 37.617], 'israel': [31.046, 34.851], 'gaza': [31.416, 34.333],
  'iran': [32.427, 53.688], 'lebanon': [33.854, 35.862], 'syria': [34.802, 38.996],
  'yemen': [15.552, 48.516], 'china': [35.861, 104.195], 'taiwan': [23.697, 120.960],
  'united states': [38.907, -77.036], 'europe': [48.800, 2.300], 'middle east': [31.500, 34.800]
};

function scoreRisk(text: string): number {
  const lower = text.toLowerCase();
  let score = 1;
  for (const kw of RISK_KEYWORDS) {
    if (lower.includes(kw)) score += 2;
  }
  return Math.min(10, score);
}

function findCoords(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  for (const [keyword, coords] of Object.entries(KEYWORD_COORDS)) {
    if (lower.includes(keyword)) return coords;
  }
  return null;
}

function parseRSSItems(xml: string, sourceName: string): any[] {
  const items: any[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag: string) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return (m?.[1] || m?.[2] || '').trim();
    };

    const title = getTag('title').replace(/<[^>]+>/g, '');
    const desc = getTag('description').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    
    items.push({
      title: title.length > 100 ? title.substring(0, 100) + '...' : title,
      description: desc,
      link: getTag('link'),
      pubDate: getTag('pubDate') || new Date().toISOString(),
      source: sourceName
    });
  }
  return items;
}

export async function GET() {
  try {
    const feedPromises = Object.entries(FEEDS).map(async ([source, url]) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRSSItems(xml, source).slice(0, 8);
      } catch { return []; }
    });

    const feedResults = await Promise.allSettled(feedPromises);
    const allArticles: any[] = [];
    for (const result of feedResults) {
      if (result.status === 'fulfilled') allArticles.push(...result.value);
    }

    const newsItems = allArticles.map(article => {
      const riskScore = scoreRisk(article.description || article.title);
      const coords = findCoords(article.description || article.title);

      return {
        id: crypto.createHash('md5').update((article.link || '') + (article.pubDate || '')).digest('hex'),
        title: article.title,
        description: article.description,
        link: article.link,
        published: article.pubDate,
        source: article.source,
        risk_score: riskScore,
        coords: coords ? [coords[0], coords[1]] : null,
        coords_default: !coords,
        /**
         * Retained in the contract because `IntelFeed` renders it, and emitted
         * as null because there is no assessment to report. It used to carry
         * "AI Analysis indicates elevated tactical priority based on OSINT
         * stream patterns" whenever `risk_score >= 8` — a fixed sentence, from
         * no model, describing an analysis that never ran. Whether anything
         * should fill this field is a separate decision from whether a canned
         * string may pretend to.
         */
        machine_assessment: null,
      };
    });

    newsItems.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

    return NextResponse.json({
      news: newsItems,
      total: newsItems.length,
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    return NextResponse.json({ news: [], error: 'Failed to fetch disruption feed' }, { status: 500 });
  }
}
