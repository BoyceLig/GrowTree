<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { api } from '@/api/client';
import { useToastStore } from '@/stores/toast';
import Modal from '@/components/Modal.vue';
import CategoryIcon from '@/components/CategoryIcon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { useImageUpload } from '@/composables/useImageUpload';
import { useCategories } from '@/composables/useCategories';
import {
  BUILTIN_ICONS, CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR,
  isImageIcon, type ProductCategory,
} from '@/utils/categories';

// ─────────────────────────────────────────────────────────────────────────────
// 商品分类管理：新建 / 改名 / 换图标 / 拖拽排序 / 删除。
// 做成「列表 ↔ 编辑表单」两个视图共用同一个弹窗（而不是嵌套弹窗）：
// 手机上嵌套弹窗会一层压一层，返回路径也容易乱。
// ─────────────────────────────────────────────────────────────────────────────

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; changed: [] }>();

const toast = useToastStore();
const { categories, loadCategories } = useCategories();
const { uploading, fileInput, pickImage, onFileChange, ACCEPT } = useImageUpload();

/** null = 正在看列表；否则是编辑中的草稿（id 为 0 表示新建） */
const draft = ref<{ id: number; name: string; icon: string; color: string } | null>(null);
const saving = ref(false);

const isEditing = computed(() => draft.value !== null);
const isNew = computed(() => draft.value?.id === 0);
const draftIsImage = computed(() => isImageIcon(draft.value?.icon));

/** 列表展示顺序：跟随全局分类表（后端已按 sort_order 排序），拖拽时本地先重排 */
const ordered = ref<ProductCategory[]>([]);
watch(categories, (v) => { ordered.value = v.slice(); }, { immediate: true });

watch(() => props.modelValue, (open) => {
  if (open) {
    draft.value = null;
    loadCategories();
  }
});

function openCreate() {
  // 新分类默认取一个还没被占用的内置图标，省得一千个「礼盒」
  const used = new Set(categories.value.map((c) => c.icon));
  const free = BUILTIN_ICONS.find((i) => !used.has(i.key)) ?? BUILTIN_ICONS[BUILTIN_ICONS.length - 1];
  draft.value = { id: 0, name: '', icon: free.key, color: free.color };
}

function openEdit(c: ProductCategory) {
  draft.value = { id: c.id, name: c.name, icon: c.icon, color: c.color || DEFAULT_CATEGORY_COLOR };
}

function pickBuiltin(key: string, color: string) {
  if (!draft.value) return;
  draft.value.icon = key;
  draft.value.color = color;
}

function removeCustomIcon() {
  if (!draft.value) return;
  draft.value.icon = 'gift';
  draft.value.color = DEFAULT_CATEGORY_COLOR;
}

