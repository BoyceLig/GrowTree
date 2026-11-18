<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import DiaryTiptapEditor from '@/components/DiaryTiptapEditor.vue';
import { todayStr } from '@/utils/growth';
import type { Diary } from '@/utils/diary';

/**
 * 写 / 改一篇成长日记（Tiptap 富文本版）。
 *
 * 所有媒体（图片 + 视频）全部内嵌到富文本 HTML 里，通过编辑器工具栏 🖼 / 🎬 按钮插入。
 * 保存时 media 数组固定传空 []（所有媒体引用都在 content HTML 里了）。
 * Timeline 渲染时，如果 content 是 HTML（新富文本），就不再渲染独立 media 区，避免重复。
 *
 * content 字段存 HTML（Tiptap getHTML 输出），后端 TEXT 列直接存没问题。
 */
const props = defineProps<{
  modelValue: boolean;
  child: { id: number; name: string; avatar: string } | null;
  /** 有值 = 编辑模式 */
  diary?: Diary | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  saved: [];
}>();

const toast = useToastStore();

const diaryDate = ref(todayStr());
const title = ref('');
const contentHtml = ref('');
const contentText = ref('');
const saving = ref(false);

const today = todayStr();
const yesterday = computed(() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});

const isEdit = computed(() => !!props.diary?.id);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    const d = props.diary;
    diaryDate.value = d?.diary_date ?? todayStr();
    title.value = d?.title ?? '';
    contentHtml.value = d?.content ?? '';
    contentText.value = ''; // 由编辑器 onUpdate 重新填充
  },
  { immediate: true }
);

const canSave = computed(
  () =>
    !!props.child &&
    !saving.value &&
    !!(title.value.trim() || contentText.value.trim() || contentHtml.value.trim())
);

function onEditorChange(html: string, text: string) {
  contentHtml.value = html;
  contentText.value = text;
}

async function save() {
  if (!props.child || !canSave.value) return;
  // 视频占位节点还没有 src → 还在上传/截帧，暂不允许保存，避免存下空视频
  if (/data-src=""/.test(contentHtml.value)) {
    toast.error('视频还在上传中，请稍候再保存');
    return;
  }
  saving.value = true;
  try {
    const body = {
      diary_date: diaryDate.value,
      title: title.value.trim() || null,
      content: contentHtml.value.trim() || null,
      media: [] as any, // 新富文本方案：所有媒体内嵌到 HTML，不再走独立数组
    };
    if (isEdit.value) {
      await api.patch(`/growth/diaries/${props.diary!.id}`, body);
    } else {
      await api.post('/growth/diaries', { ...body, user_id: props.child.id });
    }
    toast.success(isEdit.value ? '日记已更新' : '日记已保存');
    emit('saved');
    emit('update:modelValue', false);
  } catch (e: any) {
    toast.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="isEdit ? '编辑成长日记' : '写一篇成长日记'"
    width="680px"
    :close-on-esc="!saving"
    :close-on-mask="!saving"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="child" class="editor">
      <div class="who">
        <ZodiacAvatar :zodiac="child.avatar" :size="36" />
        <div class="who-text">
          <div class="who-name">{{ child.name }}</div>
          <div class="who-sub">试试输入 # 标题，1. 列表，> 引用，或直接粘贴图片/视频…</div>
        </div>
      </div>

      <div class="field">
        <label class="label" for="diary-date">哪一天</label>
        <div class="date-row">
          <input id="diary-date" v-model="diaryDate" type="date" class="input date" :max="today" />
          <button
            type="button"
            :class="['quick', { on: diaryDate === today }]"
            @click="diaryDate = today"
          >今天</button>
          <button
            type="button"
            :class="['quick', { on: diaryDate === yesterday }]"
            @click="diaryDate = yesterday"
          >昨天</button>
        </div>
      </div>

      <div class="field">
        <label class="label" for="diary-title">标题 <span class="opt">（可留空）</span></label>
        <input
          id="diary-title"
          v-model="title"
          class="input"
          maxlength="60"
          placeholder="比如：第一次自己系鞋带"
        />
      </div>

      <div class="field">
        <label class="label">正文 <span class="opt">（图片 🖼 / 视频 🎬 点工具栏，或直接粘贴）</span></label>
        <DiaryTiptapEditor
          v-model="contentHtml"
          @change="onEditorChange"
        />
        <div class="counter">{{ contentText.length }} 字</div>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" type="button" :disabled="saving" @click="emit('update:modelValue', false)">
        取消
      </button>
      <button class="btn btn-primary" type="button" :disabled="!canSave" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: var(--space-14); }

.who {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  background: var(--glass-bg);
}
.who-name { font-family: var(--font-cute); font-size: var(--fs-md); }
.who-sub { font-size: var(--fs-xs); color: var(--text-muted); }

.field { display: flex; flex-direction: column; gap: var(--space-6); }
.label { font-size: var(--fs-sm); color: var(--text-secondary); font-weight: 600; }
.opt { font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }

.input {
  width: 100%;
  padding: var(--space-10) var(--space-12);
  border-radius: var(--r-md);
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.6);
  font-size: var(--fs-sm);
  font-family: inherit;
  color: var(--text-primary);
}
.input:focus { outline: 2px solid var(--accent-yellow); outline-offset: 1px; }
.date { flex: 1; min-width: 0; }

.date-row { display: flex; align-items: center; gap: var(--space-8); }
.quick {
  padding: var(--space-8) var(--space-12);
  border-radius: var(--r-pill);
  background: var(--glass-bg-strong);
  font-size: var(--fs-xs);
  flex-shrink: 0;
  transition: all var(--dur-fast);
}
.quick.on { background: rgba(255, 209, 102, 0.45); font-weight: 700; }

.counter { text-align: right; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
