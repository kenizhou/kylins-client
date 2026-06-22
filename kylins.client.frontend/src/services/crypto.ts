import { invoke } from '@tauri-apps/api/core';

export async function encryptSecret(plaintext: string): Promise<string> {
  return invoke<string>('encrypt_secret', { plaintext });
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  return invoke<string>('decrypt_secret', { ciphertext });
}
