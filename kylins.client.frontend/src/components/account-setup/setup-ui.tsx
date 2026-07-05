import * as React from 'react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Button,
  Input,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Label,
} from 'react-aria-components';
import {
  CloseIcon,
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
} from '../icons';
import type { SetupProviderId } from '../../services/auth/providers';

// ---------------------------------------------------------------------------
// Brand / provider accents
// ---------------------------------------------------------------------------

export const PROVIDER_ACCENT_VARS: Record<SetupProviderId, string> = {
  gmail: 'var(--provider-gmail)',
  outlook: 'var(--provider-outlook)',
  microsoft365: 'var(--provider-microsoft365)',
  yahoo: 'var(--provider-yahoo)',
  imap: 'var(--provider-imap)',
  exchange: 'var(--provider-exchange)',
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
      data-testid="kylins-mark"
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
      className="relative z-50 flex h-12 shrink-0 items-center justify-end border-b border-border bg-surface px-2 select-none"
      style={dragStyle}
    >
      <div className="flex items-center" style={noDragStyle}>
        <button
          type="button"
          onClick={handleMinimize}
          className="setup-focus-ring inline-flex h-11 w-11 min-h-11 min-w-11 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground"
          aria-label="Minimize"
        >
          <MinimizeIcon size={14} />
        </button>
        <button
          type="button"
          onClick={handleToggleMaximize}
          className="setup-focus-ring inline-flex h-11 w-11 min-h-11 min-w-11 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="setup-focus-ring inline-flex h-11 w-11 min-h-11 min-w-11 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-destructive hover:text-destructive-foreground"
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
  announcement?: string;
  contentRef?: React.RefObject<HTMLElement | null>;
}

