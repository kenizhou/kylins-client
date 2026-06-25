import {
  DeleteIcon,
  ArchiveIcon,
  MoveIcon,
  TagIcon,
  LightningIcon,
  MailIcon,
  FlagIcon,
  PinIcon,
  UndoIcon,
  RedoIcon,
  MoreIcon,
  PlusIcon,
  NotificationIcon,
  SettingsIcon,
  UserIcon,
} from '../icons';
import { openComposerWindow } from '../../utils/composeWindow';

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
  onClick?: () => void;
}

function RibbonButton({ children, icon, primary, split, onClick }: RibbonButtonProps) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2.5 h-7 my-auto text-sm rounded ${
        primary
          ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
          : 'text-[var(--text)] hover:bg-[var(--hover)]'
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{children}</span>
      {split && <span className="ml-1 text-[10px]">▼</span>}
    </button>
  );
}

export function CommandRibbon() {
  return (
    <nav
      className="mx-2 mt-2 flex min-h-[var(--ribbon-h)] items-stretch justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 shadow-sm"
      aria-label="Command ribbon"
    >
      <div className="flex items-stretch">
        <RibbonGroup>
          <RibbonButton primary icon={<PlusIcon />} split onClick={() => openComposerWindow()}>
            New mail
          </RibbonButton>
        </RibbonGroup>
        <RibbonGroup>
          <RibbonButton icon={<DeleteIcon />}>Delete</RibbonButton>
          <RibbonButton icon={<ArchiveIcon />}>Archive</RibbonButton>
          <RibbonButton icon={<MoveIcon />} split>
            Move
          </RibbonButton>
        </RibbonGroup>
        <RibbonGroup>
          <RibbonButton icon={<TagIcon />} split>
            Categorize
          </RibbonButton>
          <RibbonButton icon={<LightningIcon />} split>
            Quick steps
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
          <RibbonButton icon={<MoreIcon />} />
        </RibbonGroup>
      </div>

      <div className="flex items-stretch">
        <RibbonGroup>
          <RibbonButton icon={<NotificationIcon />} />
          <RibbonButton icon={<SettingsIcon />} />
          <RibbonButton icon={<UserIcon />} />
        </RibbonGroup>
      </div>
    </nav>
  );
}
