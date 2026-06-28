// Task 5 (Option C) clean-cut cutover: the cache read/write half of this
// service now delegates to Rust `db_*` Tauri commands (see
// `kylins.client.backend/src/db/ai_cache.rs`). The LLM provider invocation
// (`chat` / `summarize`) stays TS-side — it streams from the provider and only
// touches the DB to read/write the cache row.

import { invoke } from '@tauri-apps/api/core';
import type { LLMProvider, ChatMessage, ChatOptions } from './providers/base';

export class AIService {
  constructor(private _provider: LLMProvider) {}

  async getCachedResult(
    accountId: string | undefined,
    threadId: string,
    type: string,
  ): Promise<string | null> {
    return invoke<string | null>('db_get_cached_ai_result', {
      accountId: accountId ?? null,
      threadId,
      cacheType: type,
    });
  }

  async cacheResult(
    accountId: string | undefined,
    threadId: string,
    type: string,
    content: string,
  ): Promise<void> {
    await invoke<void>('db_cache_ai_result', {
      accountId: accountId ?? null,
      threadId,
      cacheType: type,
      content,
    });
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
