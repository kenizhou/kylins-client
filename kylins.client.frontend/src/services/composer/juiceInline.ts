// CSS-inlining step for outgoing mail (Mailspring inline-style-transformer pattern).
//
// Email clients (Outlook, Gmail, etc.) widely ignore <style> blocks in the
// <head>/<body>; presentational CSS must be inlined as `style=""` attributes for
// faithful rendering. `juice` parses any <style> tags in the editor HTML and
// pushes their declarations onto matching elements, then strips the <style>.
//
// Runs synchronously on the send path (one call per message, not per keystroke).
// TODO (plan risk register): for very large pastes, move this to a Web Worker or
// a Rust command to avoid main-thread jank.

import juice from 'juice';

/**
 * Inline <style> blocks into element-level `style` attributes for email-client
 * fidelity. On any parse failure the original HTML is returned unchanged so a
 * juice bug can never block sending.
 */
export function inlineCss(html: string): string {
  if (!html) return html;
  try {
    return juice(html, {
      applyStyleTags: true,
      removeStyleTags: true,
    });
  } catch (err) {
    console.warn('[composer] juice inline-css failed, sending original HTML:', err);
    return html;
  }
}
