import {
  Button,
  MenuTrigger,
  Popover,
  Menu,
  MenuItem,
  Separator,
  ToggleButton,
} from 'react-aria-components';
import {
  SendIcon,
  SpinnerIcon,
  TrashIcon,
  ClockIcon,
  EncryptIcon,
  SignIcon,
  AttachmentIcon,
  MoreIcon,
  SaveIcon,
  PrintIcon,
  CopySlashIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  MinusIcon,
  MailOpenIcon,
  MailIcon,
  CheckIcon,
  CaretDownIcon,
} from '../../icons';
import { useComposerStore } from '../../../stores/composerStore';
import type { Importance } from '../../../stores/composerStore';
import { useClassification } from '../../../features/classification/useClassification';
import type { ReactNode } from 'react';

/** react-aria Buttons don't forward `title` — wrap for a native tooltip. */
function TooltipWrap({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span title={title} className="inline-flex">
      {children}
    </span>
  );
}

export interface ComposerActionsRowProps {
  canSend: boolean;
  sending: boolean;
  onSend: () => void;
  onDiscard: () => void;
  onSchedule: () => void;
  onAttach: () => void;
  /** Save the draft without closing (lives in the overflow menu). */
  onSave: () => void;
  /** Print the message body (lives in the overflow menu). */
  onPrint: () => void;
}

const iconButtonClass =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40';

const toggleButtonClass = `${iconButtonClass} data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--primary)]`;

const menuItemClass =
  'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--hover)] data-[focus-visible]:bg-[var(--hover)] data-[disabled]:opacity-50';

const menuClass =
  'min-w-[200px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg';

/**
 * Consolidated composer action row: Send/Schedule on the left, the most-used
 * message options (Encrypt/Sign/Attach) as tooltipped icon toggles on the
 * right, and everything else (Prevent Copy, Importance, receipts, Discard)
 * behind an overflow menu. Replaces the old Send row + compose ribbon pair.
 * Option state is read straight from the composer store (same pattern as
 * ComposeRibbon, which still serves the main-window inline reply).
 */
