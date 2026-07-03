// Pure relative-time formatter used by the StatusBar ("just now", "2m ago", …).
// No external dep — date-fns/chrono are overkill for 5 buckets.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a Unix timestamp (seconds) as a short relative string for display in
 * the status bar / tray tooltip. Five buckets:
 *   - null / undefined          -> "never"
 *   - < 60s (incl. future/clock-skew) -> "just now"
 *   - < 1h                      -> "{n}m ago"
 *   - < 24h                     -> "{n}h ago"
 *   - 24h..48h                  -> "yesterday"
 *   - >= 48h                    -> "Mon D" absolute (e.g. "Jun 24")
 *
 * `now` is injectable for deterministic tests; in production it defaults to the
 * current wall-clock time. Pure: no side effects, no I/O.
 */
export function formatRelativeTime(
  unixSeconds: number | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (unixSeconds == null) return 'never';
  const delta = now - unixSeconds;
  if (delta < 60) return 'just now'; // also covers clock skew / future timestamps
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 172800) return 'yesterday'; // < 48h
  const d = new Date(unixSeconds * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
