// Mailspring tracker-pixel blacklist (verbatim data pattern).
//
// Known email-open / read-receipt tracking domains. Any <img> whose host matches
// is treated as a tracker and blocked even when the user has chosen to load
// remote images for a sender. This is the inbound-privacy counterpart to the
// (intentionally absent) outbound open-tracking: we strip others' trackers but
// never emit our own.

/** Hostnames / suffixes of known tracking services. */
export const TRACKER_DOMAINS: readonly string[] = [
  // Read receipts / email analytics
  'yesware.com',
  't.yesware.com',
  'track.yesware.com',
  'bananatag.com',
  'getsidekick.com',
  'sidekick.com',
  'salesloft.com',
  'track.salesloft.com',
  'outreach.io',
  'outreach.com',
  'mailtrack.io',
  'track.mailtrack.io',
  'streak.com',
  'pixel.streak.com',
  'cirrusinsight.com',
  'troops.ai',
  // Marketing / ESP tracking pixels
  'ct.sendgrid.net',
  'sendgrid.net',
  'mandrillapp.com',
  'trk.klaviyo.com',
  '1x1.klaviyo.com',
  'click.klaviyo.com',
  'track.constantcontact.com',
  'open.exacttarget.com',
  'pixel.app.returnpath.net',
  'pixel.monitor1.returnpath.net',
  'tags.bluekai.com',
  'ib.adnxs.com',
  'www.google-analytics.com',
  'ssl.google-analytics.com',
  'dc.ads.linkedin.com',
  'px.ads.linkedin.com',
  'facebook.com/tr',
];

/** True if the URL points at a known tracking service. */
export function isTrackerUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TRACKER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
