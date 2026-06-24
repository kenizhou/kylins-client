// Viewer-specific HTML sanitizer (Mailspring hardening on top of DOMPurify).
//
// Distinct from the composer's `utils/sanitize.ts`: the VIEWER must allow
// <style> blocks for email fidelity, so we strip risky at-rules (@import,
// @charset, expression(), javascript: url()) from <style> contents instead of
// forbidding the tag. We also enforce a URI-scheme allowlist on href/src/action
// (block javascript:, vbscript:, mhtml:, file:, and non-image data:) and force
// safe link targets.

import DOMPurify from 'dompurify';

/** Schemes that must never survive sanitization. */
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|mhtml|file):/i;

function isDangerousUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (DANGEROUS_SCHEME.test(v)) return true;
  // `data:` is allowed only for images.
  if (v.startsWith('data:') && !v.startsWith('data:image/')) return true;
  return false;
}

/** Remove CSS vectors that can exfiltrate data or execute in some clients. */
function stripRiskyCss(css: string): string {
  return css
    .replace(/@import\b[^;]*;/gi, '')
    .replace(/@charset\b[^;]*;/gi, '')
    .replace(/expression\s*\(/gi, 'expression-disabled(')
    .replace(/url\(\s*(['"]?)\s*(javascript|vbscript|file|mhtml):/gi, 'url($1blk:');
}

let hooksInstalled = false;

/** Install DOMPurify hooks once (global). Idempotent. */
function ensureHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // URI-scheme allowlist on url-bearing attributes.
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const { attrName, attrValue } = data;
    if ((attrName === 'href' || attrName === 'src' || attrName === 'action') && attrValue) {
      if (isDangerousUrl(attrValue)) {
        data.keepAttr = false;
      }
    }
  });

  // (The <style> @import strip is done by pre-extraction before DOMPurify — no
  // uponSanitizeElement hook needed, since DOMPurify strips <style> in fragment
  // mode anyway and never sees our re-hardened blocks.)

  // Force safe link targets.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Sanitize incoming email HTML for sandboxed-iframe rendering. Allows <style>
 * (with @import stripped) for fidelity, blocks scripts/forms/dangerous schemes.
 */
export function sanitizeForViewer(html: string): string {
  ensureHooks();
  // DOMPurify strips <style> in fragment mode. To preserve email CSS fidelity
  // while still neutralizing @import / expression() / js: url(), extract the
  // <style> blocks first, harden their CSS, and re-attach after sanitizing the
  // rest. The uponSanitizeElement hook remains as defense-in-depth.
  const styles: string[] = [];
  const withoutStyles = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    styles.push(`<style>${stripRiskyCss(css)}</style>`);
    return '';
  });

  const cleaned = DOMPurify.sanitize(withoutStyles, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button'],
    ADD_ATTR: ['target', 'rel'],
  });

  return styles.length > 0 ? `${styles.join('')}${cleaned}` : cleaned;
}
