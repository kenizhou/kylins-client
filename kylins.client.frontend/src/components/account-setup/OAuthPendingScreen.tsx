import { Input } from 'react-aria-components';
import { useState, useEffect, useRef } from 'react';
import { SetupCard, SetupHeader, SetupButton, SetupBackButton } from './setup-ui';

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
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(fallbackUrl);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <SetupCard>
      <SetupHeader
        eyebrow={providerName}
        title="Sign in with your browser"
        subtitle="A browser window should have opened. Finish signing in there and we’ll connect your account automatically."
        hideMark
      />

      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-3 text-sm text-muted-text">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Waiting for sign-in…
        </div>

        {fallbackUrl && (
          <div className="w-full">
            <label
              className="mb-1.5 block type-caption text-muted-text"
              htmlFor="oauth-fallback-url"
            >
              Didn’t open? Paste this URL into your browser:
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="oauth-fallback-url"
                readOnly
                value={fallbackUrl}
                className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
              />
              <SetupButton variant="secondary" onPress={copy}>
                {copied ? 'Copied' : 'Copy'}
              </SetupButton>
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 flex justify-center">
        <SetupBackButton onPress={onCancel} />
      </div>
    </SetupCard>
  );
}
