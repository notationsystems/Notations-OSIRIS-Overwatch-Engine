/**
 * Payload Terminal — deployment configuration seams (shipping order S-3).
 *
 * The rule: a missing REQUIRED configuration refuses loudly at startup
 * with the key named — never a silent degrade. A source that quietly
 * serves snapshot because a credential is absent is the fresh-but-wrong
 * failure at the configuration layer: the degradation ladder exists for
 * the NETWORK failing, not for the operator forgetting a key.
 *
 * Current seams (every one optional today — no built source requires a
 * credential; the validation is the socket the first credentialed source
 * plugs into):
 *
 *   SEA_DOG_EDGAR_ENABLED=1     enables the EDGAR document-tier adapter
 *                               (unbuilt; operator-blocked on identity).
 *                               When set, BOTH identity parts are REQUIRED:
 *   SEA_DOG_SEC_UA_ORG          organization name for the SEC User-Agent
 *   SEA_DOG_SEC_UA_CONTACT      role email the firm controls
 *                               → UA: "SeaDogTerminal/<ver> <org> <contact>"
 *
 *   SEA_DOG_MISS_LOG_DIR        where search-misses.jsonl accumulates
 *                               (default: <cwd>/data-archive)
 *   PAYLOAD_DISABLE_LIVE=1      force every source to its snapshot rung
 *                               (visible in provenance notes, never silent)
 */

export interface ConfigCheck {
  ok: boolean;
  /** Missing required keys, each with why it is required. */
  missing: Array<{ key: string; reason: string }>;
}

export function checkRequiredConfig(env: Record<string, string | undefined> = process.env): ConfigCheck {
  const missing: ConfigCheck['missing'] = [];
  if (env.SEA_DOG_EDGAR_ENABLED === '1') {
    if (!env.SEA_DOG_SEC_UA_ORG) {
      missing.push({ key: 'SEA_DOG_SEC_UA_ORG', reason: 'EDGAR document tier is enabled; the SEC requires a declared organization identity and the instrument must not fabricate one.' });
    }
    if (!env.SEA_DOG_SEC_UA_CONTACT) {
      missing.push({ key: 'SEA_DOG_SEC_UA_CONTACT', reason: 'EDGAR document tier is enabled; the SEC requires a contact email (a role address the firm controls).' });
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Startup gate — throws with every missing key named. Called from the
 *  Next.js instrumentation hook so a misconfigured deploy dies at boot,
 *  not at first request. */
export function assertRequiredConfig(env: Record<string, string | undefined> = process.env): void {
  const check = checkRequiredConfig(env);
  if (!check.ok) {
    throw new Error(
      'Payload Terminal refuses to start — required configuration missing:\n'
      + check.missing.map(m => `  ${m.key}: ${m.reason}`).join('\n'),
    );
  }
}
