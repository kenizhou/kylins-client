# Composer AI Inline Assist — 技术设计

> 如何在 Tiptap/ProseMirror 中实现类似 Cursor/GitHub Copilot 的 AI 智能提示和内联补全
> 日期: 2026-06-30

---

## 一、Tiptap 能支持吗？

**直接回答：完全可以。** Tiptap 底层是 ProseMirror，它暴露了实现 inline AI 所需的所有底层能力。

### ProseMirror 的四个关键机制

| 机制 | 用途 | AI 场景 |
|------|------|---------|
| **Decoration** | 在文档上叠加视觉层，不修改实际内容 | Ghost text（灰色预测文本） |
| **Plugin** | 拦截编辑器事件、管理外部状态 | 监听输入 → 触发 AI → 展示结果 |
| **Node Extension** | 自定义文档节点类型 | AI 生成的富文本块 |
| **Command** | 程序化操作编辑器 | 接受/拒绝 AI 建议 |

### 三种 AI 内联交互模式

参考编程编辑器的成熟模式，对应到邮件编辑场景：

| 模式 | 编辑器类比 | 邮件场景 | 实现难度 |
|------|-----------|---------|---------|
| **Ghost Text（智能补全）** | GitHub Copilot 灰色预测 | Gmail Smart Compose — 预测下一个词/句 | ⭐⭐⭐ 中等 |
| **Inline Chat（行内指令）** | Cursor Ctrl+K | 选中文字 → AI 改写/润色/翻译 | ⭐⭐ 简单 |
| **Command Palette（指令面板）** | VS Code `/` 命令 | 输入 `/summary` → AI 生成段落 | ⭐⭐ 简单 |

---

## 二、模式一：Ghost Text（Gmail Smart Compose 增强版）

这是最核心也是技术最有意思的模式。对标：
- **GitHub Copilot** — 灰色 ghost text，Tab 接受
- **Gmail Smart Compose** — 浅灰色预测文本，Tab 接受
- **Cursor Tab** — 灰色预测 + 实时 streaming

### 2.1 效果示意

```
用户在 Composer 中输入:

┌──────────────────────────────────────────────────────────┐
│ Dear Mr. Johnson,                                         │
│                                                          │
│ Following up on our discussion last week, I'd like to     │
│ propose the following timeline for the Q4 project launch: │
│                                                          │
│ 1. Phase 1 de│sign review (Week of Oct 10)  ← ghost text │
│              │                                           │
│              └─ 光标位置                                  │
│                                                          │
│ [Tab to accept] [Esc to dismiss]                         │
└──────────────────────────────────────────────────────────┘
```

### 2.2 ProseMirror Decoration 原理

ProseMirror 的 Decoration 系统允许在不修改文档内容的情况下，在编辑器视图上叠加视觉效果。这是实现 ghost text 的完美机制。

**关键概念：**

```
Document State（实际内容）     View（用户看到的）
┌──────────────────────┐     ┌──────────────────────┐
│ "Dear Mr. Johnson, " │     │ "Dear Mr. Johnson,   │
│ "Following up..."    │     │ Following up..."      │
│ "1. Phase 1 de"      │  +  │ 1. Phase 1 de████████│ ← Widget Decoration
│                      │     │ sign review (Week..."  │   (灰色,不占文档)
└──────────────────────┘     └──────────────────────┘
                                      ↑
                               Decoration 层:
                               仅存在于 View,
                               不影响 Document
```

**三种 Decoration 类型：**

