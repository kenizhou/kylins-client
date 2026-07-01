import { HugeiconsIcon } from '@hugeicons/react';
import type { IconSvgElement } from '@hugeicons/react';
import type { SVGProps } from 'react';
import {
  Menu01Icon,
  Add01Icon,
  Notification03Icon,
  Settings01Icon,
  UserCircleIcon,
  Delete01Icon,
  Delete02Icon,
  Copy01Icon,
  Archive01Icon,
  Move02Icon,
  Tag01Icon,
  FlashIcon,
  Mail01Icon,
  Flag02Icon,
  Pin02Icon,
  StarIcon as StarIconData,
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
  MoreHorizontalIcon,
  Sent02Icon,
  File02Icon,
  SmileIcon as SmileIconData,
  MailReply01Icon,
  MailReply02Icon,
  MailReplyAll01Icon,
  MailReplyAll02Icon,
  Forward01Icon,
  Forward02Icon,
  Calendar03Icon,
  UserMultipleIcon,
  TickDoubleIcon,
  AiChat02Icon,
  Alert01Icon,
  MinusSignIcon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  Clock01Icon,
  Attachment01Icon,
  TextBoldIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  TextStrikethroughIcon,
  TextFontIcon,
  HighlighterIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  QuoteDownIcon,
  SourceCodeIcon,
  Link02Icon,
  Unlink02Icon,
  Image01Icon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Folder01Icon,
  UserAccountIcon,
  Search01Icon,
  PaintBoardIcon,
  KeyboardIcon,
  FilterIcon,
  File01Icon,
  SignatureIcon,
  GlobeIcon,
  MailSend01Icon,
  MailOpen01Icon,
  PencilEdit01Icon,
  Database01Icon,
  Shield01Icon,
  LockIcon,
  EyeIcon,
  Flag01Icon,
  SquareLock02Icon,
  CircleLock02Icon,
  BiometricAccessIcon,
  FingerPrintIcon,
  SecurityIcon,
  Certificate02Icon,
} from '@hugeicons/core-free-icons';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  strokeWidth?: number;
}

function makeIcon(iconData: Parameters<typeof HugeiconsIcon>[0]['icon']) {
  return function Icon({ size = 16, strokeWidth = 1.5, ...rest }: IconProps) {
    return <HugeiconsIcon icon={iconData} size={size} strokeWidth={strokeWidth} {...rest} />;
  };
}

export function UploadIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      {...rest}
    >
      <path
        d="M12 16V4m0 0l-4 4m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DownloadIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      {...rest}
    >
      <path
        d="M12 8v8m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PanelLeftOpenIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      {...rest}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M14 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PanelLeftCloseIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      {...rest}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M17 9l-3 3 3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const CornerUpLeftIcon: IconSvgElement = [
  [
    'path',
    {
      d: 'M4 9.00195H11C14.7712 9.00195 16.6569 9.00195 17.8284 10.1735C19 11.3451 19 13.2307 19 17.002V20.002',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    },
  ],
  [
    'path',
    {
      d: 'M7.99996 4.00195C7.99996 4.00195 3.00001 7.6844 3 9.00199C2.99999 10.3196 8 14.002 8 14.002',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    },
  ],
];

export const CornerUpRightIcon: IconSvgElement = [
  [
    'path',
    {
      d: 'M18 9.00195H11C7.22876 9.00195 5.34315 9.00195 4.17157 10.1735C3 11.3451 3 13.2307 3 17.002V20.002',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    },
  ],
  [
    'path',
    {
      d: 'M14 4.00195C14 4.00195 19 7.6844 19 9.00199C19 10.3196 14 14.002 14 14.002',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    },
  ],
];

export const MenuIcon = makeIcon(Menu01Icon);
export const PlusIcon = makeIcon(Add01Icon);
export const NotificationIcon = makeIcon(Notification03Icon);
export const SettingsIcon = makeIcon(Settings01Icon);
export const UserIcon = makeIcon(UserCircleIcon);
export const DeleteIcon = makeIcon(Delete01Icon);
export const ArchiveIcon = makeIcon(Archive01Icon);
export const MoveIcon = makeIcon(Move02Icon);
export const TagIcon = makeIcon(Tag01Icon);
export const LightningIcon = makeIcon(FlashIcon);
export const MailIcon = makeIcon(Mail01Icon);
export const FolderIcon = makeIcon(Folder01Icon);
export const SearchIcon = makeIcon(Search01Icon);
export const FlagIcon = makeIcon(Flag02Icon);
export const StarIcon = makeIcon(StarIconData);
export const PinIcon = makeIcon(Pin02Icon);
export const UndoIcon = makeIcon(ArrowTurnBackwardIcon);
export const RedoIcon = makeIcon(ArrowTurnForwardIcon);
export const MoreIcon = makeIcon(MoreHorizontalIcon);
export const SendIcon = makeIcon(Sent02Icon);
export const FileTextIcon = makeIcon(File02Icon);
export const SmileIcon = makeIcon(SmileIconData);
export const ReplyIcon = makeIcon(MailReply01Icon);
export const ReplyAllIcon = makeIcon(MailReplyAll01Icon);
export const ForwardIcon = makeIcon(Forward01Icon);
export const ReplyFilledIcon = makeIcon(MailReply02Icon);
export const ReplyAllFilledIcon = makeIcon(MailReplyAll02Icon);
export const ForwardFilledIcon = makeIcon(Forward02Icon);
export const CalendarIcon = makeIcon(Calendar03Icon);
export const ContactsIcon = makeIcon(UserMultipleIcon);
export const PencilIcon = makeIcon(PencilEdit01Icon);
export const CheckIcon = makeIcon(TickDoubleIcon);
export const TasksIcon = makeIcon(TickDoubleIcon);
export const AiIcon = makeIcon(AiChat02Icon);
export const BellIcon = makeIcon(Alert01Icon);
export const TrashIcon = makeIcon(Delete02Icon);
export const CopyIcon = makeIcon(Copy01Icon);
export const MinimizeIcon = makeIcon(MinusSignIcon);
export const MaximizeIcon = makeIcon(ArrowExpand01Icon);
export const RestoreIcon = makeIcon(ArrowShrink01Icon);
export const CloseIcon = makeIcon(Cancel01Icon);
export const WarningIcon = makeIcon(Alert01Icon);
export const ClockIcon = makeIcon(Clock01Icon);
export const AttachmentIcon = makeIcon(Attachment01Icon);

