import { MenuTrigger, Button, Popover, Menu, MenuItem, DialogTrigger } from 'react-aria-components';
import { useState } from 'react';
import {
  MailAddIcon,
  ReplyIcon,
  ReplyAllIcon,
  MailSendIcon,
  CaretDownIcon,
  DeleteIcon,
  MoveIcon,
  TagIcon,
  MailIcon,
  FlagIcon,
  PinIcon,
  MoreIcon,
  ArchiveIcon,
  ClassificationIcon,
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
import { useViewStore } from '../../../features/view/viewStore';
import { useAccountStore } from '../../../stores/accountStore';
import { useThreadStore } from '../../../stores/threadStore';
import { useFolderStore } from '../../../stores/folderStore';
import { useClassification } from '../../../features/classification/useClassification';
import type { ClassificationLevel } from '../../../features/classification/classificationTypes';
import type { MailFolder } from '../../../services/mail/folders/folderModel';
import { FolderPickerMenu } from './FolderPickerMenu';
import { ClassificationBadge } from '../../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../../features/classification/components/SecurityChips';
import { RibbonButton, RibbonGroup, RibbonStatusItem } from './RibbonPrimitives';
import { RibbonShell } from './RibbonShell';
import { ShieldCheck, Eye } from '@phosphor-icons/react';

function defaultSecurityForLevel(levelId: string): { isEncrypted: boolean; isSigned: boolean } {
  if (levelId === 'confidential' || levelId === 'restricted')
    return { isEncrypted: true, isSigned: true };
  return { isEncrypted: false, isSigned: false };
}

interface SplitMenuItem {
  label: string;
  onClick: () => void;
}

interface SplitRibbonButtonProps {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
  primary: () => void;
  items: SplitMenuItem[];
}

function SplitRibbonButton({
  icon,
  label,
  disabled,
  title,
  primary,
  items,
}: SplitRibbonButtonProps) {
  return (
    <div className="relative flex items-stretch">
      <Button
        isDisabled={disabled}
        onPress={primary}
        aria-label={title ?? label}
        className="flex items-center gap-1.5 rounded-l px-2.5 h-8 my-auto text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40 text-[var(--text)] hover:bg-[var(--hover)] disabled:hover:bg-transparent"
      >
        {icon}
        <span className="whitespace-nowrap">{label}</span>
      </Button>
      <MenuTrigger>
        <Button
          isDisabled={disabled}
          className="my-auto flex h-8 items-center rounded-r border-r border-[var(--border)] px-1.5 text-[var(--muted-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`${label} options`}
        >
          <CaretDownIcon size={10} className="opacity-70" />
        </Button>
        <Popover className="min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
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
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]"
              >
                <span className="flex-1 whitespace-nowrap">{item.label}</span>
              </MenuItem>
            )}
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
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
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]"
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
  const accountEmail = accounts.find((a) => a.id === activeAccountId)?.email ?? null;
  const { levels, getDefaultLevel, getLevelById } = useClassification();
  const [moveOpen, setMoveOpen] = useState(false);

  const handleMoveSelect = (folder: MailFolder) => {
    setMoveOpen(false);
    if (!selectedThread) return;
    void moveThread(selectedThread, folder.id, folder.remoteId ?? folder.name);
  };

  const openComposerForLevel = (level: ClassificationLevel) => {
    openComposerWindow({
      classificationId: level.id,
      ...defaultSecurityForLevel(level.id),
    });
  };

  const handleNewEmail = () => {
    const level = getDefaultLevel();
    openComposerWindow({
      classificationId: level.id,
      ...defaultSecurityForLevel(level.id),
    });
  };

  const handleReply = () => {
    if (!selectedMessage) return;
    openReplyComposer(selectedMessage, accountEmail);
  };

  const handleReplyWithAttachments = () => {
    if (!selectedMessage) return;
    openReplyComposerWithAttachments(selectedMessage, accountEmail);
  };

  const handleReplyAll = () => {
    if (!selectedMessage) return;
    openReplyAllComposer(selectedMessage, accountEmail);
  };

  const handleReplyAllWithAttachments = () => {
    if (!selectedMessage) return;
    openReplyAllComposerWithAttachments(selectedMessage, accountEmail);
  };

  const handleForward = () => {
    if (!selectedMessage) return;
    openForwardComposer(selectedMessage, accountEmail);
  };

  const handleForwardAsAttachment = () => {
    if (!selectedMessage) return;
    openForwardComposerAsAttachment(selectedMessage, accountEmail);
  };

  const hasMessage = selectedMessage != null;
  const hasThread = selectedThread != null;

  const level = selectedMessage?.classificationId
    ? getLevelById(selectedMessage.classificationId)
    : undefined;

  return (
    <RibbonShell>
      {!viewer && (
        <RibbonGroup>
          <div className="relative flex items-stretch">
            <RibbonButton icon={<MailAddIcon size={18} />} onClick={handleNewEmail}>
              New Email
            </RibbonButton>
            <MenuTrigger>
              <Button
                className="my-auto flex h-8 items-center rounded-r px-1.5 text-[10px] text-[var(--muted-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
                aria-label="Choose classification"
              >
                <CaretDownIcon size={10} />
              </Button>
              <Popover className="min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
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
              </Popover>
            </MenuTrigger>
          </div>
        </RibbonGroup>
      )}

      <RibbonGroup>
        <SplitRibbonButton
          icon={
            <span className="text-[var(--primary)]">
              <ReplyIcon size={18} />
            </span>
          }
          label="Reply"
          disabled={!hasMessage}
          primary={handleReply}
          items={[
            { label: 'Reply', onClick: handleReply },
            { label: 'Reply with Attachment', onClick: handleReplyWithAttachments },
          ]}
        />
        <SplitRibbonButton
          icon={
            <span className="text-[var(--primary)]">
              <ReplyAllIcon size={18} />
            </span>
          }
          label="Reply all"
          disabled={!hasMessage}
          primary={handleReplyAll}
          items={[
            { label: 'Reply all', onClick: handleReplyAll },
            { label: 'Reply all with Attachment', onClick: handleReplyAllWithAttachments },
          ]}
        />
        <SplitRibbonButton
          icon={
            <span className="text-[var(--primary)]">
              <MailSendIcon size={18} />
            </span>
          }
          label="Forward"
          disabled={!hasMessage}
          primary={handleForward}
          items={[
            { label: 'Forward', onClick: handleForward },
            { label: 'Forward as Attachment', onClick: handleForwardAsAttachment },
          ]}
        />
        <RibbonButton icon={<ArchiveIcon size={18} />} disabled={!hasMessage} title="Archive" />
        <RibbonButton
          icon={<DeleteIcon size={17} />}
          disabled={!hasThread}
          title="Delete"
          onClick={() => {
            if (!selectedThread) return;
            void deleteThread(selectedThread);
          }}
        />
        <RibbonButton icon={<MoreIcon size={17} />} disabled={!hasMessage} title="More actions" />
      </RibbonGroup>

      <RibbonGroup>
        <DialogTrigger isOpen={moveOpen} onOpenChange={setMoveOpen}>
          <RibbonButton
            icon={<MoveIcon size={18} />}
            split
            disabled={!hasThread}
            title="Move to folder"
            onClick={() => setMoveOpen(true)}
          >
            Move
          </RibbonButton>
          <Popover className="min-w-[220px] max-h-[360px] overflow-auto rounded-md border border-border bg-background py-1 shadow-lg">
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

      <RibbonGroup>
        <RibbonButton icon={<TagIcon />} split>
          Categorize
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup>
        <RibbonButton
          icon={<MailIcon />}
          split
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
          icon={<FlagIcon />}
          disabled={!hasThread}
          title={selectedThread?.isStarred ? 'Remove flag' : 'Flag'}
          onClick={() => {
            if (!selectedThread) return;
            void toggleThreadStarred(selectedThread);
          }}
        >
          {selectedThread?.isStarred ? 'Unflag' : 'Flag'}
        </RibbonButton>
        <RibbonButton icon={<PinIcon />} disabled={!hasThread}>
          Pin
        </RibbonButton>
      </RibbonGroup>

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
                icon={<ShieldCheck size={12} />}
                label="Prevent Copy"
                color={level.color}
              />
            )}
            {selectedMessage?.readReceiptRequested && (
              <RibbonStatusItem icon={<Eye size={12} />} label="Read Receipt" color={level.color} />
            )}
          </div>
        </RibbonGroup>
      )}
    </RibbonShell>
  );
}
