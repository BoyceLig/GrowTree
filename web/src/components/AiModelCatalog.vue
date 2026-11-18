<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';

/**
 * 共用的模型列表面板（所有供应商 / 所有用途都走这一个组件）
 *  - mode=chat      → 聊天模型（保持原有列表与能力标签）
 *  - mode=vision    → 只显示支持识图的模型
 * 放在对应输入框下面渲染即可。
 */

type ModelMode = 'chat' | 'vision';

const props = defineProps<{
  providerId: string;
  baseUrl: string;
  apiKey: string;
  mode: ModelMode;
  /** 当前字段已选的值，用于打勾 */
  modelValue: string;
}>();

const emit = defineEmits<{
  pick: [id: string];
  close: [];
}>();

const entries = ref<{ id: string; badges: string[] }[]>([]);
const search = ref('');
const meta = ref<{ retired: number; unusable: number } | null>(null);
const loading = ref(false);
const error = ref('');

const title = computed(() => (props.mode === 'vision' ? '选择图片识别模型' : '选择聊天模型'));
const emptyText = computed(() => (props.mode === 'vision' ? '接口没有返回支持识图的模型' : '接口没有返回可用模型'));

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return q ? entries.value.filter((e) => e.id.toLowerCase().includes(q)) : entries.value;
});

/** 接口只返回模型名、没有任何能力字段时会完全没有标签 */
const hasNoBadges = computed(() => entries.value.length > 0 && entries.value.every((e) => !e.badges.length));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  search.value = '';
  try {
    const data = await api.post<{
      ok: boolean;
      entries?: { id: string; badges: string[] }[];
      retired: number;
      unusable: number;
      error?: string;
    }>('/ai/models', {
      providerId: props.providerId,
      baseUrl: props.baseUrl,
      apiKey: props.apiKey,
      mode: props.mode,
    });
    if (!data.ok) {
      error.value = data.error ?? '拉取模型列表失败';
      entries.value = [];
      return;
    }
    entries.value = data.entries ?? [];
    meta.value = { retired: data.retired ?? 0, unusable: data.unusable ?? 0 };
    if (!entries.value.length) error.value = emptyText.value;
  } catch (err) {
    error.value = (err as Error).message || '拉取模型列表失败';
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="catalog glass">
    <div class="catalog-head">
      <b class="catalog-title">{{ title }}</b>
      <input v-model="search" class="catalog-search" placeholder="搜索模型…" spellcheck="false" />
      <button class="btn small" type="button" :disabled="loading" @click="load">刷新</button>
      <button class="btn small" type="button" @click="emit('close')">收起</button>
    </div>
    <p v-if="error" class="catalog-error">{{ error }}</p>
    <p v-else-if="loading" class="catalog-loading">正在拉取模型列表…</p>
    <div v-else class="catalog-list">
      <button
        v-for="e in filtered"
        :key="e.id"
        class="catalog-item"
        :class="{ picked: e.id === modelValue }"
        type="button"
        @click="emit('pick', e.id)"
      >
        <span class="catalog-id">{{ e.id }}</span>
        <span v-if="e.badges.length" class="catalog-badges">
          <span v-for="b in e.badges" :key="b" class="badge">{{ b }}</span>
        </span>
        <span v-if="e.id === modelValue" class="check">✓</span>
      </button>
      <p v-if="!filtered.length" class="catalog-loading">没有匹配的模型</p>
    </div>
    <p v-if="meta && (meta.retired || meta.unusable)" class="hint">
      已隐藏 {{ meta.retired }} 个退役模型、{{ meta.unusable }} 个不符合当前用途的模型
    </p>
    <p v-if="hasNoBadges" class="hint">
      该接口的 /models 只返回模型名、没有能力字段，所以不显示标签；识图能力可用下方「测试连接」确认。
    </p>
  </div>
</template>

<style scoped>
.catalog {
  border: 1px solid rgba(224, 188, 125, 0.55);
  border-radius: var(--r-md);
  padding: var(--space-12);
  background: #fdfaf6;
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.catalog-head {
  display: flex;
  gap: var(--space-6);
  flex-wrap: wrap;
}
.catalog-title {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  white-space: nowrap;
  align-self: center;
}
.catalog-search {
  flex: 1;
  min-width: 120px;
  min-height: 36px;
  padding: 0 var(--space-12);
  border-radius: var(--r-sm);
  border: 1px solid rgba(90, 58, 74, 0.18);
  background: #fff;
  color: var(--text-primary);
  font-size: var(--fs-sm);
  box-shadow: inset 0 1px 2px rgba(90, 58, 74, 0.05);
  outline: none;
  transition: border-color var(--dur-base), box-shadow var(--dur-base);
}
.catalog-search:hover {
  border-color: rgba(90, 58, 74, 0.32);
}
.catalog-search:focus {
  border-color: var(--accent-orange);
  box-shadow: 0 0 0 3px rgba(255, 180, 84, 0.22);
}
.catalog-search:focus-visible {
  outline: 2px solid var(--text-on-orange);
  outline-offset: 1px;
}
.btn.small {
  min-height: 34px;
  padding: var(--space-4) var(--space-10);
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
.catalog-error {
  margin: 0;
  font-size: var(--fs-xs);
  color: #b23a3a;
  background: rgba(255, 122, 122, 0.14);
  border-radius: var(--r-sm);
  padding: var(--space-6) var(--space-8);
  white-space: pre-wrap;
  word-break: break-all;
}
.catalog-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-6);
  max-height: 240px;
  overflow-y: auto;
}
.catalog-item {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 36px;
  padding: var(--space-4) var(--space-8);
  border-radius: var(--r-sm);
  border: 1px solid transparent;
  background: var(--glass-bg);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  text-align: left;
  cursor: pointer;
}
.catalog-item:hover {
  border-color: var(--accent-orange);
  color: var(--text-primary);
}
.catalog-item.picked {
  border-color: var(--accent-orange);
  background: var(--glass-bg-strong);
  color: var(--text-primary);
}
.catalog-id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catalog-badges {
  display: flex;
  gap: 4px;
  flex: none;
}
.badge {
  font-size: var(--fs-2xs);
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: rgba(180, 150, 255, 0.18);
  color: #553a8a;
  white-space: nowrap;
}
.check {
  color: #2f6b52;
  flex: none;
}
.catalog-loading {
  grid-column: 1 / -1;
  margin: 0;
  padding: var(--space-10);
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-muted, #7a6a55);
}
.hint {
  margin: 0;
  font-size: var(--fs-2xs);
  color: var(--text-muted, #7a6a55);
}
@media (max-width: 720px) {
  .catalog-list {
    grid-template-columns: 1fr;
  }
}
</style>