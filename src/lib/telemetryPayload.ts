/**
 * Payload — what the instrument may send about the person visiting it.
 *
 * WHY THIS IS A MODULE (ledger phase 72). `src/middleware.ts` runs on every
 * page request. It sent Umami two events: a pageview, and a second one named
 * `"Network Log"` carrying `data: { IP: ip }` — the visitor's raw address, in
 * the event BODY.
 *
 * The distinction that makes one of those acceptable and the other not is
 * narrow enough to be worth writing down, because it is invisible at a glance:
 *
 *   - `x-forwarded-for` is the documented way to give a self-hosted Umami the
 *     real client address from behind a proxy. Umami salts and hashes it into
 *     a rotating visitor id and derives a country, and does NOT retain the
 *     address. The IP is used and discarded.
 *   - `data: {}` is CUSTOM EVENT PROPERTIES. Umami stores those verbatim and
 *     renders them back. An address placed there is retained, per visitor,
 *     for as long as the analytics database exists.
 *
 * So the same value, two lines apart, was both used-and-discarded and
 * retained — and the retaining one was given a name that reads like
 * infrastructure telemetry. A firm about to hold carrier, driver and customer
 * records was accumulating a visitor-IP log as a side effect of counting page
 * views.
 *
 * The rule is therefore structural rather than remembered: the client address
 * is a HEADER argument here and is never part of a body. A test asserts that
 * of the OUTPUT, because asking whether the file mentions an IP cannot
 * distinguish the permitted use from the forbidden one — the same reason
 * `rdapProjection` exists one phase earlier.
 *
 * AND SEND ONLY WHAT THE SERVER ACTUALLY KNOWS. The old payload declared
 * `screen: "1920x1080"` and `language: "en-US"` on every request. Middleware
 * cannot observe either. They are not defaults, they are measurements that
 * were never taken, reported as if they had been — which is the one thing
 * this codebase refuses everywhere else.
 */

export interface TelemetryRequest {
  /** Path being requested. Known. */
  readonly url: string;
  /** Host serving it. Known. */
  readonly hostname: string;
  /** Referrer header, or empty. Known. */
  readonly referrer: string;
  /** The visitor's user agent, forwarded as a header. */
  readonly userAgent: string;
  /** The visitor's address. HEADER ONLY — never a body field. */
  readonly clientIp: string;
  /** Umami site id. Absent means telemetry is not configured. */
  readonly websiteId?: string;
  /** Umami collector. Absent means telemetry is not configured. */
  readonly endpoint?: string;
}

export interface TelemetryPost {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialised body. The client address never appears in here. */
  readonly body: string;
}

/**
 * Build the posts middleware should make, or none at all.
 *
 * RETURNS EMPTY WHEN UNCONFIGURED, and that is a decision rather than
 * defensiveness. The previous version fell back to a hard-coded site id, so
 * any fork or second deployment silently posted its traffic into one specific
 * person's analytics account — a default that cannot be noticed from the
 * outside by either party.
 */
export function buildTelemetryPosts(req: TelemetryRequest): TelemetryPost[] {
  if (!req.websiteId || !req.endpoint) return [];

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': req.userAgent,
    // Used to derive a hashed visitor id and a country, then discarded by the
    // collector. This is the ONLY place the address may travel.
    'x-forwarded-for': req.clientIp,
  };

  const payload = {
    website: req.websiteId,
    hostname: req.hostname,
    url: req.url,
    referrer: req.referrer,
  };

  return [{
    endpoint: req.endpoint,
    headers,
    body: JSON.stringify({ payload, type: 'event' }),
  }];
}
