<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

/**
 * AI 记忆面板：直接管理 <DATA_DIR>/ai-memory/*.md（Basic Memory 格式）。
 *  - 列表展示标题 / 标签 / 摘要 / 更新时间；
 *  - 编辑用 Markdown 编辑器（左源码右预览，带常用格式按钮），保存时整份 Markdown 原样写回；
 *  - 删除需二次确认。
 */

type MemoryItem = {
  permalink: string;
  title: string;
  type: string;
  tags: string[];
  updatedAt: string;
  excerpt: string;
  observations: number;
};

const toast = useToastStore();
const notes = ref<MemoryItem[]>([]);
const dir = ref('');
const loading = ref(false);

const editorOpen = ref(false);
const editing = ref<MemoryItem | null>(null);
const markdown = ref('');
const saving = ref(false);
const textareaEl = ref<HTMLTextAreaElement | null>(null);

const deleteTarget = ref<MemoryItem | null>(null);
const deleteOpen = computed({
  get: () => deleteTarget.value != null,
  set: (v: boolean) => {
    if (!v) deleteTarget.value = null;
  },
});

marked.setOptions({ async: false, gfm: true, breaks: true });

/** 预览时去掉 frontmatter，避免把 --- 渲染成横线 */
const previewHtml = computed(() => {
  const text = markdown.value.replace(/^\uFEFF?---\n[\s\S]*?\n---\n?/, '');
  return DOMPurify.sanitize(marked.parse(text || '（空白）') as string);
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api.get<{ notes: MemoryItem[]; dir: string }>('/ai/memories');
    notes.value = data.notes ?? [];
    dir.value = data.dir ?? '';
  } catch (err) {
    toast.warning((err as Error).message || '读取记忆失败');
  } finally {
    loading.value = false;
  }
}

async function openEditor(item: MemoryItem): Promise<void> {
  try {
    const data = await api.get<{ markdown: string }>(`/ai/memories/${encodeURIComponent(item.permalink)}`);
    editing.value = item;
    markdown.value = data.markdown ?? '';
    editorOpen.value = true;
  } catch (err) {
    toast.warning((err as Error).message || '读取记忆内容失败');
  }
}

