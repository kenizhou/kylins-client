import {
  Button,
  Popover,
  Menu,
  MenuItem,
  DialogTrigger,
  Provider,
  ButtonContext,
  PopoverContext,
  MenuContext,
  OverlayTriggerStateContext,
  RootMenuTriggerStateContext,
} from 'react-aria-components';
import { useId, useRef, useState } from 'react';
import { useElementWidth } from '../../../hooks/useElementWidth';
import { useMenuTrigger } from 'react-aria';
import { useMenuTriggerState } from 'react-stately';
import {
  MailAddIcon,
  ReplyIcon,
  ReplyAllIcon,
  MailSendIcon,
  ReplyFilledIcon,
  ReplyAllFilledIcon,
  CaretDownIcon,
  DeleteIcon,
  MoveIcon,
  MailIcon,
  FlagIcon,
  MoreIcon,
  ArchiveIcon,
  ClassificationIcon,
  ShieldCheckIcon,
  EyeIcon,
} from '../../icons';
import { openComposerWindow } from '../../../utils/composeWindow';
import {
  openReplyComposer,
  openReplyAllComposer,
  openForwardComposer,
  openReplyComposerWithAttachments,
  openReplyAllComposerWithAttachments,
  openForwardComposerAsAttachment,
} from '../../../utils/composerActions';
import { archiveThread } from '../../../services/mail/actions';
import { useViewStore } from '../../../features/view/viewStore';
import { useAccountStore } from '../../../stores/accountStore';
import { usePreferencesStore } from '../../../stores/preferencesStore';
import { useThreadStore } from '../../../stores/threadStore';
import { useFolderStore } from '../../../stores/folderStore';
import { useClassification } from '../../../features/classification/useClassification';
import type { ClassificationLevel } from '../../../features/classification/classificationTypes';
import type { MailFolder } from '../../../services/mail/folders/folderModel';
import { FolderPickerMenu } from './FolderPickerMenu';
import { ClassificationBadge } from '../../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../../features/classification/components/SecurityChips';
import { CryptoBadge } from '../../../features/view/CryptoBadge';
import { RibbonButton, RibbonGroup, RibbonStatusItem } from './RibbonPrimitives';
import { RibbonShell } from './RibbonShell';

function defaultSecurityForLevel(levelId: string): { isEncrypted: boolean; isSigned: boolean } {
  if (levelId === 'confidential' || levelId === 'restricted')
    return { isEncrypted: true, isSigned: true };
  return { isEncrypted: false, isSigned: false };
}

interface SplitMenuItem {
  label: string;
  onClick: () => void;
}

interface SplitButtonProps {
  main: React.ReactNode;
  menu: React.ReactNode;
  menuLabel: string;
  disabled?: boolean;
  caretClassName?: string;
}

/** Split button whose dropdown popover is anchored to the full button width,
 *  not just the caret half. The main action stays on the left half; only the
 *  caret opens the menu. */
function SplitButton({
  main,
  menu,
  menuLabel,
  disabled = false,
  caretClassName = '',
}: SplitButtonProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const state = useMenuTriggerState({});
  const { menuTriggerProps, menuProps } = useMenuTrigger(
    { type: 'menu', isDisabled: disabled },
    state,
    triggerRef,
  );

  return (
    <Provider
      values={[
        [OverlayTriggerStateContext, state],
        [RootMenuTriggerStateContext, state],
        [MenuContext, menuProps],
        [
          PopoverContext,
          {
            triggerRef: groupRef,
            placement: 'bottom start',
            'aria-labelledby': triggerId,
          } as never,
        ],
      ]}
    >
      <div
        ref={groupRef}
        data-open={state.isOpen}
        className="split-button group relative flex items-stretch rounded-md text-[var(--text)] transition-colors"
      >
        {main}
        <Provider
          values={[
            [
              ButtonContext,
              {
                ...menuTriggerProps,
                id: triggerId,
                ref: triggerRef,
              } as never,
            ],
          ]}
        >
          <Button
            isDisabled={disabled}
            aria-label={menuLabel}
            className={`my-auto flex h-11 items-center rounded-r px-1.5 text-[10px] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40 ${caretClassName}`}
          >
            <CaretDownIcon size={10} />
          </Button>
        </Provider>
      </div>
      {state.isOpen && (
        <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
          {menu}
        </Popover>
      )}
    </Provider>
  );
}

interface SplitRibbonButtonProps {
  icon: React.ReactNode;
  selectedIcon?: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
  iconOnly?: boolean;
  primary: () => void;
  items: SplitMenuItem[];
}