export const BoldIcon = makeIcon(TextBoldIcon);
export const ItalicIcon = makeIcon(TextItalicIcon);
export const UnderlineIcon = makeIcon(TextUnderlineIcon);
export const StrikethroughIcon = makeIcon(TextStrikethroughIcon);
export const FontIcon = makeIcon(TextFontIcon);
export const HighlightIcon = makeIcon(HighlighterIcon);
export const BulletListIcon = makeIcon(LeftToRightListBulletIcon);
export const OrderedListIcon = makeIcon(LeftToRightListNumberIcon);
export const QuoteIcon = makeIcon(QuoteDownIcon);
export const CodeBlockIcon = makeIcon(SourceCodeIcon);
export const LinkIcon = makeIcon(Link02Icon);
export const UnlinkIcon = makeIcon(Unlink02Icon);
export const ImageIcon = makeIcon(Image01Icon);
export const H1Icon = makeIcon(Heading01Icon);
export const H2Icon = makeIcon(Heading02Icon);
export const H3Icon = makeIcon(Heading03Icon);
export const ArrowLeftIcon = makeIcon(ArrowLeft01Icon);
export const ArrowRightIcon = makeIcon(ArrowRight01Icon);
export const PopOutIcon = makeIcon(ArrowUpRight01Icon);

export const PreferencesGeneralIcon = makeIcon(Settings01Icon);
export const PreferencesAccountsIcon = makeIcon(UserAccountIcon);
export const PreferencesAppearanceIcon = makeIcon(PaintBoardIcon);
export const PreferencesShortcutsIcon = makeIcon(KeyboardIcon);
export const PreferencesMailRulesIcon = makeIcon(FilterIcon);
export const PreferencesSignaturesIcon = makeIcon(SignatureIcon);
export const PreferencesTemplatesIcon = makeIcon(File01Icon);

export const PreferencesReadingIcon = makeIcon(MailOpen01Icon);
export const PreferencesSendingIcon = makeIcon(MailSend01Icon);
export const PreferencesComposingIcon = makeIcon(PencilEdit01Icon);
export const PreferencesNotificationsIcon = makeIcon(Notification03Icon);
export const PreferencesLanguageIcon = makeIcon(GlobeIcon);
export const PreferencesLocalDataIcon = makeIcon(Database01Icon);
export const PreferencesSystemIcon = makeIcon(UserCircleIcon);
export const PreferencesPrivacySecurityIcon = makeIcon(Shield01Icon);

export const CLASSIFICATION_ICON_IDS = [
  'shield',
  'lock',
  'eye',
  'flag',
  'star',
  'alert',
  'square-lock',
  'circle-lock',
  'biometric',
  'fingerprint',
  'security',
  'certificate',
] as const;

export type ClassificationIconId = (typeof CLASSIFICATION_ICON_IDS)[number];

const CLASSIFICATION_ICON_MAP: Record<
  ClassificationIconId,
  Parameters<typeof HugeiconsIcon>[0]['icon']
> = {
  shield: Shield01Icon,
  lock: LockIcon,
  eye: EyeIcon,
  flag: Flag01Icon,
  star: StarIconData,
  alert: Alert01Icon,
  'square-lock': SquareLock02Icon,
  'circle-lock': CircleLock02Icon,
  biometric: BiometricAccessIcon,
  fingerprint: FingerPrintIcon,
  security: SecurityIcon,
  certificate: Certificate02Icon,
};

export function ClassificationIcon({
  icon,
  size = 14,
  className,
  style,
}: {
  icon?: string | null;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (!icon) return null;
  const data = CLASSIFICATION_ICON_MAP[icon as ClassificationIconId];
  if (!data) return null;
  return (
    <HugeiconsIcon icon={data} size={size} strokeWidth={2} className={className} style={style} />
  );
}
