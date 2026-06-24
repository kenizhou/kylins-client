import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CloseIcon, MinimizeIcon, MaximizeIcon, RestoreIcon } from '../icons';
import type { SetupProviderId } from '../../services/auth/providers';

// ---------------------------------------------------------------------------
// Brand / provider accents
// ---------------------------------------------------------------------------

export const PROVIDER_ACCENTS: Record<SetupProviderId, string> = {
  gmail: '#EA4335',
  outlook: '#0078D4',
  microsoft365: '#D83B01',
  yahoo: '#6001D2',
  imap: '#6B7280',
  exchange: '#0078D4',
};

/**
 * Distinctive per-provider glyph (white-on-brand). Generic iconography, not
 * trademarked logos — cleaner than the single-letter badges they replace.
 */
export function ProviderGlyph({
  id,
  className = 'h-5 w-5',
}: {
  id: SetupProviderId;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {renderProviderGlyph(id)}
    </svg>
  );
}

function renderProviderGlyph(id: SetupProviderId) {
  switch (id) {
    case 'gmail':
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M3.5 7.5L12 13l8.5-5.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'outlook':
      return (
        <>
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
        </>
      );
    case 'microsoft365':
      return (
        <>
          <rect x="4" y="4" width="7" height="7" rx="1" fill="currentColor" />
          <rect x="13" y="4" width="7" height="7" rx="1" fill="currentColor" />
          <rect x="4" y="13" width="7" height="7" rx="1" fill="currentColor" />
          <rect x="13" y="13" width="7" height="7" rx="1" fill="currentColor" />
        </>
      );
    case 'yahoo':
      return (
        <>
          <path
            d="M5 6l5 7v5M19 6l-5 7"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="19" cy="18.5" r="1.4" fill="currentColor" />
        </>
      );
    case 'exchange':
      return (
        <>
          <path
            d="M4 10a8 8 0 0 1 13-3.5L20 9"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M20 14a8 8 0 0 1-13 3.5L4 15"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M20 4v5h-5M4 20v-5h5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'imap':
    default:
      return (
        <>
          <path
            d="M4 7.5L12 4l8 3.5-8 3.5-8-3.5z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M4 12l8 3.5L20 12M4 16.5L12 20l8-3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// Signature mark — stylized envelope / qilin horn glyph
// ---------------------------------------------------------------------------

export function KylinsMark({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="10" className="fill-current opacity-10" />
      <path
        d="M11 16L20 11L29 16L20 29L11 16Z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M13 17.5L20 22L27 17.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Window chrome for the fullscreen setup flow
// ---------------------------------------------------------------------------

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

function SetupTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null);

  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) return;

    let unlisten: (() => void) | undefined;
    try {
      const appWindow = getCurrentWindow();
      appWindowRef.current = appWindow;

      async function init() {
        setIsMaximized(await appWindow.isMaximized());
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
      }

      init();
    } catch {
      // Not a real Tauri window context (e.g. jsdom tests that set the
      // internals sentinel but don't mock the window API).
    }

    return () => {
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => appWindowRef.current?.minimize();
  const handleToggleMaximize = () => appWindowRef.current?.toggleMaximize();
  const handleClose = () => appWindowRef.current?.close();

  return (
    <div
      className="relative z-50 flex h-10 shrink-0 items-center justify-end border-b border-[var(--border)] bg-[var(--surface)] px-2 select-none"
      style={dragStyle}
    >
      <div className="flex items-center" style={noDragStyle}>
        <button
          type="button"
          onClick={handleMinimize}
          className="inline-flex h-7 w-9 items-center justify-center text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          aria-label="Minimize"
        >
          <MinimizeIcon size={14} />
        </button>
        <button
          type="button"
          onClick={handleToggleMaximize}
          className="inline-flex h-7 w-9 items-center justify-center text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="inline-flex h-7 w-9 items-center justify-center text-[var(--muted-text)] transition-colors hover:bg-red-500 hover:text-white"
          aria-label="Close"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout shell
// ---------------------------------------------------------------------------

export interface SetupShellProps {
  variant: 'fullscreen' | 'modal';
  children: ReactNode;
}

export function SetupShell({ variant, children }: SetupShellProps) {
  const isFullscreen = variant === 'fullscreen';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--background)]">
      {isFullscreen && <SetupTitleBar />}
      <div
        className="relative flex flex-1 items-center justify-center overflow-y-auto p-6"
        style={isFullscreen ? dragStyle : undefined}
      >
        {/* Subtle ambient radial wash behind the card */}
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              'radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--primary) 12%, transparent), transparent 60%)',
          }}
        />
        <div className="relative w-full" style={noDragStyle}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface SetupCardProps {
  children: ReactNode;
  className?: string;
  width?: 'md' | 'lg';
}

export function SetupCard({ children, className = '', width = 'md' }: SetupCardProps) {
  const widthClass = width === 'lg' ? 'max-w-2xl' : 'max-w-md';
  return (
    <div
      className={`setup-fade mx-auto w-full ${widthClass} rounded-xl border border-[var(--border)] bg-[var(--card)] p-8 shadow-lg shadow-black/5 ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface SetupHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: 'left' | 'center';
  hideMark?: boolean;
}

export function SetupHeader({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  hideMark = false,
}: SetupHeaderProps) {
  const alignClass = align === 'center' ? 'text-center' : 'text-left';

  return (
    <div className={`mb-8 flex flex-col ${alignClass}`}>
      {!hideMark && (
        <div className={`mb-4 flex ${align === 'center' ? 'justify-center' : 'justify-start'}`}>
          <KylinsMark className="h-10 w-10 text-[var(--primary)]" />
        </div>
      )}
      {eyebrow && (
        <span className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--primary)]">
          {eyebrow}
        </span>
      )}
      <h1 className="text-2xl font-semibold text-[var(--foreground)] sm:text-3xl">{title}</h1>
      {subtitle && (
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted-text)]">{subtitle}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface SetupButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
}

export function SetupButton({
  children,
  variant = 'primary',
  loading = false,
  disabled,
  className = '',
  ...rest
}: SetupButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50';
  const variantClass =
    variant === 'primary'
      ? 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 active:scale-[0.98]'
      : variant === 'secondary'
        ? 'border border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--hover)]'
        : 'text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]';

  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`${base} ${variantClass} ${className}`}
      {...rest}
    >
      {loading && (
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const inputBase =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm text-[var(--foreground)] shadow-sm transition-colors placeholder:text-[var(--muted-text)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]';

export const SetupInput = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input className={inputBase} {...props} />
);

export const SetupSelect = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={`${inputBase} appearance-none bg-[var(--background)]`} {...props} />
);

export function SetupField({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-[var(--foreground)]">{label}</span>
        {children}
      </label>
      {hint && <span className="text-xs text-[var(--muted-text)]">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Back button
// ---------------------------------------------------------------------------

export function SetupBackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted-text)] transition-colors hover:text-[var(--foreground)]"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M10 12L6 8L10 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Back
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step transition wrapper
// ---------------------------------------------------------------------------

export function SetupStepTransition({ children }: { children: ReactNode }) {
  return <div className="setup-fade">{children}</div>;
}

// ---------------------------------------------------------------------------
// Provider tile (used by ProviderPicker)
// ---------------------------------------------------------------------------

export interface ProviderTileProps {
  name: string;
  id: SetupProviderId;
  onClick: () => void;
  style?: React.CSSProperties;
}

export function ProviderTile({ name, id, onClick, style }: ProviderTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="setup-stagger-child group relative flex items-center gap-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--primary)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      style={style}
    >
      <span
        className="absolute left-0 top-0 h-full w-1"
        style={{ backgroundColor: PROVIDER_ACCENTS[id] }}
      />
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white"
        style={{ backgroundColor: PROVIDER_ACCENTS[id] }}
      >
        <ProviderGlyph id={id} className="h-5 w-5" />
      </span>
      <span className="flex-1 text-sm font-semibold text-[var(--foreground)]">{name}</span>
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        className="text-[var(--muted-text)] transition-transform group-hover:translate-x-0.5"
      >
        <path
          d="M6 4L10 8L6 12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
