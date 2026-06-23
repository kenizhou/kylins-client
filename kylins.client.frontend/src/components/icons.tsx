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
  MailReplyAll01Icon,
  Forward01Icon,
  Calendar03Icon,
  UserMultipleIcon,
  TickDoubleIcon,
  AiChat02Icon,
  Alert01Icon,
  MinusSignIcon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
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
