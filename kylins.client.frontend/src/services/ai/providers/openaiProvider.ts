import type { ChatMessage, ChatOptions, LLMProvider } from './base';

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';

  constructor(private _apiKey: string) {
    void this._apiKey;
  }

  async *chat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<string> {
    // TODO: integrate OpenAI SDK
    yield '';
  }

  async summarize(_text: string): Promise<string> {
    // TODO: implement
    return '';
  }
}
