import { HugeiconsIcon } from '@hugeicons/react';
import type { SVGProps } from 'react';
import {
  Menu01Icon,
  Add01Icon,
  Notification03Icon,
  Settings01Icon,
  UserCircleIcon,
  Delete01Icon,
  Delete02Icon,
  Archive01Icon,
  Move02Icon,
  Tag01Icon,
  FlashIcon,
  Mail01Icon,
  Flag02Icon,
  Pin02Icon,
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
export const FlagIcon = makeIcon(Flag02Icon);
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
export const TasksIcon = makeIcon(TickDoubleIcon);
export const AiIcon = makeIcon(AiChat02Icon);
export const BellIcon = makeIcon(Alert01Icon);
export const TrashIcon = makeIcon(Delete02Icon);
export const MinimizeIcon = makeIcon(MinusSignIcon);
export const MaximizeIcon = makeIcon(ArrowExpand01Icon);
export const RestoreIcon = makeIcon(ArrowShrink01Icon);
export const CloseIcon = makeIcon(Cancel01Icon);
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
