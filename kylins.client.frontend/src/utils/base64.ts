/**
 * Decode a base64 string into bytes. Uses `atob` when available (browser +
 * jsdom); otherwise falls back to Node's `Buffer` in test/Node-only contexts.
 */
export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) return new Uint8Array(B.from(base64, 'base64'));
  throw new Error('No base64 decoder available');
}
