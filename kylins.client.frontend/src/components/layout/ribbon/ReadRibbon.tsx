import {
  DeleteIcon,
  MoveIcon,
  TagIcon,
  MailIcon,
  FlagIcon,
  PinIcon,
  UndoIcon,
  RedoIcon,
  MoreIcon,
  PlusIcon,
} from '../../icons';
import {
  ArrowBendUpLeft,
  ArrowBendDoubleUpLeft,
  ArrowBendUpRight,
  Archive as PhosphorArchive,
  CaretDown,
} from '@phosphor-icons/react';
import { openComposerWindow } from '../../../utils/composeWindow';
import {
  openReplyComposer,
  openReplyAllComposer,
  openForwardComposer,
} from '../../../utils/composerActions';
import { useViewStore } from '../../../features/view/viewStore';
import { useAccountStore } from '../../../stores/accountStore';
import { useThreadStore } from '../../../stores/threadStore';
import { useClassification } from '../../../features/classification/useClassification';
import { useState, useRef, useEffect } from 'react';
import type { ClassificationLevel } from '../../../features/classification/classificationTypes';
import { ClassificationBadge } from '../../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../../features/classification/components/SecurityChips';
import { RibbonButton, RibbonGroup, RibbonStatusItem } from './RibbonPrimitives';
import { RibbonShell } from './RibbonShell';
import { ClassificationIcon } from '../../icons';
import { ShieldCheck, Eye } from '@phosphor-icons/react';

function defaultSecurityForLevel(levelId: string): { isEncrypted: boolean; isSigned: boolean } {
  if (levelId === 'confidential' || levelId === 'restricted')
    return { isEncrypted: true, isSigned: true };
  return { isEncrypted: false, isSigned: false };
}

function ClassificationMenuItem({
  level,
  onClick,
}: {
  level: ClassificationLevel;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
    >
      {level.icon ? (
        <span className="flex w-5 items-center justify-center">
          <ClassificationIcon icon={level.icon} size={18} style={{ color: level.color }} />
        </span>
      ) : (
        <span className="w-5" />
      )}
      <span className="whitespace-nowrap">{level.name}</span>
    </button>
  );
}

export function ReadRibbon() {
  const selectedMessage = useViewStore((s) => s.selectedMessage);
  const selectedThread = useThreadStore((s) => s.threads.find((t) => t.id === s.selectedThreadId));
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const accountEmail = accounts.find((a) => a.id === activeAccountId)?.email ?? null;
  const { levels, getDefaultLevel, getLevelById } = useClassification();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const openComposerForLevel = (level: ClassificationLevel) => {
    setMenuOpen(false);
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

  const handleReplyAll = () => {
    if (!selectedMessage) return;
    openReplyAllComposer(selectedMessage, accountEmail);
  };

  const handleForward = () => {
    if (!selectedMessage) return;
    openForwardComposer(selectedMessage, accountEmail);
  };

  const hasMessage = selectedMessage != null;
  const hasThread = selectedThread != null;

  const level = selectedMessage?.classificationId
    ? getLevelById(selectedMessage.classificationId)
    : undefined;

  return (
    <RibbonShell>
      <RibbonGroup>
        <div className="relative flex items-stretch">
          <RibbonButton icon={<PlusIcon />} onClick={handleNewEmail}>
            New Email
          </RibbonButton>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="my-auto flex h-8 items-center rounded-r border-l border-[var(--border)] px-1.5 text-[10px] text-[var(--muted-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Choose classification"
            title="Choose classification"
          >
            <CaretDown size={10} />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg"
            >
              {levels.map((level) => (
                <ClassificationMenuItem
                  key={level.id}
                  level={level}
                  onClick={() => openComposerForLevel(level)}
                />
              ))}
            </div>
          )}
        </div>
      </RibbonGroup>

      <RibbonGroup>
        <RibbonButton
          icon={
            <span className="text-[var(--primary)]">
              <ArrowBendUpLeft size={18} weight="bold" />
            </span>
          }
          disabled={!hasMessage}
          onClick={handleReply}
        >
          Reply
        </RibbonButton>
        <RibbonButton
          icon={
            <span className="text-[var(--primary)]">
              <ArrowBendDoubleUpLeft size={18} weight="bold" />
            </span>
          }
          disabled={!hasMessage}
          onClick={handleReplyAll}
        >
          Reply all
        </RibbonButton>
        <RibbonButton
          icon={
            <span className="text-[var(--primary)]">
              <ArrowBendUpRight size={18} weight="bold" />
            </span>
          }
          disabled={!hasMessage}
          onClick={handleForward}
        >
          Forward
        </RibbonButton>
        <RibbonButton icon={<PhosphorArchive size={18} />} disabled={!hasMessage} title="Archive" />
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
        <RibbonButton icon={<MoveIcon />} split>
          Move
        </RibbonButton>
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

      <RibbonGroup>
        <RibbonButton icon={<UndoIcon />} />
        <RibbonButton icon={<RedoIcon />} />
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
