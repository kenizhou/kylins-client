// Development helper: populate the local SQLite database with realistic dummy
// data for manual testing. Safe to run repeatedly — it uses deterministic IDs
// and INSERT OR REPLACE so re-runs update rows in place instead of creating
// duplicates.
//
// This is intended for local dev/QA only. It never writes real secrets; OAuth
// tokens and IMAP passwords are left NULL.

import { getDb } from './connection';
import { runMigrations } from './migrations';

export interface SeedDummyDataOptions {
  /** When true, deletes existing dummy rows before re-seeding. */
  clearExisting?: boolean;
}

const ACCOUNT_IDS = ['dummy-gmail', 'dummy-work', 'dummy-eas'];

const ACCOUNTS = [
  {
    id: ACCOUNT_IDS[0],
    email: 'alice.doe@gmail.com',
    displayName: 'Alice Doe',
    provider: 'gmail_api',
  },
  {
    id: ACCOUNT_IDS[1],
    email: 'alice@example.com',
    displayName: 'Alice at Example Inc.',
    provider: 'imap',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    authMethod: 'password',
  },
  {
    id: ACCOUNT_IDS[2],
    email: 'alice@contoso.com',
    displayName: 'Alice (Exchange)',
    provider: 'eas',
    easUrl: 'https://mail.contoso.com/Microsoft-Server-ActiveSync',
    easProtocolVersion: '16.1',
    easDeviceId: 'KYLINS-SEED-EAS1',
  },
];

const CONTACTS = [
  { email: 'bob.smith@example.com', displayName: 'Bob Smith', avatarUrl: '' },
  { email: 'carol.white@example.com', displayName: 'Carol White', avatarUrl: '' },
  { email: 'david@contoso.com', displayName: 'David Lee', avatarUrl: '' },
  { email: 'eve@startup.io', displayName: 'Eve Martinez', avatarUrl: '' },
  { email: 'frank@university.edu', displayName: 'Frank Chen', avatarUrl: '' },
  { email: 'grace@design.studio', displayName: 'Grace Taylor', avatarUrl: '' },
  { email: 'noreply@github.com', displayName: 'GitHub', avatarUrl: '' },
  { email: 'team@figma.com', displayName: 'Figma', avatarUrl: '' },
];

interface SeedLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  /** Explicit canonical role override; otherwise derived for system labels. */
  role?: string | null;
  /** Provider-native id; defaults to the label id. */
  remoteId?: string;
  /** Native parent id (matched against a sibling's remoteId for nesting). */
  parentId?: string | null;
  /** Folder class; non-'mail' folders are hidden by the mail folder pane. */
  mailClass?: string;
}

const LABELS: SeedLabel[] = [
  { id: 'inbox', name: 'Inbox', type: 'system' },
  { id: 'sent', name: 'Sent', type: 'system' },
  { id: 'drafts', name: 'Drafts', type: 'system' },
  { id: 'trash', name: 'Trash', type: 'system' },
  { id: 'spam', name: 'Spam', type: 'system' },
  { id: 'important', name: 'Important', type: 'system' },
  { id: 'starred', name: 'Starred', type: 'system' },
  { id: 'newsletters', name: 'Newsletters', type: 'user' },
];

