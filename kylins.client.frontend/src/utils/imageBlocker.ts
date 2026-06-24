// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client (+ Mailspring tracker/1×1 rule).
//
// Block/restore remote images in email HTML. Preserves data: and cid: URIs; only
// http(s) remote images are hidden. On top of velo's behavior, known tracking
// pixels and 1×1 images are neutralized even when remote images are loaded.

import { isTrackerUrl } from '@/services/email/trackerBlacklist';

/**
 * Strip remote images by moving `src` to `data-blocked-src`. Also strips remote
 * url() references in inline styles.
 */
export function stripRemoteImages(html: string): string {
  let result = html.replace(
    /(<img\b[^>]*?)(\ssrc\s*=\s*)(["'])(https?:\/\/[^"']*)\3/gi,
    '$1 data-blocked-src=$3$4$3 src=$3$3',
  );
  result = result.replace(/url\(\s*(["']?)(https?:\/\/[^)"']*)\1\s*\)/gi, 'url($1$1)');
  return result;
}

/** Restore previously blocked remote images. */
export function restoreRemoteImages(html: string): string {
  return html.replace(
    /(<img\b[^>]*?)\sdata-blocked-src\s*=\s*(["'])(https?:\/\/[^"']*)\2([^>]*?)\ssrc\s*=\s*(["'])\5/gi,
    '$1 src=$2$3$2$4',
  );
}

/** True if the HTML contains any blocked (data-blocked-src) images. */
export function hasBlockedImages(html: string): boolean {
  return /data-blocked-src\s*=\s*["']https?:\/\//i.test(html);
}

/**
 * Neutralize known tracker pixels and obvious 1×1 images even when remote images
 * are otherwise allowed. Tracker srcs are blanked and tagged data-tracker="1".
 */
export function stripTrackers(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\ssrc\s*=\s*["']([^"']*)["']/i);
    const src = srcMatch?.[1] ?? '';
    const isSmallAttr = /\b(width|height)\s*=\s*["']?\s*0?1\b/i.test(tag);
    const isSmallStyle = /(width|height)\s*:\s*0?1px/i.test(tag);
    if ((src && isTrackerUrl(src)) || isSmallAttr || isSmallStyle) {
      return tag.replace(/(\ssrc\s*=\s*)(["'])([^"']*)\2/i, '$1$2$2 data-tracker="1"');
    }
    return tag;
  });
}

/** True if the HTML contains any tracker-tagged images. */
export function hasTrackerImages(html: string): boolean {
  return /data-tracker\s*=\s*["']?1/i.test(html);
}