```typescript
import { Decoration, DecorationSet } from 'prosemirror-view';

// 1. Widget Decoration — 在指定位置插入一个 DOM 节点
//    用于: ghost text（光标后的灰色文字）
const ghostWidget = Decoration.widget(
  cursorPos,  // 位置
  () => {
    const span = document.createElement('span');
    span.className = 'ai-ghost-text';
    span.textContent = 'sign review (Week of Oct 10)';
    span.style.color = 'var(--muted-foreground)';
    span.style.opacity = '0.5';
    return span;
  },
  { side: 1 }  // 在光标右侧
);

// 2. Inline Decoration — 给已有内容加样式
//    用于: 高亮 AI 改写后的文字
const highlightDeco = Decoration.inline(from, to, {
  class: 'ai-suggested-text',
  style: 'background: rgba(0,120,212,0.1); border-bottom: 1px dashed var(--primary);'
});

// 3. Node Decoration — 给整个节点加样式
//    用于: AI 生成的整个段落
const nodeDeco = Decoration.node(from, to, {
  class: 'ai-generated-block',
});
```

### 2.3 实现架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Tiptap Editor (React)                      │
│                                                               │
│  ┌──────────────────────────────────────┐                    │
│  │        AI Ghost Text Plugin           │                    │
│  │        (ProseMirror Plugin)           │                    │
│  │                                       │                    │
│  │  state: {                             │                    │
│  │    suggestion: string | null          │  ← 当前建议文本     │
│  │    position: number | null            │  ← 建议位置         │
│  │    isLoading: boolean                 │  ← 加载中          │
│  │    requestId: number                  │  ← 请求版本号       │
│  │  }                                    │                    │
│  │                                       │                    │
│  │  decorations(state):                  │                    │
│  │    if state.suggestion:               │                    │
│  │      return [widget at position]      │                    │
│  │    else:                              │                    │
│  │      return []                        │                    │
│  │                                       │                    │
│  │  view.update():                       │                    │
│  │    on doc change:                     │                    │
│  │      cancel pending request           │                    │
│  │      debounce 300ms →                 │                    │
│  │        invoke AI →                    │                    │
│  │        update suggestion state        │                    │
│  └──────────────────────────────────────┘                    │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────┐                    │
│  │     AI Context Assembler              │                    │
│  │     (invoke Rust command)             │                    │
│  │                                       │                    │
│  │  Input:                               │                    │
│  │    - draftText (before cursor)        │                    │
│  │    - threadContext (原邮件内容)        │                    │
│  │    - recipientInfo (收件人关系)        │                    │
│  │    - userStyle (写作风格偏好)          │                    │
│  │                                       │                    │
│  │  Output:                              │                    │
│  │    - assembled prompt for LLM         │                    │
│  └──────────────────────────────────────┘                    │
│                          │                                    │
│                          ▼                                    │
│  ┌──────────────────────────────────────┐                    │
│  │     AI Streaming (Vercel AI SDK)      │                    │
│  │                                       │                    │
│  │  streamText({                         │                    │
│  │    model: 'gpt-4o-mini',             │                    │
│  │    prompt: assembledContext,          │                    │
│  │    maxTokens: 50,  // 内联建议不需要太长  │                 │
│  │  })                                   │                    │
│  │                                       │                    │
│  │  onChunk → update ghost text          │                    │
│  └──────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 核心代码

#### Step 1: AI Ghost Text Plugin (ProseMirror Plugin)

