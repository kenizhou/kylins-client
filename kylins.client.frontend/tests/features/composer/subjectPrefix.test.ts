import { describe, it, expect } from 'vitest';
import { subjectWithPrefix } from '@/features/composer/subjectPrefix';

describe('subjectWithPrefix', () => {
  it('adds a prefix when absent', () => {
    expect(subjectWithPrefix('Hello', 'Re:')).toBe('Re: Hello');
  });
  it('does not double an existing prefix', () => {
    expect(subjectWithPrefix('Re: Hello', 'Re:')).toBe('Re: Hello');
  });
  it('collapses repeated prefixes', () => {
    expect(subjectWithPrefix('Re: Re: Re: Hi', 'Re:')).toBe('Re: Hi');
  });
  it('switches Fwd to Re', () => {
    expect(subjectWithPrefix('Fwd: Hello', 'Re:')).toBe('Re: Hello');
  });
  it('is case-insensitive', () => {
    expect(subjectWithPrefix('RE: hello', 'Re:')).toBe('Re: hello');
  });
  it('handles the Fw variant', () => {
    expect(subjectWithPrefix('Fw: Hello', 'Fwd:')).toBe('Fwd: Hello');
  });
  it('handles an empty subject', () => {
    expect(subjectWithPrefix('', 'Fwd:')).toBe('Fwd: ');
  });
});