export function SetupShell({ variant, children, announcement, contentRef }: SetupShellProps) {
  const isFullscreen = variant === 'fullscreen';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {isFullscreen && <SetupTitleBar />}
      <main
        ref={contentRef}
        className="relative flex flex-1 items-start justify-center overflow-y-auto p-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pr-[calc(1.5rem+env(safe-area-inset-right))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] pl-[calc(1.5rem+env(safe-area-inset-left))]"
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
        {announcement && (
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface SetupCardProps {
  children: ReactNode;
  className?: string;
  width?: 'md' | 'lg' | 'xl';
}

export function SetupCard({ children, className = '', width = 'md' }: SetupCardProps) {
  const widthClass = width === 'xl' ? 'max-w-4xl' : width === 'lg' ? 'max-w-2xl' : 'max-w-md';
  return (
    <div
      className={`setup-fade mx-auto w-full ${widthClass} rounded-2xl border border-border/60 bg-card/95 p-6 shadow-2xl shadow-black/[0.06] backdrop-blur-sm sm:p-8 ${className}`}
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
        <div className={`mb-5 flex ${align === 'center' ? 'justify-center' : 'justify-start'}`}>
          <KylinsMark className="h-12 w-12 text-primary" />
        </div>
      )}
      {eyebrow && (
        <span className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
          {eyebrow}
        </span>
      )}
      <h1 className="text-balance text-[1.75rem] font-semibold tracking-tight text-foreground sm:text-[2rem]">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-3 text-balance text-sm leading-relaxed text-muted-text">{subtitle}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface SetupButtonProps {
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  onPress?: () => void;
}

export function SetupButton({
  children,
  variant = 'primary',
  loading = false,
  disabled,
  className = '',
  type = 'button',
  onPress,
}: SetupButtonProps) {
  const base =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-safe:active:scale-[0.97] motion-safe:hover:-translate-y-px';
  const variantMap = {
    primary: 'bg-primary text-primary-foreground shadow-md hover:bg-primary/90 hover:shadow-lg',
    secondary:
      'border border-border/80 bg-secondary text-secondary-foreground hover:bg-hover hover:border-border hover:shadow-sm',
    ghost: 'text-muted-text hover:bg-hover hover:text-foreground',
  };

  return (
    <Button
      type={type}
      isDisabled={disabled || loading}
      isPending={loading}
      onPress={onPress}
      className={`${base} ${variantMap[variant]} ${className}`}
    >
      {loading && (
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const inputBase =
  'min-h-11 w-full rounded-lg border border-border/80 bg-background px-3.5 py-2.5 text-sm text-foreground shadow-sm transition-all placeholder:text-muted-text/70 hover:border-border hover:bg-background focus:border-primary focus:bg-background focus:outline-none focus:ring-[3px] focus:ring-ring/40 disabled:opacity-50';

export interface SetupInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  describedBy?: string;
}

export const SetupInput = ({ error, describedBy, className = '', ...props }: SetupInputProps) => (
  <Input
    className={`${inputBase} ${error ? 'border-destructive focus:border-destructive focus:ring-destructive/30' : ''} ${className}`}
    aria-invalid={error || undefined}
    aria-describedby={describedBy}
    {...props}
  />
);

export interface SetupSelectOption {
  value: string;
  label: string;
}

export interface SetupSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SetupSelectOption[];
  label?: string;
  ariaLabel?: string;
  error?: boolean;
  describedBy?: string;
}

export function SetupSelect({
  id,
  value,
  onChange,
  options,
  label,
  ariaLabel,
  error,
  describedBy,
}: SetupSelectProps) {
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      aria-label={ariaLabel ?? label}
      aria-invalid={error || undefined}
      aria-describedby={describedBy}
      className="flex flex-col gap-1.5"
    >
      {label && <Label className="text-sm font-medium text-foreground">{label}</Label>}
      <Button
        id={id}
        className={`${inputBase} flex min-h-11 items-center justify-between text-left ${error ? 'border-destructive focus:border-destructive focus:ring-destructive/25' : ''}`}
      >
        <SelectValue />
        <ArrowRightIcon size={14} className="rotate-90 text-muted-text/70" aria-hidden="true" />
      </Button>
      <Popover className="min-w-[--trigger-width] rounded-lg border border-border/60 bg-background shadow-xl shadow-black/[0.08]">
        <ListBox className="py-1 outline-none">
          {options.map((option) => (
            <ListBoxItem
              key={option.value}
              id={option.value}
              className="flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm text-foreground outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring selected:bg-selected selected:text-selected-text"
            >
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function SetupField({
  label,
  children,
  hint,
  error,
  id,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: string;
  id?: string;
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const describedBy =
    [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="flex flex-col gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {React.isValidElement(children)
          ? React.cloneElement(
              children as React.ReactElement<{
                id?: string;
                describedBy?: string;
                error?: boolean;
              }>,
              {
                id: fieldId,
                describedBy,
                error: Boolean(error),
              },
            )
          : children}
      </label>
      {hint && (
        <span id={hintId} className="text-xs text-muted-text/80">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Back button
// ---------------------------------------------------------------------------

export function SetupBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Button
      type="button"
      onPress={onPress}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border/60 bg-secondary px-4 text-sm font-medium text-muted-text transition-all hover:border-border hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-safe:active:scale-[0.97]"
    >
      <ArrowLeftIcon size={16} aria-hidden="true" />
      Back
    </Button>
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
    <Button
      onPress={onClick}
      className="setup-stagger-child group relative flex min-h-14 items-center gap-4 overflow-hidden rounded-xl border border-border bg-surface p-4 text-left transition-[colors,transform,shadow] hover:-translate-y-0.5 hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={style}
    >
      <span
        className="absolute left-0 top-0 h-full w-1"
        style={{ backgroundColor: PROVIDER_ACCENT_VARS[id] }}
      />
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white"
        style={{ backgroundColor: PROVIDER_ACCENT_VARS[id] }}
      >
        <ProviderGlyph id={id} className="h-5 w-5" />
      </span>
      <span className="flex-1 text-sm font-semibold text-foreground">{name}</span>
      <ArrowRightIcon
        size={16}
        className="text-muted-text transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Button>
  );
}
