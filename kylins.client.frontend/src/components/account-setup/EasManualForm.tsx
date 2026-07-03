import {
  SetupCard,
  SetupHeader,
  SetupButton,
  SetupInput,
  SetupBackButton,
  SetupField,
} from './setup-ui';

export interface EasManualFormProps {
  server: string;
  deviceId: string;
  onChange: (patch: Partial<{ server: string; deviceId: string }>) => void;
  onSubmit: () => void;
  onBack: () => void;
  canSubmit: boolean;
}

export function EasManualForm({
  server,
  deviceId,
  onChange,
  onSubmit,
  onBack,
  canSubmit,
}: EasManualFormProps) {
  return (
    <SetupCard>
      <SetupHeader
        eyebrow="Exchange ActiveSync"
        title="Server settings"
        subtitle="Enter your Exchange server URL and a device identifier."
        align="left"
      />

      <div className="flex flex-col gap-4">
        <SetupField label="Server URL">
          <SetupInput
            placeholder="https://mail.example.com/Microsoft-Server-ActiveSync"
            value={server}
            onChange={(e) => onChange({ server: e.target.value })}
            autoFocus
          />
        </SetupField>

        <SetupField label="Device ID">
          <SetupInput value={deviceId} onChange={(e) => onChange({ deviceId: e.target.value })} />
        </SetupField>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <SetupBackButton onPress={onBack} />
        <SetupButton onPress={onSubmit} disabled={!canSubmit}>
          Connect
        </SetupButton>
      </div>
    </SetupCard>
  );
}
