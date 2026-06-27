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
}

export function flagsComplete(required: RequiredField, actual: RequiredField): boolean {
  return (actual & required) === required;
}

export function emailValid(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function providerRequiredMask(config: ProviderConfig): RequiredField {
  return config.authType === 'oauth2'
    ? RequiredField.Email
    : RequiredField.Email | RequiredField.Password;
}

export interface AccountSetupState {
  step: SetupStep;
  providerId: SetupProviderId | null;
  config: ProviderConfig | null;
  requiredMask: RequiredField;
  email: string;
  password: string;
  advancedClientId: string;
  advancedClientSecret: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: SecurityMode;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SecurityMode;
  easServer: string;
  deviceId: string;
  acceptInvalidCerts: boolean;
  error: string | null;
  selectProvider: (id: SetupProviderId) => void;
  setStep: (step: SetupStep) => void;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  setAdvancedClientId: (v: string) => void;
  setAdvancedClientSecret: (v: string) => void;
  setImap: (
    patch: Partial<Pick<AccountSetupState, 'imapHost' | 'imapPort' | 'imapSecurity'>>,
  ) => void;
  setSmtp: (
    patch: Partial<Pick<AccountSetupState, 'smtpHost' | 'smtpPort' | 'smtpSecurity'>>,
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
  | 'password'
  | 'advancedClientId'
  | 'advancedClientSecret'
  | 'imapHost'
  | 'imapPort'
  | 'imapSecurity'
  | 'smtpHost'
  | 'smtpPort'
  | 'smtpSecurity'
  | 'easServer'
  | 'deviceId'
  | 'acceptInvalidCerts'
  | 'error'
>;

function initialForm(): FormState {
  return {
    email: '',
    password: '',
    advancedClientId: '',
    advancedClientSecret: '',
    imapHost: '',
    imapPort: '993',
    imapSecurity: 'tls',
    smtpHost: '',
    smtpPort: '587',
    smtpSecurity: 'starttls',
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
  setStep: (step) => set({ step }),
  setEmail: (email) => set({ email }),
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
