import type { MailMessage } from '@/features/view/viewStore';
import { formatFullDate } from '@/utils/formatDate';

export const DEMO_MESSAGES: MailMessage[] = [
  {
    id: 'msg-1',
    subject: 'Coral Gables project — revised timeline',
    from: { name: 'Kevin Sturgis', address: 'kevin@example.com' },
    to: [{ name: 'You', address: 'you@kylins.local' }],
    date: '2026-06-24T09:30:00Z',
    preview: "After yesterday's standup I moved the foundation milestone out by two weeks...",
    html: `<p>Hi,</p>
<p>After yesterday's standup I moved the foundation milestone out by two weeks. The structural drawings should be ready by Friday, but we need sign-off from the city before we can pour.</p>
<p>I've attached the updated Gantt chart. Let me know if the new dates work on your end.</p>
<p>— Kevin</p>`,
    text: "Hi,\n\nAfter yesterday's standup I moved the foundation milestone out by two weeks. The structural drawings should be ready by Friday, but we need sign-off from the city before we can pour.\n\nI've attached the updated Gantt chart. Let me know if the new dates work on your end.\n\n— Kevin",
    threadId: 'thread-1',
    messageId: '<msg-1@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
  },
  {
    id: 'msg-2',
    subject: 'Security review passed',
    from: { name: 'Cecil Folk', address: 'security@example.com' },
    to: [{ name: 'You', address: 'you@kylins.local' }],
    date: '2026-06-24T13:23:00Z',
    preview: 'The latest penetration test completed with no critical findings...',
    html: `<p>Great news — the latest penetration test completed with no critical findings. The full report is available in the shared drive.</p>
<table style="border-collapse:collapse;width:100%;margin:12px 0;">
  <tr style="background:#f3f4f6;">
    <th style="padding:8px;border:1px solid #d1d5db;text-align:left;">Severity</th>
    <th style="padding:8px;border:1px solid #d1d5db;text-align:left;">Count</th>
  </tr>
  <tr>
    <td style="padding:8px;border:1px solid #d1d5db;">Critical</td>
    <td style="padding:8px;border:1px solid #d1d5db;">0</td>
  </tr>
  <tr>
    <td style="padding:8px;border:1px solid #d1d5db;">High</td>
    <td style="padding:8px;border:1px solid #d1d5db;">1</td>
  </tr>
  <tr>
    <td style="padding:8px;border:1px solid #d1d5db;">Medium</td>
    <td style="padding:8px;border:1px solid #d1d5db;">3</td>
  </tr>
</table>
<p>— Cecil</p>`,
    text: 'Great news — the latest penetration test completed with no critical findings.\n\nSeverity | Count\nCritical | 0\nHigh | 1\nMedium | 3\n\n— Cecil',
    threadId: 'thread-2',
    messageId: '<msg-2@example.com>',
    classificationId: 'restricted',
    isEncrypted: true,
    isSigned: true,
  },
  {
    id: 'msg-3',
    subject: 'Q3 budget draft',
    from: { name: 'Lydia Bauer', address: 'lydia@example.com' },
    to: [{ name: 'You', address: 'you@kylins.local' }],
    date: '2026-06-23T12:55:00Z',
    preview: 'Please review the attached Q3 budget draft by Friday...',
    html: `<p>Please review the attached Q3 budget draft by Friday. I flagged two line items for your input:</p>
<ul>
  <li>Cloud infrastructure spend is up 12% quarter-over-quarter.</li>
  <li>Contractor hours exceeded plan in May; I added a contingency for June.</li>
</ul>
<p>Let me know if you want to walk through it together.</p>
<p>Thanks,<br/>Lydia</p>`,
    text: 'Please review the attached Q3 budget draft by Friday. I flagged two line items for your input:\n\n- Cloud infrastructure spend is up 12% quarter-over-quarter.\n- Contractor hours exceeded plan in May; I added a contingency for June.\n\nLet me know if you want to walk through it together.\n\nThanks,\nLydia',
    threadId: 'thread-3',
    messageId: '<msg-3@example.com>',
    classificationId: 'confidential',
    isEncrypted: true,
    isSigned: true,
  },
  {
    id: 'msg-4',
    subject: 'Action required: verify your account',
    from: { name: 'Support Team', address: 'support@secure-portal.example.com' },
    to: [{ name: 'You', address: 'you@kylins.local' }],
    date: '2026-06-23T08:12:00Z',
    preview: 'We noticed unusual activity on your account. Click here to verify...',
    html: `<p>Dear user,</p>
<p>We noticed unusual activity on your account. Please <a href="https://secure-portal.example.com/verify">click here</a> to verify your details.</p>
<p style="font-size:12px;color:#6b7280;">This is a demo message used to test the suspicious-link warning.</p>`,
    text: 'Dear user,\n\nWe noticed unusual activity on your account. Please click here to verify your details: https://secure-portal.example.com/verify\n\nThis is a demo message used to test the suspicious-link warning.',
    threadId: 'thread-4',
    messageId: '<msg-4@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
  },
  {
    id: 'msg-5',
    subject: 'Your weekly digest',
    from: { name: 'Design Review', address: 'digest@example.com' },
    to: [{ name: 'You', address: 'you@kylins.local' }],
    date: '2026-06-22T11:20:00Z',
    preview: 'Here are the top stories from this week...',
    html: `<p>Here are the top stories from this week:</p>
<img src="https://images.example.com/hero-week-25.jpg" alt="Weekly hero" width="600" style="display:block;max-width:100%;" />
<p>Read the full recap on our blog.</p>
<img src="https://tracker.example.com/pixel.gif" width="1" height="1" alt="" />
<p style="font-size:12px;color:#6b7280;">This message demonstrates remote-image blocking and tracker-pixel stripping.</p>`,
    text: 'Here are the top stories from this week:\n\n[Image: Weekly hero]\n\nRead the full recap on our blog.\n\nThis message demonstrates remote-image blocking and tracker-pixel stripping.',
    threadId: 'thread-5',
    messageId: '<msg-5@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
  },
  {
    id: 'msg-6',
    subject: 'Plain-text update from the field',
    from: { name: 'Mina Nichols', address: 'mina@example.com' },
    to: [{ name: 'You', address: 'you@kylins.local' }],
    date: '2026-06-22T09:04:00Z',
    preview: 'Site visit went well. Foundation is curing as expected...',
    html: null,
    text: 'Site visit went well. Foundation is curing as expected and the weather looks clear for the pour on Monday.\n\n— Mina',
    threadId: 'thread-6',
    messageId: '<msg-6@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
  },
];

export function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return '?';
  const first = parts[0];
  if (!first) return '?';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1];
  return (first[0] + (last?.[0] ?? '')).toUpperCase();
}

export function formatMessageTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatMessageDate(isoDate: string): string {
  // Delegate to the shared util so the composer (and other non-demo code) and
  // demo data share one date-formatting implementation.
  return formatFullDate(isoDate);
}
