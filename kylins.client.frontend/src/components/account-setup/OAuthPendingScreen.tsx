import { useState } from 'react';

export interface OAuthPendingScreenProps {
  providerName: string;
  fallbackUrl: string;
  onCancel: () => void;
}

export function OAuthPendingScreen({
  providerName,
  fallbackUrl,
  onCancel,
}: OAuthPendingScreenProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(fallbackUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">
        Sign in with {providerName} in your browser.
      </h1>
      <p className="text-sm text-[var(--muted-text)]">
        Page didn’t open? Paste this URL into your browser:
      </p>
      <div className="flex w-full items-center gap-2">
        <input
          readOnly
          value={fallbackUrl}
          className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)]"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded border border-[var(--border)] px-3 py-2 text-xs text-[var(--foreground)]"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="flex items-center gap-2 text-sm text-[var(--muted-text)]">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
        Waiting for sign-in…
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-sm text-[var(--muted-text)] underline"
      >
        Cancel
      </button>
    </div>
  );
}
