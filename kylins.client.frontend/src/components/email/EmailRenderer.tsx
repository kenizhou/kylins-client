// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client (+ Mailspring hardening).
//
// Renders remote email HTML in a sandboxed iframe (allow-same-origin, NO
// allow-scripts) with: viewer-grade sanitization (services/email/sanitizeForViewer
// — <style> kept but @import/JS stripped), remote-image blocking with a per-
// sender allowlist, known-tracker / 1×1 stripping even when images are loaded,
// auto-height via ResizeObserver, and link clicks gated by a phishing pre-check
// (LinkConfirmDialog). CID: references are resolved from a parent-supplied map.
//
// Sandbox decision (plan §5.1 / risk register): velo's allow-same-origin +
// no-allow-scripts + DOMPurify is the correct industry-standard config. Do NOT
// regress to pure sandbox="" or find-in-thread / context-menu lose parent access.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sanitizeForViewer } from '@/services/email/sanitizeForViewer';
import { escapeHtml } from '@/utils/sanitize';
import {
  stripRemoteImages,
  stripTrackers,
  hasBlockedImages,
  hasTrackerImages,
} from '@/utils/imageBlocker';
import { addToAllowlist } from '@/services/db/imageAllowlist';
import { openExternalUrl } from '@/utils/opener';
import { useUIStore } from '@/stores/uiStore';
import { LinkConfirmDialog } from './LinkConfirmDialog';

interface PendingLink {
  url: string;
  text: string;
  suspicious: boolean;
}

interface EmailRendererProps {
  html: string | null;
  text?: string | null;
  blockImages?: boolean;
  senderAddress?: string | null;
  accountId?: string | null;
  senderAllowlisted?: boolean;
  /** True when the parent's phishing check flags the whole message (gates links). */
  isMessageSuspicious?: boolean;
  /** cid: → data: URL map, resolved by the parent from inline attachments. */
  cidMap?: Map<string, string> | null;
}

function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True if an anchor's visible text masquerades as a different host than its href. */
function isSuspiciousAnchor(anchor: HTMLAnchorElement): boolean {
  const hrefHost = linkHost(anchor.href);
  if (!hrefHost) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hrefHost)) return true; // IP-literal host
  const text = (anchor.textContent ?? '').trim();
  const textHost = linkHost(text.startsWith('http') ? text : `http://${text}`);
  return Boolean(textHost) && textHost !== hrefHost;
}

