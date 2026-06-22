import { describe, it, expect, vi } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/services/crypto';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args: { plaintext?: string; ciphertext?: string }) => {
    if (cmd === 'encrypt_secret') return Promise.resolve(`enc:${args.plaintext}`);
    if (cmd === 'decrypt_secret') return Promise.resolve(args.ciphertext!.replace('enc:', ''));
    return Promise.reject(new Error('unknown command'));
  }),
}));

describe('crypto', () => {
  it('round-trips plaintext through mocked encryption', async () => {
    const secret = 'my-password';
    const encrypted = await encryptSecret(secret);
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe(secret);
  });
});
