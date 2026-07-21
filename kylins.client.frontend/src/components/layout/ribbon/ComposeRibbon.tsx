import { useState } from 'react';
import {
  MenuTrigger,
  Button,
  Popover,
  Menu,
  MenuItem,
  DialogTrigger,
  Separator,
} from 'react-aria-components';
import {
  ClockIcon,
  AttachmentIcon,
  CopySlashIcon,
  ArrowUpIcon,
  MinusIcon,
  ArrowDownIcon,
  LockIcon,
  ShieldCheckIcon,
  CaretDownIcon,
  MailOpenIcon,
  MailIcon,
  CheckIcon,
  WarningIcon,
  BellIcon,
  MoreIcon,
} from '../../icons';
import { useElementWidth } from '../../../hooks/useElementWidth';
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

  const [overflowOpen, setOverflowOpen] = useState(false);
  const { ref: ribbonRef, width: ribbonWidth } = useElementWidth<HTMLElement>();
  const compact = ribbonWidth > 0 && ribbonWidth < 640;
  const iconOnly = ribbonWidth > 0 && ribbonWidth < 900;

  return (
    <RibbonShell ref={ribbonRef}>
      <RibbonGroup>
        <RibbonButton
          icon={<ClockIcon size={17} />}
          split
          iconOnly={iconOnly}
          title={
            scheduleActive ? new Date(deliverAt).toLocaleString() : 'Schedule / Delay delivery'
          }
          className={scheduleActive ? 'text-[var(--primary)]' : undefined}
          onClick={() => window.dispatchEvent(new Event('composer:schedule-requested'))}
        >
          {!iconOnly && (scheduleActive ? 'Scheduled' : 'Delay Delivery')}
        </RibbonButton>
      </RibbonGroup>

      {!compact && (
        <RibbonGroup>
          <MenuTrigger>
            <Button
              className="flex items-center gap-1.5 rounded px-2.5 h-11 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              aria-label="Importance"
            >
              <WarningIcon size={17} />
              {!iconOnly && (
                <span className="whitespace-nowrap">Importance: {importanceLabel}</span>
              )}
              <CaretDownIcon size={10} className="opacity-70" />
            </Button>
            <Popover className="min-w-[140px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
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
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)] selected:bg-[var(--primary-muted)] selected:text-[var(--foreground)]"
                  >
                    <span className="text-[var(--muted-text)]">{option.icon}</span>
                    <span className="flex-1 whitespace-nowrap">{option.label}</span>
                  </MenuItem>
                )}
              </Menu>
            </Popover>
          </MenuTrigger>
        </RibbonGroup>
      )}

      {!compact && (
        <RibbonGroup>
          <MenuTrigger>
            <Button
              className="flex items-center gap-1.5 rounded px-2.5 h-11 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              aria-label="Tracking"
            >
              <BellIcon size={17} />
              {!iconOnly && <span className="whitespace-nowrap">Tracking</span>}
              {(requestReadReceipt || requestDeliveryReceipt) && (
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
              )}
              <CaretDownIcon size={10} className="opacity-70" />
            </Button>
            <Popover className="min-w-[160px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
              <Menu aria-label="Tracking" className="outline-none">
                <MenuItem
                  id="read-receipt"
                  onAction={() => setRequestReadReceipt(!requestReadReceipt)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)]"
                >
                  <span className="text-[var(--muted-text)]">
                    <MailOpenIcon size={14} />
                  </span>
                  <span className="flex-1 whitespace-nowrap">Read Receipt</span>
                  {requestReadReceipt && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="delivery-receipt"
                  onAction={() => setRequestDeliveryReceipt(!requestDeliveryReceipt)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)]"
                >
                  <span className="text-[var(--muted-text)]">
                    <MailIcon size={14} />
                  </span>
                  <span className="flex-1 whitespace-nowrap">Delivery Receipt</span>
                  {requestDeliveryReceipt && (
                    <CheckIcon size={14} className="text-[var(--primary)]" />
                  )}
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </RibbonGroup>
      )}

      {!compact && (
        <RibbonGroup>
          <RibbonToggle
            icon={<LockIcon size={17} />}
            label="Encrypt"
            checked={isEncrypted}
            disabled={requiresCrypto}
            onChange={setIsEncrypted}
          />
          <RibbonToggle
            icon={<ShieldCheckIcon size={17} />}
            label="Sign"
            checked={isSigned}
            disabled={requiresCrypto}
            onChange={setIsSigned}
          />
          <RibbonToggle
            icon={<CopySlashIcon size={17} />}
            label="Prevent Copy"
            title="Discourage forwarding/copying (best-effort)"
            checked={preventCopy}
            onChange={setPreventCopy}
          />
        </RibbonGroup>
      )}

      <RibbonGroup>
        <RibbonButton
          icon={<AttachmentIcon size={17} />}
          iconOnly={iconOnly}
          title="Attach"
          onClick={() => window.dispatchEvent(new Event('composer:attach-requested'))}
        >
          {!iconOnly && 'Attach'}
        </RibbonButton>
      </RibbonGroup>

      {compact && (
        <RibbonGroup>
          <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
            <RibbonButton icon={<MoreIcon size={17} />} iconOnly title="More actions">
              More
            </RibbonButton>
            <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
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
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)] selected:bg-[var(--primary-muted)] selected:text-[var(--foreground)]"
                  >
                    <span className="text-[var(--muted-text)]">{option.icon}</span>
                    <span className="flex-1 whitespace-nowrap">{option.label}</span>
                  </MenuItem>
                )}
              </Menu>
              <Separator className="my-1 border-t border-[var(--border-subtle)]" />
              <Menu aria-label="Message options" className="outline-none">
                <MenuItem
                  id="read-receipt"
                  shouldCloseOnSelect={false}
                  onAction={() => setRequestReadReceipt(!requestReadReceipt)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <MailOpenIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Read Receipt</span>
                  {requestReadReceipt && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="delivery-receipt"
                  shouldCloseOnSelect={false}
                  onAction={() => setRequestDeliveryReceipt(!requestDeliveryReceipt)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <MailIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Delivery Receipt</span>
                  {requestDeliveryReceipt && (
                    <CheckIcon size={14} className="text-[var(--primary)]" />
                  )}
                </MenuItem>
                <Separator className="my-1 border-t border-[var(--border-subtle)]" />
                <MenuItem
                  id="encrypt"
                  shouldCloseOnSelect={false}
                  isDisabled={requiresCrypto}
                  onAction={() => setIsEncrypted(!isEncrypted)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)] data-[disabled]:opacity-50"
                >
                  <LockIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Encrypt</span>
                  {isEncrypted && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="sign"
                  shouldCloseOnSelect={false}
                  isDisabled={requiresCrypto}
                  onAction={() => setIsSigned(!isSigned)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)] data-[disabled]:opacity-50"
                >
                  <ShieldCheckIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Sign</span>
                  {isSigned && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="prevent-copy"
                  shouldCloseOnSelect={false}
                  onAction={() => setPreventCopy(!preventCopy)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <CopySlashIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Prevent Copy</span>
                  {preventCopy && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
              </Menu>
            </Popover>
          </DialogTrigger>
        </RibbonGroup>
      )}
    </RibbonShell>
  );
}