export function EmailRenderer({
  html,
  text,
  blockImages = false,
  senderAddress,
  accountId,
  senderAllowlisted = false,
  isMessageSuspicious = false,
  cidMap = null,
}: EmailRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const [overrideShow, setOverrideShow] = useState(false);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);

  const theme = useUIStore((s) => s.theme);
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const shouldBlock = blockImages && !senderAllowlisted && !overrideShow;

  // Sanitize once (viewer config) — reused for content + blocked-image detection.
  const sanitizedBody = useMemo(() => (html ? sanitizeForViewer(html) : null), [html]);
  const isPlainText = !sanitizedBody;

  const bodyHtml = useMemo(() => {
    let body = sanitizedBody;
    if (!body) {
      body = `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text ?? '')}</pre>`;
    }
    if (shouldBlock) {
      body = stripRemoteImages(body);
    } else {
      // Even when remote images are allowed, neutralize trackers + 1×1 pixels.
      body = stripTrackers(body);
    }
    if (cidMap && cidMap.size > 0) {
      body = body.replace(
        /\bcid:([^"'\s)]+)/gi,
        (match, cidRef: string) => cidMap.get(cidRef) ?? match,
      );
    }
    return body;
  }, [sanitizedBody, text, shouldBlock, cidMap]);

  // Derive the flags from `bodyHtml`, which already ran the strip pass above —
  // avoids re-scanning the whole document with stripRemoteImages/stripTrackers.
  const blocked = useMemo(() => shouldBlock && hasBlockedImages(bodyHtml), [shouldBlock, bodyHtml]);
  const trackerNote = useMemo(
    () => !shouldBlock && hasTrackerImages(bodyHtml),
    [shouldBlock, bodyHtml],
  );

  // Write content into the iframe document; keep height in sync.
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;

    observerRef.current?.disconnect();

    const plainTextDark = isDark && isPlainText;
    const htmlDark = isDark && !isPlainText;

    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0; padding: 16px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 14px; line-height: 1.6;
      color: ${plainTextDark ? '#e5e7eb' : '#1f2937'};
      background: ${htmlDark ? '#f8f9fa' : 'transparent'};
      word-wrap: break-word; overflow-wrap: break-word; overflow: hidden;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${plainTextDark ? '#60a5fa' : '#3b82f6'}; }
    blockquote { border-left: 3px solid ${plainTextDark ? '#4b5563' : '#d1d5db'}; margin: 8px 0; padding: 4px 12px; color: ${plainTextDark ? '#9ca3af' : '#6b7280'}; }
    pre { overflow-x: auto; }
    table { max-width: 100%; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`);
    doc.close();

    const applyHeight = () => {
      if (doc.body) {
        const h = doc.body.scrollHeight;
        if (h > 0) iframe.style.height = `${h}px`;
      }
    };
    applyHeight();

    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(applyHeight);
    });
    if (doc.body) resizeObserver.observe(doc.body);
    observerRef.current = resizeObserver;

    // Gate link clicks through a phishing pre-check.
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor?.href) return;
      e.preventDefault();
      const url = anchor.href;
      const suspicious = isMessageSuspicious || isSuspiciousAnchor(anchor);
      if (suspicious) {
        setPendingLink({ url, text: anchor.textContent ?? '', suspicious: true });
      } else {
        openExternalUrl(url).catch((err) => console.error('Failed to open link:', err));
      }
    };
    doc.addEventListener('click', handleClick);

    return () => {
      doc.removeEventListener('click', handleClick);
      observerRef.current?.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [bodyHtml, isDark, isPlainText, isMessageSuspicious]);

  const handleLoadImages = useCallback(() => setOverrideShow(true), []);

  const handleAlwaysLoad = useCallback(async () => {
    if (accountId && senderAddress) {
      try {
        await addToAllowlist(accountId, senderAddress);
      } catch (err) {
        console.error('Failed to add sender to image allowlist:', err);
      }
    }
    setOverrideShow(true);
  }, [accountId, senderAddress]);

  const confirmPendingLink = useCallback(() => {
    if (pendingLink) {
      openExternalUrl(pendingLink.url).catch((err) => console.error('Failed to open link:', err));
    }
    setPendingLink(null);
  }, [pendingLink]);

  return (
    <div>
      {blocked && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-xs">
          <span className="text-[var(--muted-text)]">Images hidden to protect your privacy.</span>
          <button
            onClick={handleLoadImages}
            className="font-medium text-[var(--primary)] hover:opacity-80"
          >
            Load images
          </button>
          {senderAddress && accountId && (
            <button
              onClick={handleAlwaysLoad}
              className="font-medium text-[var(--primary)] hover:opacity-80"
            >
              Always load from sender
            </button>
          )}
        </div>
      )}
      {trackerNote && (
        <div className="mb-2 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 py-1.5 text-[0.625rem] text-[var(--muted-text)]">
          Known tracking pixels were blocked.
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        className={`w-full border-0 ${isDark && !isPlainText ? 'rounded-md' : ''}`}
        style={{ overflow: 'hidden' }}
        title="Email content"
      />
      {pendingLink && (
        <LinkConfirmDialog
          href={pendingLink.url}
          displayText={pendingLink.text}
          suspicious={pendingLink.suspicious}
          onConfirm={confirmPendingLink}
          onCancel={() => setPendingLink(null)}
        />
      )}
    </div>
  );
}
