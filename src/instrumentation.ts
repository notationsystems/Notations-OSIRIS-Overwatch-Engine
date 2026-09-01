/**
 * Next.js instrumentation hook — runs once at server start.
 *
 * Two things happen here, in order, and both are deliberate:
 *
 * 1. The configuration gate (shipping order S-3): a misconfigured
 *    deployment refuses at boot with the missing key NAMED, instead of
 *    degrading silently at first request. This throws — a refused boot
 *    must not proceed to warm state it has no business serving.
 * 2. State warming (deployment order D-2): the canonical state is
 *    assembled at STARTUP rather than lazily on the first request, so a
 *    researcher's first click does not pay for the whole assembly with
 *    no indication anything is happening.
 *
 *    Warming is FIRED, NOT AWAITED. Measured in the running
 *    configuration: once D-10's per-host limiter serialises both
 *    commodities against comtradeapi.un.org, the copper assembly runs
 *    past thirty seconds — and blocking startup on it would hold the
 *    port closed while the instrument looks dead, which is the exact
 *    "researcher assumes it is broken" failure this item exists to
 *    prevent, moved earlier. So the server serves immediately; a request
 *    arriving mid-warm JOINS the in-flight assembly (the store memoises
 *    the promise) rather than starting a second one, and /api/health
 *    reports warming honestly while it runs. NEVER fatal: a source that
 *    will not answer brings the instance up degraded and saying so.
 */
export async function register() {
  // Next.js invokes this hook in both runtimes. Keep all filesystem,
  // database, and Node OpenTelemetry dependencies out of the Edge graph.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeRuntime } = await import('./instrumentation.node');
    await registerNodeRuntime();
  }
}
