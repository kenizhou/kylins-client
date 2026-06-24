// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client (restyled to CSS-var tokens).
//
// Tokenizing recipient input with frequency-ranked contacts autocomplete.
// Enter / Tab / "," commits a token; Backspace removes the last; arrow keys
// navigate suggestions. The 200ms-debounced search only fires for ≥2 chars.

import { useState, useRef, useCallback, useEffect } from 'react';
import { searchContacts, type DbContact } from '@/services/db/contacts';

interface AddressInputProps {
  label: string;
  addresses: string[];
  onChange: (addresses: string[]) => void;
  placeholder?: string;
}

export function AddressInput({
  label,
  addresses,
  onChange,
  placeholder = 'Add recipients...',
}: AddressInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<DbContact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
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

  const addAddress = useCallback(
    (address: string) => {
      const trimmed = address.trim();
      if (trimmed && !addresses.includes(trimmed)) {
        onChange([...addresses, trimmed]);
      }
      setInputValue('');
      setSuggestions([]);
      setShowSuggestions(false);
      inputRef.current?.focus();
    },
    [addresses, onChange],
  );

  const removeAddress = useCallback(
    (index: number) => {
      onChange(addresses.filter((_, i) => i !== index));
    },
    [addresses, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
      e.preventDefault();
      if (showSuggestions && selectedIdx >= 0 && suggestions[selectedIdx]) {
        addAddress(suggestions[selectedIdx]!.email);
      } else if (inputValue.trim()) {
        addAddress(inputValue);
      }
    } else if (e.key === 'Backspace' && !inputValue && addresses.length > 0) {
      removeAddress(addresses.length - 1);
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
      <span className="w-8 shrink-0 pt-1.5 text-xs text-[var(--muted-foreground)]">{label}</span>
      <div className="relative flex min-h-[32px] flex-1 flex-wrap items-center gap-1">
        {addresses.map((addr) => (
          <span
            key={addr}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs text-[var(--selected-text)]"
          >
            {addr}
            <button
              onClick={() => onChange(addresses.filter((a) => a !== addr))}
              className="text-[0.625rem] leading-none hover:text-[var(--destructive)]"
              aria-label={`Remove ${addr}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Delay to allow click on suggestion.
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => setShowSuggestions(false), 150);
            if (inputValue.trim()) addAddress(inputValue);
          }}
          placeholder={addresses.length === 0 ? placeholder : ''}
          aria-label={label}
          className="min-w-[120px] flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
        />

        {/* Autocomplete dropdown */}
        {showSuggestions && (
          <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg">
            {suggestions.map((contact, i) => (
              <button
                key={contact.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addAddress(contact.email)}
                className={`w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--hover)] ${
                  i === selectedIdx ? 'bg-[var(--hover)]' : ''
                }`}
              >
                <div className="text-[var(--foreground)]">
                  {contact.display_name ?? contact.email}
                </div>
                {contact.display_name && (
                  <div className="text-xs text-[var(--muted-foreground)]">{contact.email}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