```typescript
// src/features/composer/plugins/aiGhostText.ts

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';

// Plugin state
interface GhostTextState {
  suggestion: string;
  position: number;     // ProseMirror position where ghost text starts
  requestId: number;    // Monotonic counter — 丢弃过期请求
  isLoading: boolean;
}

const ghostTextKey = new PluginKey<GhostTextState>('ai-ghost-text');

// ---- AI invocation (extracted for testability) ----
type SuggestionFetcher = (
  textBefore: string,
  context: ComposeContext,
  signal: AbortSignal,
) => AsyncIterable<string>; // streaming chunks

interface ComposeContext {
  threadId?: string;
  recipients: string[];
}

// ---- Plugin factory ----
export function aiGhostTextPlugin(
  fetcher: SuggestionFetcher,
  getContext: () => ComposeContext,
  debounceMs = 300,
) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  function cancelPending() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abortController) { abortController.abort(); abortController = null; }
  }

  return new Plugin<GhostTextState>({
    key: ghostTextKey,

    state: {
      init(): GhostTextState {
        return { suggestion: '', position: 0, requestId: 0, isLoading: false };
      },
      apply(tr, prev) {
        // Meta can carry a new suggestion update
        const meta = tr.getMeta(ghostTextKey);
        if (meta) return { ...prev, ...meta };
        // Clear suggestion on any doc change
        if (tr.docChanged) return { ...prev, suggestion: '', isLoading: false };
        return prev;
      },
    },

    view(editorView: EditorView) {
      return {
        update(view: EditorView) {
          // Only trigger on doc changes (user typing)
          if (!view.state.docChanged) return;

          cancelPending();

          const { $cursor } = view.state.selection;
          if (!$cursor) {
            // No cursor — clear suggestion
            const state = ghostTextKey.getState(view.state);
            if (state?.suggestion) {
              view.dispatch(view.state.tr.setMeta(ghostTextKey, { suggestion: '', position: 0 }));
            }
            return;
          }

          // Get text before cursor as context
          const cursorPos = $cursor.pos;
          const textBefore = $cursor.parent.textContent.slice(0, $cursor.parentOffset);

          // Don't suggest if cursor is at the very beginning or text is too short
          if (textBefore.trim().length < 5) return;

          const requestId = (ghostTextKey.getState(view.state)?.requestId ?? 0) + 1;

          debounceTimer = setTimeout(async () => {
            abortController = new AbortController();
            const signal = abortController.signal;

            // Mark loading
            view.dispatch(view.state.tr.setMeta(ghostTextKey, { isLoading: true }));

            try {
              let suggestion = '';
              for await (const chunk of fetcher(textBefore, getContext(), signal)) {
                suggestion += chunk;
                // Stream each chunk as it arrives
                view.dispatch(view.state.tr.setMeta(ghostTextKey, {
                  suggestion,
                  position: cursorPos,
                  requestId,
                  isLoading: true,
                }));
              }
              // Mark complete
              view.dispatch(view.state.tr.setMeta(ghostTextKey, {
                isLoading: false,
                requestId,
              }));
            } catch (err: any) {
              if (err?.name === 'AbortError') return;
              // On error, just clear the suggestion
              view.dispatch(view.state.tr.setMeta(ghostTextKey, { suggestion: '', isLoading: false }));
            }
          }, debounceMs);
        },
      };
    },

    props: {
      decorations(state) {
        const ghost = ghostTextKey.getState(state);
        if (!ghost?.suggestion || !ghost?.position) return DecorationSet.empty;

        const widget = Decoration.widget(
          ghost.position,
          () => {
            const span = document.createElement('span');
            span.className = 'ai-ghost-text';
            span.setAttribute('contenteditable', 'false');
            span.textContent = ghost.suggestion;

            // Loading state — shimmer animation
            if (ghost.isLoading) {
              span.classList.add('ai-ghost-loading');
            }

            return span;
          },
          {
            side: 1,           // right side of position
            marks: [],          // no marks
            stopEvent: () => true, // prevent editing ghost text
          },
        );

        return DecorationSet.create(state.doc, [widget]);
      },

      handleKeyDown(view, event) {
        const ghost = ghostTextKey.getState(view.state);

        // Tab — accept suggestion
        if (event.key === 'Tab' && ghost?.suggestion) {
          event.preventDefault();
          cancelPending();

          // Insert the suggestion as real text
          const tr = view.state.tr.insertText(ghost.suggestion, ghost.position);
          // Move cursor to end of inserted text
          tr.setSelection(
            view.state.selection.constructor.near(
              tr.doc.resolve(ghost.position + ghost.suggestion.length),
            ),
          );
          // Clear the ghost
          tr.setMeta(ghostTextKey, { suggestion: '', position: 0, isLoading: false });
          view.dispatch(tr);
          return true;
        }

        // Escape — dismiss suggestion
        if (event.key === 'Escape' && ghost?.suggestion) {
          event.preventDefault();
          cancelPending();
          view.dispatch(
            view.state.tr.setMeta(ghostTextKey, { suggestion: '', position: 0, isLoading: false }),
          );
          return true;
        }

        // Any other key — clear ghost text (user is writing their own content)
        if (ghost?.suggestion && event.key.length === 1) {
          view.dispatch(
            view.state.tr.setMeta(ghostTextKey, { suggestion: '', position: 0, isLoading: false }),
          );
        }

        return false;
      },
    },
  });
}
```

