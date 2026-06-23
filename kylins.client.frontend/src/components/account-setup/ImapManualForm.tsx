import type { SecurityMode } from '../../types';

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
  canSubmit: boolean;
}

const inputClass =
  'w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]';
const labelClass = 'flex flex-col gap-1 text-sm text-[var(--foreground)]';

export function ImapManualForm({ values, onChange, onSubmit, canSubmit }: ImapManualFormProps) {
  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Server settings</h1>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">
          Incoming (IMAP)
        </legend>
        <label className={labelClass}>
          Server
          <input
            className={inputClass}
            value={values.imapHost}
            onChange={(e) => onChange({ imapHost: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Port
          <input
            className={inputClass}
            value={values.imapPort}
            onChange={(e) => onChange({ imapPort: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Security
          <select
            className={inputClass}
            value={values.imapSecurity}
            onChange={(e) => onChange({ imapSecurity: e.target.value as SecurityMode })}
          >
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">
          Outgoing (SMTP)
        </legend>
        <label className={labelClass}>
          Server
          <input
            className={inputClass}
            value={values.smtpHost}
            onChange={(e) => onChange({ smtpHost: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Port
          <input
            className={inputClass}
            value={values.smtpPort}
            onChange={(e) => onChange({ smtpPort: e.target.value })}
          />
        </label>
        <label className={labelClass}>
          Security
          <select
            className={inputClass}
            value={values.smtpSecurity}
            onChange={(e) => onChange({ smtpSecurity: e.target.value as SecurityMode })}
          >
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </label>
      </fieldset>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={onSubmit}
        className="self-end rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-40"
      >
        Sign in
      </button>
    </div>
  );
}
