/**
 * Payload — the environment-variable rename, with a landing strip.
 *
 * The fork shipped under the name OSIRIS, an OSINT platform's name, and
 * the name asserts a purpose this application no longer has. Renaming the
 * variables is therefore not cosmetic. But a rename that takes effect the
 * moment it lands breaks every running deployment silently — the variable
 * is simply unset, the feature it gated turns off, and nothing says why.
 *
 * So: the new name wins, the OLD NAME IS STILL ACCEPTED FOR ONE RELEASE,
 * and using the old name WARNS on the way through. An operator who reads
 * no release note still gets a working deployment and a line telling them
 * what to change. The deprecation is a state with an end, not a
 * permanent second spelling — `LEGACY_ENV_REMOVED_AFTER` names the
 * release that drops it, and the test asserts the map empties then.
 */

/** The release in which the legacy names stop being read. */
export const LEGACY_ENV_REMOVED_AFTER = 'v0.2.0';

/** New name → the legacy name still honoured for one release. */
export const LEGACY_ENV_NAMES: Readonly<Record<string, string>> = {
  PAYLOAD_DISABLE_LIVE: 'OSIRIS_DISABLE_LIVE',
  PAYLOAD_PORT: 'OSIRIS_PORT',
  PAYLOAD_TELEGRAM_CHANNELS: 'OSIRIS_TELEGRAM_CHANNELS',
};

const warned = new Set<string>();

export interface EnvRead {
  value: string | undefined;
  /** Which spelling supplied the value; null when neither is set. */
  suppliedBy: 'current' | 'legacy' | null;
}

/**
 * Read an environment variable by its CURRENT name, falling back to the
 * legacy spelling. The current name wins when both are set: an operator
 * mid-migration has the new one right, and silently preferring the old
 * one would make the migration untestable.
 */
export function readEnvWithLegacy(
  name: string,
  env: Record<string, string | undefined> = process.env,
  onWarn: (message: string) => void = (m) => console.warn(m),
): EnvRead {
  const current = env[name];
  if (current !== undefined && current !== '') return { value: current, suppliedBy: 'current' };

  const legacyName = LEGACY_ENV_NAMES[name];
  if (!legacyName) return { value: current, suppliedBy: current === undefined ? null : 'current' };

  const legacy = env[legacyName];
  if (legacy === undefined || legacy === '') return { value: current, suppliedBy: null };

  if (!warned.has(legacyName)) {
    warned.add(legacyName);
    onWarn(
      `[payload] ${legacyName} is deprecated and will stop being read after ` +
        `${LEGACY_ENV_REMOVED_AFTER}. Rename it to ${name}. It is honoured for now so a ` +
        `running deployment does not break on the rename.`,
    );
  }
  return { value: legacy, suppliedBy: 'legacy' };
}

/** Test seam: forget which names have already warned. */
export function resetLegacyEnvWarnings(): void {
  warned.clear();
}
