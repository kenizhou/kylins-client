// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// NOTE (Phase 1): ported verbatim. The Mailspring @import-strip hardening is
// deferred to Phase 2 (viewer) — it only matters if/when we allow <style> tags
// for inbound marketing-email rendering. velo forbids <style> (FORBID_TAGS),
// which already neutralizes @import here. The explicit URI-scheme allowlist
// (ALLOW_UNKNOWN_PROTOCOLS: false) already blocks javascript:/data: HTML etc.

import DOMPurify from 'dompurify';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    ALLOWED_ATTR: [
      'href',
      'src',
      'alt',
      'title',
      'width',
      'height',
      'class',
      'style',
      'target',
      'rel',
      'colspan',
      'rowspan',
      'cellpadding',
      'cellspacing',
      'border',
      'align',
      'valign',
      'bgcolor',
      'color',
      'dir',
      'lang',
      'data-blocked-src',
    ],
  });
}
