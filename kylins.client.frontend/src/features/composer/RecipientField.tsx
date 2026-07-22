// Tokenizing recipient field over structured Recipient[] (composer header for
// To/Cc/Bcc). Shows the display name when present (falling back to the email),
// flags invalid addresses in red, parses pasted multi-recipient blobs, and
// autocompletes from the contacts DB. This replaces the string-based
// AddressInput for the composer surfaces.

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { searchContacts, type DbContact } from '@/services/db/contacts';
import {
  parseRecipients,
  isValidEmail,
  formatRecipient,
  type Recipient,
} from '@/features/composer/contacts';
import { CopyIcon, MoveIcon, TrashIcon, CaretDownIcon } from '@/components/icons';

export type MoveTarget = 'to' | 'cc' | 'bcc' | 'replyTo';

interface RecipientFieldProps {
  label: string;
  recipients: Recipient[];
  onChange: (recipients: Recipient[]) => void;
  placeholder?: string;
  moveTargets?: { label: string; target: MoveTarget }[];
  onMove?: (recipient: Recipient, target: MoveTarget) => void;
  /** Optional content pinned to the right edge of the row (e.g. Cc/Bcc toggles). */
  trailing?: ReactNode;
}

export function RecipientField({
  label,
  recipients,
  onChange,
  placeholder = 'Add recipients…',
  moveTargets,
  onMove,
  trailing,
}: RecipientFieldProps) {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<DbContact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  // Which recipient chip has its action menu open (chip click or right-click).
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.length >= 2) {
      searchTimerRef.current = setTimeout(async () => {
        const results = await searchContacts(value, 5);
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
        setSelectedIdx(-1);
      }, 200);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, []);

  const addFromText = useCallback(
    (text: string) => {
      // parseRecipients handles comma/semicolon split, "Name <email>", and
      // produces one invalid recipient for unparseable blobs (so it surfaces as
      // a red chip rather than being silently dropped).
      const existing = new Set(recipients.map((r) => r.email.toLowerCase()));
      const parsed = parseRecipients(text).filter((r) => !existing.has(r.email.toLowerCase()));
      if (parsed.length > 0) onChange([...recipients, ...parsed]);
      setInputValue('');
      setSuggestions([]);
      setShowSuggestions(false);
      inputRef.current?.focus();
    },
    [recipients, onChange],
  );

  const addContact = useCallback(
    (contact: DbContact) => {
      const email = contact.email;
      if (recipients.some((x) => x.email.toLowerCase() === email.toLowerCase())) {
        setInputValue('');
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }
      onChange([...recipients, { name: contact.display_name?.trim() || email, email }]);
      setInputValue('');
      setSuggestions([]);
      setShowSuggestions(false);
      inputRef.current?.focus();
    },
    [recipients, onChange],
  );

  const removeAt = useCallback(
    (index: number) => {
      onChange(recipients.filter((_, i) => i !== index));
    },
    [recipients, onChange],
  );

  const copyAddress = useCallback(
    (i: number) => {
      const r = recipients[i];
      if (!r) return;
      navigator.clipboard?.writeText(r.email).catch(() => {});
      setCopiedIndex(i);
      setMenuIndex(null);
      setTimeout(() => setCopiedIndex((cur) => (cur === i ? null : cur)), 1200);
    },
    [recipients],
  );

  const moveRecipient = useCallback(
    (i: number, target: MoveTarget) => {
      const r = recipients[i];
      if (!r || !onMove) return;
      onMove(r, target);
      setMenuIndex(null);
    },
    [recipients, onMove],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (showSuggestions && selectedIdx >= 0 && suggestions[selectedIdx]) {
        e.preventDefault();
        addContact(suggestions[selectedIdx]!);
      } else if (inputValue.trim()) {
        e.preventDefault();
        addFromText(inputValue);
      }
    } else if (e.key === 'Backspace' && !inputValue && recipients.length > 0) {
      removeAt(recipients.length - 1);
    } else if (e.key === 'ArrowDown' && showSuggestions) {
      e.preventDefault();
      setSelectedIdx((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp' && showSuggestions) {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setMenuIndex(null);
    }
  };

  const hasMoveOptions = moveTargets && moveTargets.length > 0 && onMove;

  return (
    <div className="flex items-start gap-2">
      <span className="w-8 shrink-0 pt-1.5 text-xs font-medium text-[var(--muted-text)]">
        {label}
      </span>
      <div className="relative flex min-h-[32px] flex-1 flex-wrap items-center gap-1">
        {recipients.map((r, i) => {
          const invalid = !isValidEmail(r.email);
          const menuOpen = menuIndex === i;
          return (
            <span
              key={`${r.email}-${i}`}
              title={r.email}
              className={`group relative inline-flex items-center gap-1 rounded pl-2.5 pr-1 py-0.5 text-xs cursor-pointer transition-colors ${
                invalid
                  ? 'bg-[var(--destructive)]/15 text-[var(--destructive)] ring-1 ring-[var(--destructive)]/40'
                  : 'bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--hover)]'
              }`}
              onClick={(e) => {
                // Left-click the chip (but not the arrow button) opens the menu.
                if ((e.target as HTMLElement).closest('[data-chip-arrow]')) return;
                setMenuIndex(menuOpen ? null : i);
              }}
              onContextMenu={(e) => {
                // Right-click a recipient to open its action menu.
                e.preventDefault();
                setMenuIndex(i);
              }}
            >
              <span className="max-w-[260px] truncate">{formatRecipient(r)}</span>
              <button
                type="button"
                data-chip-arrow
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuIndex(menuOpen ? null : i);
                }}
                className="relative flex h-6 w-6 items-center justify-center rounded text-[0.625rem] leading-none opacity-60 hover:bg-black/10 hover:opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Actions for ${r.email}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="absolute -inset-1" aria-hidden="true" />
                <CaretDownIcon size={10} />
              </button>
              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuIndex(null)}
                    aria-hidden="true"
                  />
                  <div
                    role="menu"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setMenuIndex(null);
                    }}
                    className="absolute left-0 top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--popover)] py-1 text-[var(--popover-foreground)] shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => copyAddress(i)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--hover)] transition-colors"
                    >
                      <CopyIcon size={14} />
                      <span>{copiedIndex === i ? 'Copied!' : 'Copy email address'}</span>
                    </button>
                    {hasMoveOptions && (
                      <>
                        <div className="my-1 border-t border-[var(--border)]" />
                        {moveTargets.map((target) => (
                          <button
                            key={target.target}
                            type="button"
                            role="menuitem"
                            onClick={() => moveRecipient(i, target.target)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--hover)] transition-colors"
                          >
                            <MoveIcon size={14} />
                            <span>Move to {target.label}</span>
                          </button>
                        ))}
                      </>
                    )}
                    <div className="my-1 border-t border-[var(--border)]" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        removeAt(i);
                        setMenuIndex(null);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--destructive)] hover:bg-[var(--hover)] transition-colors"
                    >
                      <TrashIcon size={14} />
                      <span>Remove</span>
                    </button>
                  </div>
                </>
              )}
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Delay so a suggestion click registers before the dropdown closes.
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => setShowSuggestions(false), 150);
            if (inputValue.trim()) addFromText(inputValue);
          }}
          placeholder={recipients.length === 0 ? placeholder : ''}
          aria-label={label}
          className="min-w-[120px] flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
        />

        {showSuggestions && (
          <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg">
            {suggestions.map((contact, i) => (
              <button
                key={contact.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addContact(contact)}
                className={`w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--hover)] ${
                  i === selectedIdx ? 'bg-[var(--hover)]' : ''
                }`}
              >
                <div className="text-[var(--foreground)]">
                  {contact.display_name ?? contact.email}
                </div>
                {contact.display_name && (
                  <div className="text-xs text-[var(--muted-text)]">{contact.email}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}
