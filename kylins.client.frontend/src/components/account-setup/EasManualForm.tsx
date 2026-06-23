export interface EasManualFormProps {
  server: string;
  deviceId: string;
  onChange: (patch: Partial<{ server: string; deviceId: string }>) => void;
  onSubmit: () => void;
  canSubmit: boolean;
}

const inputClass =
  'w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]';
const labelClass = 'flex flex-col gap-1 text-sm text-[var(--foreground)]';

export function EasManualForm({
  server,
  deviceId,
  onChange,
  onSubmit,
  canSubmit,
}: EasManualFormProps) {
  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Exchange server</h1>
      <label className={labelClass}>
        Server URL
        <input
          className={inputClass}
          value={server}
          onChange={(e) => onChange({ server: e.target.value })}
        />
      </label>
      <label className={labelClass}>
        Device ID
        <input
          className={inputClass}
          value={deviceId}
          onChange={(e) => onChange({ deviceId: e.target.value })}
        />
      </label>
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
