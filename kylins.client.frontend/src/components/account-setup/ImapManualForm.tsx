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
}

export interface ImapManualFormProps {
  values: ImapManualValues;
  onChange: (patch: Partial<ImapManualValues>) => void;
  onSubmit: () => void;
  onBack: () => void;
  canSubmit: boolean;
}

export function ImapManualForm({
  values,
  onChange,
  onSubmit,
  onBack,
  canSubmit,
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

      <div className="mt-8 flex items-center justify-between">
        <SetupBackButton onClick={onBack} />
        <SetupButton onClick={onSubmit} disabled={!canSubmit}>
          Connect
        </SetupButton>
      </div>
    </SetupCard>
  );
}
