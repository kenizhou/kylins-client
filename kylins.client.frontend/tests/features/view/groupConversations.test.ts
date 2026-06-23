import { describe, it, expect } from 'vitest';
import { groupConversations } from '../../../src/features/view/utils/groupConversations';

describe('groupConversations', () => {
  it('groups messages by threadId when present', () => {
    const messages = [
      { id: '1', subject: 'Project', threadId: 't1' },
      { id: '2', subject: 'Re: Project', threadId: 't1' },
      { id: '3', subject: 'Other', threadId: 't2' },
    ];

    const groups = groupConversations(messages);
    expect(groups).toHaveLength(2);

    const t1 = groups.find((g) => g.key === 't1');
    expect(t1?.messages).toHaveLength(2);
    expect(t1?.messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('falls back to subject when threadId is missing', () => {
    const messages = [
      { id: '1', subject: 'Standalone' },
      { id: '2', subject: 'Standalone' },
      { id: '3', subject: 'Another' },
    ];

    const groups = groupConversations(messages);
    expect(groups).toHaveLength(2);

    const standalone = groups.find((g) => g.key === 'Standalone');
    expect(standalone?.messages).toHaveLength(2);
  });

  it('returns an empty array for empty input', () => {
    expect(groupConversations([])).toEqual([]);
  });
});
