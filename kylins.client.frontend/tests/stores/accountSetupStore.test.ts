import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAccountSetupStore,
  flagsComplete,
  emailValid,
  RequiredField,
} from '../../src/stores/accountSetupStore';

beforeEach(() => useAccountSetupStore.getState().reset());

describe('accountSetupStore', () => {
  it('flagsComplete returns true only when all required flags are present', () => {
    expect(flagsComplete(RequiredField.Email, RequiredField.Email)).toBe(true);
    expect(flagsComplete(RequiredField.Email | RequiredField.Password, RequiredField.Email)).toBe(
      false,
    );
  });

  it('emailValid accepts basic addresses', () => {
    expect(emailValid('a@b.com')).toBe(true);
    expect(emailValid('nope')).toBe(false);
  });

  it('selectProvider moves to gateway and records authType', () => {
    useAccountSetupStore.getState().selectProvider('gmail');
    expect(useAccountSetupStore.getState().step).toBe('gateway');
    expect(useAccountSetupStore.getState().providerId).toBe('gmail');
  });

  it('required mask for oauth provider is email+displayName; for password is email+password+displayName', () => {
    useAccountSetupStore.getState().selectProvider('gmail');
    expect(useAccountSetupStore.getState().requiredMask).toBe(
      RequiredField.Email | RequiredField.DisplayName,
    );
    useAccountSetupStore.getState().selectProvider('yahoo');
    expect(useAccountSetupStore.getState().requiredMask).toBe(
      RequiredField.Email | RequiredField.Password | RequiredField.DisplayName,
    );
  });

  it('canSubmit reflects required fields being valid', () => {
    useAccountSetupStore.getState().selectProvider('yahoo');
    expect(useAccountSetupStore.getState().canSubmit()).toBe(false);
    useAccountSetupStore.getState().setDisplayName('A User');
    useAccountSetupStore.getState().setEmail('a@b.com');
    useAccountSetupStore.getState().setPassword('pass');
    expect(useAccountSetupStore.getState().canSubmit()).toBe(true);
  });

  it('entering imap-manual prefills usernames and domain-based server hosts', () => {
    useAccountSetupStore.getState().selectProvider('imap');
    useAccountSetupStore.getState().setEmail('user@example.com');
    useAccountSetupStore.getState().setStep('imap-manual');
    const s = useAccountSetupStore.getState();
    expect(s.imapUsername).toBe('user@example.com');
    expect(s.smtpUsername).toBe('user@example.com');
    expect(s.imapHost).toBe('imap.example.com');
    expect(s.smtpHost).toBe('smtp.example.com');
  });

  it('entering imap-manual preserves manually edited server hosts', () => {
    useAccountSetupStore.getState().selectProvider('imap');
    useAccountSetupStore.getState().setEmail('user@example.com');
    useAccountSetupStore.getState().setImap({ imapHost: 'custom-imap.example.com' });
    useAccountSetupStore.getState().setStep('imap-manual');
    const s = useAccountSetupStore.getState();
    expect(s.imapHost).toBe('custom-imap.example.com');
    expect(s.smtpHost).toBe('smtp.example.com');
  });
});
