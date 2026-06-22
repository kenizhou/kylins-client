export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  id: string;
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
  summarize(text: string): Promise<string>;
}
