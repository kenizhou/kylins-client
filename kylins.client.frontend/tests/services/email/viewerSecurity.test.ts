import { describe, it, expect } from 'vitest';
import { sanitizeForViewer } from '../../../src/services/email/sanitizeForViewer';
import {
  stripRemoteImages,
  hasBlockedImages,
  stripTrackers,
  hasTrackerImages,
} from '../../../src/utils/imageBlocker';
import { isTrackerUrl } from '../../../src/services/email/trackerBlacklist';
import { detectPhishing } from '../../../src/utils/phishingDetector';

describe('viewer sanitizeForViewer', () => {
  it('strips <script> tags', () => {
    const out = sanitizeForViewer('<script>alert(1)</script><p>hi</p>');
    expect(out).not.toContain('<script');
    expect(out).toContain('hi');
  });

  it('blocks javascript: hrefs', () => {
    const out = sanitizeForViewer('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain('javascript:alert');
  });

  it('keeps <style> for fidelity but strips @import', () => {
    const out = sanitizeForViewer(
      '<style>@import url(evil.css); .a{color:red}</style><p class="a">x</p>',
    );
    expect(out).toContain('<style');
    expect(out.toLowerCase()).not.toContain('@import');
    expect(out).toContain('color:red');
  });

  it('forces safe link targets', () => {
    const out = sanitizeForViewer('<a href="https://example.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe('viewer imageBlocker', () => {
  it('moves remote img src to data-blocked-src', () => {
    const out = stripRemoteImages('<img src="https://track.example.com/a.png">');
    expect(out).toContain('data-blocked-src');
    expect(hasBlockedImages(out)).toBe(true);
  });

  it('preserves cid: and data: images', () => {
    const html = '<img src="cid:abc"><img src="data:image/png;base64,xxxx">';
    expect(stripRemoteImages(html)).toBe(html);
  });

  it('neutralizes known tracker pixels', () => {
    const out = stripTrackers('<img src="https://track.mailtrack.io/p.png" width="1" height="1">');
    expect(hasTrackerImages(out)).toBe(true);
    expect(out).not.toContain('track.mailtrack.io/p.png');
  });

  it('detects tracker URLs by host', () => {
    expect(isTrackerUrl('https://ct.sendgrid.net/track')).toBe(true);
    expect(isTrackerUrl('https://example.com/logo.png')).toBe(false);
  });
});

describe('viewer phishingDetector', () => {
  it('flags from-domain ≠ reply-to-domain as a high signal', () => {
    const r = detectPhishing({
      fromAddress: 'support@paypal.com',
      replyTo: 'attacker@evil.ru',
    });
    expect(r.signals.some((s) => s.severity === 'high')).toBe(true);
  });

  it('does not flag matching from/reply-to domains', () => {
    const r = detectPhishing({
      fromAddress: 'a@corp.com',
      replyTo: 'b@corp.com',
    });
    expect(r.isLikelyPhishing).toBe(false);
  });

  it('escalates to likely phishing when signals compound', () => {
    const r = detectPhishing({
      fromAddress: 'security@google-account.ru',
      replyTo: 'attacker@evil.ru',
      subject: 'URGENT: verify your account',
      bodyHtml: '<p>Please enter your password to confirm your identity</p>',
    });
    expect(r.isLikelyPhishing).toBe(true);
  });
});