#### Step 2: 注册到 Tiptap

```typescript
// src/features/composer/editorExtensions.ts (扩展)

import { aiGhostTextPlugin } from './plugins/aiGhostText';
import type { ComposeContext } from './plugins/aiGhostText';

// AI Suggestion fetcher — 调用 Vercel AI SDK streaming
async function* fetchSuggestion(
  textBefore: string,
  context: ComposeContext,
  signal: AbortSignal,
): AsyncIterable<string> {
  // 1. 组装 AI 上下文 (调 Rust command)
  const promptContext = await invoke<string>('ai_assemble_compose_context', {
    draftText: textBefore,
    threadId: context.threadId ?? null,
    recipients: context.recipients,
  });

  // 2. 调用 LLM streaming
  const { streamText } = await import('ai');
  const { openai } = await import('@ai-sdk/openai');

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system: `You are an email writing assistant. Continue the user's draft naturally, 
             matching their tone and style. Only provide the NEXT few words (2-8 words).
             Do NOT repeat what the user already wrote. Do NOT add greetings or signatures.
             Just continue the sentence naturally.`,
    messages: [{ role: 'user', content: `${promptContext}\n\nContinue: ${textBefore}` }],
    maxTokens: 30,
    temperature: 0.3,
    abortSignal: signal,
  });

  // 3. Yield streaming chunks
  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

export function buildComposerExtensions(
  placeholder: string,
  aiOptions?: { threadId?: string; recipients: string[] },
) {
  const extensions = [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
    Placeholder.configure({ placeholder }),
    Image.configure({ inline: true, allowBase64: true }),
    TextStyle, Color, Highlight.configure({ multicolor: true }), FontFamily,
    Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
  ];

  // Add AI ghost text plugin if AI is enabled in preferences
  const aiEnabled = usePreferencesStore.getState().aiAutoDraftEnabled;
  if (aiEnabled) {
    extensions.push(
      aiGhostTextPlugin(
        fetchSuggestion,
        () => ({ threadId: aiOptions?.threadId, recipients: aiOptions?.recipients ?? [] }),
        300, // debounce 300ms
      ),
    );
  }

  return extensions;
}
```

**注意上面有个问题：** ProseMirror Plugin 和 Tiptap Extension 是不同的类型。正确的集成方式是通过 Tiptap Extension 包装 ProseMirror Plugin：

```typescript
// Tiptap Extension 包装 — 推荐
import { Extension } from '@tiptap/core';

export const AiGhostText = Extension.create({
  name: 'aiGhostText',

  addOptions() {
    return {
      fetcher: null as SuggestionFetcher | null,
      getContext: () => ({ recipients: [] as string[] }),
      debounceMs: 300,
    };
  },

  addProseMirrorPlugins() {
    if (!this.options.fetcher) return [];
    return [
      aiGhostTextPlugin(
        this.options.fetcher,
        this.options.getContext,
        this.options.debounceMs,
      ),
    ];
  },
});

// 使用
const editor = useEditor({
  extensions: [
    ...buildComposerExtensions('Write your message...'),
    AiGhostText.configure({
      fetcher: fetchSuggestion,
      getContext: () => ({
        threadId: useComposerStore.getState().threadId,
        recipients: useComposerStore.getState().to.map(r => r.email),
      }),
      debounceMs: 300,
    }),
  ],
});
```

#### Step 3: CSS 样式

```css
/* src/styles/ai-composer.css */

.ai-ghost-text {
  color: var(--muted-foreground);
  opacity: 0.45;
  font-style: normal;
  pointer-events: none;
  user-select: none;
  transition: opacity 0.15s ease;
}

.ai-ghost-loading {
  opacity: 0.25;
  animation: ai-shimmer 1.5s ease-in-out infinite;
}

@keyframes ai-shimmer {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.45; }
}
```

