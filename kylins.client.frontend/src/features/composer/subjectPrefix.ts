// Subject-line prefix normalization for replies/forwards. Ports Mailspring's
// app/src/flux/models/utils.ts::subjectWithPrefix, hardened to strip ALL leading
// Re:/Fwd:/Fw: sequences (Mailspring strips only one), so we never emit
// "Re: Re: Re: …".

const LEADING_PREFIX_RE = /^(?:\s*(?:re|fwd|fw):\s*)+/i;

/**
 * Strip any leading `Re:`/`Fwd:`/`Fw:` (case-insensitive, possibly repeated)
 * from `subject`, then prepend a single `prefix`. Examples:
 *   ("Hello", "Re:")   -> "Re: Hello"
 *   ("Re: Re: Hi", "Re:") -> "Re: Hi"
 *   ("Fwd: Hi", "Re:") -> "Re: Hi"
 */
export function subjectWithPrefix(subject: string, prefix: 'Re:' | 'Fwd:'): string {
  const stripped = subject.replace(LEADING_PREFIX_RE, '').trim();
  return `${prefix} ${stripped}`;
}
