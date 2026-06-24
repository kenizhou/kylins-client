// Composer-side HTML sanitizer for embedding an original (untrusted) message
// body into a reply/forward. Reuses the viewer policy — keeps hardened <style>
// for fidelity, blocks scripts/forms/dangerous URI schemes — but lives in its
// own seam so the composer can tighten or relax its policy later without
// touching the viewer.
//
// Decision (plan): reuse the viewer policy rather than inventing a composer
// allowlist. Mailspring keeps <form>/<button> in compose; we deliberately do
// NOT (the viewer FORBID set already excludes them) — safer default.

import { sanitizeForViewer } from '@/services/email/sanitizeForViewer';

/** Sanitize untrusted original-message HTML for embedding in a composed body. */
export function sanitizeForCompose(html: string): string {
  return sanitizeForViewer(html);
}
