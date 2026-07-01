import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../../src/utils/relativeTime';

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000; // fixed epoch so assertions are deterministic

  it('returns "never" for null', () => {
    expect(formatRelativeTime(null, NOW)).toBe('never');
  });

  it('returns "just now" for < 60s', () => {
    expect(formatRelativeTime(NOW - 30, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 5, NOW)).toBe('just now');
  });

  it('returns minutes for < 1h', () => {
    expect(formatRelativeTime(NOW - 60, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 120, NOW)).toBe('2m ago');
    expect(formatRelativeTime(NOW - 3599, NOW)).toBe('59m ago');
  });

  it('returns hours for < 24h', () => {
    expect(formatRelativeTime(NOW - 3600, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 7200, NOW)).toBe('2h ago');
  });

  it('returns "yesterday" for 24–48h', () => {
    expect(formatRelativeTime(NOW - 86400, NOW)).toBe('yesterday');
    expect(formatRelativeTime(NOW - 100_000, NOW)).toBe('yesterday');
  });

  it('returns absolute date for >= 48h', () => {
    // 5 days ago -> "Jun 24" style (month + day). Don't over-assert; check shape.
    const out = formatRelativeTime(NOW - 5 * 86400, NOW);
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});
