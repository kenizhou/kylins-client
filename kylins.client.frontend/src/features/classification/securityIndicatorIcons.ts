import { getSetting, setSetting } from '../../services/settings';
import { SETTING_KEYS } from '../../services/settingsKeys';
import { CLASSIFICATION_ICON_IDS } from '../../components/icons';

export interface SecurityIndicatorIcons {
  encryptedIcon: string;
  signedIcon: string;
}

const DEFAULT_ICONS: SecurityIndicatorIcons = {
  encryptedIcon: 'lock',
  signedIcon: 'shield',
};

function isValidIconId(value: unknown): value is string {
  return typeof value === 'string' && CLASSIFICATION_ICON_IDS.includes(value as never);
}

function isValidSecurityIndicatorIcons(value: unknown): value is SecurityIndicatorIcons {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isValidIconId(v.encryptedIcon) && isValidIconId(v.signedIcon);
}

export function getDefaultSecurityIndicatorIcons(): SecurityIndicatorIcons {
  return { ...DEFAULT_ICONS };
}

export function sanitizeSecurityIndicatorIcons(value: unknown): SecurityIndicatorIcons {
  if (!isValidSecurityIndicatorIcons(value)) return getDefaultSecurityIndicatorIcons();
  return { encryptedIcon: value.encryptedIcon, signedIcon: value.signedIcon };
}

export async function loadSecurityIndicatorIcons(): Promise<SecurityIndicatorIcons> {
  try {
    const raw = await getSetting(SETTING_KEYS.securityIndicatorIcons);
    if (!raw) return getDefaultSecurityIndicatorIcons();
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeSecurityIndicatorIcons(parsed);
  } catch {
    return getDefaultSecurityIndicatorIcons();
  }
}

export async function saveSecurityIndicatorIcons(icons: SecurityIndicatorIcons): Promise<void> {
  await setSetting(SETTING_KEYS.securityIndicatorIcons, JSON.stringify(icons));
}
