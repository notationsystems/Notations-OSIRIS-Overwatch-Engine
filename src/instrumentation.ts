/**
 * Next.js instrumentation hook — runs once at server start.
 *
 * The configuration gate lives here so a misconfigured deployment refuses
 * at boot with the missing key named (shipping order S-3), instead of
 * degrading silently at first request.
 */
export async function register() {
  const { assertRequiredConfig } = await import('@/lib/economy/config');
  assertRequiredConfig();
}
