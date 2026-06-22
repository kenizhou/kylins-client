import type { ChatMessage, ChatOptions, LLMProvider } from './base';

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';

  constructor(private _baseUrl: string = 'http://localhost:11434') {
    void this._baseUrl;
  }

  async *chat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<string> {
    // TODO: integrate Ollama API
    yield '';
  }

  async summarize(_text: string): Promise<string> {
    // TODO: implement
    return '';
  }
}
