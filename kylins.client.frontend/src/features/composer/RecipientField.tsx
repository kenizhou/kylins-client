// Tokenizing recipient field over structured Recipient[] (composer header for
// To/Cc/Bcc). Shows the display name when present (falling back to the email),
// flags invalid addresses in red, parses pasted multi-recipient blobs, and
// autocompletes from the contacts DB. This replaces the string-based
// AddressInput for the composer surfaces.

import { useState, useRef, useCallback, useEffect } from 'react';
import { searchContacts, type DbContact } from '@/services/db/contacts';
import { parseRecipients, isValidEmail, type Recipient } from '@/features/composer/contacts';

interface RecipientFieldProps {
  label: string;
  recipients: Recipient[];
  onChange: (recipients: Recipient[]) => void;
  placeholder?: string;
}

export function RecipientField({
  label,
  recipients,
  onChange,
  placeholder = 'Add recipients…',
}: RecipientFieldProps) {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<DbContact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  // Which recipient chip has its action menu open (arrow click or right-click).
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
      const parsed = parseRecipients(text).filter(
        (r) => !recipients.some((x) => x.email.toLowerCase() === r.email.toLowerCase()),
      );
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
    }
  };

  return (
    <div className="flex items-start gap-2">
      <span className="w-8 shrink-0 pt-1.5 text-xs text-[var(--muted-text)]">{label}</span>
      <div className="relative flex min-h-[32px] flex-1 flex-wrap items-center gap-1">
        {recipients.map((r, i) => {
          const invalid = !isValidEmail(r.email);
          const menuOpen = menuIndex === i;
          return (
            <span
              key={`${r.email}-${i}`}
              title={r.email}
              className={`relative inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs ${
                invalid
                  ? 'bg-[var(--destructive)]/15 text-[var(--destructive)] ring-1 ring-[var(--destructive)]/40'
                  : 'bg-[var(--accent)] text-[var(--selected-text)]'
              }`}
              onContextMenu={(e) => {
                // Right-click a recipient to open its action menu (copy / remove).
                e.preventDefault();
                setMenuIndex(i);
              }}
            >
              <span className="max-w-[180px] truncate">
                {r.name !== r.email ? r.name : r.email}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuIndex(menuOpen ? null : i);
                }}
                className="text-[0.625rem] leading-none opacity-70 hover:opacity-100"
                aria-label={`Actions for ${r.email}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                ▾
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
                    className="absolute right-0 top-full z-50 mt-1 min-w-[168px] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--popover)] py-1 text-[var(--foreground)] shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => copyAddress(i)}
                      className="block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--hover)]"
                    >
                      {copiedIndex === i ? 'Copied!' : 'Copy email address'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        removeAt(i);
                        setMenuIndex(null);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-[var(--destructive)] hover:bg-[var(--hover)]"
                    >
                      Remove
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
          className="min-w-[120px] flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-text)]"
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
    </div>
  );
}
