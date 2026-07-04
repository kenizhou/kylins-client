import { Checkbox } from 'react-aria-components';
import type { SecurityMode } from '../../types';
import { CheckIcon, CloseIcon } from '../icons';
import {
  SetupCard,
  SetupHeader,
  SetupButton,
  SetupInput,
  SetupSelect,
  SetupBackButton,
  SetupField,
} from './setup-ui';

const SECURITY_OPTIONS: { value: SecurityMode; label: string }[] = [
  { value: 'tls', label: 'SSL / TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'None' },
];

const IMAP_PORT_OPTIONS = [
  { value: '993', label: '993' },
  { value: '143', label: '143' },
];

const SMTP_PORT_OPTIONS = [
  { value: '465', label: '465' },
  { value: '587', label: '587' },
  { value: '25', label: '25' },
];

export interface ImapManualValues {
  imapHost: string;
  imapPort: string;
  imapSecurity: SecurityMode;
  imapUsername: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SecurityMode;
  smtpUsername: string;
  acceptInvalidCerts: boolean;
}

export interface ImapManualFormErrors extends Partial<Record<keyof ImapManualValues, string>> {
  general?: string;
}

export interface ImapManualFormProps {
  values: ImapManualValues;
  password: string;
  errors?: ImapManualFormErrors;
  onChange: (patch: Partial<ImapManualValues & { password: string }>) => void;
  onSubmit: () => void;
  onTestConnection?: () => void;
  onBack: () => void;
  canSubmit: boolean;
  isTesting?: boolean;
  testResult?: { success: boolean; message: string } | null;
}

export function ImapManualForm({
  values,
  password,
  errors = {},
  onChange,
  onSubmit,
  onTestConnection,
  onBack,
  canSubmit,
  isTesting = false,
  testResult = null,
}: ImapManualFormProps) {
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit();
  }

  return (
    <SetupCard width="xl">
      <SetupHeader
        eyebrow="Manual setup"
        title="Set up Account"
        subtitle="Complete the IMAP and SMTP settings below to connect your account."
        hideMark
      />

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="grid gap-6 md:grid-cols-2">
          <fieldset className="flex flex-col gap-4 md:pr-6">
            <legend className="mb-1 text-sm font-semibold text-foreground">
              Incoming Mail (IMAP):
            </legend>
            <SetupField label="Server" error={errors.imapHost}>
              <SetupInput
                placeholder="imap.example.com"
                value={values.imapHost}
                onChange={(e) => onChange({ imapHost: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </SetupField>

            <div className="grid grid-cols-2 gap-3">
              <SetupField label="Port" error={errors.imapPort}>
                <SetupSelect
                  ariaLabel="Port"
                  value={values.imapPort}
                  onChange={(value) => onChange({ imapPort: value })}
                  options={IMAP_PORT_OPTIONS}
                  error={!!errors.imapPort}
                />
              </SetupField>
              <SetupField label="Security" error={errors.imapSecurity}>
                <SetupSelect
                  ariaLabel="Security"
                  value={values.imapSecurity}
                  onChange={(value) => onChange({ imapSecurity: value as SecurityMode })}
                  options={SECURITY_OPTIONS}
                  error={!!errors.imapSecurity}
                />
              </SetupField>
            </div>

            <SetupField label="Username" error={errors.imapUsername}>
              <SetupInput
                placeholder="you@example.com"
                value={values.imapUsername}
                onChange={(e) => onChange({ imapUsername: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </SetupField>

            <SetupField label="Password">
              <SetupInput
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => onChange({ password: e.target.value })}
                autoComplete="off"
              />
            </SetupField>
          </fieldset>

          <fieldset className="flex flex-col gap-4 md:pl-6">
            <legend className="mb-1 text-sm font-semibold text-foreground">
              Outgoing Mail (SMTP):
            </legend>
            <SetupField label="Server" error={errors.smtpHost}>
              <SetupInput
                placeholder="smtp.example.com"
                value={values.smtpHost}
                onChange={(e) => onChange({ smtpHost: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </SetupField>

            <div className="grid grid-cols-2 gap-3">
              <SetupField label="Port" error={errors.smtpPort}>
                <SetupSelect
                  ariaLabel="Port"
                  value={values.smtpPort}
                  onChange={(value) => onChange({ smtpPort: value })}
                  options={SMTP_PORT_OPTIONS}
                  error={!!errors.smtpPort}
                />
              </SetupField>
              <SetupField label="Security" error={errors.smtpSecurity}>
                <SetupSelect
                  ariaLabel="Security"
                  value={values.smtpSecurity}
                  onChange={(value) => onChange({ smtpSecurity: value as SecurityMode })}
                  options={SECURITY_OPTIONS}
                  error={!!errors.smtpSecurity}
                />
              </SetupField>
            </div>

            <SetupField label="Username" error={errors.smtpUsername}>
              <SetupInput
                placeholder="you@example.com"
                value={values.smtpUsername}
                onChange={(e) => onChange({ smtpUsername: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </SetupField>

            <SetupField label="Password">
              <SetupInput
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => onChange({ password: e.target.value })}
                autoComplete="off"
              />
            </SetupField>
          </fieldset>
        </div>

        <div className="flex flex-col gap-4">
          <Checkbox
            isSelected={values.acceptInvalidCerts}
            onChange={(checked) => onChange({ acceptInvalidCerts: checked })}
            className="group flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border/60 bg-secondary/60 p-3 text-sm transition-colors hover:bg-hover data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-2 data-[focus-visible]:ring-offset-background"
          >
            {({ isSelected }) => (
              <>
                <div
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background'
                  }`}
                >
                  {isSelected && <CheckIcon size={10} aria-hidden="true" />}
                </div>
                <span className="flex flex-col">
                  <span className="font-medium text-foreground">Allow insecure SSL</span>
                  <span className="text-muted-text/80">
                    Allow self-signed or mismatched TLS certificates for this server.
                  </span>
                </span>
              </>
            )}
          </Checkbox>

          {testResult && (
            <div
              role="status"
              aria-live="polite"
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                testResult.success
                  ? 'border-success-border bg-success-bg text-success-foreground'
                  : 'border-error-border bg-error-bg text-destructive'
              }`}
            >
              <span
                aria-hidden="true"
                className={testResult.success ? 'text-success' : 'text-destructive'}
              >
                {testResult.success ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
              </span>
              <span>{testResult.message}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/60 pt-5">
          <SetupBackButton onPress={onBack} />
          <div className="flex items-center gap-3">
            {onTestConnection && (
              <SetupButton
                variant="secondary"
                type="button"
                onPress={onTestConnection}
                disabled={!canSubmit || isTesting}
                loading={isTesting}
              >
                Test connection
              </SetupButton>
            )}
            <SetupButton type="submit" disabled={!canSubmit || isTesting}>
              Connect Account
            </SetupButton>
          </div>
        </div>
      </form>
    </SetupCard>
  );
}