// EAS (Exchange ActiveSync) folders for the dummy Exchange account. Same
// canonical ids as the other accounts (so seeded threads link via
// thread_labels), but with Exchange display names and source='eas'. Also
// exercises folder hierarchy (Projects > Apollo via remoteId/parentId) and
// non-mail filtering (Calendar, hidden from the mail folder pane).
const EAS_LABELS: SeedLabel[] = [
  { id: 'inbox', name: 'Inbox', type: 'system', role: 'inbox' },
  { id: 'sent', name: 'Sent Items', type: 'system', role: 'sent' },
  { id: 'drafts', name: 'Drafts', type: 'system', role: 'drafts' },
  { id: 'trash', name: 'Deleted Items', type: 'system', role: 'trash' },
  { id: 'spam', name: 'Junk E-mail', type: 'system', role: 'junk' },
  { id: 'important', name: 'Important', type: 'system', role: 'important' },
  { id: 'starred', name: 'Starred', type: 'system', role: 'starred' },
  { id: 'newsletters', name: 'Newsletters', type: 'user' },
  { id: 'eas-projects', name: 'Projects', type: 'user', remoteId: 'col-projects' },
  {
    id: 'eas-apollo',
    name: 'Apollo',
    type: 'user',
    remoteId: 'col-apollo',
    parentId: 'col-projects',
  },
  {
    id: 'eas-calendar',
    name: 'Calendar',
    type: 'system',
    role: null,
    remoteId: 'col-cal',
    mailClass: 'calendar',
  },
];

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const COMPLEX_BODIES = [
  // 0: inline image + styled paragraph
  `<div style="font-family: sans-serif;">
     <p>Hi team,</p>
     <p>Please review the mock below:</p>
     <img src="data:image/png;base64,${TINY_PNG_B64}" alt="mock" style="border:1px solid #ccc;" />
     <p>Thanks,<br/>Alice</p>
   </div>`,
  // 1: HTML table with data
  `<div style="font-family: sans-serif;">
     <p>Here is the budget breakdown:</p>
     <table border="1" cellpadding="6" style="border-collapse: collapse;">
       <thead><tr><th>Item</th><th>Qty</th><th>Cost</th></tr></thead>
       <tbody>
         <tr><td>Licenses</td><td>10</td><td>$1,200</td></tr>
         <tr><td>Support</td><td>1 yr</td><td>$800</td></tr>
       </tbody>
     </table>
   </div>`,
  // 2: newsletter-like image header + button
  `<div style="max-width: 480px; font-family: sans-serif;">
     <img src="data:image/png;base64,${TINY_PNG_B64}" style="width:100%; height:auto;" alt="header" />
     <h2>Your weekly digest</h2>
     <p>Top stories from your subscriptions this week.</p>
     <a href="https://example.com" style="display:inline-block;padding:8px 16px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:4px;">Read more</a>
   </div>`,
  // 3: reply with quoted original (gmail_quote)
  `<p>Agreed — let’s go with option B.</p>
   <div class="gmail_quote">
     <blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;">
       On Mon, someone wrote:<br/>
       Which option do you prefer?
     </blockquote>
   </div>`,
  // 4: multi-image gallery
  `<p>Screenshots from the latest build:</p>
   <div style="display:flex;gap:8px;">
     <img src="data:image/png;base64,${TINY_PNG_B64}" width="120" alt="shot1" />
     <img src="data:image/png;base64,${TINY_PNG_B64}" width="120" alt="shot2" />
     <img src="data:image/png;base64,${TINY_PNG_B64}" width="120" alt="shot3" />
   </div>`,
];

const [BODY_INLINE, BODY_TABLE, BODY_NEWSLETTER, BODY_REPLY_QUOTE, BODY_GALLERY] = COMPLEX_BODIES;

const SIGNATURES = [
  {
    name: 'Personal default',
    bodyHtml: '<p>— Alice Doe<br/><a href="mailto:alice.doe@gmail.com">alice.doe@gmail.com</a></p>',
    context: 'all' as const,
    isDefault: true,
  },
  {
    name: 'Casual new-mail',
    bodyHtml: '<p>Cheers,<br/>Alice</p>',
    context: 'new' as const,
    isDefault: true,
  },
  {
    name: 'Work reply',
    bodyHtml: '<p>Best regards,<br/>Alice Doe<br/>Example Inc. | Engineering</p>',
    context: 'reply' as const,
    isDefault: true,
  },
  {
    name: 'Work forward',
    bodyHtml: '<p>—<br/>Alice Doe<br/>Senior Engineer, Example Inc.</p>',
    context: 'forward' as const,
    isDefault: true,
  },
];

const TEMPLATES = [
  {
    name: 'Quick thanks',
    subject: 'Thanks!',
    bodyHtml: '<p>Hi {{name}},</p><p>Thanks for your help!</p><p>— Alice</p>',
    shortcut: ';thanks',
  },
  {
    name: 'Meeting request',
    subject: 'Meeting request',
    bodyHtml:
      '<p>Hi {{name}},</p><p>Are you available for a quick meeting on {{day}}?</p><p>— Alice</p>',
    shortcut: ';meet',
  },
  {
    name: 'Out of office',
    subject: 'Out of office',
    bodyHtml: '<p>Hi,</p><p>I am currently out of office and will reply when I return.</p>',
    shortcut: '',
  },
];

interface TaskScenario {
  title: string;
  priority: 'low' | 'medium' | 'high';
  isCompleted: boolean;
  dueOffsetDays: number | null;
}

const TASKS: TaskScenario[] = [
  { title: 'Review Q3 roadmap', priority: 'high', isCompleted: false, dueOffsetDays: 2 },
  { title: 'Update team documentation', priority: 'medium', isCompleted: false, dueOffsetDays: 5 },
  {
    title: 'Book flights for conference',
    priority: 'medium',
    isCompleted: true,
    dueOffsetDays: -3,
  },
  { title: 'Prepare demo script', priority: 'high', isCompleted: false, dueOffsetDays: 1 },
  { title: 'Order office supplies', priority: 'low', isCompleted: false, dueOffsetDays: null },
  {
    title: 'Follow up with design team',
    priority: 'medium',
    isCompleted: false,
    dueOffsetDays: -1,
  },
];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function deterministicId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}-${parts.join('-')}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function pick<T>(arr: T[], index: number): T {
  return arr[index % arr.length]!;
}

