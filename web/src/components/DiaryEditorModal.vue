<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import { todayStr } from '@/utils/growth';
import type { Diary, DiaryMedia } from '@/utils/diary';

/**
 * 写 / 改一篇成长日记。
 *
 * 附件走 /upload/media（图片 6MB、视频 20MB），上传成功拿到本站 /uploads/xxx 路径
 * 后只存在 media 数组里，正式落库要等点「保存」—— 这样"传了图又反悔"不会留下半篇日记。
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

const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_VIDEO = 20 * 1024 * 1024;

const diaryDate = ref(todayStr());
const title = ref('');
const content = ref('');
const media = ref<DiaryMedia[]>([]);
const saving = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const today = todayStr();
const yesterday = computed(() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});

const isEdit = computed(() => !!props.diary?.id);

// v-if 挂载 + immediate：组件创建时 modelValue 已经是 true，非 immediate 的 watch 等不到那次跳变
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    const d = props.diary;
    diaryDate.value = d?.diary_date ?? todayStr();
    title.value = d?.title ?? '';
    content.value = d?.content ?? '';
    media.value = d ? [...d.media] : [];
  },
  { immediate: true }
);

const canSave = computed(
  () =>
    !!props.child &&
    !saving.value &&
    !uploading.value &&
    !!(title.value.trim() || content.value.trim() || media.value.length)
);

function pickFiles() {
  fileInput.value?.click();
}

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ''; // 允许连续选同一批文件
  if (!files.length) return;

  if (media.value.length + files.length > 9) {
    return toast.warning('一篇日记最多 9 个附件');
  }

  uploading.value = true;
  let failed = 0;
  for (const f of files) {
    const isVideo = f.type.startsWith('video/');
    const isImage = f.type.startsWith('image/');
    if (!isVideo && !isImage) { failed++; continue; }
    const limit = isVideo ? MAX_VIDEO : MAX_IMAGE;
    if (f.size > limit) {
      toast.warning(`${f.name} 超过 ${isVideo ? 20 : 6}MB，先压缩一下吧`);
      failed++;
      continue;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('读取失败'));
        reader.readAsDataURL(f);
      });
      const res = await api.post<{ url: string; type: 'image' | 'video' }>('/upload/media', {
        data: dataUrl,
      });
      media.value.push({ type: res.type, url: res.url });
    } catch (err: any) {
      failed++;
      const code = err.payload?.error;
      if (code === 'too_large') toast.error(`${f.name} 太大了，压缩后再试`);
      else if (code === 'unsupported_type') toast.error(`${f.name} 的格式不支持`);
      else toast.error(err.message || '上传失败');
    }
  }
  uploading.value = false;
  if (!failed && files.length) toast.success(files.length > 1 ? `已上传 ${files.length} 个附件` : '附件已上传');
}

function removeMedia(i: number) {
  media.value.splice(i, 1);
}

async function save() {
  if (!props.child || !canSave.value) return;
  saving.value = true;
  try {
    const body = {
      diary_date: diaryDate.value,
      title: title.value.trim() || null,
      content: content.value.trim() || null,
      media: media.value,
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
    width="520px"
    :close-on-esc="!saving"
    :close-on-mask="!saving"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="child" class="editor">
      <div class="who">
        <ZodiacAvatar :zodiac="child.avatar" :size="36" />
        <div class="who-text">
          <div class="who-name">{{ child.name }}</div>
          <div class="who-sub">记下今天发生的小事吧~</div>
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
        <label class="label" for="diary-content">正文</label>
        <textarea
          id="diary-content"
          v-model="content"
          class="input textarea"
          rows="6"
          maxlength="2000"
          placeholder="今天发生了什么？写给自己，也写给长大后的孩子看~"
        ></textarea>
        <div class="counter">{{ content.length }} / 2000</div>
      </div>

      <div class="field">
        <label class="label">照片 / 视频 <span class="opt">（最多 9 个，图片 6MB、视频 20MB）</span></label>
        <div class="media-grid">
          <div v-for="(m, i) in media" :key="i" class="m-cell">
            <img v-if="m.type === 'image'" :src="m.url" alt="" />
            <video v-else :src="m.url" preload="metadata" muted></video>
            <button type="button" class="m-del" aria-label="移除附件" @click="removeMedia(i)">✕</button>
          </div>
          <button
            v-if="media.length < 9"
            type="button"
            class="m-add"
            :disabled="uploading"
            @click="pickFiles"
          >
            <span class="m-add-icon">{{ uploading ? '⏳' : '＋' }}</span>
            <span class="m-add-text">{{ uploading ? '上传中' : '添加' }}</span>
          </button>
        </div>
        <input
          ref="fileInput"
          class="hidden-input"
          type="file"
          accept="image/*,video/*"
          multiple
          @change="onFiles"
        />
        <p class="tip">支持 JPG / PNG / GIF / WebP 与 MP4 / WebM / MOV 视频</p>
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
.textarea { resize: vertical; line-height: 1.7; min-height: 120px; }
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

.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  gap: var(--space-8);
}
.m-cell {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--r-md);
  overflow: hidden;
  background: rgba(90, 58, 74, 0.06);
}
.m-cell img, .m-cell video { width: 100%; height: 100%; object-fit: cover; display: block; }
.m-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  background: rgba(20, 16, 12, 0.62);
  color: #fff;
  font-size: var(--fs-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.m-add {
  aspect-ratio: 1;
  border-radius: var(--r-md);
  border: 2px dashed var(--glass-border);
  background: var(--glass-bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-muted);
  transition: all var(--dur-fast);
}
.m-add:hover:not(:disabled) { border-color: var(--accent-yellow); color: var(--text-on-yellow); }
.m-add-icon { font-size: var(--fs-lg); line-height: 1; }
.m-add-text { font-size: var(--fs-xs); }

.hidden-input { display: none; }
.tip { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
