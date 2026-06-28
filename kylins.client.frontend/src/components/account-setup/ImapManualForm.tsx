import type { SecurityMode } from '../../types';
import {
  SetupCard,
  SetupHeader,
  SetupButton,
  SetupInput,
  SetupSelect,
  SetupBackButton,
  SetupField,
} from './setup-ui';

export interface ImapManualValues {
  imapHost: string;
  imapPort: string;
  imapSecurity: SecurityMode;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SecurityMode;
  acceptInvalidCerts: boolean;
}

export interface ImapManualFormProps {
  values: ImapManualValues;
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
  onChange,
  onSubmit,
  onTestConnection,
  onBack,
  canSubmit,
  isTesting = false,
  testResult = null,
}: ImapManualFormProps) {
  return (
    <SetupCard>
      <SetupHeader
        eyebrow="Manual setup"
        title="Server settings"
        subtitle="Enter the IMAP and SMTP server details from your provider."
        align="left"
      />

      <div className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">
            Incoming (IMAP)
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <SetupField label="Server">
                <SetupInput
                  placeholder="imap.example.com"
                  value={values.imapHost}
                  onChange={(e) => onChange({ imapHost: e.target.value })}
                  autoFocus
                />
              </SetupField>
            </div>
            <SetupField label="Port">
              <SetupInput
                placeholder="993"
                value={values.imapPort}
                onChange={(e) => onChange({ imapPort: e.target.value })}
              />
            </SetupField>
            <SetupField label="Security">
              <SetupSelect
                value={values.imapSecurity}
                onChange={(e) => onChange({ imapSecurity: e.target.value as SecurityMode })}
              >
                <option value="tls">SSL/TLS</option>
                <option value="starttls">STARTTLS</option>
                <option value="none">None</option>
              </SetupSelect>
            </SetupField>
          </div>
        </fieldset>

        <div className="h-px bg-[var(--border)]" />

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">
            Outgoing (SMTP)
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <SetupField label="Server">
                <SetupInput
                  placeholder="smtp.example.com"
                  value={values.smtpHost}
                  onChange={(e) => onChange({ smtpHost: e.target.value })}
                />
              </SetupField>
            </div>
            <SetupField label="Port">
              <SetupInput
                placeholder="587"
                value={values.smtpPort}
                onChange={(e) => onChange({ smtpPort: e.target.value })}
              />
            </SetupField>
            <SetupField label="Security">
              <SetupSelect
                value={values.smtpSecurity}
                onChange={(e) => onChange({ smtpSecurity: e.target.value as SecurityMode })}
              >
                <option value="tls">SSL/TLS</option>
                <option value="starttls">STARTTLS</option>
                <option value="none">None</option>
              </SetupSelect>
            </SetupField>
          </div>
        </fieldset>
      </div>

      <div className="mt-8 flex flex-col gap-3">
        {testResult && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              testResult.success
                ? 'border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-400'
                : 'border-red-500/20 bg-red-500/10 text-[var(--destructive)]'
            }`}
          >
            {testResult.success ? '✓ ' : '✗ '}
            {testResult.message}
          </div>
        )}
        <div className="flex items-center justify-between">
          <SetupBackButton onClick={onBack} />
          <div className="flex items-center gap-2">
            {onTestConnection && (
              <SetupButton
                variant="secondary"
                onClick={onTestConnection}
                disabled={!canSubmit || isTesting}
                loading={isTesting}
              >
                Test connection
              </SetupButton>
            )}
            <SetupButton onClick={onSubmit} disabled={!canSubmit || isTesting}>
              Connect
            </SetupButton>
          </div>
        </div>

        <div className="h-px bg-[var(--border)]" />

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
            checked={values.acceptInvalidCerts}
            onChange={(e) => onChange({ acceptInvalidCerts: e.target.checked })}
          />
          <span className="flex flex-col">
            <span className="font-medium text-[var(--foreground)]">Allow invalid certificates</span>
            <span className="text-[var(--muted-text)]">
              Accept self-signed or mismatched TLS certificates for this server.
            </span>
          </span>
        </label>
      </div>
    </SetupCard>
  );
}
