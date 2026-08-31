import { describe, it, expect } from 'vitest';
import { buildTelemetryPosts, type TelemetryRequest } from './telemetryPayload';

/**
 * THE VISITOR'S ADDRESS NEVER REACHES A STORED FIELD (ledger phase 72).
 *
 * `src/middleware.ts` posted a second Umami event named `"Network Log"` whose
 * body carried `data: { IP: ip }`. Umami stores custom event properties
 * verbatim, so every page view accumulated a retained visitor-IP record — in
 * the one file that runs ahead of every route, and inside a codebase whose
 * miss log has a vocabulary gate specifically so query text about a person is
 * counted and discarded.
 *
 * It was in the scanned population of `collectionPolicySurface` the whole
 * time. The population was right; the markers named upstream OSINT hosts, and
 * an address going out in a JSON body matches none of them. So the check is
 * behavioural, as in `rdapProjection`: what does this actually emit?
 */

const REQ: TelemetryRequest = {
  url: '/lanes/tor-det',
  hostname: 'payload.example',
  referrer: 'https://payload.example/',
  userAgent: 'Mozilla/5.0 (test)',
  clientIp: '203.0.113.47',
  websiteId: 'site-abc',
  endpoint: 'http://umami:3000/api/send',
};

describe('the client address is a header argument, never a body field', () => {
  it('never puts the address in any body', () => {
    const posts = buildTelemetryPosts(REQ);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(post.body, 'the visitor address must not be serialised into a body')
        .not.toContain('203.0.113.47');
    }
  });

  /**
   * THE DISCRIMINATING HALF. If the address were simply absent everywhere, the
   * assertion above would hold for a payload that had dropped it entirely —
   * and the check would pass while the permitted use had been deleted too.
   * The address must still travel, as a header, or this proves nothing.
   */
  it('still forwards the address as a header, so the two uses are distinguishable', () => {
    const posts = buildTelemetryPosts(REQ);
    expect(posts[0].headers['x-forwarded-for']).toBe('203.0.113.47');
  });

  it('emits no custom event properties at all', () => {
    const body = JSON.parse(buildTelemetryPosts(REQ)[0].body);
    expect(body.payload.data, 'custom properties are where a retained address hid').toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/Network Log/);
  });
});

describe('it sends only what the server can actually observe', () => {
  /**
   * `screen: "1920x1080"` and `language: "en-US"` were sent on every request.
   * Middleware runs on the server and cannot observe either. They were not
   * defaults — they were measurements never taken, reported as though they
   * had been.
   */
  it('fabricates no measurement it could not have taken', () => {
    const body = JSON.parse(buildTelemetryPosts(REQ)[0].body);
    expect(body.payload.screen, 'the server cannot observe a screen size').toBeUndefined();
    expect(body.payload.language, 'the server cannot observe a language preference').toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('1920x1080');
  });

  it('sends the things it does know', () => {
    const body = JSON.parse(buildTelemetryPosts(REQ)[0].body);
    expect(body.payload.url).toBe('/lanes/tor-det');
    expect(body.payload.hostname).toBe('payload.example');
    expect(body.payload.website).toBe('site-abc');
  });
});

describe('unconfigured means silent, not defaulted', () => {
  /**
   * The old code fell back to a hard-coded site id, so any fork or second
   * deployment posted its traffic into one specific person's analytics
   * account — invisible from both ends.
   */
  it('emits nothing without a website id', () => {
    expect(buildTelemetryPosts({ ...REQ, websiteId: undefined })).toEqual([]);
    expect(buildTelemetryPosts({ ...REQ, websiteId: '' })).toEqual([]);
  });

  it('emits nothing without an endpoint', () => {
    expect(buildTelemetryPosts({ ...REQ, endpoint: undefined })).toEqual([]);
  });

  it('carries no hard-coded site id anywhere in its output', () => {
    const posts = buildTelemetryPosts({ ...REQ, websiteId: 'site-abc' });
    expect(JSON.stringify(posts)).not.toMatch(/cd8f216c/);
  });
});