function backToList() {
  draft.value = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 拖拽排序：用 Pointer Events 手写（HTML5 drag & drop 在手机上根本不触发）。
// 手柄上 touch-action:none + setPointerCapture，手指滑多远事件都还会回到手柄。
// ─────────────────────────────────────────────────────────────────────────────
const listEl = ref<HTMLElement | null>(null);
const dragId = ref<number | null>(null);
const dragging = ref(false);
let pressY = 0;

function onDragStart(e: PointerEvent, c: ProductCategory) {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragId.value = c.id;
  dragging.value = false;
  pressY = e.clientY;
}

function onDragMove(e: PointerEvent) {
  if (dragId.value === null) return;
  // 先过一道抖动阈值：单纯点一下手柄不该被当成拖动
  if (!dragging.value) {
    if (Math.abs(e.clientY - pressY) < 5) return;
    dragging.value = true;
  }
  e.preventDefault();
  autoScroll(e.clientY);
  moveTo(e.clientY);
}

function onDragEnd() {
  if (dragId.value === null) return;
  const moved = dragging.value;
  dragId.value = null;
  dragging.value = false;
  if (moved) commitOrder();
}

/** 把正在拖的分类挪到指针所在的那道缝里 */
function moveTo(y: number) {
  const el = listEl.value;
  if (!el) return;
  const from = ordered.value.findIndex((c) => c.id === dragId.value);
  if (from < 0) return;
  // 排除被拖的那一行再看指针落在哪两行之间：
  // 这样算出的下标，正好就是「移出元素后」数组里的插入位置
  const others = Array.from(el.querySelectorAll<HTMLElement>('.cat-row'))
    .filter((r) => Number(r.dataset.id) !== dragId.value);
  let to = others.findIndex((r) => {
    const rect = r.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  if (to < 0) to = others.length;
  if (to === from) return;
  const arr = ordered.value.slice();
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  ordered.value = arr;
}

/** 拖到列表上下边缘时，自动滚动最近的那个可滚动祖先（弹窗内容区） */
function autoScroll(y: number) {
  let sp = listEl.value?.parentElement ?? null;
  while (sp && sp.scrollHeight <= sp.clientHeight + 2) sp = sp.parentElement;
  if (!sp) return;
  const rect = sp.getBoundingClientRect();
  const EDGE = 48;
  if (y < rect.top + EDGE) sp.scrollTop -= 10;
  else if (y > rect.bottom - EDGE) sp.scrollTop += 10;
}

async function commitOrder() {
  const before = categories.value.map((c) => c.id).join(',');
  const after = ordered.value.map((c) => c.id).join(',');
  if (before === after) return; // 拖回原位就不打接口
  try {
    await api.post('/product-categories/reorder', { ids: ordered.value.map((c) => c.id) });
    await loadCategories();
    emit('changed');
  } catch (e: any) {
    toast.error(e.message);
    await loadCategories(); // 失败就退回服务端的顺序
  }
}

async function save() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) return toast.warning('请输入分类名称');
  if (name.length > 12) return toast.warning('分类名称最多 12 个字');
  const dup = categories.value.find((c) => c.name === name && c.id !== d.id);
  if (dup) return toast.warning(`已经有叫「${name}」的分类了`);

  saving.value = true;
  try {
    const body = { name, icon: d.icon, color: d.color };
    if (d.id === 0) await api.post('/product-categories', body);
    else await api.patch(`/product-categories/${d.id}`, body);
    await loadCategories();
    toast.success(d.id === 0 ? '分类已创建 🏷️' : '分类已更新');
    emit('changed');
    draft.value = null;
  } catch (e: any) {
    toast.error(e.message);
  } finally {
    saving.value = false;
  }
}

// 删除确认：分类下还有商品时必须说清后果，不能一键抹掉
const confirmOpen = ref(false);
const pendingDelete = ref<ProductCategory | null>(null);

function askDelete(c: ProductCategory) {
  pendingDelete.value = c;
  confirmOpen.value = true;
}

async function doDelete() {
  const c = pendingDelete.value;
  pendingDelete.value = null;
  if (!c) return;
  try {
    await api.delete(`/product-categories/${c.id}`);
    await loadCategories();
    toast.success('分类已删除');
    emit('changed');
  } catch (e: any) {
    toast.error(e.message);
  }
}

const deleteMessage = computed(() => {
  const c = pendingDelete.value;
  if (!c) return '';
  const n = c.product_count ?? 0;
  return n > 0
    ? `确认删除分类「${c.name}」？该分类下的 ${n} 件商品不会被删除，会变成「未分类」，可以在商品里重新选分类。`
    : `确认删除分类「${c.name}」？`;
});
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="isEditing ? (isNew ? '🏷️ 新建分类' : '🏷️ 编辑分类') : '🏷️ 商品分类'"
    width="460px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- ── 视图一：分类列表 ─────────────────────────────────────────────── -->
    <template v-if="!isEditing">
      <p class="hint top-hint">
        分类会出现在商城页顶部，点一下就能筛选商品。没有单独上传图片的商品，图片跟着分类图标走。
      </p>
      <p class="hint drag-hint">按住左侧 ⠿ 拖动，可以调整分类在商城里的先后顺序。</p>

      <div ref="listEl" class="cat-list">
        <div
          v-for="c in ordered"
          :key="c.id"
          class="cat-row"
          :class="{ 'is-dragging': dragging && dragId === c.id }"
          :data-id="c.id"
        >
          <button
            type="button"
            class="drag-handle"
            title="按住拖动排序"
            aria-label="按住拖动排序"
            @pointerdown="onDragStart($event, c)"
            @pointermove="onDragMove"
            @pointerup="onDragEnd"
            @pointercancel="onDragEnd"
          >⠿</button>
          <CategoryIcon :icon="c.icon" :size="40" :color="c.color" />
          <div class="cat-meta">
            <span class="cat-name">{{ c.name }}</span>
            <span class="cat-count">{{ c.product_count ?? 0 }} 件商品</span>
          </div>
          <button type="button" class="mini-btn" @click="openEdit(c)">编辑</button>
          <button type="button" class="mini-btn danger" @click="askDelete(c)">删除</button>
        </div>
        <p v-if="ordered.length === 0" class="hint empty-hint">还没有分类，先建一个吧</p>
      </div>

      <button type="button" class="btn btn-primary add-cat" @click="openCreate">＋ 新建分类</button>
    </template>

    <!-- ── 视图二：新建 / 编辑表单 ─────────────────────────────────────── -->
    <template v-else-if="draft">
      <div class="preview">
        <CategoryIcon :icon="draft.icon" :size="72" :color="draft.color" />
        <span class="preview-name">{{ draft.name.trim() || '分类名称' }}</span>
      </div>

      <div class="field">
        <label class="label">分类名称</label>
        <input v-model="draft.name" type="text" maxlength="12" placeholder="如：零食 / 玩具 / 周末特权" />
        <p class="hint">最多 12 个字，商城页的筛选按钮上显示</p>
      </div>

      <div class="field">
        <label class="label">分类图标</label>
        <div class="icon-grid">
          <button
            v-for="i in BUILTIN_ICONS"
            :key="i.key"
            type="button"
            :class="['icon-chip', { active: draft.icon === i.key }]"
            @click="pickBuiltin(i.key, i.color)"
          >
            <CategoryIcon :icon="i.key" :size="36" :color="i.color" />
            <span class="icon-label">{{ i.label }}</span>
          </button>
          <button
            type="button"
            :class="['icon-chip', 'custom-chip', { active: draftIsImage }]"
            :disabled="uploading"
            @click="draftIsImage ? undefined : pickImage()"
          >
            <span v-if="uploading" class="cam">…</span>
            <CategoryIcon v-else-if="draftIsImage" :icon="draft.icon" :size="36" :color="draft.color" />
            <span v-else class="cam">📷</span>
            <span class="icon-label">{{ uploading ? '上传中' : '上传图片' }}</span>
            <span v-if="draftIsImage" class="remove-btn" title="移除图片" @click.stop="removeCustomIcon">✕</span>
          </button>
        </div>
        <input
          ref="fileInput"
          type="file"
          :accept="ACCEPT"
          style="display:none"
          @change="(e) => onFileChange(e, (url) => { if (draft) draft.icon = url; })"
        />
      </div>

      <div class="field">
        <label class="label">图标底色</label>
        <div class="color-row">
          <button
            v-for="c in CATEGORY_COLORS"
            :key="c"
            type="button"
            class="color-dot"
            :class="{ active: draft.color.toLowerCase() === c.toLowerCase() }"
            :style="{ background: c }"
            :title="c"
            @click="draft.color = c"
          ></button>
        </div>
      </div>
    </template>

    <template #footer>
      <template v-if="isEditing">
        <button type="button" class="btn btn-ghost" @click="backToList">返回</button>
        <button type="button" class="btn btn-primary" :disabled="saving || uploading" @click="save">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </template>
      <button v-else type="button" class="btn btn-ghost" @click="emit('update:modelValue', false)">完成</button>
    </template>
  </Modal>

  <ConfirmDialog
    v-model="confirmOpen"
    title="删除分类"
    :message="deleteMessage"
    confirmText="删除"
    variant="danger"
    @confirm="doDelete"
  />
</template>

<style scoped>
.hint { font-size: var(--fs-xs); color: var(--text-muted); }
.top-hint { margin-bottom: var(--space-14); line-height: 1.6; }
.empty-hint { text-align: center; padding: var(--space-16) 0; }

.cat-list { display: flex; flex-direction: column; gap: var(--space-8); margin-bottom: var(--space-14); }
.cat-row {
  display: flex;
  align-items: center;
  gap: var(--space-10);
  padding: var(--space-8) var(--space-12) var(--space-8) var(--space-6);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  transition: background var(--dur-fast), box-shadow var(--dur-fast), transform var(--dur-fast);
}
/* 拖拽手柄：touch-action:none —— 从手柄起手的手势不滚动弹窗，只用来排序 */
.drag-handle {
  flex-shrink: 0;
  width: 28px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-sm);
  color: var(--text-muted);
  font-size: var(--fs-xl);
  line-height: 1;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.drag-handle:hover { color: var(--text-primary); background: var(--glass-bg-strong); }
.drag-handle:active { cursor: grabbing; }
/* 正在拖的那一行浮起来，明确「它跟着手指走」 */
.cat-row.is-dragging {
  position: relative;
  z-index: 5;
  background: var(--glass-bg-strong);
  box-shadow: var(--shadow-pop);
  transform: scale(1.02);
}
.drag-hint { margin-top: calc(-1 * var(--space-8)); margin-bottom: var(--space-12); }
.cat-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cat-name {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cat-count { font-size: var(--fs-2xs); color: var(--text-muted); }

.mini-btn {
  flex-shrink: 0;
  padding: var(--space-6) var(--space-12);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: var(--glass-bg-strong);
  transition: all var(--dur-fast);
}
.mini-btn:hover { color: var(--text-primary); background: var(--glass-bg); }
.mini-btn.danger { color: var(--text-on-red); }

.add-cat { width: 100%; }

/* ── 编辑表单 ── */
.preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
  margin-bottom: var(--space-16);
}
.preview-name { font-family: var(--font-cute); font-size: var(--fs-md); color: var(--text-secondary); }

.field { display: flex; flex-direction: column; gap: var(--space-8); margin-bottom: var(--space-16); }
.label { font-size: var(--fs-sm); color: var(--text-secondary); padding-left: var(--space-4); }

.icon-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-8); }
.icon-chip {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-4);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  border: 2px solid transparent;
  transition: all var(--dur-base);
  cursor: pointer;
}
.icon-chip.active { border-color: var(--accent-yellow); background: rgba(255, 209, 102, 0.15); }
.icon-label { font-size: var(--fs-xs); color: var(--text-secondary); font-family: var(--font-cute); }
.cam { font-size: 26px; line-height: 36px; }
.remove-btn {
  position: absolute;
  top: -6px;
  right: -4px;
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  background: rgba(255, 122, 122, 0.9);
  color: #fff;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.color-row { display: flex; gap: var(--space-8); flex-wrap: wrap; padding-left: var(--space-4); }
.color-dot {
  width: 30px;
  height: 30px;
  border-radius: var(--r-full);
  border: 3px solid transparent;
  box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.7);
  transition: transform var(--dur-fast), border-color var(--dur-fast);
}
.color-dot:hover { transform: scale(1.08); }
.color-dot.active { border-color: var(--text-primary); }
</style>
