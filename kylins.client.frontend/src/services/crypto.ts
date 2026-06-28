import { invoke } from '@tauri-apps/api/core';

export async function encryptSecret(plaintext: string): Promise<string> {
  console.log('[encryptSecret] invoking encrypt_secret');
  const result = await invoke<string>('encrypt_secret', { plaintext });
  console.log('[encryptSecret] encrypt_secret returned');
  return result;
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  console.log('[decryptSecret] invoking decrypt_secret');
  const result = await invoke<string>('decrypt_secret', { ciphertext });
  console.log('[decryptSecret] decrypt_secret returned');
  return result;
}
