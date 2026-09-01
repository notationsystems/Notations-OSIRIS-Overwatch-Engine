import { NextResponse } from 'next/server';

/**
 * Payload — MAC address OUI lookup — the vendor that registered the prefix.
 *
 * CONSTRAINT — ORGANISATIONAL INFRASTRUCTURE ATTRIBUTION ONLY.
 * The subject is a hardware vendor prefix, never a device's owner. This route exists to attribute infrastructure to the
 * ORGANISATION that operates it — a carrier's mail domain, a terminal's
 * network, a broker's hosting — and to no other purpose. It must never be
 * used to profile, locate, enumerate or identify a natural person, and no
 * output of it may be joined to a person record.
 *
 * The constraint is stated here because the collection policy classifies
 * this category as CONDITIONAL: permitted only with the condition written
 * down. A conditional permission with the condition left implicit is an
 * unconditional permission.
 */

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mac = searchParams.get('mac');

  if (!mac) {
    return NextResponse.json({ error: 'Missing MAC parameter' }, { status: 400 });
  }

  // Clean the MAC address format to allow varied inputs
  const cleanMac = mac.trim().toUpperCase().replace(/[^A-F0-9:-]/g, '');

  try {
    const res = await fetch(`https://api.maclookup.app/v2/macs/${encodeURIComponent(cleanMac)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      throw new Error(`MAC Lookup API HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data && data.found) {
      return NextResponse.json({
        mac: cleanMac,
        vendor: data.company || 'Unknown',
        address: data.address || '',
        prefix: data.macPrefix || cleanMac.slice(0, 8)
      });
    } else {
      return NextResponse.json({ mac: cleanMac, vendor: 'Not Found' });
    }
  } catch (error: any) {
    return NextResponse.json({ error: 'MAC lookup failed', detail: error.message }, { status: 502 });
  }
}
