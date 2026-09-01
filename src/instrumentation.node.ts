/** Node-only startup boundary. Imported conditionally by instrumentation.ts. */
export async function registerNodeRuntime() {
  const { assertRequiredConfig } = await import('@/lib/economy/config');
  assertRequiredConfig();

  const { runBoot } = await import('@/lib/economy/boot');
  console.log('[payload-terminal] serving; warming state in the background (/api/health → seaDogTerminal.boot)');
  void runBoot().then(report => {
    // stdout at boot is the one place an operator looks first; the health
    // endpoint carries the same report for everything after that.
    console.log(`[payload-terminal] boot ${report.status} in ${report.ms}ms — ` +
      report.commodities.map(c => `${c.commodity}:${c.status}`).join(' ') +
      ` archive:${report.archive?.status ?? 'unknown'}`);
    for (const c of report.commodities) {
      for (const issue of c.issues) console.warn(`[payload-terminal] boot degradation (${c.commodity}): ${issue}`);
    }
    if (report.archive && report.archive.status !== 'writable') {
      console.warn(`[payload-terminal] boot degradation (archive): ${report.archive.detail}`);
    }
  }).catch(e => {
    // runBoot never throws by design; if it somehow does, the instance is
    // still serving and the failure must not be silent.
    console.error('[payload-terminal] boot reporting failed (instance still serving):', e);
  });
}