### 2.5 请求去重和取消机制

这是一个非常重要的工程细节——处理不好会导致过期结果覆盖新结果：

```
用户快速输入: "Dear" " Mr" ". Jo" "hnson" ", " "fol" "low" "ing"...

时间线:
  t=0ms  输入 "Dear"     → 启动请求 #1 (debounce 300ms 后发)
  t=50ms 输入 " Mr"      → 取消 #1, 重启 debounce
  t=100ms 输入 ". Jo"    → 取消, 重启 debounce
  t=200ms 输入 "hnson"   → 取消, 重启 debounce
  t=500ms 用户停止        → 请求 #5 发出 (requestId=5)
  t=650ms 结果返回         → 只有 requestId === currentRequestId 才展示
  t=700ms 用户继续输入    → cancelPending() + abort() + 重置 debounce
```

ProseMirror Plugin 的 `requestId` monotonic counter 保证了这个机制。

### 2.6 上下文窗口策略

Ghost text 的 AI 需要上下文来决定补全什么。但每 300ms 发一次完整线程上下文给 LLM 太贵了。分层策略：

| 层 | 内容 | 更新频率 | Token 预算 |
|----|------|---------|-----------|
| **L0: 即时上下文** | 光标前 200 字符 + 上一条消息的 100 字符 | 每次请求 | ~50 tokens |
| **L1: 线程摘要** | 原始邮件的一句话摘要 (已有 AI cache) | 打开 Composer 时一次 | ~30 tokens |
| **L2: 收件人关系** | "收件人张三: 上次互动 3 天前, 讨论 Q4 项目" | 打开 Composer 时一次 | ~20 tokens |
| **L3: 用户风格** | "用户偏好简洁表达, 避免表情符号" | 周期性 (每天) | ~15 tokens |

**总 token 预算: ~115 tokens 上下文 + ~30 tokens 输出 = ~150 tokens/请求。**

用 GPT-4o-mini ($0.15/1M input tokens), 100 次 ghost text 请求约花费 **$0.002**。几乎免费。

---

## 三、模式二：Inline AI Command（行内指令）

### 3.1 效果示意

类似 VS Code 的 `Ctrl+K` 或 Notion 的 `/` 命令：

```
用户在 Composer 中选择一段文字, 按 Ctrl+Space:

┌──────────────────────────────────────────────────────────┐
│ I think we need to reconsider the timeline and resource   │
│ allocation for this project.                              │
│ ┌──────────────────────────────────────┐                  │
│ │ ▓▓▓ timeline and resource allocation ▓▓▓  ← 选中文字    │
│ └──────────────────────────────────────┘                  │
│                                                          │
│ ┌────────────────────────────────┐                       │
│ │ ✨ AI Actions                   │                       │
│ │ ├ Rewrite (more formal)        │                       │
│ │ ├ Rewrite (more concise)       │                       │
│ │ ├ Expand (add details)         │                       │
│ │ ├ Fix grammar & spelling       │                       │
│ │ ├ Translate to English         │                       │
│ │ └ Custom instruction...        │                       │
│ └────────────────────────────────┘                       │
│                                                          │
│ Result (streaming):                                       │
│ "I suggest we reassess the project timeline and resource  │
│  distribution to better align with current priorities."   │
│                                                          │
│ [Accept] [Retry] [Undo]                                  │
└──────────────────────────────────────────────────────────┘
```

### 3.2 实现方式

这比 ghost text 简单得多——主要是一个浮动 popup + Tiptap 的 `setTextSelection` + `insertContent`。

