import { NextResponse } from 'next/server';
import { safeFetch, isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { matchExact, PERSON_SCHEMAS, type SanctionEntry } from '@/lib/sanctions';
import { projectRdapEntities, type ScreeningCandidate } from '@/lib/rdapProjection';

/**
 * Payload — WHOIS / domain intelligence via RDAP (free, standardised).
 * Cross-checks any registrant / org names returned by RDAP against the
 * OFAC SDN list so a sanctioned registrant surfaces alongside the WHOIS
 * metadata (still keyless — the SDN snapshot is sourced from the open
 * OpenSanctions mirror).
 *
 * CONSTRAINT — ORGANISATIONAL INFRASTRUCTURE ATTRIBUTION ONLY.
 * The subject is a DOMAIN and the organisation that registered it. This
 * route exists to attribute infrastructure to the organisation that
 * operates it — is this carrier's mail domain really this carrier's — and
 * to no other purpose. It must never be used to profile, locate or
 * identify a natural person, and no output of it may be joined to a
 * person record.
 *
 * WHOIS carries the sharpest edge of the conditional category, because a
 * domain registered by an individual has a natural person in the
 * registrant field. RDAP redacts most of it; where a registry does not,
 * the redaction is the registry's choice and not this route's licence to
 * use what comes back. Registrant contact details are passed through for
 * ORGANISATIONAL attribution and OFAC screening only.
 *
 * The constraint is stated here because the collection policy classifies
 * this category as CONDITIONAL: permitted only with the condition written
 * down. A conditional permission with the condition left implicit is an
 * unconditional permission.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get('domain');
  if (!domain) return NextResponse.json({ error: 'Missing domain parameter' }, { status: 400 });

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 20, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
  }

  try {
    const results: any = { domain, timestamp: new Date().toISOString() };

    /**
     * Values screened against the SDN but NEVER returned as themselves. The
     * condition permits USING a registrant name for OFAC screening; it does
     * not permit handing it back. Keeping them in a local rather than on
     * `results` is what makes that structural instead of remembered.
     */
    const screening: ScreeningCandidate[] = [];

    // RDAP (Registration Data Access Protocol) — successor to WHOIS
    try {
      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        // The person-handling lives in `rdapProjection` so it can be exercised
        // against a planted individual registrant. See its header: a rule
        // enforced by reading this file could only ask whether `fn` is
        // TOUCHED, and screening requires touching it.
        const projected = projectRdapEntities(data.entities);
        screening.push(...projected.screening);
        results.rdap = {
          handle: data.handle,
          name: data.ldhName,
          status: data.status,
          events: (data.events || []).map((e: any) => ({
            action: e.eventAction,
            date: e.eventDate,
          })),
          nameservers: (data.nameservers || []).map((ns: any) => ns.ldhName),
          entities: projected.entities,
        };

        // Extract key dates
        const events = results.rdap.events || [];
        results.registration = events.find((e: any) => e.action === 'registration')?.date;
        results.expiration = events.find((e: any) => e.action === 'expiration')?.date;
        results.last_changed = events.find((e: any) => e.action === 'last changed')?.date;
      }
    } catch (e) { console.warn('[Payload Terminal] Suppressed error:', e instanceof Error ? e.message : e); }

    // HTTP headers for tech fingerprinting — go through safeFetch so the
    // attacker can't aim a HEAD request at internal infrastructure with a
    // hostname that resolves to a reserved range, or chain a redirect from a
    // public host to one. Redirects are followed manually with re-validation.
    try {
      const res = await safeFetch(`https://${domain}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        maxRedirects: 3,
      });
      const headers: Record<string, string> = {};
      ['server', 'x-powered-by', 'x-frame-options', 'strict-transport-security',
       'content-security-policy', 'x-content-type-options', 'x-xss-protection',
       'referrer-policy', 'permissions-policy'].forEach(h => {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      });
      results.http = {
        status: res.status,
        headers,
        redirected: res.redirected,
        final_url: res.url,
      };

      // Security score
      let score = 0;
      if (headers['strict-transport-security']) score += 2;
      if (headers['content-security-policy']) score += 2;
      if (headers['x-frame-options']) score += 1;
      if (headers['x-content-type-options']) score += 1;
      if (headers['referrer-policy']) score += 1;
      results.security_score = { score, max: 7, grade: score >= 5 ? 'A' : score >= 3 ? 'B' : score >= 1 ? 'C' : 'F' };
    } catch (e) { console.warn('[Payload Terminal] Suppressed error:', e instanceof Error ? e.message : e); }

    /**
     * OFAC SDN cross-check. Screening a registrant name is a use the condition
     * ALLOWS — the route exists partly to surface a sanctioned registrant —
     * and returning that name is a use it forbids. Those come apart here.
     *
     * A designated PERSON is filtered out of the entries, the same filter
     * `osint/sanctions` applies to its own results and now from the same
     * definition. What survives is by construction a designated NON-natural
     * person, so echoing the value that matched it names an organisation
     * rather than an individual — which is why `matched_value` can be
     * returned for a surviving hit and never for a suppressed one.
     *
     * The suppressed count is reported rather than dropped. A caller who sees
     * no hits is entitled to know whether that means nothing matched or
     * something matched and was withheld: those are different answers.
     */
    try {
      const seen = new Set<string>();
      const hits: Array<{ matched_value: string; matched_from: string; entries: SanctionEntry[] }> = [];
      let withheldPersonClass = 0;
      for (const { value, source } of screening) {
        if (seen.has(value)) continue;
        seen.add(value);
        const entries = await matchExact(value);
        if (!entries.length) continue;
        const servable = entries.filter((m) => !PERSON_SCHEMAS.has(m.schema));
        withheldPersonClass += entries.length - servable.length;
        if (servable.length) hits.push({ matched_value: value, matched_from: source, entries: servable });
      }
      results.sanctions_match = hits.length || withheldPersonClass
        ? { source: 'OFAC SDN', hits, withheld_person_class: withheldPersonClass }
        : null;
    } catch (e) { console.warn('[Payload Terminal] Sanctions cross-check failed:', e instanceof Error ? e.message : e); }

    return NextResponse.json(results);
  } catch {
    return NextResponse.json({ error: 'WHOIS lookup failed' }, { status: 500 });
  }
}
