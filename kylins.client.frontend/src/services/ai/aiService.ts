import { getDb } from '../db/connection';
import type { LLMProvider, ChatMessage, ChatOptions } from './providers/base';

export class AIService {
  constructor(private _provider: LLMProvider) {}

  async getCachedResult(
    accountId: string | undefined,
    threadId: string,
    type: string,
  ): Promise<string | null> {
    const db = await getDb();
    const rows = await db.select<{ content: string }[]>(
      'SELECT content FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3',
      [accountId ?? null, threadId, type],
    );
    return rows[0]?.content ?? null;
  }

  async cacheResult(
    accountId: string | undefined,
    threadId: string,
    type: string,
    content: string,
  ): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO ai_cache (account_id, thread_id, type, content)
       VALUES ($1, $2, $3, $4)`,
      [accountId ?? null, threadId, type, content],
    );
  }

  async chat(
    accountId: string | undefined,
    threadId: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    const cached = await this.getCachedResult(accountId, threadId, 'chat');
    if (cached !== null) return cached;

    let result = '';
    for await (const chunk of this._provider.chat(messages, options)) {
      result += chunk;
    }

    await this.cacheResult(accountId, threadId, 'chat', result);
    return result;
  }

  async summarize(accountId: string | undefined, threadId: string, text: string): Promise<string> {
    const cached = await this.getCachedResult(accountId, threadId, 'summary');
    if (cached !== null) return cached;

    const result = await this._provider.summarize(text);
    await this.cacheResult(accountId, threadId, 'summary', result);
    return result;
  }
}
