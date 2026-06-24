// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

/** Current time as a Unix timestamp in seconds. */
export function getCurrentUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
