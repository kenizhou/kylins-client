import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadStore } from '../../src/stores/threadStore';
import type { Thread } from '../../src/services/db/threads';

function mkThread(id: string): Thread {
  return {
    id,
    accountId: 'a',
    subject: null,
    snippet: null,
    lastMessageAt: null,
    messageCount: 1,
    isRead: false,
    isStarred: false,
    isImportant: false,
    hasAttachments: false,
    isSnoozed: false,
    fromName: null,
    fromAddress: null,
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
  };
}

describe('threadStore.patchSnippets', () => {
  beforeEach(() => {
    useThreadStore.setState({
      threads: [mkThread('t1'), mkThread('t2'), mkThread('t3')],
      selectedThreadId: null,
      isLoading: false,
      cursor: null,
      currentQuery: null,
    });
  });

  it('patches only the snippet of matching threads in place', () => {
    useThreadStore.getState().patchSnippets([
      { threadId: 't2', snippet: 'hello' },
      { threadId: 'missing', snippet: 'nope' },
    ]);
    const after = useThreadStore.getState().threads;
    expect(after[1]!.snippet).toBe('hello');
    expect(after[0]!.snippet).toBeNull();
    expect(after[2]!.snippet).toBeNull();
  });

  it('preserves array identity of UNPATCHED threads (scroll-safe)', () => {
    // react-virtualized #1837: a full reload invalidates measured sizes.
    // Unpatched thread objects MUST be === their prior reference.
    const before = useThreadStore.getState().threads;
    useThreadStore.getState().patchSnippets([{ threadId: 't2', snippet: 'hello' }]);
    const after = useThreadStore.getState().threads;
    expect(after[0]).toBe(before[0]); // same ref
    expect(after[2]).toBe(before[2]); // same ref
    expect(after[1]).not.toBe(before[1]); // patched row is a new object
  });
});
