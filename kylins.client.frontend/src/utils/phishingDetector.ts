// Phishing heuristics for incoming mail. Ported in spirit from velo's
// phishingDetector (which carries ~10 rules) — this is a focused, high-value
// subset incl. the Mailspring from-domain≠reply-to-domain rule. The full velo
// rule set can be layered in later without changing the interface.

export type PhishingSeverity = 'low' | 'medium' | 'high';

export interface PhishingSignal {
  reason: string;
  severity: PhishingSeverity;
}

export interface PhishingContext {
  fromAddress: string | null;
  replyTo: string | null;
  fromName?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
}

export interface PhishingResult {
  /** Weighted score; >=8 means "likely phishing — warn". */
  score: number;
  signals: PhishingSignal[];
  isLikelyPhishing: boolean;
}

/** Extract the lowercase domain from an email address, or null. */
export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const match = address.match(/@([\w.-]+)/);
  const domain = match?.[1]?.toLowerCase();
  return domain ?? null;
}

const URGENT_WORDS =
  /(urgent|immediately|account.{0,12}(suspend|lock|disabled)|verify your|confirm your|password.{0,12}(expire|reset)|unauthorized|security alert|invoice.{0,8}overdue)/i;

const CREDENTIAL_WORDS =
  /(enter your password|confirm your password|provide your (ssn|social security)|credit card number|bank account number|login credentials)/i;

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'aol.com',
  'icloud.com',
  'protonmail.com',
  'proton.me',
]);

/** Parse distinct bare-link href hosts from the HTML body. */
function linkHosts(html: string | null | undefined): string[] {
  if (!html) return [];
  const hosts = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']https?:\/\/([^"'/\s]+)/gi)) {
    hosts.add(m[1]!.toLowerCase());
  }
  return [...hosts];
}

/**
 * Score an incoming message for phishing signals. `isLikelyPhishing` is true
 * when the weighted score crosses the warn threshold.
 */
export function detectPhishing(ctx: PhishingContext): PhishingResult {
  const signals: PhishingSignal[] = [];
  const fromDomain = domainOf(ctx.fromAddress);
  const replyToDomain = domainOf(ctx.replyTo);

  // 1. From domain ≠ reply-to domain (Mailspring reply-to redirection).
  if (fromDomain && replyToDomain && fromDomain !== replyToDomain) {
    signals.push({
      reason: `Reply-to (${replyToDomain}) differs from sender (${fromDomain})`,
      severity: 'high',
    });
  }

  // 2. Display name impersonates a different domain than the from address.
  if (ctx.fromName && fromDomain) {
    const nameDomain = domainOf(ctx.fromName);
    if (nameDomain && nameDomain !== fromDomain) {
      signals.push({
        reason: `Display name mentions ${nameDomain} but sender is ${fromDomain}`,
        severity: 'high',
      });
    }
  }

  // 3. Lookalike sender domain on a free-email provider impersonating a brand.
  if (fromDomain && FREE_EMAIL_PROVIDERS.has(fromDomain) && ctx.bodyHtml) {
    const brandHosts = linkHosts(ctx.bodyHtml).filter((h) => !h.endsWith(fromDomain));
    if (
      brandHosts.some(
        (h) =>
          h.includes('paypal') ||
          h.includes('apple') ||
          h.includes('microsoft') ||
          h.includes('amazon'),
      )
    ) {
      signals.push({
        reason: `Sender uses a free email provider (${fromDomain}) but links to a known brand`,
        severity: 'medium',
      });
    }
  }

  // 4. Urgency / alarm language in the subject.
  if (ctx.subject && URGENT_WORDS.test(ctx.subject)) {
    signals.push({ reason: 'Subject uses alarm / urgency language', severity: 'low' });
  }

  // 5. Body asks for credentials.
  if (ctx.bodyHtml && CREDENTIAL_WORDS.test(ctx.bodyHtml)) {
    signals.push({ reason: 'Message requests credentials or financial data', severity: 'high' });
  }

  const weights: Record<PhishingSeverity, number> = { low: 2, medium: 4, high: 6 };
  const score = signals.reduce((sum, s) => sum + weights[s.severity], 0);

  return { score, signals, isLikelyPhishing: score >= 8 };
}
