import { MenuTrigger, Button, Popover, Menu, MenuItem } from 'react-aria-components';
import {
  ClockIcon,
  AttachmentIcon,
  LinkIcon,
  CopySlashIcon,
  ArrowUpIcon,
  MinusIcon,
  ArrowDownIcon,
  LockIcon,
  ShieldCheckIcon,
  CaretDownIcon,
  MailOpenIcon,
  MailIcon,
} from '../../icons';
import { useComposerStore } from '../../../stores/composerStore';
import type { Importance } from '../../../stores/composerStore';
import { useClassification } from '../../../features/classification/useClassification';
import { RibbonButton, RibbonGroup, RibbonToggle } from './RibbonPrimitives';
import { RibbonShell } from './RibbonShell';

export function ComposeRibbon() {
  const {
    classificationId,
    isEncrypted,
    isSigned,
    importance,
    requestReadReceipt,
    requestDeliveryReceipt,
    deliverAt,
    preventCopy,
    setIsEncrypted,
    setIsSigned,
    setImportance,
    setRequestReadReceipt,
    setRequestDeliveryReceipt,
    setPreventCopy,
  } = useComposerStore();
  const { getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();
  const requiresCrypto = currentLevel.id === 'confidential' || currentLevel.id === 'restricted';

  const scheduleActive = deliverAt != null;

  const importanceLabel = importance === 'high' ? 'High' : importance === 'low' ? 'Low' : 'Normal';
  const importanceOptions: Array<{ value: Importance; label: string; icon: React.ReactNode }> = [
    { value: 'high', label: 'High', icon: <ArrowUpIcon size={14} /> },
    { value: 'normal', label: 'Normal', icon: <MinusIcon size={14} /> },
    { value: 'low', label: 'Low', icon: <ArrowDownIcon size={14} /> },
  ];

  return (
    <RibbonShell>
      <RibbonGroup>
        <RibbonButton
          icon={<ClockIcon size={17} />}
          split
          title={
            scheduleActive ? new Date(deliverAt).toLocaleString() : 'Schedule / Delay delivery'
          }
          className={scheduleActive ? 'text-[var(--primary)]' : undefined}
          onClick={() => window.dispatchEvent(new Event('composer:schedule-requested'))}
        >
          {scheduleActive ? 'Scheduled' : 'Delay Delivery'}
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup>
        <MenuTrigger>
          <Button
            className="flex items-center gap-1.5 rounded px-2.5 h-8 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Importance"
          >
            <span className="whitespace-nowrap">Importance: {importanceLabel}</span>
            <CaretDownIcon size={10} className="opacity-70" />
          </Button>
          <Popover className="min-w-[140px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
            <Menu
              aria-label="Importance"
              selectionMode="single"
              selectedKeys={new Set([importance])}
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const key = Array.from(keys)[0];
                const option = importanceOptions.find((o) => o.value === key);
                if (option) setImportance(option.value);
              }}
              items={importanceOptions}
              className="outline-none"
            >
              {(option) => (
                <MenuItem
                  id={option.value}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] selected:bg-[var(--selected)] selected:text-[var(--foreground)]"
                >
                  <span className="text-[var(--muted-text)]">{option.icon}</span>
                  <span className="flex-1 whitespace-nowrap">{option.label}</span>
                </MenuItem>
              )}
            </Menu>
          </Popover>
        </MenuTrigger>
      </RibbonGroup>

      <RibbonGroup>
        <MenuTrigger>
          <Button
            className="flex items-center gap-1.5 rounded px-2.5 h-8 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Tracking"
          >
            <span className="whitespace-nowrap">Tracking</span>
            {(requestReadReceipt || requestDeliveryReceipt) && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
            )}
            <CaretDownIcon size={10} className="opacity-70" />
          </Button>
          <Popover className="min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
            <Menu aria-label="Tracking" className="outline-none">
              <MenuItem
                id="read-receipt"
                onAction={() => setRequestReadReceipt(!requestReadReceipt)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]"
              >
                <span className="text-[var(--muted-text)]">
                  <MailOpenIcon size={14} />
                </span>
                <span className="flex-1 whitespace-nowrap">Read Receipt</span>
                {requestReadReceipt && <span className="text-[var(--primary)]">✓</span>}
              </MenuItem>
              <MenuItem
                id="delivery-receipt"
                onAction={() => setRequestDeliveryReceipt(!requestDeliveryReceipt)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]"
              >
                <span className="text-[var(--muted-text)]">
                  <MailIcon size={14} />
                </span>
                <span className="flex-1 whitespace-nowrap">Delivery Receipt</span>
                {requestDeliveryReceipt && <span className="text-[var(--primary)]">✓</span>}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      </RibbonGroup>

      <RibbonGroup>
        <RibbonToggle
          icon={<LockIcon size={14} />}
          label="Encrypt"
          checked={isEncrypted}
          disabled={requiresCrypto}
          onChange={setIsEncrypted}
        />
        <RibbonToggle
          icon={<ShieldCheckIcon size={14} />}
          label="Sign"
          checked={isSigned}
          disabled={requiresCrypto}
          onChange={setIsSigned}
        />
        <RibbonToggle
          icon={<CopySlashIcon size={14} />}
          label="Prevent Copy"
          title="Discourage forwarding/copying (best-effort)"
          checked={preventCopy}
          onChange={setPreventCopy}
        />
      </RibbonGroup>

      <RibbonGroup>
        <RibbonButton icon={<AttachmentIcon size={17} />}>Attach</RibbonButton>
        <RibbonButton
          icon={<LinkIcon size={17} />}
          onClick={() => window.dispatchEvent(new Event('composer:insert-link'))}
        >
          Link
        </RibbonButton>
      </RibbonGroup>
    </RibbonShell>
  );
}
