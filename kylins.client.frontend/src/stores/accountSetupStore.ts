import { create } from 'zustand';
import type { SetupProviderId, ProviderConfig } from '../services/auth/providers';
import { getProvider } from '../services/auth/providers';
import type { SecurityMode } from '../types';

export type SetupStep =
  | 'pick'
  | 'gateway'
  | 'oauth-pending'
  | 'imap-manual'
  | 'eas-manual'
  | 'verifying'
  | 'welcome'
  | 'error';

export enum RequiredField {
  None = 0,
  Email = 1 << 0,
  Password = 1 << 1,
  ImapServer = 1 << 2,
  ImapPort = 1 << 3,
  SmtpServer = 1 << 4,
  SmtpPort = 1 << 5,
  EasServer = 1 << 6,
  DisplayName = 1 << 7,
}

export function flagsComplete(required: RequiredField, actual: RequiredField): boolean {
  return (actual & required) === required;
}

export function emailValid(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

export function portValid(port: string): boolean {
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

export interface CredentialsGateErrors {
  displayName?: string;
  email?: string;
  password?: string;
}

export type ImapManualFormErrors = Partial<
  Record<
    | 'imapHost'
    | 'imapPort'
    | 'imapSecurity'
    | 'imapUsername'
    | 'smtpHost'
    | 'smtpPort'
    | 'smtpSecurity'
    | 'smtpUsername',
    string
  >
>;

export interface EasManualFormErrors {
  server?: string;
  deviceId?: string;
}

function domainFromEmail(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain || !emailValid(email)) return null;
  return domain;
}

function imapDefaultsFromEmail(
  email: string,
): Partial<Pick<AccountSetupState, 'imapHost' | 'smtpHost'>> {
  const domain = domainFromEmail(email);
  if (!domain) return {};
  return { imapHost: `imap.${domain}`, smtpHost: `smtp.${domain}` };
}

export function getCredentialsGateErrors(
  state: Pick<AccountSetupState, 'displayName' | 'email' | 'password' | 'config'>,
): CredentialsGateErrors {
  const errors: CredentialsGateErrors = {};
  if (!state.displayName.trim()) {
    errors.displayName = 'Enter the name shown on outgoing messages.';
  }
  if (!state.email.trim()) {
    errors.email = 'Enter your email address.';
  } else if (!emailValid(state.email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (state.config?.authType === 'password' && state.password.trim().length < 3) {
    errors.password = 'Enter your password.';
  }
  return errors;
}

export function getImapManualErrors(
  state: Pick<
    AccountSetupState,
    'imapHost' | 'imapPort' | 'imapUsername' | 'smtpHost' | 'smtpPort' | 'smtpUsername'
  >,
): ImapManualFormErrors {
  const errors: ImapManualFormErrors = {};
  if (!state.imapHost.trim()) errors.imapHost = 'Enter the IMAP server.';
  if (!portValid(state.imapPort)) errors.imapPort = 'Enter a valid port (1–65535).';
  if (!state.imapUsername.trim()) errors.imapUsername = 'Enter the IMAP username.';
  if (!state.smtpHost.trim()) errors.smtpHost = 'Enter the SMTP server.';
  if (!portValid(state.smtpPort)) errors.smtpPort = 'Enter a valid port (1–65535).';
  if (!state.smtpUsername.trim()) errors.smtpUsername = 'Enter the SMTP username.';
  return errors;
}

export function getEasManualErrors(
  state: Pick<AccountSetupState, 'easServer' | 'deviceId'>,
): EasManualFormErrors {
  const errors: EasManualFormErrors = {};
  if (!state.easServer.trim()) errors.server = 'Enter the Exchange server URL.';
  if (!state.deviceId.trim()) errors.deviceId = 'Enter a device ID.';
  return errors;
}

function providerRequiredMask(config: ProviderConfig): RequiredField {
  const base =
    config.authType === 'oauth2'
      ? RequiredField.Email
      : RequiredField.Email | RequiredField.Password;
  return base | RequiredField.DisplayName;
}

export interface AccountSetupState {
  step: SetupStep;
  providerId: SetupProviderId | null;
  config: ProviderConfig | null;
  requiredMask: RequiredField;
  email: string;
  displayName: string;
  password: string;
  advancedClientId: string;
  advancedClientSecret: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: SecurityMode;
  imapUsername: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SecurityMode;
  smtpUsername: string;
  easServer: string;
  deviceId: string;
  acceptInvalidCerts: boolean;
  error: string | null;
  selectProvider: (id: SetupProviderId) => void;
  setStep: (step: SetupStep) => void;
  setEmail: (v: string) => void;
  setDisplayName: (v: string) => void;
  setPassword: (v: string) => void;
  setAdvancedClientId: (v: string) => void;
  setAdvancedClientSecret: (v: string) => void;
  setImap: (
    patch: Partial<
      Pick<AccountSetupState, 'imapHost' | 'imapPort' | 'imapSecurity' | 'imapUsername'>
    >,
  ) => void;
  setSmtp: (
    patch: Partial<
      Pick<AccountSetupState, 'smtpHost' | 'smtpPort' | 'smtpSecurity' | 'smtpUsername'>
    >,
  ) => void;
  setEasServer: (v: string) => void;
  setDeviceId: (v: string) => void;
  setAcceptInvalidCerts: (v: boolean) => void;
  setError: (e: string | null) => void;
  back: () => void;
  canSubmit: () => boolean;
  reset: () => void;
}

type FormState = Pick<
  AccountSetupState,
  | 'email'
  | 'displayName'
  | 'password'
  | 'advancedClientId'
  | 'advancedClientSecret'
  | 'imapHost'
  | 'imapPort'
  | 'imapSecurity'
  | 'imapUsername'
  | 'smtpHost'
  | 'smtpPort'
  | 'smtpSecurity'
  | 'smtpUsername'
  | 'easServer'
  | 'deviceId'
  | 'acceptInvalidCerts'
  | 'error'
>;

function initialForm(): FormState {
  return {
    email: '',
    displayName: '',
    password: '',
    advancedClientId: '',
    advancedClientSecret: '',
    imapHost: '',
    imapPort: '993',
    imapSecurity: 'tls',
    imapUsername: '',
    smtpHost: '',
    smtpPort: '587',
    smtpSecurity: 'starttls',
    smtpUsername: '',
    easServer: '',
    deviceId: '',
    acceptInvalidCerts: false,
    error: null,
  };
}

export const useAccountSetupStore = create<AccountSetupState>((set, get) => ({
  step: 'pick',
  providerId: null,
  config: null,
  requiredMask: RequiredField.None,
  ...initialForm(),
  selectProvider: (id) => {
    const config = getProvider(id);
    const presets =
      config.authType === 'password' && config.presets
        ? {
            imapHost: config.presets.imapHost,
            imapPort: String(config.presets.imapPort),
            imapSecurity: config.presets.imapSecurity,
            smtpHost: config.presets.smtpHost,
            smtpPort: String(config.presets.smtpPort),
            smtpSecurity: config.presets.smtpSecurity,
          }
        : {};
    set({
      providerId: id,
      config,
      requiredMask: providerRequiredMask(config),
      step: 'gateway',
      ...initialForm(),
      ...presets,
    });
  },
  setStep: (step) => {
    const s = get();
    // When landing on the manual IMAP form, default both usernames and the
    // server hostnames (from the email domain) so the user only has to edit
    // them if they differ.
    if (step === 'imap-manual' && s.email) {
      const defaults = imapDefaultsFromEmail(s.email);
      set({
        step,
        imapUsername: s.imapUsername || s.email,
        smtpUsername: s.smtpUsername || s.email,
        imapHost: s.imapHost || defaults.imapHost || '',
        smtpHost: s.smtpHost || defaults.smtpHost || '',
      });
    } else {
      set({ step });
    }
  },
  setEmail: (email) => set({ email }),
  setDisplayName: (displayName) => set({ displayName }),
  setPassword: (password) => set({ password }),
  setAdvancedClientId: (advancedClientId) => set({ advancedClientId }),
  setAdvancedClientSecret: (advancedClientSecret) => set({ advancedClientSecret }),
  setImap: (patch) => set(patch),
  setSmtp: (patch) => set(patch),
  setEasServer: (easServer) => set({ easServer }),
  setDeviceId: (deviceId) => set({ deviceId }),
  setAcceptInvalidCerts: (acceptInvalidCerts) => set({ acceptInvalidCerts }),
  setError: (error) => set({ error }),
  back: () => {
    const s = get();
    if (s.step === 'gateway' || s.step === 'oauth-pending') set({ step: 'pick', error: null });
    else set({ step: 'gateway', error: null });
  },
  canSubmit: () => {
    const s = get();
    if (!s.config) return false;
    let actual = RequiredField.None;
    if (s.displayName.trim().length > 0) actual |= RequiredField.DisplayName;
    if (emailValid(s.email)) actual |= RequiredField.Email;
    if (s.password.trim().length >= 3) actual |= RequiredField.Password;
    return flagsComplete(s.requiredMask, actual);
  },
  reset: () =>
    set({
      step: 'pick',
      providerId: null,
      config: null,
      requiredMask: RequiredField.None,
      ...initialForm(),
    }),
}));
