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
  { value: 'tls', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'None' },
];

export interface ImapManualValues {
  imapHost: string;
  imapPort: string;
  imapSecurity: SecurityMode;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SecurityMode;
  acceptInvalidCerts: boolean;
}

export interface ImapManualFormErrors extends Partial<Record<keyof ImapManualValues, string>> {
  general?: string;
}

export interface ImapManualFormProps {
  values: ImapManualValues;
  errors?: ImapManualFormErrors;
  onChange: (patch: Partial<ImapManualValues>) => void;
  onSubmit: () => void;
  onTestConnection?: () => void;
  onBack: () => void;
  canSubmit: boolean;
  isTesting?: boolean;
  testResult?: { success: boolean; message: string } | null;
}

export function ImapManualForm({
  values,
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
    <SetupCard>
      <SetupHeader
        eyebrow="Manual setup"
        title="Server settings"
        subtitle="Enter the IMAP and SMTP server details from your provider."
        align="left"
        hideMark
      />

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-foreground">Incoming (IMAP)</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
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
            </div>
            <SetupField label="Port" error={errors.imapPort}>
              <SetupInput
                placeholder="993"
                value={values.imapPort}
                onChange={(e) => onChange({ imapPort: e.target.value })}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                spellCheck={false}
              />
            </SetupField>
            <SetupSelect
              label="Security"
              value={values.imapSecurity}
              onChange={(value) => onChange({ imapSecurity: value as SecurityMode })}
              options={SECURITY_OPTIONS}
              error={!!errors.imapSecurity}
            />
          </div>
        </fieldset>

        <div className="h-px bg-border" />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-foreground">Outgoing (SMTP)</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <SetupField label="Server" error={errors.smtpHost}>
                <SetupInput
                  placeholder="smtp.example.com"
                  value={values.smtpHost}
                  onChange={(e) => onChange({ smtpHost: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </SetupField>
            </div>
            <SetupField label="Port" error={errors.smtpPort}>
              <SetupInput
                placeholder="587"
                value={values.smtpPort}
                onChange={(e) => onChange({ smtpPort: e.target.value })}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                spellCheck={false}
              />
            </SetupField>
            <SetupSelect
              label="Security"
              value={values.smtpSecurity}
              onChange={(value) => onChange({ smtpSecurity: value as SecurityMode })}
              options={SECURITY_OPTIONS}
              error={!!errors.smtpSecurity}
            />
          </div>
        </fieldset>

        <div className="mt-2 flex flex-col gap-3">
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
          <div className="flex items-center justify-between">
            <SetupBackButton onPress={onBack} />
            <div className="flex items-center gap-2">
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
                Connect
              </SetupButton>
            </div>
          </div>

          <div className="h-px bg-border" />

          <Checkbox
            isSelected={values.acceptInvalidCerts}
            onChange={(checked) => onChange({ acceptInvalidCerts: checked })}
            className="group flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border bg-secondary p-3 text-sm transition-colors hover:bg-hover data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-2 data-[focus-visible]:ring-offset-background"
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
                  <span className="font-medium text-foreground">Allow invalid certificates</span>
                  <span className="text-muted-text">
                    Accept self-signed or mismatched TLS certificates for this server.
                  </span>
                </span>
              </>
            )}
          </Checkbox>
        </div>
      </form>
    </SetupCard>
  );
}
