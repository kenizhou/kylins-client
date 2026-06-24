import { describe, it, expect } from 'vitest';
import { formatFullDate } from '@/utils/formatDate';

describe('formatFullDate', () => {
  it('returns a non-empty localized string for a valid ISO date', () => {
    const out = formatFullDate('2026-06-24T09:30:00Z');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
