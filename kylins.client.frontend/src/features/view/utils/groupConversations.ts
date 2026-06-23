interface MessageLike {
  id: string;
  subject: string;
  threadId?: string;
}

interface ConversationGroup {
  key: string;
  subject: string;
  messages: MessageLike[];
}

export function groupConversations(messages: MessageLike[]): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();

  for (const message of messages) {
    const key = message.threadId ?? message.subject;
    const existing = groups.get(key);
    if (existing) {
      existing.messages.push(message);
    } else {
      groups.set(key, {
        key,
        subject: message.subject,
        messages: [message],
      });
    }
  }

  return Array.from(groups.values());
}