export function ComposerActionsRow({
  canSend,
  sending,
  onSend,
  onDiscard,
  onSchedule,
  onAttach,
  onSave,
  onPrint,
}: ComposerActionsRowProps) {
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
    setDeliverAt,
    setPreventCopy,
  } = useComposerStore();
  const { getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();
  // Confidential/Restricted force crypto on — the toggles stay locked.
  const requiresCrypto = currentLevel.id === 'confidential' || currentLevel.id === 'restricted';

  const scheduleActive = deliverAt != null;

  const importanceOptions: Array<{ value: Importance; label: string; icon: React.ReactNode }> = [
    { value: 'high', label: 'High', icon: <ArrowUpIcon size={14} /> },
    { value: 'normal', label: 'Normal', icon: <MinusIcon size={14} /> },
    { value: 'low', label: 'Low', icon: <ArrowDownIcon size={14} /> },
  ];

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
      {/* Gmail-style split Send: main action + caret for delivery options */}
      <div className="inline-flex items-stretch">
        <Button
          onPress={onSend}
          isDisabled={!canSend || sending}
          className="inline-flex items-center gap-1.5 rounded-l-lg bg-[var(--primary)] py-1.5 pl-4 pr-3 text-xs font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? <SpinnerIcon size={14} /> : <SendIcon size={14} />}
          {sending ? 'Sending…' : 'Send'}
        </Button>
        <MenuTrigger>
          <TooltipWrap
            title={
              scheduleActive
                ? `Scheduled: ${new Date(deliverAt).toLocaleString()}`
                : 'Delivery options'
            }
          >
            <Button
              isDisabled={sending}
              aria-label="Delivery options"
              className={`inline-flex items-center rounded-r-lg border-l border-[var(--primary-fg)]/25 bg-[var(--primary)] px-2 text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
                scheduleActive ? 'opacity-90' : ''
              }`}
            >
              <CaretDownIcon size={12} />
            </Button>
          </TooltipWrap>
          <Popover placement="bottom start" className={menuClass}>
            <Menu aria-label="Delivery options" className="outline-none">
              <MenuItem id="deliver-time" onAction={onSchedule} className={menuItemClass}>
                <ClockIcon size={14} className="text-[var(--muted-text)]" />
                <span className="flex-1 whitespace-nowrap">Set Deliver Time</span>
              </MenuItem>
              {scheduleActive && (
                <MenuItem
                  id="clear-schedule"
                  onAction={() => setDeliverAt(null)}
                  className={menuItemClass}
                >
                  <TrashIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">
                    Clear: {new Date(deliverAt).toLocaleString()}
                  </span>
                </MenuItem>
              )}
            </Menu>
          </Popover>
        </MenuTrigger>
      </div>
      {scheduleActive && (
        <span className="text-xs text-[var(--primary)]">
          {new Date(deliverAt).toLocaleString()}
        </span>
      )}

      <div className="flex-1" />

      <TooltipWrap title={requiresCrypto ? 'Encrypt (required by classification)' : 'Encrypt'}>
        <ToggleButton
          isSelected={isEncrypted}
          onChange={setIsEncrypted}
          isDisabled={requiresCrypto || sending}
          aria-label={requiresCrypto ? 'Encrypt (required by classification)' : 'Encrypt'}
          className={toggleButtonClass}
        >
          <EncryptIcon size={16} />
        </ToggleButton>
      </TooltipWrap>
      <TooltipWrap title={requiresCrypto ? 'Sign (required by classification)' : 'Sign'}>
        <ToggleButton
          isSelected={isSigned}
          onChange={setIsSigned}
          isDisabled={requiresCrypto || sending}
          aria-label={requiresCrypto ? 'Sign (required by classification)' : 'Sign'}
          className={toggleButtonClass}
        >
          <SignIcon size={16} />
        </ToggleButton>
      </TooltipWrap>
      <TooltipWrap title="Attach files">
        <Button
          onPress={onAttach}
          isDisabled={sending}
          aria-label="Attach files"
          className={iconButtonClass}
        >
          <AttachmentIcon size={16} />
        </Button>
      </TooltipWrap>

      <MenuTrigger>
        <TooltipWrap title="More message options">
          <Button
            aria-label="More message options"
            isDisabled={sending}
            className={iconButtonClass}
          >
            <MoreIcon size={16} />
          </Button>
        </TooltipWrap>
        <Popover className={menuClass}>
          <Menu aria-label="Draft actions" className="outline-none">
            <MenuItem id="save-draft" onAction={onSave} className={menuItemClass}>
              <SaveIcon size={14} className="text-[var(--muted-text)]" />
              <span className="flex-1 whitespace-nowrap">Save draft</span>
            </MenuItem>
            <MenuItem id="print" onAction={onPrint} className={menuItemClass}>
              <PrintIcon size={14} className="text-[var(--muted-text)]" />
              <span className="flex-1 whitespace-nowrap">Print</span>
            </MenuItem>
          </Menu>
          <Separator className="my-1 border-t border-[var(--border-subtle)]" />
          <Menu aria-label="Message options" className="outline-none">
            <MenuItem
              id="prevent-copy"
              shouldCloseOnSelect={false}
              onAction={() => setPreventCopy(!preventCopy)}
              className={menuItemClass}
            >
              <CopySlashIcon size={14} className="text-[var(--muted-text)]" />
              <span className="flex-1 whitespace-nowrap">Prevent Copy</span>
              {preventCopy && <CheckIcon size={14} className="text-[var(--primary)]" />}
            </MenuItem>
          </Menu>
          <Separator className="my-1 border-t border-[var(--border-subtle)]" />
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
              <MenuItem id={option.value} className={menuItemClass}>
                <span className="text-[var(--muted-text)]">{option.icon}</span>
                <span className="flex-1 whitespace-nowrap">Importance: {option.label}</span>
              </MenuItem>
            )}
          </Menu>
          <Separator className="my-1 border-t border-[var(--border-subtle)]" />
          <Menu aria-label="Tracking" className="outline-none">
            <MenuItem
              id="read-receipt"
              shouldCloseOnSelect={false}
              onAction={() => setRequestReadReceipt(!requestReadReceipt)}
              className={menuItemClass}
            >
              <MailOpenIcon size={14} className="text-[var(--muted-text)]" />
              <span className="flex-1 whitespace-nowrap">Read Receipt</span>
              {requestReadReceipt && <CheckIcon size={14} className="text-[var(--primary)]" />}
            </MenuItem>
            <MenuItem
              id="delivery-receipt"
              shouldCloseOnSelect={false}
              onAction={() => setRequestDeliveryReceipt(!requestDeliveryReceipt)}
              className={menuItemClass}
            >
              <MailIcon size={14} className="text-[var(--muted-text)]" />
              <span className="flex-1 whitespace-nowrap">Delivery Receipt</span>
              {requestDeliveryReceipt && <CheckIcon size={14} className="text-[var(--primary)]" />}
            </MenuItem>
          </Menu>
          <Separator className="my-1 border-t border-[var(--border-subtle)]" />
          <Menu aria-label="Danger zone" className="outline-none">
            <MenuItem
              id="discard"
              onAction={onDiscard}
              className={`${menuItemClass} text-[var(--destructive)]`}
            >
              <TrashIcon size={14} />
              <span className="flex-1 whitespace-nowrap">Discard</span>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
}
