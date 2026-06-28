// Task 5 clean-cut: aiService.ts cache read/write now routes through
// `invoke('db_*')` instead of getDb(). Mock invoke; the LLM provider stays a
// real mock object passed into the constructor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIService } from '../../../src/services/ai/aiService';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';
import type { ChatMessage, ChatOptions } from '../../../src/services/ai/providers/base';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

function createMockProvider(
  overrides?: Partial<{
    chat: (messages: ChatMessage[], options?: ChatOptions) => AsyncIterable<string>;
    summarize: (text: string) => Promise<string>;
  }>,
) {
  return {
    id: 'mock',
    chat:
      overrides?.chat ??
      async function* () {
        yield 'mock response';
      },
    summarize: overrides?.summarize ?? (async () => 'mock summary'),
  };
}

describe('AIService', () => {
  it('getCachedResult returns cached content when invoke returns a string', async () => {
    mockInvoke.mockResolvedValueOnce('cached summary');
    const service = new AIService(createMockProvider());
    const result = await service.getCachedResult('acc-1', 'thread-1', 'summary');
    expect(result).toBe('cached summary');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_cached_ai_result', {
      accountId: 'acc-1',
      threadId: 'thread-1',
      cacheType: 'summary',
    });
  });

  it('getCachedResult returns null when invoke returns null', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const service = new AIService(createMockProvider());
    const result = await service.getCachedResult('acc-1', 'thread-1', 'summary');
    expect(result).toBeNull();
  });

  it('getCachedResult forwards undefined accountId as null', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const service = new AIService(createMockProvider());
    await service.getCachedResult(undefined, 'thread-1', 'summary');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_cached_ai_result', {
      accountId: null,
      threadId: 'thread-1',
      cacheType: 'summary',
    });
  });

  it('cacheResult forwards to db_cache_ai_result', async () => {
    const service = new AIService(createMockProvider());
    await service.cacheResult('acc-1', 'thread-1', 'summary', 'new summary');
    expect(mockInvoke).toHaveBeenCalledWith('db_cache_ai_result', {
      accountId: 'acc-1',
      threadId: 'thread-1',
      cacheType: 'summary',
      content: 'new summary',
    });
  });

  it('chat returns cached result when available (no cache write)', async () => {
    mockInvoke.mockResolvedValueOnce('cached chat'); // getCachedResult hit
    const provider = createMockProvider();
    const service = new AIService(provider);
    const result = await service.chat('acc-1', 'thread-1', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('cached chat');
    // Only one invoke call: the cache read. No cache write should follow a hit.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('db_get_cached_ai_result');
  });

  it('chat delegates to provider and caches the streamed result on miss', async () => {
    mockInvoke.mockResolvedValueOnce(null); // getCachedResult miss
    mockInvoke.mockResolvedValueOnce(undefined); // cacheResult
    const provider = createMockProvider({
      chat: async function* () {
        yield 'hello ';
        yield 'world';
      },
    });
    const service = new AIService(provider);
    const result = await service.chat('acc-1', 'thread-1', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('hello world');
    // Second invoke is the cache write.
    expect(mockInvoke.mock.calls[1]![0]).toBe('db_cache_ai_result');
    expect(mockInvoke.mock.calls[1]![1]).toMatchObject({
      accountId: 'acc-1',
      threadId: 'thread-1',
      cacheType: 'chat',
      content: 'hello world',
    });
  });

  it('summarize returns cached result when available (no cache write)', async () => {
    mockInvoke.mockResolvedValueOnce('cached summary');
    const provider = createMockProvider();
    const service = new AIService(provider);
    const result = await service.summarize('acc-1', 'thread-1', 'long text');
    expect(result).toBe('cached summary');
    // Only one invoke call: the cache read. No cache write should follow a hit.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]![0]).toBe('db_get_cached_ai_result');
  });

  it('summarize delegates to provider and caches the result on miss', async () => {
    mockInvoke.mockResolvedValueOnce(null); // miss
    mockInvoke.mockResolvedValueOnce(undefined); // cacheResult
    const provider = createMockProvider({
      summarize: async () => 'short summary',
    });
    const service = new AIService(provider);
    const result = await service.summarize('acc-1', 'thread-1', 'long text');
    expect(result).toBe('short summary');
    expect(mockInvoke.mock.calls[1]![0]).toBe('db_cache_ai_result');
    expect(mockInvoke.mock.calls[1]![1]).toMatchObject({
      cacheType: 'summary',
      content: 'short summary',
    });
  });
});