```typescript
// src/features/composer/plugins/inlineAiCommand.ts

import { Extension } from '@tiptap/core';

export const InlineAiCommand = Extension.create({
  name: 'inlineAiCommand',

  addKeyboardShortcuts() {
    return {
      // Ctrl+Space → 触发 AI 改写
      'Mod-Space': () => {
        const { editor } = this;
        const { from, to, empty } = editor.state.selection;

        if (empty) {
          // 没有选中文字 → 打开 AI command palette (模式三)
          editor.commands.insertContent('[AI: type your instruction...]');
          return true;
        }

        // 有选中文字 → 打开 inline AI popup
        const selectedText = editor.state.doc.textBetween(from, to);
        showAiPopup(editor, selectedText, from, to);
        return true;
      },
    };
  },
});
```

### 3.3 AI Rewrite 流程

```typescript
async function rewrite(
  editor: Editor,
  selectedText: string,
  from: number,
  to: number,
  instruction: string,
) {
  // 1. 组装上下文
  const context = await invoke<string>('ai_assemble_compose_context', {
    draftText: editor.getText(),
    selectedText,
    instruction,
    threadId: useComposerStore.getState().threadId,
  });

  // 2. Streaming AI response
  const { streamText } = await import('ai');
  const { openai } = await import('@ai-sdk/openai');

  const result = streamText({
    model: openai('gpt-4o-mini'),
    messages: [{ role: 'user', content: context }],
  });

  // 3. 边 stream 边替换选区内容
  //    策略: 先删除选区, 再逐 chunk 插入
  editor.chain().focus().deleteRange({ from, to }).run();

  let newPos = from;
  for await (const chunk of result.textStream) {
    editor.chain().focus().insertContentAt(newPos, chunk).run();
    // 重新计算位置 (因为内容被分段插入)
    newPos += chunk.length;
  }

  // 4. 标记 AI 改写区域 (用 Decoration 高亮)
  const finalFrom = from;
  const finalTo = newPos;
  editor.view.dispatch(
    editor.state.tr.setMeta(aiRewriteHighlightKey, { from: finalFrom, to: finalTo }),
  );

  // 5. 展示 Accept/Retry/Undo 按钮
  showAcceptRetryButtons(editor, finalFrom, finalTo);
}
```

---

## 四、模式三：Command Palette（指令面板）

### 4.1 效果示意

类似 Notion 的 `/` 命令，但专门为邮件优化：

```
┌──────────────────────────────────────────────────────────┐
│ /│                                                        │
│ ┌──────────────────────────────────┐                     │
│ │ 📝 Draft reply from prompt      │                     │
│ │ 🔄 Rewrite selection            │                     │
│ │ 📋 Summarize thread             │ ← 插入当前邮件摘要    │
│ │ 📅 Suggest meeting times        │ ← 扫描日历找空档      │
│ │ 📎 Reference previous email     │ ← 语义搜索相关邮件    │
│ │ 🎨 Change tone → [Formal]       │                     │
│ │ 🌐 Translate to → [English]     │                     │
│ └──────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

### 4.2 实现

Tiptap 有内置的 Suggestion 工具，但更简单的方式是复用现有的 template shortcut 机制：

```typescript
// Composer.tsx 的 handleKeyDown 扩展
handleKeyDown: (_view, event) => {
  // 现有的 Cmd/Ctrl+K → 链接
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    setShowLinkDialog(true);
    return true;
  }
  // NEW: Cmd/Ctrl+J → AI 命令面板
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
    setShowAiCommandPalette(true);
    return true;
  }
  return false;
},
```

然后在 Composer 上方渲染一个浮动的 AI Command Palette（纯 React，不需要 ProseMirror Plugin）。

---

## 五、性能优化关键点

### 5.1 Don't call AI on every keystroke

```
用户输入速率: ~200ms/char
AI 响应延迟: ~500ms (包括 debounce + API)

错误做法: 每按一个键发一次请求
正确做法: 
  - Debounce 300ms (可配置)
  - 光标前文字 < 5 字符 → 不发
  - 光标不在段落末尾 → 不发
  - 正在 streaming 上一轮结果 → 不发新请求
