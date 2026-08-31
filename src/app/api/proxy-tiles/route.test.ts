import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { registerBudget, resetSpendGovernor, spendReport } from '@/lib/economy/spendGovernor';

const TILE = 'https://a.basemaps.cartocdn.com/dark_all/6/34/22.png';
const req = (url: string | null, ip = '198.51.100.7') =>
  new NextRequest(
    `http://localhost/api/proxy-tiles${url === null ? '' : `?url=${encodeURIComponent(url)}`}`,
    { headers: { 'x-forwarded-for': ip } },
  );

const okTile = () => Promise.resolve(new Response(new ArrayBuffer(8), {
  status: 200, headers: { 'content-type': 'image/png' },
}));

const carto = {
  provider: 'carto-basemaps',
  unit: 'tiles' as const,
  cap: 2,
  periodMs: 60_000,
  basis: 'test budget',
};

let ipSeq = 0;
/** A fresh IP per test: the throttle is process-wide by design. */
const freshIp = () => `203.0.113.${(ipSeq += 1) % 250 + 1}`;

beforeEach(() => {
  resetSpendGovernor();
  vi.restoreAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the tile proxy refuses what it should before spending anything', () => {
  it('rejects a missing url without calling upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await GET(req(null, freshIp()));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a host outside the allowlist, including one that merely ends in the name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const bad of [
      'https://evil.com/tile.png',
      'https://notcartocdn.com/tile.png',      // endsWith('cartocdn.com') without the dot
      'https://cartocdn.com.evil.com/tile.png', // the name as a prefix of another host
    ]) {
      const res = await GET(req(bad, freshIp()));
      expect(res.status, bad).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed url rather than throwing a 500', async () => {
    const res = await GET(req('not a url', freshIp()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Malformed url parameter' });
  });
});

describe('the credit governor is actually on this path', () => {
  it('serves ungoverned when no budget is registered, and says so', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(okTile);
    const res = await GET(req(TILE, freshIp()));
    expect(res.status).toBe(200);
    // Ungoverned-by-decision and ungoverned-because-nobody-looked have to be
    // tellable apart from outside the process.
    expect(res.headers.get('X-Payload-Tile-Governance')).toBe('unbudgeted');
  });

  it('spends against the cap and then refuses, without calling upstream again', async () => {
    registerBudget(carto);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(okTile);

    expect((await GET(req(TILE, freshIp()))).status).toBe(200);
    expect((await GET(req(TILE, freshIp()))).status).toBe(200);
    expect(spendReport(Date.now())[0].committed).toBe(2);

    const over = await GET(req(TILE, freshIp()));
    expect(over.status).toBe(429);
    expect(over.headers.get('Retry-After')).toBe('3600');
    const body = await over.json();
    expect(body.reason).toBe('would_exceed_cap');
    expect(body.remedy).toContain('test budget'); // the cap's basis reaches the caller
    expect(fetchSpy).toHaveBeenCalledTimes(2); // the refused call never went out
  });

  it('gives the hold back when upstream fails — a failed call is not spend', async () => {
    registerBudget(carto);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 502 }));
    const res = await GET(req(TILE, freshIp()));
    expect(res.status).toBe(502);
    const rep = spendReport(Date.now())[0];
    expect(rep.committed).toBe(0);
    expect(rep.held).toBe(0); // released, not leaked
    expect(rep.openReservations).toBe(0);
  });

  it('gives the hold back when the fetch throws', async () => {
    registerBudget(carto);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req(TILE, freshIp()));
    expect(res.status).toBe(500);
    // The error the caller sees names nothing about the upstream.
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(spendReport(Date.now())[0].held).toBe(0);
  });
});

describe('the per-IP throttle', () => {
  it('cuts one caller off without spending budget on the refused requests', async () => {
    registerBudget({ ...carto, cap: 100_000 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(okTile);
    const ip = freshIp();

    let limited = 0;
    for (let i = 0; i < 300; i++) {
      const res = await GET(req(TILE, ip));
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    // Throttled requests cost nothing: the throttle runs before the reserve.
    expect(spendReport(Date.now())[0].committed).toBe(300 - limited);
  });
});