function hashIndex(seed: string, max: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % max;
}

function buildSimpleBody(snippet: string, seed: string): string {
  const templates = [
    `<p>Hi there,</p><p>{snippet}</p><p>Let me know if you have any questions.</p><p>— Alice</p>`,
    `<p>Hello,</p><p>{snippet} I have cc’d the rest of the team.</p><p>Best,<br/>Alice</p>`,
    `<p>Hi,</p><p>Just a quick note: {snippet}</p><p>Thanks!</p>`,
  ];
  return pick(templates, hashIndex(seed, templates.length)).replace('{snippet}', snippet);
}

async function seedAccounts(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  for (const account of ACCOUNTS) {
    await db.execute(
      `INSERT OR REPLACE INTO accounts (
        id, email, display_name, provider, is_active, created_at, updated_at,
        imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, auth_method,
        eas_url, eas_protocol_version, eas_device_id
      ) VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        account.id,
        account.email,
        account.displayName,
        account.provider,
        nowSeconds(),
        'imapHost' in account ? account.imapHost : null,
        'imapPort' in account ? account.imapPort : null,
        'imapSecurity' in account ? account.imapSecurity : null,
        'smtpHost' in account ? account.smtpHost : null,
        'smtpPort' in account ? account.smtpPort : null,
        'smtpSecurity' in account ? account.smtpSecurity : null,
        'authMethod' in account ? account.authMethod : null,
        'easUrl' in account ? account.easUrl : null,
        'easProtocolVersion' in account ? account.easProtocolVersion : null,
        'easDeviceId' in account ? account.easDeviceId : null,
      ],
    );
  }
}

async function seedContacts(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  for (let i = 0; i < CONTACTS.length; i++) {
    const contact = CONTACTS[i]!;
    const id = deterministicId('contact', contact.email);
    const lastContacted = nowSeconds() - i * 86400 * 3;
    await db.execute(
      `INSERT OR REPLACE INTO contacts (
        id, email, display_name, avatar_url, frequency, last_contacted_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [
        id,
        contact.email,
        contact.displayName,
        contact.avatarUrl || null,
        1 + (i % 10),
        lastContacted,
        nowSeconds(),
      ],
    );
  }
}

// Canonical role for each well-known system label id. Mirrors the role
// resolvers in services/mail/folders/folderRoles.ts so dummy folders classify
// the same way real provider folders do.
const SYSTEM_LABEL_ROLES: Record<string, string> = {
  inbox: 'inbox',
  sent: 'sent',
  drafts: 'drafts',
  trash: 'trash',
  spam: 'junk',
  important: 'important',
  starred: 'starred',
};

async function seedLabels(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  for (let a = 0; a < ACCOUNT_IDS.length; a++) {
    const accountId = ACCOUNT_IDS[a]!;
    const isEas = ACCOUNTS[a]!.provider === 'eas';
    const set = isEas ? EAS_LABELS : LABELS;
    const source = isEas ? 'eas' : 'local';
    for (let i = 0; i < set.length; i++) {
      const label = set[i]!;
      const role =
        label.role !== undefined
          ? label.role
          : label.type === 'system'
            ? (SYSTEM_LABEL_ROLES[label.id] ?? null)
            : null;
      await db.execute(
        `INSERT OR REPLACE INTO labels (
           id, account_id, name, type, visible, sort_order,
           source, role, parent_id, remote_id, mail_class
         ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)`,
        [
          label.id,
          accountId,
          label.name,
          label.type,
          i,
          source,
          role,
          label.parentId ?? null,
          label.remoteId ?? label.id,
          label.mailClass ?? 'mail',
        ],
      );
    }
  }
}

interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  isInline?: boolean;
  contentId?: string;
}

interface MessageInput {
  id: string;
  accountId: string;
  threadId: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string;
  ccAddresses?: string;
  bccAddresses?: string;
  subject: string;
  snippet: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml?: string;
  inReplyTo?: string;
  attachments?: AttachmentMeta[];
  classificationId?: string | null;
  isEncrypted?: boolean;
  isSigned?: boolean;
}

