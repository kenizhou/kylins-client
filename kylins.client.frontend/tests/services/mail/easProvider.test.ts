import { describe, it, expect } from 'vitest';
import { EasProvider } from '../../../src/services/mail/easProvider';

describe('EasProvider', () => {
  it('has provider id "eas"', () => {
    const provider = new EasProvider({
      id: 'acc-1',
      email: 'test@example.com',
      provider: 'eas',
      providerConfig: { endpoint: 'https://exchange.example.com/Microsoft-Server-ActiveSync' },
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(provider.id).toBe('eas');
  });
});