function SplitRibbonButton({
  icon,
  selectedIcon,
  label,
  disabled,
  title,
  iconOnly,
  primary,
  items,
}: SplitRibbonButtonProps) {
  return (
    <SplitButton
      disabled={disabled}
      menuLabel={`${label} options`}
      caretClassName="border-r-[var(--border-subtle)]"
      main={
        <Button
          isDisabled={disabled}
          onPress={primary}
          aria-label={title ?? label}
          className={`flex items-center gap-1.5 rounded-l px-2.5 h-11 my-auto text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40 text-[var(--text)] hover:bg-[var(--primary-subtle)] disabled:hover:bg-transparent ${
            iconOnly ? 'w-11 justify-center px-0' : ''
          }`}
        >
          <span className="icon-default">{icon}</span>
          {selectedIcon && <span className="icon-selected">{selectedIcon}</span>}
          <span className={`whitespace-nowrap ${iconOnly ? 'sr-only' : ''}`}>{label}</span>
        </Button>
      }
      menu={
        <Menu
          aria-label={`${label} options`}
          items={items}
          onAction={(key) => {
            const item = items.find((_, idx) => String(idx) === key);
            item?.onClick();
          }}
          className="outline-none"
        >
          {(item) => (
            <MenuItem
              id={String(items.indexOf(item))}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
            >
              <span className="flex-1 whitespace-nowrap">{item.label}</span>
            </MenuItem>
          )}
        </Menu>
      }
    />
  );
}

function ClassificationMenuItem({
  level,
  onAction,
}: {
  level: ClassificationLevel;
  onAction: () => void;
}) {
  return (
    <MenuItem
      id={level.id}
      onAction={onAction}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
    >
      {level.icon ? (
        <span className="flex w-5 items-center justify-center">
          <ClassificationIcon icon={level.icon} size={18} style={{ color: level.color }} />
        </span>
      ) : (
        <span className="w-5" />
      )}
      <span className="whitespace-nowrap">{level.name}</span>
    </MenuItem>
  );
}