async function createMessage(
  db: Awaited<ReturnType<typeof getDb>>,
  input: MessageInput,
): Promise<void> {
  const bodyHtml = input.bodyHtml ?? buildSimpleBody(input.snippet, input.id);
  const bodyText = input.snippet;

  await db.execute(
    `INSERT OR REPLACE INTO messages (
      id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
      subject, snippet, date, is_read, is_starred, body_text,
      body_cached, message_id_header, internal_date, in_reply_to_header,
      classification_id, is_encrypted, is_signed
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $11, $16, $17, $18, $19)`,
    [
      input.id,
      input.accountId,
      input.threadId,
      input.fromAddress,
      input.fromName,
      input.toAddresses,
      input.ccAddresses ?? null,
      input.bccAddresses ?? null,
      input.subject,
      input.snippet,
      input.date,
      input.isRead ? 1 : 0,
      input.isStarred ? 1 : 0,
      bodyText,
      `<${input.id}@dummy.kylins>`,
      input.inReplyTo ?? null,
      input.classificationId ?? null,
      input.isEncrypted ? 1 : 0,
      input.isSigned ? 1 : 0,
    ],
  );

  // HTML body lives in the separate message_bodies table (migration v34);
  // messages keeps only body_text for FTS + the reading-pane text fallback.
  await db.execute(
    `INSERT OR REPLACE INTO message_bodies (account_id, message_id, body_html)
     VALUES ($1, $2, $3)`,
    [input.accountId, input.id, bodyHtml],
  );

  if (input.attachments) {
    for (let i = 0; i < input.attachments.length; i++) {
      const att = input.attachments[i]!;
      const attachmentId = deterministicId('att', input.id, i);
      await db.execute(
        `INSERT OR REPLACE INTO attachments (
          id, message_id, account_id, filename, mime_type, size, is_inline, content_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          attachmentId,
          input.id,
          input.accountId,
          att.filename,
          att.mimeType,
          att.size,
          att.isInline ? 1 : 0,
          att.contentId ?? null,
        ],
      );
    }
  }
}

async function createThread(
  db: Awaited<ReturnType<typeof getDb>>,
  input: {
    id: string;
    accountId: string;
    subject: string;
    snippet: string;
    lastMessageAt: number;
    messageCount: number;
    isRead: boolean;
    isStarred: boolean;
    isImportant: boolean;
    hasAttachments: boolean;
    primaryLabel: string;
    extraLabels?: string[];
    classificationId?: string | null;
    isEncrypted?: boolean;
    isSigned?: boolean;
  },
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO threads (
      id, account_id, subject, snippet, last_message_at, message_count,
      is_read, is_starred, is_important, has_attachments,
      classification_id, is_encrypted, is_signed
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.id,
      input.accountId,
      input.subject,
      input.snippet,
      input.lastMessageAt,
      input.messageCount,
      input.isRead ? 1 : 0,
      input.isStarred ? 1 : 0,
      input.isImportant ? 1 : 0,
      input.hasAttachments ? 1 : 0,
      input.classificationId ?? null,
      input.isEncrypted ? 1 : 0,
      input.isSigned ? 1 : 0,
    ],
  );

  const labels = [input.primaryLabel, ...(input.extraLabels ?? [])];
  if (input.isImportant && !labels.includes('important')) labels.push('important');
  if (input.isStarred && !labels.includes('starred')) labels.push('starred');
  for (const labelId of labels) {
    await db.execute(
      `INSERT OR REPLACE INTO thread_labels (thread_id, account_id, label_id)
       VALUES ($1, $2, $3)`,
      [input.id, input.accountId, labelId],
    );
  }
}

async function seedThreadsAndMessages(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const baseTime = nowSeconds();

  for (let a = 0; a < ACCOUNT_IDS.length; a++) {
    const accountId = ACCOUNT_IDS[a]!;
    const accountEmail = ACCOUNTS[a]!.email;

    // 1. Unread important security alert (restricted, encrypted + signed).
    {
      const threadId = deterministicId('thread', accountId, 'unread-important');
      const subject = 'Action required: security alert';
      const snippet = 'We noticed a new sign-in to your account.';
      const date = baseTime - 3600;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet,
        lastMessageAt: date,
        messageCount: 1,
        isRead: false,
        isStarred: false,
        isImportant: true,
        hasAttachments: false,
        primaryLabel: 'inbox',
        classificationId: 'restricted',
        isEncrypted: true,
        isSigned: true,
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'unread-important'),
        accountId,
        threadId,
        fromAddress: 'security@github.com',
        fromName: 'GitHub',
        toAddresses: accountEmail,
        subject,
        snippet,
        date,
        isRead: false,
        isStarred: false,
        classificationId: 'restricted',
        isEncrypted: true,
        isSigned: true,
      });
    }

    // 2. Inbox thread with attachment + reply (confidential, encrypted + signed).
    {
      const threadId = deterministicId('thread', accountId, 'attachment-reply');
      const subject = 'Q3 roadmap review';
      const contact = CONTACTS[0]!; // Bob
      const date1 = baseTime - 3600 * 8;
      const date2 = baseTime - 3600 * 2;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'Here is the latest draft for everyone to review.',
        lastMessageAt: date2,
        messageCount: 2,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: true,
        primaryLabel: 'inbox',
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
      const msg1Id = deterministicId('msg', accountId, 'attachment-reply', 1);
      const msg2Id = deterministicId('msg', accountId, 'attachment-reply', 2);
      await createMessage(db, {
        id: msg1Id,
        accountId,
        threadId,
        fromAddress: contact.email,
        fromName: contact.displayName,
        toAddresses: accountEmail,
        ccAddresses: 'carol.white@example.com',
        subject,
        snippet: 'Here is the latest draft for everyone to review.',
        date: date1,
        isRead: true,
        isStarred: false,
        bodyHtml: BODY_INLINE,
        attachments: [
          { filename: 'roadmap.pdf', mimeType: 'application/pdf', size: 512000 },
          {
            filename: 'budget.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 128000,
          },
        ],
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
      await createMessage(db, {
        id: msg2Id,
        accountId,
        threadId,
        fromAddress: accountEmail,
        fromName: ACCOUNTS[a]!.displayName,
        toAddresses: contact.email,
        ccAddresses: 'carol.white@example.com',
        subject: `Re: ${subject}`,
        snippet: 'Thanks Bob, I left a few comments.',
        date: date2,
        isRead: true,
        isStarred: false,
        bodyHtml: BODY_REPLY_QUOTE,
        inReplyTo: `<${msg1Id}@dummy.kylins>`,
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
    }

    // 3. Starred newsletter with inline image and table.
    {
      const threadId = deterministicId('thread', accountId, 'newsletter');
      const subject = 'Your weekly digest';
      const snippet = 'Top stories from your subscriptions.';
      const date = baseTime - 3600 * 24;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet,
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: true,
        isImportant: false,
        hasAttachments: false,
        primaryLabel: 'inbox',
        extraLabels: ['newsletters'],
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'newsletter'),
        accountId,
        threadId,
        fromAddress: 'team@figma.com',
        fromName: 'Figma',
        toAddresses: accountEmail,
        bccAddresses: 'list@figma.com',
        subject,
        snippet,
        date,
        isRead: true,
        isStarred: true,
        bodyHtml: BODY_NEWSLETTER,
      });
    }

    // 4. Sent message with CC/BCC.
    {
      const threadId = deterministicId('thread', accountId, 'sent');
      const subject = 'Welcome to the team!';
      const contact = CONTACTS[3]!; // Eve
      const date = baseTime - 3600 * 12;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'Looking forward to working with you!',
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: false,
        primaryLabel: 'sent',
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'sent'),
        accountId,
        threadId,
        fromAddress: accountEmail,
        fromName: ACCOUNTS[a]!.displayName,
        toAddresses: contact.email,
        ccAddresses: 'hr@example.com',
        bccAddresses: 'manager@example.com',
        subject,
        snippet: 'Looking forward to working with you!',
        date,
        isRead: true,
        isStarred: false,
        bodyHtml: BODY_INLINE,
      });
    }

    // 5. Local draft (restricted, encrypted + signed).
    {
      const draftId = deterministicId('draft', accountId);
      await db.execute(
        `INSERT OR REPLACE INTO local_drafts (
          id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_html,
          reply_to_message_id, thread_id, from_email, signature_id, remote_draft_id,
          attachments, classification_id, is_encrypted, is_signed, created_at, updated_at, sync_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, 'pending')`,
        [
          draftId,
          accountId,
          'carol.white@example.com, david@contoso.com',
          'bob.smith@example.com',
          null,
          'Draft: Project Apollo update',
          '<p>Hi Carol and David,</p><p>Here is the latest update on Project Apollo...</p>',
          null,
          null,
          accountEmail,
          null,
          null,
          null,
          'restricted',
          1,
          1,
          nowSeconds(),
        ],
      );
    }

    // 6. Spam.
    {
      const threadId = deterministicId('thread', accountId, 'spam');
      const subject = 'Congratulations, you won!';
      const snippet = 'Click here to claim your prize.';
      const date = baseTime - 3600 * 48;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet,
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: false,
        primaryLabel: 'spam',
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'spam'),
        accountId,
        threadId,
        fromAddress: 'prizes@totally-legit.example',
        fromName: 'Prize Department',
        toAddresses: accountEmail,
        subject,
        snippet,
        date,
        isRead: true,
        isStarred: false,
        bodyHtml: BODY_NEWSLETTER,
      });
    }

    // 7. Trash.
    {
      const threadId = deterministicId('thread', accountId, 'trash');
      const subject = 'Expired coupon';
      const snippet = 'This coupon has expired.';
      const date = baseTime - 3600 * 72;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet,
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: false,
        primaryLabel: 'trash',
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'trash'),
        accountId,
        threadId,
        fromAddress: 'deals@shop.example',
        fromName: 'Shop Deals',
        toAddresses: accountEmail,
        subject,
        snippet,
        date,
        isRead: true,
        isStarred: false,
      });
    }

    // 8. Forward thread with table budget (restricted, signed).
    {
      const threadId = deterministicId('thread', accountId, 'forward');
      const subject = 'Fwd: Conference notes';
      const contact = CONTACTS[4]!; // Frank
      const date = baseTime - 3600 * 4;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'Sharing the notes from yesterday.',
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: true,
        hasAttachments: false,
        primaryLabel: 'inbox',
        classificationId: 'restricted',
        isEncrypted: false,
        isSigned: true,
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'forward'),
        accountId,
        threadId,
        fromAddress: contact.email,
        fromName: contact.displayName,
        toAddresses: accountEmail,
        subject,
        snippet: 'Sharing the notes from yesterday.',
        date,
        isRead: true,
        isStarred: false,
        bodyHtml: BODY_TABLE,
        classificationId: 'restricted',
        isEncrypted: false,
        isSigned: true,
      });
    }

    // 9. Multi-participant reply chain.
    {
      const threadId = deterministicId('thread', accountId, 'multi');
      const subject = 'Lunch next week?';
      const contact1 = CONTACTS[1]!; // Carol
      const contact2 = CONTACTS[2]!; // David
      const date1 = baseTime - 3600 * 16;
      const date2 = baseTime - 3600 * 10;
      const date3 = baseTime - 3600 * 3;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'Can we reschedule to Thursday?',
        lastMessageAt: date3,
        messageCount: 3,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: false,
        primaryLabel: 'inbox',
      });
      const msg1Id = deterministicId('msg', accountId, 'multi', 1);
      const msg2Id = deterministicId('msg', accountId, 'multi', 2);
      const msg3Id = deterministicId('msg', accountId, 'multi', 3);
      await createMessage(db, {
        id: msg1Id,
        accountId,
        threadId,
        fromAddress: contact1.email,
        fromName: contact1.displayName,
        toAddresses: `${accountEmail}, ${contact2.email}`,
        subject,
        snippet: 'Are folks free for lunch next week?',
        date: date1,
        isRead: true,
        isStarred: false,
      });
      await createMessage(db, {
        id: msg2Id,
        accountId,
        threadId,
        fromAddress: contact2.email,
        fromName: contact2.displayName,
        toAddresses: `${accountEmail}, ${contact1.email}`,
        subject: `Re: ${subject}`,
        snippet: 'Tuesday works for me.',
        date: date2,
        isRead: true,
        isStarred: false,
        inReplyTo: `<${msg1Id}@dummy.kylins>`,
      });
      await createMessage(db, {
        id: msg3Id,
        accountId,
        threadId,
        fromAddress: accountEmail,
        fromName: ACCOUNTS[a]!.displayName,
        toAddresses: `${contact1.email}, ${contact2.email}`,
        subject: `Re: ${subject}`,
        snippet: 'Can we reschedule to Thursday?',
        date: date3,
        isRead: true,
        isStarred: false,
        inReplyTo: `<${msg2Id}@dummy.kylins>`,
      });
    }

    // 10. Complex marketing email with inline images and attachment.
    {
      const threadId = deterministicId('thread', accountId, 'marketing');
      const subject = 'Big summer sale 🌞';
      const snippet = 'Save up to 50% this weekend.';
      const date = baseTime - 3600 * 30;
      const contentId = 'hero@dummy';
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet,
        lastMessageAt: date,
        messageCount: 1,
        isRead: false,
        isStarred: false,
        isImportant: false,
        hasAttachments: true,
        primaryLabel: 'inbox',
        extraLabels: ['newsletters'],
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'marketing'),
        accountId,
        threadId,
        fromAddress: 'marketing@shop.example',
        fromName: 'Summer Shop',
        toAddresses: accountEmail,
        subject,
        snippet,
        date,
        isRead: false,
        isStarred: false,
        bodyHtml: BODY_NEWSLETTER!.replace('alt="header"', `alt="header" id="${contentId}"`),
        attachments: [
          {
            filename: 'summer-catalog.pdf',
            mimeType: 'application/pdf',
            size: 1048576,
          },
          {
            filename: 'hero.png',
            mimeType: 'image/png',
            size: 4096,
            isInline: true,
            contentId: contentId,
          },
        ],
      });
    }

    // 11. Multi-image screenshot thread (confidential, encrypted + signed).
    {
      const threadId = deterministicId('thread', accountId, 'screenshots');
      const subject = 'UI feedback';
      const contact = CONTACTS[5]!; // Grace
      const date = baseTime - 3600 * 6;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'Screenshots from the latest build.',
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: true,
        isImportant: false,
        hasAttachments: false,
        primaryLabel: 'inbox',
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'screenshots'),
        accountId,
        threadId,
        fromAddress: contact.email,
        fromName: contact.displayName,
        toAddresses: accountEmail,
        ccAddresses: 'design@studio.example',
        subject,
        snippet: 'Screenshots from the latest build.',
        date,
        isRead: true,
        isStarred: true,
        bodyHtml: BODY_GALLERY,
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
    }

    // 12. Board memo (confidential, encrypted + signed).
    {
      const threadId = deterministicId('thread', accountId, 'board-memo');
      const subject = 'Board memo: FY26 strategic plan';
      const contact = CONTACTS[6]!; // GitHub (reuse as corporate sender)
      const date = baseTime - 3600 * 5;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'Please review the attached draft before Friday.',
        lastMessageAt: date,
        messageCount: 1,
        isRead: false,
        isStarred: false,
        isImportant: true,
        hasAttachments: true,
        primaryLabel: 'inbox',
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'board-memo'),
        accountId,
        threadId,
        fromAddress: contact.email,
        fromName: 'Corporate Secretary',
        toAddresses: accountEmail,
        subject,
        snippet: 'Please review the attached draft before Friday.',
        date,
        isRead: false,
        isStarred: false,
        bodyHtml: BODY_TABLE,
        attachments: [{ filename: 'fy26-plan.pdf', mimeType: 'application/pdf', size: 768000 }],
        classificationId: 'confidential',
        isEncrypted: true,
        isSigned: true,
      });
    }

    // 13. Vendor contract (restricted, encrypted + signed).
    {
      const threadId = deterministicId('thread', accountId, 'vendor-contract');
      const subject = 'Vendor contract: engineering tools';
      const contact = CONTACTS[7]!; // Figma (reuse as vendor contact)
      const date = baseTime - 3600 * 9;
      await createThread(db, {
        id: threadId,
        accountId,
        subject,
        snippet: 'The negotiated terms are in the attachment.',
        lastMessageAt: date,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: true,
        primaryLabel: 'inbox',
        classificationId: 'restricted',
        isEncrypted: true,
        isSigned: true,
      });
      await createMessage(db, {
        id: deterministicId('msg', accountId, 'vendor-contract'),
        accountId,
        threadId,
        fromAddress: contact.email,
        fromName: 'Vendor Relations',
        toAddresses: accountEmail,
        ccAddresses: 'procurement@example.com',
        subject,
        snippet: 'The negotiated terms are in the attachment.',
        date,
        isRead: true,
        isStarred: false,
        bodyHtml: BODY_INLINE,
        attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', size: 512000 }],
        classificationId: 'restricted',
        isEncrypted: true,
        isSigned: true,
      });
    }
  }
}

async function seedCalendars(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const baseTime = nowSeconds();
  const dayStart = baseTime - (baseTime % 86400);

  for (const accountId of ACCOUNT_IDS) {
    const calendarId = deterministicId('cal', accountId);
    await db.execute(
      `INSERT OR REPLACE INTO calendars (
        id, account_id, provider, remote_id, display_name, color, is_primary, is_visible
      ) VALUES ($1, $2, 'google', $3, 'My Calendar', '#0ea5e9', 1, 1)`,
      [calendarId, accountId, `remote-${accountId}`],
    );

    const events = [
      {
        id: deterministicId('event', accountId, 'past'),
        summary: 'Yesterday retrospective',
        start: dayStart - 86400 + 15 * 3600,
        end: dayStart - 86400 + 16 * 3600,
        isAllDay: false,
      },
      {
        id: deterministicId('event', accountId, 'today'),
        summary: 'Team standup',
        start: dayStart + 9 * 3600,
        end: dayStart + 9.5 * 3600,
        isAllDay: false,
      },
      {
        id: deterministicId('event', accountId, 'tomorrow-allday'),
        summary: 'Company offsite',
        start: dayStart + 86400,
        end: dayStart + 86400,
        isAllDay: true,
      },
      {
        id: deterministicId('event', accountId, 'multiday'),
        summary: 'Conference',
        start: dayStart + 2 * 86400 + 9 * 3600,
        end: dayStart + 4 * 86400 + 17 * 3600,
        isAllDay: false,
      },
      {
        id: deterministicId('event', accountId, 'future'),
        summary: 'Sprint planning',
        start: dayStart + 5 * 86400 + 14 * 3600,
        end: dayStart + 5 * 86400 + 15 * 3600,
        isAllDay: false,
      },
    ];

    for (let i = 0; i < events.length; i++) {
      const evt = events[i]!;
      await db.execute(
        `INSERT OR REPLACE INTO calendar_events (
          id, account_id, google_event_id, calendar_id, summary, description,
          location, start_time, end_time, is_all_day, status, organizer_email, attendees_json,
          remote_event_id, uid, recurrence_start, recurrence_end
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', $11, $12, $3, $13, $14, $15)`,
        [
          evt.id,
          accountId,
          `evt-${accountId}-${i}`,
          calendarId,
          evt.summary,
          'Generated dummy calendar event for testing.',
          'Conference Room A',
          evt.start,
          evt.end,
          evt.isAllDay ? 1 : 0,
          accountId === ACCOUNT_IDS[0] ? 'alice.doe@gmail.com' : 'alice@example.com',
          JSON.stringify([
            { email: 'bob.smith@example.com', responseStatus: 'accepted' },
            { email: 'carol.white@example.com', responseStatus: 'tentative' },
          ]),
          `uid-${accountId}-${i}@kylins`,
          evt.start,
          evt.end,
        ],
      );
    }
  }
}

async function seedSignatures(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  for (const accountId of ACCOUNT_IDS) {
    for (let i = 0; i < SIGNATURES.length; i++) {
      const sig = SIGNATURES[i]!;
      const id = deterministicId('sig', accountId, i);
      await db.execute(
        `INSERT OR REPLACE INTO signatures (id, account_id, name, body_html, is_default, sort_order, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, accountId, sig.name, sig.bodyHtml, sig.isDefault ? 1 : 0, i, sig.context],
      );
    }
  }
}

async function seedTemplates(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  for (const accountId of ACCOUNT_IDS) {
    for (let i = 0; i < TEMPLATES.length; i++) {
      const tmpl = TEMPLATES[i]!;
      const id = deterministicId('tmpl', accountId, i);
      await db.execute(
        `INSERT OR REPLACE INTO templates (id, account_id, name, subject, body_html, shortcut, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, accountId, tmpl.name, tmpl.subject, tmpl.bodyHtml, tmpl.shortcut || null, i],
      );
    }
  }
}

async function seedTasks(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const baseTime = nowSeconds();

  for (const accountId of ACCOUNT_IDS) {
    for (let i = 0; i < TASKS.length; i++) {
      const task = TASKS[i]!;
      const id = deterministicId('task', accountId, i);
      const dueDate = task.dueOffsetDays !== null ? baseTime + task.dueOffsetDays * 86400 : null;
      const completedAt = task.isCompleted ? baseTime - 86400 : null;
      await db.execute(
        `INSERT OR REPLACE INTO tasks (
          id, account_id, title, description, priority, is_completed, completed_at,
          due_date, sort_order, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          id,
          accountId,
          task.title,
          'Generated dummy task for testing.',
          task.priority,
          task.isCompleted ? 1 : 0,
          completedAt,
          dueDate,
          i,
          nowSeconds(),
        ],
      );
    }
  }
}

async function clearDummyData(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  // Delete in an order that respects foreign keys.
  for (const accountId of ACCOUNT_IDS) {
    await db.execute('DELETE FROM tasks WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM templates WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM signatures WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM calendar_events WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM calendars WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM local_drafts WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM message_bodies WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM attachments WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM messages WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM thread_labels WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM threads WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM labels WHERE account_id = $1', [accountId]);
    await db.execute('DELETE FROM accounts WHERE id = $1', [accountId]);
  }
}

/**
 * Seed the local database with dummy accounts, contacts, labels, threads,
 * messages, attachments, drafts, calendars, events, signatures, templates, and
 * tasks covering a variety of scenarios (read/unread, starred, important, sent,
 * drafts, spam, trash, reply chains, forwards, multi-participant threads,
 * complex HTML bodies with images/tables, inline attachments, CC/BCC
 * recipients, all-day/multi-day events, and completed/overdue tasks).
 *
 * Safe to call multiple times: deterministic IDs and INSERT OR REPLACE keep
 * rows stable across re-runs.
 */
export async function seedDummyData(options: SeedDummyDataOptions = {}): Promise<void> {
  const db = await getDb();

  // Make sure the latest schema (including the signatures.context column) is in
  // place before inserting any dummy rows.
  await runMigrations();

  if (options.clearExisting) {
    await clearDummyData(db);
  }

  await seedAccounts(db);
  await seedContacts(db);
  await seedLabels(db);
  await seedThreadsAndMessages(db);
  await seedCalendars(db);
  await seedSignatures(db);
  await seedTemplates(db);
  await seedTasks(db);

  console.log('[seedDummyData] dummy data seeded');
}

/** Remove all dummy data created by {@link seedDummyData}. */
export async function clearAllDummyData(): Promise<void> {
  const db = await getDb();
  await clearDummyData(db);
  console.log('[seedDummyData] dummy data cleared');
}
