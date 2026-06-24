// Locale-aware full date formatting for user-facing timestamps (e.g. the
// "On <date>, <sender> wrote:" attribution line in a reply quote). Extracted
// from data/demoMessages so non-demo code (the composer quote builder) doesn't
// depend on demo fixtures. demoMessages.formatMessageDate delegates here.

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