export function ReadRibbon({ viewer = false }: { viewer?: boolean }) {
  const selectedMessage = useViewStore((s) => s.selectedMessage);
  const selectedThread = useThreadStore((s) => s.threads.find((t) => t.id === s.selectedThreadId));
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const moveThread = useThreadStore((s) => s.moveThread);
  const selectedFolder = useFolderStore((s) => s.selected);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const account = accounts.find((a) => a.id === activeAccountId) ?? null;
  const defaultReplyBehavior = usePreferencesStore((s) => s.defaultReplyBehavior);
  const { levels, getDefaultLevel, getLevelById } = useClassification();
  const [moveOpen, setMoveOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const { ref: ribbonRef, width: ribbonWidth } = useElementWidth<HTMLElement>();
  const compact = ribbonWidth > 0 && ribbonWidth < 640;
  const iconOnly = ribbonWidth > 0 && ribbonWidth < 900;

  const handleMoveSelect = (folder: MailFolder) => {
    setMoveOpen(false);
    if (!selectedThread) return;
    void moveThread(selectedThread, folder.id, folder.remoteId ?? folder.name);
  };

  const openComposerForLevel = (level: ClassificationLevel) => {
    openComposerWindow({
      accountId: activeAccountId ?? undefined,
      classificationId: level.id,
      ...defaultSecurityForLevel(level.id),
    });
  };

  const handleNewEmail = () => {
    const level = getDefaultLevel();
    openComposerWindow({
      accountId: activeAccountId ?? undefined,
      classificationId: level.id,
      ...defaultSecurityForLevel(level.id),
    });
  };

  const handleReply = () => {
    if (!selectedMessage || !account) return;
    if (defaultReplyBehavior === 'reply-all') {
      void openReplyAllComposer(selectedMessage, account);
    } else {
      void openReplyComposer(selectedMessage, account);
    }
  };

  const handleReplyWithAttachments = () => {
    if (!selectedMessage || !account) return;
    void openReplyComposerWithAttachments(selectedMessage, account);
  };

  const handleReplyAll = () => {
    if (!selectedMessage || !account) return;
    void openReplyAllComposer(selectedMessage, account);
  };

  const handleReplyAllWithAttachments = () => {
    if (!selectedMessage || !account) return;
    void openReplyAllComposerWithAttachments(selectedMessage, account);
  };

  const handleForward = () => {
    if (!selectedMessage || !account) return;
    void openForwardComposer(selectedMessage, account);
  };

  const handleForwardAsAttachment = () => {
    if (!selectedMessage || !account) return;
    void openForwardComposerAsAttachment(selectedMessage, account);
  };

  const hasMessage = selectedMessage != null;
  const hasThread = selectedThread != null;

  const level = selectedMessage?.classificationId
    ? getLevelById(selectedMessage.classificationId)
    : undefined;

  // G6 Task 4: crypto badge hoist. The granular CryptoBadge is rendered for
  // any encrypted or signed message, INDEPENDENT of the `level` gate, so
  // encrypted mail without a classification level still surfaces its badge
  // in the ribbon. Mirrors the ReadingPane hoist.
  const isCryptoMessage =
    !!selectedMessage && (selectedMessage.isEncrypted || selectedMessage.isSigned);

  return (
    <RibbonShell ref={ribbonRef}>
      {!viewer && (
        <RibbonGroup>
          <SplitButton
            menuLabel="Choose classification"
            main={
              <RibbonButton
                icon={<MailAddIcon size={18} />}
                iconOnly={iconOnly}
                onClick={handleNewEmail}
              >
                New Email
              </RibbonButton>
            }
            menu={
              <Menu
                aria-label="Choose classification"
                items={levels}
                onAction={(key) => {
                  const level = levels.find((l) => l.id === key);
                  if (level) openComposerForLevel(level);
                }}
                className="outline-none"
              >
                {(level) => (
                  <ClassificationMenuItem
                    key={level.id}
                    level={level}
                    onAction={() => openComposerForLevel(level)}
                  />
                )}
              </Menu>
            }
          />
        </RibbonGroup>
      )}

      <RibbonGroup>
        <SplitRibbonButton
          icon={<ReplyIcon size={18} />}
          selectedIcon={<ReplyFilledIcon size={18} className="text-[var(--primary)]" />}
          label="Reply"
          disabled={!hasMessage}
          iconOnly={iconOnly}
          primary={handleReply}
          items={[
            { label: 'Reply', onClick: handleReply },
            { label: 'Reply with Attachment', onClick: handleReplyWithAttachments },
          ]}
        />
        <SplitRibbonButton
          icon={<ReplyAllIcon size={18} />}
          selectedIcon={<ReplyAllFilledIcon size={18} className="text-[var(--primary)]" />}
          label="Reply all"
          disabled={!hasMessage}
          iconOnly={iconOnly}
          primary={handleReplyAll}
          items={[
            { label: 'Reply all', onClick: handleReplyAll },
            { label: 'Reply all with Attachment', onClick: handleReplyAllWithAttachments },
          ]}
        />
        <SplitRibbonButton
          icon={<MailSendIcon size={18} />}
          selectedIcon={<MailSendIcon size={18} className="text-[var(--primary)]" />}
          label="Forward"
          disabled={!hasMessage}
          iconOnly={iconOnly}
          primary={handleForward}
          items={[
            { label: 'Forward', onClick: handleForward },
            { label: 'Forward as Attachment', onClick: handleForwardAsAttachment },
          ]}
        />
        {!compact && (
          <>
            <RibbonButton
              icon={<ArchiveIcon size={18} />}
              iconOnly={iconOnly}
              disabled={!hasThread}
              title="Archive"
              onClick={() => {
                if (!selectedThread) return;
                void archiveThread(selectedThread);
              }}
            >
              Archive
            </RibbonButton>
            <RibbonButton
              icon={<DeleteIcon size={17} />}
              iconOnly={iconOnly}
              disabled={!hasThread}
              title="Delete"
              onClick={() => {
                if (!selectedThread) return;
                void deleteThread(selectedThread);
              }}
            >
              Delete
            </RibbonButton>
          </>
        )}
      </RibbonGroup>

      {!compact && (
        <RibbonGroup>
          <DialogTrigger isOpen={moveOpen} onOpenChange={setMoveOpen}>
            <RibbonButton
              icon={<MoveIcon size={18} />}
              split
              iconOnly={iconOnly}
              disabled={!hasThread}
              title="Move to folder"
              onClick={() => setMoveOpen(true)}
            >
              Move
            </RibbonButton>
            <Popover className="min-w-[220px] max-h-[360px] overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
              {selectedThread && (
                <FolderPickerMenu
                  accountId={selectedThread.accountId}
                  excludeLabelId={selectedFolder?.labelId}
                  onSelect={handleMoveSelect}
                  onClose={() => setMoveOpen(false)}
                  portal={false}
                />
              )}
            </Popover>
          </DialogTrigger>
        </RibbonGroup>
      )}

      {!compact && (
        <RibbonGroup>
          <RibbonButton
            icon={<MailIcon size={18} />}
            split
            iconOnly={iconOnly}
            disabled={!hasThread}
            title={selectedThread?.isRead ? 'Mark as unread' : 'Mark as read'}
            onClick={() => {
              if (!selectedThread) return;
              void markThreadRead(selectedThread, !selectedThread.isRead);
            }}
          >
            {selectedThread?.isRead ? 'Mark Unread' : 'Mark Read'}
          </RibbonButton>
          <RibbonButton
            icon={<FlagIcon size={18} />}
            iconOnly={iconOnly}
            disabled={!hasThread}
            title={selectedThread?.isStarred ? 'Remove flag' : 'Flag'}
            onClick={() => {
              if (!selectedThread) return;
              void toggleThreadStarred(selectedThread);
            }}
          >
            {selectedThread?.isStarred ? 'Unflag' : 'Flag'}
          </RibbonButton>
        </RibbonGroup>
      )}

      {compact && (
        <RibbonGroup>
          <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
            <RibbonButton
              ref={overflowButtonRef}
              icon={<MoreIcon size={18} />}
              iconOnly
              disabled={!hasMessage && !hasThread}
              title="More actions"
            >
              More
            </RibbonButton>
            <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
              <Menu aria-label="More actions" className="outline-none">
                <MenuItem
                  isDisabled={!hasThread}
                  onAction={() => selectedThread && void archiveThread(selectedThread)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <ArchiveIcon size={14} /> Archive
                </MenuItem>
                <MenuItem
                  isDisabled={!hasThread}
                  onAction={() => selectedThread && void deleteThread(selectedThread)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <DeleteIcon size={14} /> Delete
                </MenuItem>
                <MenuItem
                  isDisabled={!hasThread}
                  onAction={() => selectedThread && setMoveOpen(true)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <MoveIcon size={14} /> Move
                </MenuItem>
                <MenuItem
                  isDisabled={!hasThread}
                  onAction={() =>
                    selectedThread && void markThreadRead(selectedThread, !selectedThread.isRead)
                  }
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <MailIcon size={14} /> {selectedThread?.isRead ? 'Mark Unread' : 'Mark Read'}
                </MenuItem>
                <MenuItem
                  isDisabled={!hasThread}
                  onAction={() => selectedThread && void toggleThreadStarred(selectedThread)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <FlagIcon size={14} /> {selectedThread?.isStarred ? 'Unflag' : 'Flag'}
                </MenuItem>
              </Menu>
            </Popover>
          </DialogTrigger>
          <Popover
            triggerRef={overflowButtonRef}
            isOpen={moveOpen}
            onOpenChange={setMoveOpen}
            className="min-w-[220px] max-h-[360px] overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg"
          >
            {selectedThread && (
              <FolderPickerMenu
                accountId={selectedThread.accountId}
                excludeLabelId={selectedFolder?.labelId}
                onSelect={handleMoveSelect}
                onClose={() => setMoveOpen(false)}
                portal={false}
              />
            )}
          </Popover>
        </RibbonGroup>
      )}

      {level && (
        <RibbonGroup>
          <div className="flex items-center gap-2 px-1">
            <ClassificationBadge level={level} />
            <SecurityChips
              isEncrypted={selectedMessage?.isEncrypted}
              isSigned={selectedMessage?.isSigned}
              variant="label"
            />
            {selectedMessage?.preventCopy && (
              <RibbonStatusItem
                icon={<ShieldCheckIcon size={12} />}
                label="Prevent Copy"
                color={level.color}
              />
            )}
            {selectedMessage?.readReceiptRequested && (
              <RibbonStatusItem
                icon={<EyeIcon size={12} />}
                label="Read Receipt"
                color={level.color}
              />
            )}
          </div>
        </RibbonGroup>
      )}

      {isCryptoMessage && (
        <RibbonGroup>
          <div className="flex items-center gap-2 px-1">
            <CryptoBadge
              signatureState={selectedMessage?.signatureState}
              decryptState={selectedMessage?.decryptState}
              revocationState={selectedMessage?.revocationState}
              signerEmail={selectedMessage?.signerEmail}
              signerFingerprint={selectedMessage?.signerFingerprint}
              variant="label"
            />
          </div>
        </RibbonGroup>
      )}
    </RibbonShell>
  );
}
