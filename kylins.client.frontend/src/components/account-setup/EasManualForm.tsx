import {
  SetupCard,
  SetupHeader,
  SetupButton,
  SetupInput,
  SetupBackButton,
  SetupField,
} from './setup-ui';

export interface EasManualFormErrors {
  server?: string;
  deviceId?: string;
}

export interface EasManualFormProps {
  server: string;
  deviceId: string;
  errors?: EasManualFormErrors;
  onChange: (patch: Partial<{ server: string; deviceId: string }>) => void;
  onSubmit: () => void;
  onBack: () => void;
  canSubmit: boolean;
}

export function EasManualForm({
  server,
  deviceId,
  errors = {},
  onChange,
  onSubmit,
  onBack,
  canSubmit,
}: EasManualFormProps) {
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit();
  }

  return (
    <SetupCard>
      <SetupHeader
        eyebrow="Exchange ActiveSync"
        title="Server settings"
        subtitle="Enter your Exchange server URL and a device identifier."
        align="left"
        hideMark
      />

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <SetupField label="Server URL" error={errors.server}>
          <SetupInput
            placeholder="https://mail.example.com/Microsoft-Server-ActiveSync"
            value={server}
            onChange={(e) => onChange({ server: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </SetupField>

        <SetupField label="Device ID" error={errors.deviceId}>
          <SetupInput
            value={deviceId}
            onChange={(e) => onChange({ deviceId: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </SetupField>

        <div className="mt-8 flex items-center justify-between">
          <SetupBackButton onPress={onBack} />
          <SetupButton type="submit" disabled={!canSubmit}>
            Connect
          </SetupButton>
        </div>
      </form>
    </SetupCard>
  );
}