async function save(): Promise<void> {
  if (!editing.value || saving.value) return;
  saving.value = true;
  try {
    await api.put(`/ai/memories/${encodeURIComponent(editing.value.permalink)}`, { markdown: markdown.value });
    toast.success('记忆已保存');
    editorOpen.value = false;
    await load();
  } catch (err) {
    toast.warning((err as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function askDelete(item: MemoryItem): void {
  deleteTarget.value = item;
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  try {
    await api.delete(`/ai/memories/${encodeURIComponent(target.permalink)}`);
    toast.success('已删除');
    await load();
  } catch (err) {
    toast.warning((err as Error).message || '删除失败');
  }
}

/* ── Markdown 工具栏：围绕选区插入/包裹 ─────────────────────────────── */

function wrapSelection(before: string, after = before, placeholder = '文字'): void {
  const el = textareaEl.value;
  if (!el) return;
  const { selectionStart: start, selectionEnd: end } = el;
  const selected = markdown.value.slice(start, end) || placeholder;
  markdown.value = markdown.value.slice(0, start) + before + selected + after + markdown.value.slice(end);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(start + before.length, start + before.length + selected.length);
  });
}

function prefixLine(prefix: string): void {
  const el = textareaEl.value;
  if (!el) return;
  const start = markdown.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  const lineEnd = markdown.value.indexOf('\n', el.selectionStart);
  const end = lineEnd === -1 ? markdown.value.length : lineEnd;
  const line = markdown.value.slice(start, end) || '文字';
  markdown.value = markdown.value.slice(0, start) + prefix + line + markdown.value.slice(end);
  requestAnimationFrame(() => el.focus());
}

function fmtTime(unix: string): string {
  const n = Number(unix);
  if (!n) return '';
  return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="mem-pane">
    <div class="mem-bar">
      <p class="hint">
        记忆存在 <code>{{ dir || '（数据目录）/ai-memory' }}</code>：AI 只该记住"表里查不到、长期有用"的偏好与习惯，
        积分/任务等数据请让它用工具实时查。这里可以直接改或删。
      </p>
      <button class="btn small" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>

    <div v-if="!notes.length && !loading" class="empty">还没有记忆。和 AI 聊几次，它会自己记下有用的偏好。</div>

    <div v-for="m in notes" :key="m.permalink" class="mem-card">
      <div class="mem-main">
        <div class="mem-title-row">
          <b class="mem-title">{{ m.title }}</b>
          <span v-if="m.type && m.type !== 'note'" class="mem-type">{{ m.type }}</span>
          <span v-if="m.observations" class="mem-count">{{ m.observations }} 条观察</span>
        </div>
        <p v-if="m.excerpt" class="mem-excerpt">{{ m.excerpt }}</p>
        <div class="mem-meta">
          <span v-if="m.tags.length" class="mem-tags">{{ m.tags.map((t) => '#' + t).join(' ') }}</span>
          <span v-if="m.updatedAt" class="mem-time">{{ fmtTime(m.updatedAt) }}</span>
        </div>
      </div>
      <div class="mem-actions">
        <button class="btn small" @click="openEditor(m)">编辑</button>
        <button class="btn small danger" @click="askDelete(m)">删除</button>
      </div>
    </div>

    <!-- Markdown 编辑器 -->
    <Modal v-model="editorOpen" :title="`编辑记忆 · ${editing?.title ?? ''}`" width="900px">
      <div class="md-editor">
        <div class="md-toolbar">
          <button type="button" title="标题" @click="prefixLine('## ')">H2</button>
          <button type="button" title="加粗" @click="wrapSelection('**')"><b>B</b></button>
          <button type="button" title="斜体" @click="wrapSelection('*')"><i>I</i></button>
          <button type="button" title="行内代码" @click="wrapSelection('`', '`', 'code')">{ }</button>
          <button type="button" title="列表" @click="prefixLine('- ')">• 列表</button>
          <button type="button" title="引用" @click="prefixLine('> ')">❝</button>
          <button type="button" title="链接" @click="wrapSelection('[', '](https://)', '链接文字')">链接</button>
        </div>
        <div class="md-split">
          <textarea ref="textareaEl" v-model="markdown" class="md-source" spellcheck="false"></textarea>
          <div class="md-preview markdown-body" v-html="previewHtml"></div>
        </div>
        <p class="md-hint">
          编辑的是原始 Markdown（包含 frontmatter）。frontmatter 里的 title 必须保留；文件名（{{ editing?.permalink }}）保持不变。
        </p>
      </div>

      <template #footer>
        <button class="btn" @click="editorOpen = false">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>

    <ConfirmDialog
      v-model="deleteOpen"
      title="删除记忆"
      :message="`确定删除「${deleteTarget?.title ?? ''}」吗？删除后 AI 不会再记得这条信息。`"
      confirmText="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.mem-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  max-height: 60vh;
  overflow-y: auto;
}
.mem-bar {
  display: flex;
  align-items: flex-start;
  gap: var(--space-12);
}
.mem-bar .hint {
  flex: 1;
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.6;
}
.btn.small {
  min-height: 32px;
  padding: var(--space-4) var(--space-12);
  border-radius: var(--r-sm);
  border: none;
  background: var(--glass-bg-strong);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.btn.small:hover:not(:disabled) {
  color: var(--text-primary);
}
.btn.small.danger {
  color: #b23a3a;
}
.btn.small.danger:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.16);
}
.btn.small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mem-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-12);
  padding: var(--space-12);
  border: 1px solid rgba(224, 188, 125, 0.42);
  border-radius: var(--r-md);
  background: #fff;
}
.mem-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.mem-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  flex-wrap: wrap;
}
.mem-title {
  font-size: var(--fs-md);
  color: var(--text-primary);
}
.mem-type {
  font-size: var(--fs-2xs);
  padding: 1px var(--space-8);
  border-radius: var(--r-pill);
  background: rgba(180, 150, 255, 0.2);
  color: #553a8a;
}
.mem-count {
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
}
.mem-excerpt {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.mem-meta {
  display: flex;
  gap: var(--space-10);
  flex-wrap: wrap;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
}
.mem-tags {
  color: var(--text-secondary);
}
.mem-actions {
  display: flex;
  gap: var(--space-6);
  flex: none;
}
.empty {
  padding: var(--space-24);
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
}
.md-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.md-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.md-toolbar button {
  min-height: 30px;
  padding: 0 var(--space-10);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-sm);
  background: var(--glass-bg);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.md-toolbar button:hover {
  border-color: var(--accent-orange);
  color: var(--text-primary);
}
.md-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-10);
  height: 52vh;
}
.md-source {
  width: 100%;
  height: 100%;
  resize: none;
  padding: var(--space-10);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-sm);
  background: #fff;
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: var(--fs-xs);
  line-height: 1.6;
}
.md-preview {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-10) var(--space-12);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-sm);
  background: #fff;
  font-size: var(--fs-sm);
  line-height: 1.7;
}
.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3) {
  margin: 0.6em 0 0.3em;
  font-size: 1.05em;
}
.md-preview :deep(ul) {
  padding-left: 1.2em;
  margin: 0.3em 0;
}
.md-preview :deep(code) {
  background: rgba(90, 58, 74, 0.08);
  border-radius: 4px;
  padding: 0 4px;
}
.md-hint {
  margin: 0;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
  line-height: 1.5;
}
@media (max-width: 720px) {
  .md-split {
    grid-template-columns: 1fr;
    height: auto;
  }
  .md-source,
  .md-preview {
    height: 34vh;
  }
}
</style>