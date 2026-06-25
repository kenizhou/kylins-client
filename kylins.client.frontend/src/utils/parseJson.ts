/** Parse a JSON string with a fallback value. Returns fallback on null, empty, or invalid JSON. */
export function parseJsonField<T>(json: string | null, fallback: T): T {
  if (!json || json === '[]' || json === '{}') return fallback;
  try {
    const parsed = JSON.parse(json) as T;
    return Array.isArray(fallback) && !Array.isArray(parsed) ? fallback : parsed;
  } catch {
    return fallback;
  }
}
