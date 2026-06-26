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
  CornerUpLeftIcon,
  CornerUpRightIcon,
  ClassificationIcon,
} from '../icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowBendDoubleUpLeft, Archive as PhosphorArchive } from '@phosphor-icons/react';
import { openComposerWindow } from '../../utils/composeWindow';
import { useViewStore } from '../../features/view/viewStore';
import { useAccountStore } from '../../stores/accountStore';
import { useClassification } from '../../features/classification/useClassification';
import { useEffect, useRef, useState } from 'react';
import type { ClassificationLevel } from '../../features/classification/classificationTypes';

function RibbonGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-stretch px-1 border-r border-[var(--border)] last:border-r-0">
      {children}
    </div>
  );
}

interface RibbonButtonProps {
  children?: React.ReactNode;
  icon?: React.ReactNode;
  primary?: boolean;
  split?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}

function RibbonButton({
  children,
  icon,
  primary,
  split,
  disabled,
  title,
  onClick,
}: RibbonButtonProps) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2.5 h-7 my-auto text-sm rounded ${
        primary
          ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
          : 'text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent'
      }`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
    >
      {icon}
      <span className="whitespace-nowrap">{children}</span>
      {split && <span className="ml-1 text-[10px]">▼</span>}
    </button>
  );
}

function defaultSecurityForLevel(levelId: string): { isEncrypted: boolean; isSigned: boolean } {
  if (levelId === 'confidential') return { isEncrypted: true, isSigned: true };
  if (levelId === 'restricted') return { isEncrypted: true, isSigned: true };
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

export function CommandRibbon() {
  const selectedMessage = useViewStore((s) => s.selectedMessage);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const accountEmail = accounts.find((a) => a.id === activeAccountId)?.email ?? null;
  const { levels, getDefaultLevel } = useClassification();
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
    openComposerWindow({
      mode: 'reply',
      threadId: selectedMessage.threadId ?? selectedMessage.id,
      fromEmail: accountEmail,
      subject: selectedMessage.subject,
      classificationId: selectedMessage.classificationId ?? undefined,
      isEncrypted: selectedMessage.isEncrypted,
      isSigned: selectedMessage.isSigned,
    });
  };

  const handleReplyAll = () => {
    if (!selectedMessage) return;
    openComposerWindow({
      mode: 'replyAll',
      threadId: selectedMessage.threadId ?? selectedMessage.id,
      fromEmail: accountEmail,
      subject: selectedMessage.subject,
      classificationId: selectedMessage.classificationId ?? undefined,
      isEncrypted: selectedMessage.isEncrypted,
      isSigned: selectedMessage.isSigned,
    });
  };

  const handleForward = () => {
    if (!selectedMessage) return;
    openComposerWindow({
      mode: 'forward',
      threadId: selectedMessage.threadId ?? selectedMessage.id,
      fromEmail: accountEmail,
      subject: selectedMessage.subject,
      classificationId: selectedMessage.classificationId ?? undefined,
      isEncrypted: selectedMessage.isEncrypted,
      isSigned: selectedMessage.isSigned,
    });
  };

  const hasMessage = selectedMessage != null;

  return (
    <nav
      className="mx-2 mt-2 flex min-h-[var(--ribbon-h)] items-stretch justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 shadow-sm"
      aria-label="Command ribbon"
    >
      <div className="flex items-stretch">
        <RibbonGroup>
          <div className="relative flex items-stretch">
            <RibbonButton icon={<PlusIcon />} onClick={handleNewEmail}>
              New Email
            </RibbonButton>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="my-auto flex h-7 items-center rounded-r border-l border-[var(--border)] px-1.5 text-[10px] text-[var(--muted-text)] hover:bg-[var(--hover)]"
              aria-label="Choose classification"
              title="Choose classification"
            >
              ▼
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
                <HugeiconsIcon icon={CornerUpLeftIcon} size={18} strokeWidth={2} />
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
                <HugeiconsIcon icon={CornerUpRightIcon} size={18} strokeWidth={2} />
              </span>
            }
            disabled={!hasMessage}
            onClick={handleForward}
          >
            Forward
          </RibbonButton>
          <RibbonButton
            icon={<PhosphorArchive size={18} />}
            disabled={!hasMessage}
            title="Archive"
          />
          <RibbonButton icon={<DeleteIcon size={17} />} disabled={!hasMessage} title="Delete" />
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
          <RibbonButton icon={<MailIcon />} split>
            Read/Unread
          </RibbonButton>
          <RibbonButton icon={<FlagIcon />}>Flag</RibbonButton>
          <RibbonButton icon={<PinIcon />}>Pin</RibbonButton>
        </RibbonGroup>

        <RibbonGroup>
          <RibbonButton icon={<UndoIcon />} />
          <RibbonButton icon={<RedoIcon />} />
        </RibbonGroup>
      </div>
    </nav>
  );
}
