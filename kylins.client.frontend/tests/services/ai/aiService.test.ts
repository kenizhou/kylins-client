import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIService } from '../../../src/services/ai/aiService';
import { getDb } from '../../../src/services/db/connection';

vi.mock('../../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as any);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

function createMockProvider(overrides?: Partial<{
  chat: (messages: any[], options?: any) => AsyncIterable<string>;
  summarize: (text: string) => Promise<string>;
}>) {
  return {
    id: 'mock',
    chat: overrides?.chat ?? (async function* () { yield 'mock response'; }),
    summarize: overrides?.summarize ?? (async () => 'mock summary'),
  };
}

describe('AIService', () => {
  it('getCachedResult returns cached content when a row exists', async () => {
    mockDb.select.mockResolvedValue([{ content: 'cached summary' }]);
    const service = new AIService(createMockProvider());
    const result = await service.getCachedResult('acc-1', 'thread-1', 'summary');
    expect(result).toBe('cached summary');
    expect(mockDb.select).toHaveBeenCalledWith(
      'SELECT content FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3',
      ['acc-1', 'thread-1', 'summary'],
    );
  });

  it('getCachedResult returns null when no row exists', async () => {
    mockDb.select.mockResolvedValue([]);
    const service = new AIService(createMockProvider());
    const result = await service.getCachedResult('acc-1', 'thread-1', 'summary');
    expect(result).toBeNull();
  });

  it('cacheResult inserts a new row', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const service = new AIService(createMockProvider());
    await service.cacheResult('acc-1', 'thread-1', 'summary', 'new summary');
    expect(mockDb.execute).toHaveBeenCalledWith(
      `INSERT OR REPLACE INTO ai_cache (account_id, thread_id, type, content)
       VALUES ($1, $2, $3, $4)`,
      ['acc-1', 'thread-1', 'summary', 'new summary'],
    );
  });

  it('cacheResult updates an existing row (upsert behavior)', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const service = new AIService(createMockProvider());
    await service.cacheResult('acc-1', 'thread-1', 'summary', 'updated summary');
    expect(mockDb.execute).toHaveBeenCalledWith(
      `INSERT OR REPLACE INTO ai_cache (account_id, thread_id, type, content)
       VALUES ($1, $2, $3, $4)`,
      ['acc-1', 'thread-1', 'summary', 'updated summary'],
    );
  });

  it('chat returns cached result when available', async () => {
    mockDb.select.mockResolvedValue([{ content: 'cached chat' }]);
    const provider = createMockProvider();
    const service = new AIService(provider);
    const result = await service.chat('acc-1', 'thread-1', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('cached chat');
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.any(String),
      ['acc-1', 'thread-1', 'chat'],
    );
  });

  it('chat delegates to provider and caches result on miss', async () => {
    mockDb.select.mockResolvedValue([]);
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const provider = createMockProvider({
      chat: async function* () { yield 'hello '; yield 'world'; },
    });
    const service = new AIService(provider);
    const result = await service.chat('acc-1', 'thread-1', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('hello world');
    expect(mockDb.execute).toHaveBeenCalledWith(
      expect.any(String),
      ['acc-1', 'thread-1', 'chat', 'hello world'],
    );
  });

  it('summarize returns cached result when available', async () => {
    mockDb.select.mockResolvedValue([{ content: 'cached summary' }]);
    const provider = createMockProvider();
    const service = new AIService(provider);
    const result = await service.summarize('acc-1', 'thread-1', 'long text');
    expect(result).toBe('cached summary');
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.any(String),
      ['acc-1', 'thread-1', 'summary'],
    );
  });

  it('summarize delegates to provider and caches result on miss', async () => {
    mockDb.select.mockResolvedValue([]);
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const provider = createMockProvider({
      summarize: async () => 'short summary',
    });
    const service = new AIService(provider);
    const result = await service.summarize('acc-1', 'thread-1', 'long text');
    expect(result).toBe('short summary');
    expect(mockDb.execute).toHaveBeenCalledWith(
      expect.any(String),
      ['acc-1', 'thread-1', 'summary', 'short summary'],
    );
  });
});
