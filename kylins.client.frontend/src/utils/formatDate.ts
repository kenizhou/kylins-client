// Locale-aware full date formatting for user-facing timestamps (e.g. the
// "On <date>, <sender> wrote:" attribution line in a reply quote). Extracted
// from data/demoMessages so non-demo code (the composer quote builder) doesn't
// depend on demo fixtures. demoMessages.formatMessageDate delegates here.

/** Format a Date as a short, locale-aware date (e.g. "Jan 1"). */
export function formatShortDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Return a human-friendly relative due date compared to `now`.
 *  `now` is passed explicitly so callers can snapshot it and keep renders pure. */
export function formatRelativeDueDate(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const taskDay = new Date(date);
  taskDay.setHours(0, 0, 0, 0);

  const diffDays = Math.round((taskDay.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  return formatShortDate(date);
}

/** Format an ISO date string as a full, locale-aware timestamp. */
export function formatFullDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