```

### 5.2 上下文缓存

Ghost text 的 L1/L2/L3 上下文（线程摘要、收件人关系、用户风格）在一个 compose session 内不变。打开 Composer 时计算一次，缓存到内存中。每次 ghost text 请求只发 L0（光标前 200 字符 + 缓存 key）。

### 5.3 模型选择

| Feature | Model | Latency | Cost |
|---------|-------|---------|------|
| Ghost text | GPT-4o-mini / Claude Haiku | ~300-500ms | ~$0.002/100 req |
| Inline rewrite | GPT-4o-mini | ~500-800ms | ~$0.005/req |
| `/summarize` | GPT-4o-mini + cache | ~300ms (cached) | cached = $0 |
| `/draft from prompt` | Claude Sonnet (复杂) / GPT-4o-mini (简单) | ~1-2s | ~$0.01/req |

### 5.4 离线降级

当 Privacy Mode = LocalOnly 或网络不可用时：
- Ghost text → 禁用（本地小模型太慢，不实用）
- Inline rewrite → 降级到本地 Qwen-2.5-1.5B（功能有限但可接受）
- Command palette → 禁用需要 LLM 的命令，保留客户端规则类命令

---

## 六、数据流总览

```
用户输入 "Following up on"
        │
        ▼ (debounce 300ms)
┌───────────────────────┐
│ Ghost Text Plugin      │
│ 提取: textBeforeCursor │
│ = "Following up on"   │
└───────┬───────────────┘
        │ invoke('ai_assemble_compose_context', { draftText, threadId, recipients })
        ▼
┌───────────────────────┐
│ Rust Context Assembler │
│                       │
│ 1. 查 threadId →      │
│    获取原邮件摘要      │
│    (ai_cache 命中)    │
│                       │
│ 2. 查 recipients →    │
│    获取联系人关系      │
│    (knowledge_entities)│
│                       │
│ 3. 查 user style →    │
│    从 settings 表读取  │
│                       │
│ 4. 组装 system prompt │
│    + user message     │
│                       │
│ 返回: {               │
│   systemPrompt,       │
│   userMessage,        │
│   tokenBudget: 150    │
│ }                     │
└───────┬───────────────┘
        │ Tauri IPC 返回
        ▼
┌───────────────────────┐
│ Vercel AI SDK          │
│ streamText({          │
│   system: ...,        │
│   messages: [...],    │
│   maxTokens: 30,      │
│   abortSignal         │
│ })                    │
└───────┬───────────────┘
        │ textStream chunks
        ▼
┌───────────────────────┐
│ Ghost Text Plugin      │
│ 逐 chunk 更新          │
│ Decoration widget      │
│ → 灰色文字实时出现     │
└───────────────────────┘
```

---

## 七、实施顺序

### Phase 1: Command Palette + Rewrite（1-2 周）
- 最直接的价值，最小技术风险
- `/summarize` — 插入当前邮件线程的 AI 摘要
- 选中文字 → AI Rewrite
- 不涉及复杂的 ProseMirror Plugin

### Phase 2: Ghost Text（2-3 周）
- Copilot-like 智能补全
- 核心工程在 ProseMirror Plugin 的 Decoration 管理
- 需要仔细处理 debounce/取消/requestId 机制

### Phase 3: Context Deep Integration（2-3 周）
- Rust 侧 Context Assembler
- 线程上下文、收件人关系、用户风格
- 上下文缓存优化

---

## 八、关键技术风险

| 风险 | 缓解 |
|------|------|
| Ghost text 太慢 — 用户已继续输入但建议还没到 | Debounce 300ms + 小模型 (GPT-4o-mini, max 30 tokens) |
| ProseMirror Decoration 定位偏移 | Widget 放在 cursor position 右侧 (`side: 1`) |
| 多次快速请求导致结果错乱 | requestId monotonic counter + AbortController |
| AI 建议的文本已包含用户刚输入的内容 | Prompt 明确 "Do NOT repeat what user already wrote" |
| ProseMirror plugin 导致编辑性能下降 | 只用 Widget Decoration (轻量), 避免大量 inline decorations |
