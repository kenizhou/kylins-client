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

  it('required mask for oauth provider is email only; for password is email+password', () => {
    useAccountSetupStore.getState().selectProvider('gmail');
    expect(useAccountSetupStore.getState().requiredMask).toBe(RequiredField.Email);
    useAccountSetupStore.getState().selectProvider('yahoo');
    expect(useAccountSetupStore.getState().requiredMask).toBe(
      RequiredField.Email | RequiredField.Password,
    );
  });

  it('canSubmit reflects required fields being valid', () => {
    useAccountSetupStore.getState().selectProvider('yahoo');
    expect(useAccountSetupStore.getState().canSubmit()).toBe(false);
    useAccountSetupStore.getState().setEmail('a@b.com');
    useAccountSetupStore.getState().setPassword('pass');
    expect(useAccountSetupStore.getState().canSubmit()).toBe(true);
  });
});
